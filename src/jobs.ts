import type { Context } from "@deepseek-ai/cordis";
import type { JobOutcome } from "@deepseek-ai/dsh-jobs";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import path from "node:path";
import "./kinds";
import { sciHubEnabled } from "./keys";
import { LineLog } from "./log-buffer";
import { acquireByDoi, downloadAll, pickDownloadable, searchSources, type DownloadOutcome } from "./registry";
import { ingestDetailClause, stagedFiles, type IngestHandoff } from "./staging";

/** Start one papersearch background job through the ctx.jobs seam.
 * @param ctx - plugin context; must expose the jobs service when background is requested.
 * @param exec - the tool execution whose agent fences the job (owner = agent.id,
 *   the SessionId the 0.1.7 registry isolates reads/kills/waits by).
 * @param spec - job label plus the work to run with the shared log and its abort signal.
 * @returns the job handle; log and done serve in-process consumers, the tool result
 *   carries only the job id. */
export function startPapersearchJob(
  ctx: Context,
  exec: Pick<ToolRunContext, "agent">,
  spec: {
    label: string;
    run: (log: LineLog, signal: AbortSignal) => Promise<string>;
  },
): { kind: "background"; jobId: string; log: LineLog; done: Promise<JobOutcome> } {
  const jobs: Context["jobs"] | undefined = ctx.get("jobs");
  if (jobs === undefined) {
    throw new Error("background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
  }
  const log = new LineLog();
  let settle: (outcome: JobOutcome) => void = () => {};
  const done = new Promise<JobOutcome>((resolve) => {
    settle = resolve;
  });
  const id = jobs.start({
    kind: "papersearch-fetch",
    label: spec.label,
    ...(exec.agent ? { owner: exec.agent.id } : {}),
    run: (job) => {
      // 0.1.7：注册表自营输出环——producer 的每行日志经 job.append 进环，
      // job_output 的增量读取、截断与 spill 全由注册表负责。
      log.ring((chunk) => job.append(chunk));
      const controller = new AbortController();
      const worker = spec.run(log, controller.signal).then(
        (detail): JobOutcome => ({ status: "completed", detail }),
        (error: unknown): JobOutcome => {
          if (controller.signal.aborted) {
            return { status: "killed", detail: "aborted" };
          }
          const message = error instanceof Error ? error.message : String(error);
          log.append(`error: ${message}`);
          return { status: "failed", detail: message };
        },
      );
      worker.then(settle, settle);
      return {
        cancel: () => controller.abort(),
        done: worker,
      };
    },
  });
  return { kind: "background", jobId: id, log, done };
}

/** One papersearch_fetch run, validated and resolved by the tools layer. */
export interface FetchJobArgs {
  query: string;
  sources?: string[];
  maxResults: number;
  year?: string;
  /** Papers to download (already capped at MAX_FETCH_COUNT by the tools layer). */
  count: number;
  /** Absolute download dir. */
  dir: string;
  searchTimeoutMs: number;
  downloadTimeoutMs: number;
}

/** The fetch manifest shared by the synchronous tool result and the job detail. */
export interface FetchJobResult {
  query: string;
  sources: string[];
  totalFound: number;
  candidates: number;
  requested: number;
  results: DownloadOutcome[];
  dir: string;
  errors: Record<string, string>;
}

/** Search + download pipeline behind papersearch_fetch, appending one log line
 *  per phase and per settled paper into `log`.
 * @param args - the validated fetch inputs.
 * @param refreshKeys - re-resolves source credentials inside the run, so a
 *   background job honors settings/credential-store changes per operation.
 * @param log - incremental output consumed by job_output.
 * @param signal - cancellation; aborts in-flight fetches and maps to a killed job.
 * @returns the manifest the tool result (sync) or the job detail (background) renders. */
export async function runFetchJob(
  args: FetchJobArgs,
  refreshKeys: () => Promise<void>,
  log: LineLog,
  signal: AbortSignal,
): Promise<FetchJobResult> {
  await refreshKeys();
  throwIfAborted(signal);
  const sources = args.sources ? args.sources.join(",") : "all";
  log.append(`search "${args.query}" sources=${sources} max=${args.maxResults}${args.year ? ` year=${args.year}` : ""}`);
  const search = await searchSources({
    query: args.query,
    sources: args.sources,
    maxResults: args.maxResults,
    year: args.year,
    signal,
    timeoutMs: args.searchTimeoutMs,
  });
  // searchSources folds per-source failures (including aborts) into its errors
  // map, so this fence is what turns a cancelled search into a killed job.
  throwIfAborted(signal);
  const failedSources = Object.entries(search.errors);
  log.append(
    `search finished: ${search.total} paper(s) from ${search.sourcesUsed.length} source(s)`
      + (failedSources.length > 0 ? `, ${failedSources.length} source error(s)` : ""),
  );
  for (const [id, message] of failedSources) {
    log.append(`search error ${id}: ${message}`);
  }
  const candidates = pickDownloadable(
    search.papers.map((paper) => ({
      paperId: paper.paperId,
      source: paper.source,
      title: paper.title,
      pdfUrl: paper.pdfUrl,
      doi: paper.doi,
    })),
    args.count,
  );
  log.append(`download ${candidates.length} paper(s) into ${args.dir}`);
  const results = await downloadAll(
    candidates.map((paper) => ({
      source: paper.source,
      paperId: paper.paperId,
      title: paper.title,
      doi: paper.doi,
      pdfUrl: paper.pdfUrl,
    })),
    {
      dir: args.dir,
      signal,
      timeoutMs: args.downloadTimeoutMs,
      onOutcome: (outcome) => {
        const id = `${outcome.source}/${outcome.paperId}`;
        log.append(
          outcome.status === "failed"
            ? `failed ${id}: ${outcome.error ?? "unknown error"}`
            : `${outcome.status} ${id} -> ${outcome.path ?? outcome.libraryPaper ?? ""}`,
        );
      },
    },
  );
  const counts = outcomeCounts(results);
  log.append(countsLine(counts));
  return {
    query: args.query,
    sources: search.sourcesUsed,
    totalFound: search.total,
    candidates: candidates.length,
    requested: args.count,
    results,
    dir: args.dir,
    errors: search.errors,
  };
}

/** One-line completion detail: outcome counts plus the staged file names
 *  (relative names resolve against the download dir) and whether ingest started.
 * @param result - the settled fetch manifest.
 * @param ingest - the ingest consumer's answer to the staged-files hand-off, if any.
 * @returns the job outcome detail string. */
export function fetchJobDetail(result: FetchJobResult, ingest?: IngestHandoff): string {
  const counts = outcomeCounts(result.results);
  const staged = result.results
    .filter((outcome) => outcome.status !== "failed")
    .flatMap((outcome) => (outcome.path ? [path.basename(outcome.path)] : []));
  return `${countsLine(counts)} — dir ${result.dir}`
    + (staged.length > 0 ? ` (${staged.join(", ")})` : "")
    + ingestDetailClause(stagedFiles(result.results).length, ingest);
}

interface OutcomeCounts {
  downloaded: number;
  replaced: number;
  exists: number;
  inLibrary: number;
  failed: number;
}

function outcomeCounts(results: readonly DownloadOutcome[]): OutcomeCounts {
  let downloaded = 0;
  let replaced = 0;
  let exists = 0;
  let inLibrary = 0;
  let failed = 0;
  for (const outcome of results) {
    if (outcome.status === "downloaded") downloaded += 1;
    else if (outcome.status === "replaced") replaced += 1;
    else if (outcome.status === "exists") exists += 1;
    else if (outcome.status === "in-library") inLibrary += 1;
    else failed += 1;
  }
  return { downloaded, replaced, exists, inLibrary, failed };
}

/** `downloaded a, replaced b, exists c[, in-library d], failed e` — the
 * in-library count appears only when the library answered some DOI. */
function countsLine(counts: OutcomeCounts): string {
  return `downloaded ${counts.downloaded}, replaced ${counts.replaced}, exists ${counts.exists}`
    + (counts.inLibrary > 0 ? `, in-library ${counts.inLibrary}` : "")
    + `, failed ${counts.failed}`;
}

/** One papersearch_acquire run, validated and resolved by the tools layer. */
export interface AcquireJobArgs {
  /** Bare DOIs, deduplicated (already capped at MAX_ACQUIRE_COUNT). */
  dois: string[];
  /** Absolute download dir. */
  dir: string;
  downloadTimeoutMs: number;
}

/** The acquire manifest shared by the synchronous tool result and the job detail. */
export interface AcquireJobResult {
  requested: number;
  results: DownloadOutcome[];
  dir: string;
}

/** DOI acquisition pipeline behind papersearch_acquire: S2 openAccessPdf →
 *  OA repositories + unpaywall → Sci-Hub (unless `useScihub` is turned off), one log line per settled DOI. */
export async function runAcquireJob(
  args: AcquireJobArgs,
  refreshKeys: () => Promise<void>,
  log: LineLog,
  signal: AbortSignal,
): Promise<AcquireJobResult> {
  await refreshKeys();
  throwIfAborted(signal);
  log.append(`acquire ${args.dois.length} DOI(s) into ${args.dir} (chain: semantic-scholar → oa-repositories/unpaywall${sciHubEnabled() ? " → sci-hub" : "; sci-hub off"})`);
  const results = await acquireByDoi(args.dois, {
    dir: args.dir,
    signal,
    timeoutMs: args.downloadTimeoutMs,
    onOutcome: (outcome) => {
      log.append(
        outcome.status === "failed"
          ? `failed ${outcome.paperId}: ${outcome.error ?? "unknown error"}`
          : `${outcome.status} ${outcome.paperId} -> ${outcome.path ?? ""}`,
      );
    },
  });
  const counts = outcomeCounts(results);
  log.append(countsLine(counts));
  return { requested: args.dois.length, results, dir: args.dir };
}

/** One-line completion detail: outcome counts, the staged file names
 *  (relative names resolve against the download dir), and whether ingest started.
 * @param result - the settled acquire manifest.
 * @param ingest - the ingest consumer's answer to the staged-files hand-off, if any.
 * @returns the job outcome detail string. */
export function acquireJobDetail(result: AcquireJobResult, ingest?: IngestHandoff): string {
  const counts = outcomeCounts(result.results);
  const staged = result.results
    .filter((outcome) => outcome.status !== "failed")
    .flatMap((outcome) => (outcome.path ? [path.basename(outcome.path)] : []));
  const missed = result.results
    .filter((outcome) => outcome.status === "failed")
    .map(describeMiss);
  const inconclusive = result.results.some((outcome) => outcome.diagnosis?.verdict === "inconclusive");
  const inLibrary = result.results
    .filter((outcome) => outcome.status === "in-library")
    .map((outcome) => `${outcome.doi ?? outcome.paperId} → ${outcome.libraryPaper ?? "library"}`);
  const conflicts = result.results
    .filter((outcome) => outcome.identityConflict !== undefined)
    .map((outcome) => outcome.doi ?? outcome.paperId);
  return `${countsLine(counts)} — dir ${result.dir}`
    + (staged.length > 0 ? ` (${staged.join(", ")})` : "")
    + (inLibrary.length > 0 ? ` — already in the library, no download needed: ${inLibrary.join("; ")}` : "")
    + (missed.length > 0 ? ` — no full text for: ${missed.join(", ")}` : "")
    + (inconclusive ? " — inconclusive is not proof of a paywall: fix the named setting or retry later" : "")
    + (conflicts.length > 0 ? ` — identical bytes already stored under another DOI (not saved): ${conflicts.join(", ")}` : "")
    + ingestDetailClause(stagedFiles(result.results).length, ingest);
}

/** `<doi> (<verdict>[: <first failing step and why>])` for one failed acquisition. */
function describeMiss(outcome: DownloadOutcome): string {
  const id = outcome.doi ?? outcome.paperId;
  const diagnosis = outcome.diagnosis;
  if (diagnosis === undefined) return id;
  if (diagnosis.verdict === "no-open-access-copy") return `${id} (${diagnosis.verdict})`;
  const first = diagnosis.stages.find((stage) => stage.result === "unavailable" || stage.result === "unconfigured");
  return first === undefined ? `${id} (${diagnosis.verdict})` : `${id} (${diagnosis.verdict}: ${first.stage} ${first.detail ?? first.result})`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }
}
