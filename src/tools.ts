import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { GenericCallView, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import path from "node:path";
import { papersearchHelp } from "./help";
import { downloadPaper, fetchPdf, searchSources, SOURCE_IDS, activeSourceIds } from "./registry";
import { safeFileFragment } from "./sources/adapter";
import { resolveSciHubPdfUrl, sciHubMirrors } from "./sources/sci_hub";
import { resolvePdfDir } from "./paths";
import { refreshSourceKeys } from "./keys";
import { fetchJobDetail, runFetchJob, startPapersearchJob, type FetchJobArgs } from "./jobs";
import { LineLog } from "./log-buffer";
import { presentSearchResult, searchMetaFromValue } from "./presentation";
import type { ConfigSource } from "./settings";

const jsonOutput = {
  schema: { type: "json" as const },
  render: (_args: unknown, value: JsonValue) =>
    [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
};

function present(title: string, kind: GenericCallView["kind"], rawInput?: unknown): GenericCallView {
  return { card: "generic", title, kind, ...(rawInput !== undefined ? { rawInput } : {}) };
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function sessionCwd(exec?: ToolRunContext): string | undefined {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd.trim() : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const DEFAULT_SEARCH_TIMEOUT_MS = 120_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000;
const MAX_FETCH_COUNT = 10;

function parseSources(raw: string | undefined): string[] | undefined {
  const value = asString(raw);
  if (!value) return undefined;
  const cleaned = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Deliverable handoff guidance for the fetched papers, nextStep house style. */
const FETCH_SYNC_NEXT_STEP =
  "Call okf_ingest with the downloaded paths (relative names resolve against the download dir) to compile them into the OKF library.";
const FETCH_BACKGROUND_NEXT_STEP =
  "You are notified in-session when the job finishes — do NOT poll in a loop; when genuinely blocked, call job_output once with wait=true and timeout_ms=600000 (the maximum). Then call okf_ingest on the downloaded paths from the job detail (relative names resolve against the download dir) to compile them into the OKF library.";

/** Route one long tool run through the ctx.jobs background seam unless the
 *  caller opted out; only the job id crosses the lossless-JSON tool boundary. */
async function maybeBackground(
  ctx: Context,
  exec: ToolRunContext,
  background: boolean | undefined,
  spec: Parameters<typeof startPapersearchJob>[2],
  runNow: (signal: AbortSignal) => Promise<unknown>,
): Promise<unknown> {
  if (background === false) {
    return runNow(exec.signal);
  }
  const started = startPapersearchJob(ctx, exec, spec);
  return { kind: "background", jobId: started.jobId, nextStep: FETCH_BACKGROUND_NEXT_STEP };
}

export function registerTools(ctx: Context, getConfig: ConfigSource): void {
  // Settings → runtime credentials: re-resolved before every tool execution
  // so a saved settings change or credential-store write takes effect on the
  // next call (mirrors the harness per-operation credential contract).
  const refreshKeys = (): Promise<void> => refreshSourceKeys(getConfig());
  const searchTimeout = (): number =>
    typeof getConfig().searchTimeoutMs === "number" && getConfig().searchTimeoutMs! > 0
      ? getConfig().searchTimeoutMs!
      : DEFAULT_SEARCH_TIMEOUT_MS;
  const downloadTimeout = (): number =>
    typeof getConfig().downloadTimeoutMs === "number" && getConfig().downloadTimeoutMs! > 0
      ? getConfig().downloadTimeoutMs!
      : DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const pdfDirFor = (exec?: ToolRunContext): string => resolvePdfDir(getConfig().pdfDir ?? "", sessionCwd(exec));

  // ── papersearch_help ─────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "papersearch_help",
    description:
      "Return the papersearch usage guide: the search → download → okf_ingest pipeline, source capabilities, and copy-paste example prompts. Call when the user asks 怎么用, 使用说明, or how to find/download papers.",
    parameters: {},
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute() {
      await refreshKeys();
      return asJson(papersearchHelp());
    },
    presentCall: () => present("Papersearch 使用说明", "read"),
  }));

  // ── papersearch_sources ──────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "papersearch_sources",
    description:
      "List the academic source connectors available to papersearch_search. Fast, no network calls. Key-gated sources (ieee, acm) appear only when their API key is configured.",
    parameters: {},
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute() {
      await refreshKeys();
      return asJson({
        sources: activeSourceIds(),
        hiddenWithoutKey: SOURCE_IDS.filter((id) => !activeSourceIds().includes(id)),
      });
    },
    presentCall: () => present("Papersearch sources", "read"),
  }));

  // ── papersearch_search ───────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "papersearch_search",
    description:
      "Search open academic sources (arXiv, PubMed, bioRxiv, medRxiv, Semantic Scholar, Crossref, OpenAlex, Europe PMC, PMC, dblp, Unpaywall) in parallel and return deduplicated paper cards: title, authors, year, DOI, pdf_url, citations, abstract digest. Use BEFORE okf work to discover literature. Call multiple times with varied phrasings; prefer targeted sources (e.g. 'arxiv,pubmed,semantic,crossref,openalex') over 'all'.",
    parameters: {
      query: { type: "string", required: true, description: "Search query — be specific; include key terms, not full sentences. For biorxiv/medrxiv use a category name like 'cell biology'." },
      sources: { type: "string", description: `Comma-separated source ids or omit for all (${SOURCE_IDS.join(", ")})` },
      maxResults: { type: "number", description: "Max results per source (default 5)" },
      year: { type: "string", description: "Year filter for Semantic Scholar, e.g. '2023' or '2020-2024'" },
    },
    output: {
      ...jsonOutput,
      presentationMeta: (_args, value) => searchMetaFromValue(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await refreshKeys();
      const query = asString(args.query);
      if (!query) throw new Error("papersearch_search: query is required");
      const maxResults = typeof args.maxResults === "number" && args.maxResults > 0
        ? Math.min(20, Math.floor(args.maxResults))
        : 5;
      const result = await searchSources({
        query,
        sources: parseSources(args.sources),
        maxResults,
        year: asString(args.year),
        signal: exec.signal,
        timeoutMs: searchTimeout(),
      });
      return asJson(result);
    },
    presentCall: (args) => present("Papersearch search", "search", args.query),
    presentResult: (args, result) => presentSearchResult(args, result),
  }));

  // ── papersearch_download ─────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "papersearch_download",
    description:
      "Download one paper PDF by source + paper_id into the OKF sources dir (OKF/sources/pdfs). After it returns, call okf_ingest with the path to compile the paper into the library. Idempotent: an existing file is reported as status 'exists' and not re-downloaded. When the source has no native PDF, the fallback chain tries open repositories (openaire/core/europepmc/pmc) by DOI/title and then the unpaywall OA resolver.",
    parameters: {
      source: { type: "string", required: true, description: "Source id, e.g. arxiv, biorxiv, semantic, pmc" },
      paperId: { type: "string", required: true, description: "Paper id as returned by papersearch_search (e.g. 2404.18021v2, a DOI, a PMID)" },
      dir: { type: "string", description: "Optional save dir. Default the OKF sources dir; relative paths resolve against it." },
      doi: { type: "string", description: "Optional DOI for the repository/unpaywall fallback when the source has no native PDF" },
      title: { type: "string", description: "Optional title for the repository fallback and the result manifest" },
    },
    output: jsonOutput,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await refreshKeys();
      const source = (asString(args.source) ?? "").toLowerCase();
      const paperId = asString(args.paperId);
      if (!source || !paperId) throw new Error("papersearch_download: source and paperId are required");

      const base = pdfDirFor(exec);
      const rawDir = asString(args.dir);
      const dir = rawDir
        ? path.isAbsolute(rawDir) ? path.normalize(rawDir) : path.resolve(base, rawDir)
        : base;

      const outcome = await downloadPaper(source, paperId, {
        dir,
        signal: exec.signal,
        timeoutMs: downloadTimeout(),
      }, { title: asString(args.title), doi: asString(args.doi) });
      return asJson({
        ...outcome,
        dir,
        nextStep: "Call okf_ingest with the downloaded path to compile it into the OKF library.",
      });
    },
    presentCall: (args) => present("Papersearch download", "execute", `${args.source}/${args.paperId}`),
  }));

  // ── papersearch_download_scihub ──────────────────────────────────
  ctx.tools.register(defineTool({
    name: "papersearch_download_scihub",
    description:
      "Download a paper PDF from Sci-Hub as a LAST-RESORT connector by DOI, title, PMID, or paper URL into the OKF sources dir (OKF/sources/pdfs). Sci-Hub mirrors host paywalled (copyrighted) papers, so only use this when the normal OA fallback chain in papersearch_download fails. Returns the saved path, or an error if the mirror cannot resolve the article (article not found / blocked / CAPTCHA).",
    parameters: {
      identifier: { type: "string", required: true, description: "DOI (preferred), title, PMID, or paper URL to look up on Sci-Hub" },
      dir: { type: "string", description: "Optional save dir. Default the OKF sources dir; relative paths resolve against it." },
      baseUrl: { type: "string", description: "Optional Sci-Hub mirror base URL (default: built-in mirror list, rotated; or the scihubBaseUrl setting)" },
    },
    output: jsonOutput,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await refreshKeys();
      const identifier = asString(args.identifier);
      if (!identifier) throw new Error("papersearch_download_scihub: identifier is required");

      const base = pdfDirFor(exec);
      const rawDir = asString(args.dir);
      const dir = rawDir
        ? path.isAbsolute(rawDir) ? path.normalize(rawDir) : path.resolve(base, rawDir)
        : base;
      const explicit = asString(args.baseUrl);
      const mirrors = explicit ? [explicit.replace(/\/+$/, "")] : undefined;
      const primary = explicit ?? sciHubMirrors()[0];

      const resolved = await resolveSciHubPdfUrl(identifier, {
        signal: exec.signal,
        timeoutMs: downloadTimeout(),
        mirrors,
      });
      if (!resolved) {
        return asJson({
          identifier,
          status: "failed",
          error: `Sci-Hub (${primary}) could not resolve a PDF for '${identifier}' — article not found, blocked, or CAPTCHA across the mirror list. Try another mirror via baseUrl or the scihubBaseUrl setting (comma-separated list supported).`,
          dir,
        });
      }

      const saved = await fetchPdf(resolved.url, dir, safeFileFragment(`scihub-${identifier}`), {
        signal: exec.signal,
        timeoutMs: downloadTimeout(),
      });
      return asJson({
        identifier,
        url: resolved.url,
        mirror: resolved.mirror,
        status: "downloaded",
        path: saved.path,
        bytes: saved.bytes,
        dir,
        nextStep: "Call okf_ingest with the downloaded path to compile it into the OKF library.",
      });
    },
    presentCall: (args) => present("Papersearch Sci-Hub download", "execute", args.identifier),
  }));

  // ── papersearch_fetch ────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "papersearch_fetch",
    description:
      "One-call discovery → download loop: run a multi-source search, then download the top N papers that have a working PDF source into the OKF sources dir (OKF/sources/pdfs). Long-running: defaults to a background job that returns a job id, with per-paper progress (downloaded/exists/failed + path) in the job output and the staged file names in the completion detail. You are notified in-session when it finishes — do NOT poll in a loop; when genuinely blocked, call job_output once with wait=true and timeout_ms=600000 (the maximum) instead of many short waits. background=false runs synchronously and returns the per-paper manifest (downloaded / exists / failed). Follow with okf_ingest on the downloaded paths to complete the OKF closed loop.",
    parameters: {
      query: { type: "string", required: true, description: "Search query — be specific" },
      sources: { type: "string", description: `Comma-separated source ids or omit for all (${SOURCE_IDS.join(", ")})` },
      maxResults: { type: "number", description: "Max search results per source (default 5)" },
      year: { type: "string", description: "Year filter for Semantic Scholar, e.g. '2023' or '2020-2024'" },
      count: { type: "number", description: "Papers to download (default 3, max 10)" },
      background: {
        type: "boolean",
        description:
          "Default true. Returns a job id immediately. You are notified in-session on completion — end the turn or do other work; when blocked, job_output with wait=true and timeout_ms=600000. job_kill cancels. false runs the whole search+download synchronously in this call.",
      },
    },
    output: jsonOutput,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const query = asString(args.query);
      if (!query) throw new Error("papersearch_fetch: query is required");
      const maxResults = typeof args.maxResults === "number" && args.maxResults > 0
        ? Math.min(20, Math.floor(args.maxResults))
        : 5;
      const count = typeof args.count === "number" && args.count > 0
        ? Math.min(MAX_FETCH_COUNT, Math.floor(args.count))
        : 3;
      const jobArgs: FetchJobArgs = {
        query,
        sources: parseSources(args.sources),
        maxResults,
        year: asString(args.year),
        count,
        dir: pdfDirFor(exec),
        searchTimeoutMs: searchTimeout(),
        downloadTimeoutMs: downloadTimeout(),
      };
      return asJson(await maybeBackground(
        ctx,
        exec,
        args.background,
        {
          label: `papersearch_fetch ${query}`,
          run: async (log, signal) => fetchJobDetail(await runFetchJob(jobArgs, refreshKeys, log, signal)),
        },
        async (signal) => {
          const log = new LineLog();
          const result = await runFetchJob(jobArgs, refreshKeys, log, signal);
          return { ...result, nextStep: FETCH_SYNC_NEXT_STEP };
        },
      ));
    },
    presentCall: (args) => present("Papersearch fetch", "execute", args.query),
  }));
}
