import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import * as keys from "../keys";
import { registerTools } from "../tools";
import type { ConfigSource } from "../settings";

const pdfMagic = Buffer.concat([
  Buffer.from("%PDF-1.7 fake content for tests\n"),
  Buffer.from("x".repeat(2048)),
]);

/** Pre-stage a file exactly the way a completed download leaves it: the PDF
 * plus a matching .meta.json sidecar, so the exists short-circuit verifies
 * it instead of re-downloading over it. */
async function preExisting(pdfPath: string): Promise<void> {
  await writeFile(pdfPath, pdfMagic);
  await writeFile(`${pdfPath}.meta.json`, JSON.stringify({
    sha256: createHash("sha256").update(pdfMagic).digest("hex"),
    bytes: pdfMagic.byteLength,
    doi: "",
    title: "",
    source: "arxiv",
    sourceUrl: `https://arxiv.org/pdf/${path.basename(pdfPath)}`,
    retrievedAt: new Date().toISOString(),
    identity: "repository-unverified",
  }));
}

/** fetch response fake good enough for getText (text) and fetchPdf (arrayBuffer). */
function fakeResponse(body: string | Buffer, contentType: string) {
  const buffer = typeof body === "string" ? Buffer.from(body) : body;
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => buffer.toString("utf8"),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

/** arXiv Atom feed with bare entries (no title/doi) so downloads skip every fallback. */
function atomFeed(ids: string[]): string {
  const entries = ids.map((id) => [
    "<entry>",
    `<id>http://arxiv.org/abs/${id}</id>`,
    "<published>2024-01-01T00:00:00Z</published>",
    `<link href="https://arxiv.org/pdf/${id}" type="application/pdf" rel="related" title="pdf"/>`,
    "<author><name>A</name></author>",
    "</entry>",
  ].join("")).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n${entries}\n</feed>`;
}

interface JobHooksLike {
  cancel: () => void;
  done: Promise<{ status: string; detail?: string }>;
}

interface StartedJob {
  kind: string;
  label: string;
  owner?: unknown;
  /** 注册表输出环的追加序（0.1.7：job.append 的 chunk 依序落此）。 */
  ring: string[];
  hooks: JobHooksLike;
}

/** Records jobs.start specs; run(job) is invoked synchronously like the real
 *  registry, with a handle whose appends land in the recorded ring. */
function fakeJobs() {
  const started: StartedJob[] = [];
  let seq = 0;
  return {
    started,
    registry: {
      start(spec: { kind: string; label: string; owner?: unknown; run: (job: { append(chunk: string): void; updateProgress(line: string): void }) => JobHooksLike }): string {
        seq += 1;
        const ring: string[] = [];
        const hooks = spec.run({
          append: (chunk: string) => ring.push(chunk),
          updateProgress: () => {},
        });
        started.push({ kind: spec.kind, label: spec.label, owner: spec.owner, ring, hooks });
        return `${spec.kind}-${seq}`;
      },
    },
  };
}

/** Minimal plugin context: records tool registrations, resolves the jobs service. */
function harness(jobsService?: unknown): { ctx: Context; tools: ToolDefinition[] } {
  const tools: ToolDefinition[] = [];
  const ctx = {
    tools: { register: (def: ToolDefinition): (() => void) => { tools.push(def); return () => {}; } },
    get: (name: string): unknown => (name === "jobs" ? jobsService : undefined),
  } as unknown as Context;
  return { ctx, tools };
}

/** Register the plugin tools and return the papersearch_fetch definition. */
function fetchTool(jobsService: unknown, getConfig: ConfigSource): ToolDefinition {
  const { ctx, tools } = harness(jobsService);
  registerTools(ctx, getConfig);
  const def = tools.find((tool) => tool.name === "papersearch_fetch");
  if (!def) throw new Error("papersearch_fetch not registered");
  return def;
}

/** Minimal tool execution context (only the fields papersearch_fetch reads). */
function execWith(agent?: unknown): ToolRunContext {
  return {
    callId: "call-1",
    name: "papersearch_fetch",
    arguments: {},
    signal: new AbortController().signal,
    ...(agent !== undefined ? { agent } : {}),
  } as ToolRunContext;
}

/** Network stub: arXiv Atom search over three papers — 2401.00001 downloads,
 *  2401.00002 pre-exists on disk, 2401.00003 never yields a PDF. */
function stubNetwork(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const raw = String(url);
    if (raw.startsWith("http://export.arxiv.org/api/query")) {
      return fakeResponse(atomFeed(["2401.00001", "2401.00002", "2401.00003"]), "application/atom+xml");
    }
    if (raw.startsWith("https://arxiv.org/pdf/2401.00003")) {
      return fakeResponse(Buffer.from("<html>denied</html>"), "text/html");
    }
    return fakeResponse(pdfMagic, "application/pdf");
  }));
}

describe("papersearch_fetch background job seam", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-fetch-"));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults to a background job with owner fencing, per-paper log lines, and staged paths in the detail", async () => {
    await preExisting(path.join(dir, "arxiv-2401.00002.pdf"));
    stubNetwork();
    const jobs = fakeJobs();
    const getConfig: ConfigSource = () => ({ pdfDir: dir, useScihub: false });
    const fetch = fetchTool(jobs.registry, getConfig);
    const refreshSpy = vi.spyOn(keys, "refreshSourceKeys");
    // 0.1.7：job owner 是 SessionId（agent.id），不再是 Agent 引用本体。
    const agent = { id: "papersearch-fetch-session", session: { header: {} } };

    const result = await fetch.execute({ query: "crispr", sources: "arxiv", count: 3 }, execWith(agent));

    expect(result).toEqual({
      kind: "background",
      jobId: "papersearch-fetch-1",
      nextStep: expect.stringContaining("job_output"),
    });
    expect((result as { nextStep: string }).nextStep).toContain("okf_ingest");
    expect(jobs.started).toHaveLength(1);
    expect(jobs.started[0]!.kind).toBe("papersearch-fetch");
    expect(jobs.started[0]!.label).toBe("papersearch_fetch crispr");
    expect(jobs.started[0]!.owner).toBe("papersearch-fetch-session");

    const outcome = await jobs.started[0]!.hooks.done;
    expect(outcome.status).toBe("completed");
    expect(outcome.detail).toContain("downloaded 1, replaced 0, exists 1, failed 1");
    expect(outcome.detail).toContain("arxiv-2401.00001.pdf");
    expect(outcome.detail).toContain("arxiv-2401.00002.pdf");
    // Credentials refresh inside the job body, so the job honors store changes per operation.
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    const output = jobs.started[0]!.ring.join("");
    expect(output).toContain('search "crispr" sources=arxiv max=5');
    expect(output).toContain("search finished: 3 paper(s) from 1 source(s)");
    expect(output).toContain(`download 3 paper(s) into ${dir}`);
    expect(output).toContain(`downloaded arxiv/2401.00001 -> ${path.join(dir, "arxiv-2401.00001.pdf")}`);
    expect(output).toContain(`exists arxiv/2401.00002 -> ${path.join(dir, "arxiv-2401.00002.pdf")}`);
    expect(output).toContain("failed arxiv/2401.00003: ");
    expect(output.trimEnd().endsWith("downloaded 1, replaced 0, exists 1, failed 1")).toBe(true);
  });

  it("maps job kill to a killed outcome and aborts the in-flight search", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })));
    const jobs = fakeJobs();
    const fetch = fetchTool(jobs.registry, () => ({ pdfDir: dir, useScihub: false }));

    const result = await fetch.execute({ query: "crispr", sources: "arxiv" }, execWith());

    expect((result as { kind: string }).kind).toBe("background");
    // No agent on the execution: the job starts unowned.
    expect(jobs.started[0]!.owner).toBeUndefined();
    jobs.started[0]!.hooks.cancel();
    await expect(jobs.started[0]!.hooks.done).resolves.toEqual({ status: "killed", detail: "aborted" });
  });

  it("fails loud when the jobs service is absent", async () => {
    stubNetwork();
    const fetch = fetchTool(undefined, () => ({ pdfDir: dir, useScihub: false }));
    await expect(fetch.execute({ query: "crispr" }, execWith())).rejects.toThrow(
      /background jobs unavailable: load @deepseek-ai\/dsh-jobs and @deepseek-ai\/dsh-tool-jobs/,
    );
  });

  it("background=false keeps the synchronous manifest path without starting a job", async () => {
    await preExisting(path.join(dir, "arxiv-2401.00002.pdf"));
    stubNetwork();
    const jobs = fakeJobs();
    const fetch = fetchTool(jobs.registry, () => ({ pdfDir: dir, useScihub: false }));

    const result = await fetch.execute(
      { query: "crispr", sources: "arxiv", background: false },
      execWith(),
    ) as { kind?: string; results: Array<{ status: string }>; nextStep: string };

    expect(jobs.started).toHaveLength(0);
    expect(result.kind).toBeUndefined();
    expect(result.results.map((outcome) => outcome.status).sort()).toEqual(["downloaded", "exists", "failed"]);
    expect(result.nextStep).toContain("okf_ingest");
    expect(result.nextStep).toContain("relative names resolve against the download dir");
  });
});
