/** Shared HTTP layer: polite UA, timeouts, retries, abort propagation.
 * Node 20+ native fetch; zero runtime dependencies. */

export interface HttpOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Contact email for polite pools (crossref / openalex / unpaywall). */
  contactEmail?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
/** Only these statuses are retried; everything else fails fast. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Host-level 429 cooldown（2026-09-21 优化：真实 run 里 S2/OpenAlex 无 key
 * 限流是分钟级窗口，浅重试（3×≤4.5s）穿不透，且每次后续调用都重烧整段
 * 重试梯子）。终局 429 后按 host 记冷却窗口：窗口内的后续请求立即快败
 * （HttpError 429 + 冷却说明），成功即清。retry-after 优先（上限 120s），
 * 缺省 60s。
 */
const rateLimitCooldowns = new Map<string, number>();
const COOLDOWN_DEFAULT_MS = 60_000;
const COOLDOWN_MAX_MS = 120_000;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export const USER_AGENT = "dsh-papersearch/0.1.0 (+https://github.com/1-CellBio/dsh-papersearch)";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
  }
}

function mergeSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });

/** 测试缝（__ 前缀 = 非公共 API）：退避睡眠与时钟可注入——假定时器与
 * AbortSignal.timeout 的原生计时器不兼容，测试用即时睡眠+可控时钟。
 * 缺省即生产行为（真实 sleep / Date.now）。 */
export const __httpTestSeams = {
  sleep: (ms: number, signal?: AbortSignal): Promise<void> => sleep(ms, signal),
  now: (): number => Date.now(),
};

function retryDelayMs(attempt: number, retryAfter: string | null, isRateLimit: boolean): number {
  if (retryAfter && /^\d+$/.test(retryAfter.trim())) {
    const seconds = Number(retryAfter.trim());
    if (seconds > 0 && seconds <= (isRateLimit ? 120 : 60)) return seconds * 1000;
  }
  if (isRateLimit) {
    // 分钟级限流窗口：指数梯子 2s → 8s（MAX_RETRIES=3 只有两次尝试间退避，
    // 第三次即终局——其 429 直接进 host 冷却窗而非再退避；20s 上限是
    // MAX_RETRIES 调大时的护栏。浅梯子 3×1.5s 穿不透分钟级窗口）。
    return Math.min(20_000, 2_000 * 4 ** attempt);
  }
  return Math.min(15_000, (attempt + 1) * 1_500);
}

/** Shared request primitive: native fetch plus the retry ladder, host 429
 * cooldown, timeout and abort merge. Callers that need raw Response bodies
 * (PDF streams, HTML pages) ride the same transient-failure policy as the
 * JSON endpoints — a momentary 429/503 retries THIS url instead of letting
 * the caller silently fall through to a lower-quality fallback. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number; signal?: AbortSignal },
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const host = hostOf(url);
  const cooldownUntil = rateLimitCooldowns.get(host);
  if (cooldownUntil !== undefined && cooldownUntil > __httpTestSeams.now()) {
    throw new HttpError(429, `${url} (rate-limited: cooling down ${Math.ceil((cooldownUntil - __httpTestSeams.now()) / 1000)}s — retry-after honored from the terminal 429)`);
  }
  rateLimitCooldowns.delete(host);
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: mergeSignals(init.signal, timeoutMs),
        redirect: "follow",
      });
      if (!RETRYABLE.has(response.status)) {
        rateLimitCooldowns.delete(host);
        return response;
      }
      const isRateLimit = response.status === 429;
      if (attempt === MAX_RETRIES - 1) {
        if (isRateLimit) {
          const retryAfter = response.headers.get("retry-after");
          const seconds = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : 0;
          rateLimitCooldowns.set(host, __httpTestSeams.now() + Math.min(seconds > 0 ? seconds * 1000 : COOLDOWN_DEFAULT_MS, COOLDOWN_MAX_MS));
        }
        throw new HttpError(response.status, url);
      }
      await __httpTestSeams.sleep(retryDelayMs(attempt, response.headers.get("retry-after"), isRateLimit), init.signal);
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError) throw error;
      if (init.signal?.aborted) throw error;
      if (attempt === MAX_RETRIES - 1) throw error;
      await __httpTestSeams.sleep((attempt + 1) * 1_000, init.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** GET a JSON document. Throws HttpError on non-2xx after retries. */
export async function getJson<T>(url: string, options: HttpOptions & { headers?: Record<string, string> } = {}): Promise<T> {
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (!response.ok) throw new HttpError(response.status, url);
  return (await response.json()) as T;
}

/** GET a text document (XML/HTML). */
export async function getText(url: string, options: HttpOptions & { headers?: Record<string, string> } = {}): Promise<string> {
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/xml, text/xml, text/html, */*",
      ...(options.headers ?? {}),
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (!response.ok) throw new HttpError(response.status, url);
  return await response.text();
}

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  return search.toString();
}

/** Polite-pool mailto query string fragment (crossref/openalex/unpaywall). */
export function mailtoParam(email?: string): string {
  const value = email?.trim();
  return value ? `mailto=${encodeURIComponent(value)}` : "";
}
