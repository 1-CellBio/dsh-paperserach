import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { DownloadOutcome } from "../registry";
import { LineLog } from "../log-buffer";
import { registerTools } from "../tools";
import { handOffStaged, ingestDetailClause, ingestNextStep, stagedFiles, type IngestHandoff, type StagedPdfs } from "../staging";

const pdfMagic = Buffer.concat([
  Buffer.from("%PDF-1.7 fake content for tests\n"),
  Buffer.from("x".repeat(2048)),
]);

/** A pre-existing PDF with a matching sidecar, so the download reports `exists`. */
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

/** arXiv search over three papers: 2401.00001 downloads, 2401.00002 pre-exists, 2401.00003 never yields a PDF. */
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

interface StartedJob {
  kind: string;
  ring: string[];
  hooks: { cancel: () => void; done: Promise<{ status: string; detail?: string }> };
}

/** Records jobs.start specs and runs them synchronously like the real registry. */
function fakeJobs(onAppend?: (chunk: string) => void) {
  const started: StartedJob[] = [];
  return {
    started,
    registry: {
      start(spec: { kind: string; run: (job: { append(chunk: string): void }) => StartedJob["hooks"] }): string {
        const ring: string[] = [];
        const hooks = spec.run({ append: (chunk: string) => { ring.push(chunk); onAppend?.(chunk); } });
        started.push({ kind: spec.kind, ring, hooks });
        return `${spec.kind}-${started.length}`;
      },
    },
  };
}

type Listener = (event: StagedPdfs) => Promise<IngestHandoff | undefined> | IngestHandoff | undefined;

/** Plugin context with an event bus reduced to the one `ctx.serial` call papersearch makes. */
function harness(listener?: Listener, jobsService?: unknown) {
  const tools: ToolDefinition[] = [];
  const dispatched: StagedPdfs[] = [];
  const ctx = {
    tools: { register: (def: ToolDefinition): (() => void) => { tools.push(def); return () => {}; } },
    get: (name: string): unknown => (name === "jobs" ? jobsService : undefined),
    serial: async (name: string, event: StagedPdfs) => {
      expect(name).toBe("papersearch/staged");
      dispatched.push(event);
      return listener?.(event);
    },
  } as unknown as Context;
  return { ctx, tools, dispatched };
}

function toolByName(name: string, listener: Listener | undefined, getConfig: () => { pdfDir: string; useScihub: boolean }, jobsService?: unknown) {
  const { ctx, tools, dispatched } = harness(listener, jobsService);
  registerTools(ctx, getConfig);
  const def = tools.find((tool) => tool.name === name);
  if (!def) throw new Error(`${name} not registered`);
  return { def, dispatched };
}

const AGENT = { id: "agent-7", session: { header: { cwd: "/ws" } } };

function execWith(agent: unknown = AGENT): ToolRunContext {
  return { callId: "call-1", name: "t", arguments: {}, signal: new AbortController().signal, agent } as ToolRunContext;
}

const STARTED: IngestHandoff = { status: "started", jobId: "okf-ingest-9", files: 2 };

function outcome(status: DownloadOutcome["status"], file?: string): DownloadOutcome {
  return { source: "arxiv", paperId: file ?? "x", status, ...(file ? { path: file } : {}) };
}

describe("stagedFiles", () => {
  it("keeps downloaded / replaced / exists paths, drops failed and in-library, resolves and de-duplicates", () => {
    const files = stagedFiles([
      outcome("downloaded", "/pdfs/a.pdf"),
      outcome("replaced", "/pdfs/b.pdf"),
      outcome("exists", "/pdfs/c.pdf"),
      outcome("exists", "/pdfs/../pdfs/c.pdf"),
      outcome("failed"),
      { ...outcome("in-library"), libraryPaper: "papers/p" },
      outcome("downloaded"),
    ]);
    expect(files).toEqual([path.resolve("/pdfs/a.pdf"), path.resolve("/pdfs/b.pdf"), path.resolve("/pdfs/c.pdf")]);
  });
});

describe("handOffStaged", () => {
  it("dispatches papersearch/staged with the agent, origin and absolute files, and logs the answer", async () => {
    const { ctx, dispatched } = harness(() => STARTED);
    const log = new LineLog();
    const answer = await handOffStaged(ctx, { agent: AGENT as never }, "papersearch_acquire", [outcome("downloaded", "/pdfs/a.pdf")], log);
    expect(answer).toEqual(STARTED);
    expect(dispatched).toEqual([{ agent: AGENT, origin: "papersearch_acquire", files: [path.resolve("/pdfs/a.pdf")] }]);
    expect(log.snapshot()).toContain("auto-ingest started: job okf-ingest-9 for 2 file(s)");
  });

  it("does not dispatch when nothing was staged", async () => {
    const { ctx, dispatched } = harness(() => STARTED);
    expect(await handOffStaged(ctx, { agent: AGENT as never }, "t", [outcome("failed"), outcome("in-library")])).toBeUndefined();
    expect(dispatched).toEqual([]);
  });

  it("reports no consumer when no listener answers, and tolerates a context without ctx.serial", async () => {
    const { ctx } = harness(() => undefined);
    const log = new LineLog();
    expect(await handOffStaged(ctx, { agent: AGENT as never }, "t", [outcome("downloaded", "/pdfs/a.pdf")], log)).toBeUndefined();
    expect(log.snapshot()).toContain("no ingest consumer answered for 1 staged file(s)");
    const bare = {} as unknown as Context;
    expect(await handOffStaged(bare, { agent: AGENT as never }, "t", [outcome("downloaded", "/pdfs/a.pdf")])).toBeUndefined();
  });

  it("turns a throwing consumer into a not-started answer instead of failing the tool run", async () => {
    const { ctx } = harness(() => { throw new Error("listener exploded"); });
    const log = new LineLog();
    const answer = await handOffStaged(ctx, { agent: AGENT as never }, "t", [outcome("downloaded", "/pdfs/a.pdf")], log);
    expect(answer).toEqual({ status: "not-started", reason: "listener exploded" });
    expect(log.snapshot()).toContain("auto-ingest hand-off failed: listener exploded");
  });
});

describe("hand-off wording", () => {
  const tail = "then use okf_search.";

  it("tells the model not to call okf_ingest again when the job started", () => {
    const next = ingestNextStep(2, STARTED, tail);
    expect(next).toContain("job okf-ingest-9");
    expect(next).toContain("do NOT call okf_ingest");
    expect(next).toContain(tail);
    expect(ingestDetailClause(2, STARTED)).toContain("started automatically as job okf-ingest-9");
  });

  it("keeps the manual instruction when ingest did not start or nobody answered", () => {
    const declined: IngestHandoff = { status: "not-started", reason: "the okf autoIngest setting is off" };
    expect(ingestNextStep(2, declined, tail)).toMatch(/Automatic ingest did not start \(the okf autoIngest setting is off\)\. Call okf_ingest with the downloaded paths/);
    expect(ingestDetailClause(2, declined)).toContain("automatic ingest did NOT start (the okf autoIngest setting is off): call okf_ingest");
    expect(ingestNextStep(2, undefined, tail)).toMatch(/^Call okf_ingest with the downloaded paths/);
    expect(ingestDetailClause(2, undefined)).toContain("no ingest consumer answered: call okf_ingest");
  });

  it("says nothing to ingest when no PDF was staged", () => {
    expect(ingestNextStep(0, STARTED, tail)).toBe("No PDF was staged, so there is nothing to ingest.");
    expect(ingestDetailClause(0, STARTED)).toBe("");
  });
});

describe("tool hand-off", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-staging-"));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });
  const config = () => ({ pdfDir: dir, useScihub: false });

  it("papersearch_fetch (sync) announces the downloaded and unchanged PDFs, not the failed one, and reports the started job", async () => {
    await preExisting(path.join(dir, "arxiv-2401.00002.pdf"));
    stubNetwork();
    const { def, dispatched } = toolByName("papersearch_fetch", () => STARTED, config);

    const result = await def.execute({ query: "crispr", sources: "arxiv", count: 3, background: false }, execWith()) as {
      ingest: IngestHandoff; nextStep: string; results: Array<{ status: string }>;
    };

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.origin).toBe("papersearch_fetch");
    expect(dispatched[0]!.agent).toBe(AGENT);
    expect([...dispatched[0]!.files].sort()).toEqual([
      path.join(dir, "arxiv-2401.00001.pdf"),
      path.join(dir, "arxiv-2401.00002.pdf"),
    ]);
    expect(result.ingest).toEqual(STARTED);
    expect(result.nextStep).toContain("job okf-ingest-9");
    expect(result.nextStep).toContain("do NOT call okf_ingest");
  });

  it("papersearch_fetch (background) hands off after the downloads settle and names the ingest job in the completion detail and log", async () => {
    stubNetwork();
    const jobs = fakeJobs();
    const { def, dispatched } = toolByName("papersearch_fetch", () => STARTED, config, jobs.registry);

    const started = await def.execute({ query: "crispr", sources: "arxiv", count: 3 }, execWith()) as { kind: string; nextStep: string };
    expect(started.kind).toBe("background");
    expect(started.nextStep).toContain("handed to okf for automatic ingest");

    const done = await jobs.started[0]!.hooks.done;
    expect(done.status).toBe("completed");
    expect(done.detail).toContain("downloaded 2, replaced 0, exists 0, failed 1");
    expect(done.detail).toContain("okf ingest started automatically as job okf-ingest-9 (2 file(s))");
    expect(dispatched).toHaveLength(1);
    expect(jobs.started[0]!.ring.join("")).toContain("auto-ingest started: job okf-ingest-9 for 2 file(s)");
  });

  it("a declined hand-off keeps the manual instruction in the sync result and the job detail", async () => {
    stubNetwork();
    const declined: IngestHandoff = { status: "not-started", reason: "the okf autoIngest setting is off" };
    const sync = toolByName("papersearch_fetch", () => declined, config);
    const result = await sync.def.execute({ query: "crispr", sources: "arxiv", background: false }, execWith()) as { ingest: IngestHandoff; nextStep: string };
    expect(result.ingest).toEqual(declined);
    expect(result.nextStep).toContain("Automatic ingest did not start (the okf autoIngest setting is off)");
    expect(result.nextStep).toContain("Call okf_ingest with the downloaded paths");

    const jobs = fakeJobs();
    const background = toolByName("papersearch_fetch", () => declined, config, jobs.registry);
    await background.def.execute({ query: "crispr", sources: "arxiv" }, execWith());
    const done = await jobs.started[0]!.hooks.done;
    expect(done.detail).toContain("automatic ingest did NOT start (the okf autoIngest setting is off): call okf_ingest on the staged files");
  });

  it("without an ingest consumer the result carries no ingest field and the manual instruction", async () => {
    stubNetwork();
    const { def } = toolByName("papersearch_fetch", () => undefined, config);
    const result = await def.execute({ query: "crispr", sources: "arxiv", background: false }, execWith()) as Record<string, unknown> & { nextStep: string };
    expect(result).not.toHaveProperty("ingest");
    expect(result.nextStep).toMatch(/^Call okf_ingest with the downloaded paths/);
  });

  it("announces nothing when no PDF was staged", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("http://export.arxiv.org/api/query")) return fakeResponse(atomFeed(["2401.00003"]), "application/atom+xml");
      return fakeResponse(Buffer.from("<html>denied</html>"), "text/html");
    }));
    const { def, dispatched } = toolByName("papersearch_fetch", () => STARTED, config);
    const result = await def.execute({ query: "crispr", sources: "arxiv", background: false }, execWith()) as { nextStep: string };
    expect(dispatched).toEqual([]);
    expect(result.nextStep).toBe("No PDF was staged, so there is nothing to ingest.");
  });

  it("a job killed after its downloads settled does not announce the files", async () => {
    stubNetwork();
    // The counts line is the last append before the run returns its manifest: cancel there.
    const jobs: ReturnType<typeof fakeJobs> = fakeJobs((chunk) => {
      if (/^downloaded \d+, replaced \d+, exists \d+, failed \d+\s*$/.test(chunk)) jobs.started[0]!.hooks.cancel();
    });
    const { def, dispatched } = toolByName("papersearch_fetch", () => STARTED, config, jobs.registry);
    await def.execute({ query: "crispr", sources: "arxiv", count: 3 }, execWith());
    await jobs.started[0]!.hooks.done;
    expect(jobs.started[0]!.ring.join("")).toContain("downloaded 2, replaced 0, exists 0, failed 1");
    expect(dispatched).toEqual([]);
  });

  it("papersearch_download announces the saved PDF", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(pdfMagic, "application/pdf")));
    const { def, dispatched } = toolByName("papersearch_download", () => ({ status: "started", jobId: "okf-ingest-3", files: 1 }), config);
    const result = await def.execute({ source: "arxiv", paperId: "2401.00001" }, execWith()) as { status: string; ingest: IngestHandoff; nextStep: string };
    expect(result.status).toBe("downloaded");
    expect(dispatched[0]!.origin).toBe("papersearch_download");
    expect(dispatched[0]!.files).toEqual([path.join(dir, "arxiv-2401.00001.pdf")]);
    expect(result.ingest).toEqual({ status: "started", jobId: "okf-ingest-3", files: 1 });
    expect(result.nextStep).toContain("job okf-ingest-3");
  });

  it("papersearch_download_scihub announces the saved PDF", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(pdfMagic, "application/pdf")));
    const { def, dispatched } = toolByName("papersearch_download_scihub", () => STARTED, () => ({ pdfDir: dir, useScihub: true }));
    const result = await def.execute({ identifier: "https://example.com/paper.pdf" }, execWith()) as { status: string; ingest: IngestHandoff };
    expect(result.status).toBe("downloaded");
    expect(dispatched[0]!.origin).toBe("papersearch_download_scihub");
    expect(dispatched[0]!.files).toHaveLength(1);
    expect(path.dirname(dispatched[0]!.files[0]!)).toBe(dir);
    expect(result.ingest).toEqual(STARTED);
  });

  it("a failed download announces nothing and says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(Buffer.from("<html>no</html>"), "text/html")));
    const { def, dispatched } = toolByName("papersearch_download", () => STARTED, config);
    const result = await def.execute({ source: "arxiv", paperId: "2401.00009" }, execWith()) as { status: string; nextStep: string };
    expect(result.status).toBe("failed");
    expect(dispatched).toEqual([]);
    expect(result.nextStep).toBe("No PDF was staged, so there is nothing to ingest.");
  });
});
