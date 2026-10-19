import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getJson, HttpError, paceRequests, __httpTestSeams } from "../http.ts";

/**
 * 429 退避回归（2026-09-21）：真实 run 里 S2/OpenAlex 无 key 限流是分钟级
 * 窗口——浅重试（3×≤4.5s）穿不透，且每个后续调用都重烧整段梯子。钉三条：
 *   1. 终局 429 → host 进冷却窗口（缺省 60s），窗口内的后续请求零 fetch 快败。
 *   2. 冷却时长：终局 retry-after 优先（30s 实测）。
 *   3. 429 退避梯子指数（2s/8s）；成功清冷却恢复即用。
 * 测试经 __httpTestSeams 注入即时睡眠 + 可控时钟（假定时器与
 * AbortSignal.timeout 的原生计时器不兼容）。
 */

const response = (status: number, headers: Record<string, string> = {}): Response =>
  new Response("{\"ok\":true}", { status, headers });

describe("http 429 cooldown", () => {
  let fakeNow: number;
  const sleeps: number[] = [];

  beforeEach(() => {
    fakeNow = 1_000_000;
    sleeps.length = 0;
    __httpTestSeams.sleep = async (ms: number) => {
      sleeps.push(ms); // 即时睡眠——时间前进只由测试显式驱动
    };
    __httpTestSeams.now = () => fakeNow;
  });
  afterEach(() => {
    // 还原生产行为（模块级 seam 被本文件改写）
    __httpTestSeams.sleep = (ms, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      }, { once: true });
    });
    __httpTestSeams.now = () => Date.now();
    vi.unstubAllGlobals();
  });

  it("终局 429 → 缺省 60s 冷却：窗口内零 fetch 快败，过期后恢复尝试", async () => {
    const fetchMock = vi.fn(async () => response(429));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getJson("https://api.semanticscholar.org/graph/v1/paper/search?q=x")).rejects.toThrow(HttpError);
    expect(fetchMock.mock.calls.length).toBe(3);
    // 429 指数梯子：2s → 8s（第三次为终局，不睡）
    expect(sleeps).toEqual([2_000, 8_000]);

    // 冷却窗口内：零 fetch、快败、报文含冷却说明
    await expect(getJson("https://api.semanticscholar.org/graph/v1/paper/search?q=y")).rejects.toThrow(/cooling down/);
    expect(fetchMock.mock.calls.length).toBe(3);

    // 时钟越过 60s 窗口 → 恢复真实尝试（mock 恒 429 → 再烧一轮梯子）
    fakeNow += 61_000;
    await expect(getJson("https://api.semanticscholar.org/graph/v1/paper/search?q=z")).rejects.toThrow(HttpError);
    expect(fetchMock.mock.calls.length).toBe(6);
  });

  it("终局 429 的 retry-after 决定冷却时长（30s 窗口，越窗即恢复）", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return calls < 3 ? response(429) : response(429, { "retry-after": "30" });
    }));

    await expect(getJson("https://api.openalex.org/works?search=x")).rejects.toThrow(HttpError);
    expect(calls).toBe(3);
    // 窗口内（29s < 30s）快败
    fakeNow += 29_000;
    await expect(getJson("https://api.openalex.org/works?search=y")).rejects.toThrow(/cooling down/);
    expect(calls).toBe(3);
    // 越过 30s → 恢复尝试
    fakeNow += 2_000;
    await expect(getJson("https://api.openalex.org/works?search=z")).rejects.toThrow(HttpError);
    expect(calls).toBeGreaterThan(3);
  });

  it("成功清冷却：越窗后 2xx 即恢复，清除后直连成功", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return calls < 4 ? response(429) : response(200);
    }));
    await expect(getJson("https://api.crossref.org/works?q=seed")).rejects.toThrow(HttpError);
    expect(calls).toBe(3);
    // 冷却在场 → 快败
    await expect(getJson("https://api.crossref.org/works?q=w")).rejects.toThrow(/cooling down/);
    // 越窗后第 4 次调用 200：成功即清冷却
    fakeNow += 61_000;
    await expect(getJson("https://api.crossref.org/works?q=1")).resolves.toEqual({ ok: true });
    // 清除后直连成功（无快败、无退避）
    const before = calls;
    await expect(getJson("https://api.crossref.org/works?q=2")).resolves.toEqual({ ok: true });
    expect(calls).toBe(before + 1);
  });
});

describe("paceRequests", () => {
  let fakeNow: number;
  const sleeps: number[] = [];

  beforeEach(() => {
    fakeNow = 5_000_000;
    sleeps.length = 0;
    __httpTestSeams.sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    __httpTestSeams.now = () => fakeNow;
  });
  afterEach(() => {
    __httpTestSeams.sleep = (ms, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      }, { once: true });
    });
    __httpTestSeams.now = () => Date.now();
    __httpTestSeams.resetPacing();
  });

  it("并发调用按序占用间隔槽：首个即刻放行，其后每个多等一个间隔", async () => {
    await Promise.all([
      paceRequests("https://pace-a.example/x", 400),
      paceRequests("https://pace-a.example/y", 400),
      paceRequests("https://pace-a.example/z", 400),
    ]);
    expect(sleeps).toEqual([400, 800]);
  });

  it("间隔已过则不等；不同 host 互不占槽", async () => {
    await paceRequests("https://pace-b.example/1", 400);
    fakeNow += 400;
    await paceRequests("https://pace-b.example/2", 400);
    await paceRequests("https://pace-c.example/1", 400);
    expect(sleeps).toEqual([]);
  });

  it("间隔内的后一次只补足剩余时间", async () => {
    await paceRequests("https://pace-d.example/1", 400);
    fakeNow += 150;
    await paceRequests("https://pace-d.example/2", 400);
    expect(sleeps).toEqual([250]);
  });
});
