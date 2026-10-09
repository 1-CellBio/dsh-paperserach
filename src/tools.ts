import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { GenericCallView, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import { papersearchHelp } from "./help";
import { IdentityConflictError } from "./identity";
import { downloadPaper, fetchPdf, searchSources, SOURCE_IDS, activeSourceIds } from "./registry";
import { safeFileFragment } from "./sources/adapter";
import { resolveSciHubPdfUrl, sciHubMirrors } from "./sources/sci_hub";
import { confineDirToBase, resolvePdfDir } from "./paths";
import { bareDoi, extractDoi } from "./paper";
import { refreshSourceKeys, sciHubEnabled } from "./keys";
import { acquireJobDetail, fetchJobDetail, runAcquireJob, runFetchJob, startPapersearchJob, type AcquireJobArgs, type FetchJobArgs } from "./jobs";
import { LineLog } from "./log-buffer";
import { handOffStaged, ingestNextStep, stagedFiles } from "./staging";
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
const MAX_FETCH_COUNT = 50;
const MAX_ACQUIRE_COUNT = 50;

function parseSources(raw: string | undefined): string[] | undefined {
  const value = asString(raw);
  if (!value) return undefined;
  const cleaned = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** nextStep tails: what to do once the library holds the papers. */
const FETCH_TAIL = "then use okf_search / okf_get on the new papers.";
const ACQUIRE_TAIL = "then continue csw writing with okf_search / okf_get evidence.";
const DOWNLOAD_TAIL = "then use okf_search / okf_get on the new paper.";

/** nextStep for a background job: the staged PDFs are handed to okf for automatic ingest when the job finishes. */
const BACKGROUND_NEXT_STEP =
  "You are notified in-session when the job finishes — do NOT poll in a loop; when genuinely blocked, call job_output once with wait=true and timeout_ms=600000 (the maximum). "
  + "The staged PDFs are then handed to okf for automatic ingest: the completion detail names the ingest job — wait for that job's own completion notice and do NOT call okf_ingest on those files. "
  + "Only when the detail says ingest did not start, call okf_ingest on the downloaded paths from the detail (relative names resolve against the download dir).";

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
  return { kind: "background", jobId: started.jobId, nextStep: BACKGROUND_NEXT_STEP };
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
      "Return the papersearch usage guide: the search → download → automatic okf ingest pipeline, source capabilities, and copy-paste example prompts. Call when the user asks 怎么用, 使用说明, or how to find/download papers.",
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
      maxResults: { type: "number", description: "Max results per source (default 5, max 50)" },
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
        ? Math.min(50, Math.floor(args.maxResults))
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
      "Download one paper PDF by source + paper_id into the OKF sources dir (OKF/sources/pdfs). The saved PDF is handed to okf for automatic ingest (okf's autoIngest setting, on by default): the result's `ingest` field names the ingest job — do NOT call okf_ingest on that file again; call okf_ingest yourself only when `ingest` is absent or says not-started. Idempotent: an existing file whose sha256 matches its .meta.json sidecar is reported as status 'exists' and not re-downloaded; changed bytes are overwritten and reported 'replaced' (every save writes a provenance sidecar: sha256, doi, sourceUrl, retrievedAt, identity). A DOI the OKF library already covers is reported as status 'in-library' (libraryPaper = the Paper page) with no download. When the source has no native PDF, the fallback chain tries open repositories (openaire/core/europepmc/pmc) by DOI first — a DOI-verified hit stops the chain — then the unpaywall OA resolver; a repository match found by title only is saved too (identity title-fallback; a title hit can be a different paper, which okf_ingest flags afterwards as identityMismatch) unless the allowTitleMatch setting is off. A payload whose bytes are already stored under a different DOI is refused (identityConflict) — never saved.",
    parameters: {
      source: { type: "string", required: true, description: "Source id, e.g. arxiv, biorxiv, semantic, pmc" },
      paperId: { type: "string", required: true, description: "Paper id as returned by papersearch_search (e.g. 2404.18021v2, a DOI, a PMID)" },
      dir: { type: "string", description: "Optional save dir, confined to the OKF sources dir: relative paths resolve against it; absolute paths and .. escapes are rejected (move the root via the pdfDir setting)." },
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
      const dir = rawDir ? confineDirToBase(base, rawDir) : base;

      const outcome = await downloadPaper(source, paperId, {
        dir,
        signal: exec.signal,
        timeoutMs: downloadTimeout(),
      }, { title: asString(args.title), doi: asString(args.doi) });
      const ingest = await handOffStaged(ctx, exec, "papersearch_download", [outcome]);
      return asJson({
        ...outcome,
        dir,
        ...(ingest !== undefined ? { ingest } : {}),
        nextStep: ingestNextStep(stagedFiles([outcome]).length, ingest, DOWNLOAD_TAIL),
      });
    },
    presentCall: (args) => present("Papersearch download", "execute", `${args.source}/${args.paperId}`),
  }));

  // ── papersearch_download_scihub ──────────────────────────────────
  ctx.tools.register(defineTool({
    name: "papersearch_download_scihub",
    description:
      "Download a paper PDF from Sci-Hub as a LAST-RESORT connector by DOI, title, PMID, or paper URL into the OKF sources dir (OKF/sources/pdfs). Obeys the useScihub setting (default on; when an installation turns it off this tool returns status \"disabled\"). Sci-Hub mirrors host paywalled (copyrighted) papers, so only use this when the normal OA fallback chain in papersearch_download fails. The saved PDF is handed to okf for automatic ingest like papersearch_download (see the result's `ingest` field). Returns the saved path, or an error if the mirror cannot resolve the article (article not found / blocked / CAPTCHA).",
    parameters: {
      identifier: { type: "string", required: true, description: "DOI (preferred), title, PMID, or paper URL to look up on Sci-Hub" },
      dir: { type: "string", description: "Optional save dir, confined to the OKF sources dir: relative paths resolve against it; absolute paths and .. escapes are rejected (move the root via the pdfDir setting)." },
      baseUrl: { type: "string", description: "Optional Sci-Hub mirror base URL (default: built-in mirror list, rotated; or the scihubBaseUrl setting)" },
    },
    output: jsonOutput,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      await refreshKeys();
      const identifier = asString(args.identifier);
      if (!identifier) throw new Error("papersearch_download_scihub: identifier is required");
      if (!sciHubEnabled()) {
        return asJson({
          identifier,
          status: "disabled",
          error: "Sci-Hub is disabled on this installation (useScihub is off). This tool obeys the same switch as the fallback chain.",
          hint: "Use papersearch_download / papersearch_acquire (open-access sources only), or ask the user to enable useScihub in the papersearch settings.",
        });
      }

      const base = pdfDirFor(exec);
      const rawDir = asString(args.dir);
      const dir = rawDir ? confineDirToBase(base, rawDir) : base;
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

      let saved: { path: string; bytes: number };
      try {
        saved = await fetchPdf(resolved.url, dir, safeFileFragment(`scihub-${identifier}`), {
          signal: exec.signal,
          timeoutMs: downloadTimeout(),
          meta: {
            doi: extractDoi(identifier),
            source: "scihub",
            sourceUrl: resolved.url,
            identity: "scihub",
          },
        });
      } catch (error) {
        if (!(error instanceof IdentityConflictError)) throw error;
        return asJson({ identifier, status: "failed", identityConflict: error.message, error: error.message, dir });
      }
      const ingest = await handOffStaged(ctx, exec, "papersearch_download_scihub", [
        { source: "scihub", paperId: identifier, status: "downloaded", path: saved.path, bytes: saved.bytes },
      ]);
      return asJson({
        identifier,
        url: resolved.url,
        mirror: resolved.mirror,
        status: "downloaded",
        path: saved.path,
        bytes: saved.bytes,
        dir,
        ...(ingest !== undefined ? { ingest } : {}),
        nextStep: ingestNextStep(1, ingest, DOWNLOAD_TAIL),
      });
    },
    presentCall: (args) => present("Papersearch Sci-Hub download", "execute", args.identifier),
  }));

  // ── papersearch_fetch ────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "papersearch_fetch",
    description:
      "One-call discovery → download loop: run a multi-source search, then download the top N papers that have a working PDF source into the OKF sources dir (OKF/sources/pdfs). Long-running: defaults to a background job that returns a job id, with per-paper progress (downloaded/replaced/exists/failed + path) in the job output and the staged file names in the completion detail. You are notified in-session when it finishes — do NOT poll in a loop; when genuinely blocked, call job_output once with wait=true and timeout_ms=600000 (the maximum) instead of many short waits. background=false runs synchronously and returns the per-paper manifest (downloaded / replaced / exists / failed). Statuses also include in-library (the library already covers that DOI — nothing fetched). The downloaded PDFs are handed to okf for automatic ingest when the run ends (sync: the result's `ingest` field; background: the completion detail names the ingest job) — do NOT call okf_ingest on them again; call it yourself only when ingest did not start.",
    parameters: {
      query: { type: "string", required: true, description: "Search query — be specific" },
      sources: { type: "string", description: `Comma-separated source ids or omit for all (${SOURCE_IDS.join(", ")})` },
      maxResults: { type: "number", description: "Max search results per source (default 5, max 50)" },
      year: { type: "string", description: "Year filter for Semantic Scholar, e.g. '2023' or '2020-2024'" },
      count: { type: "number", description: "Papers to download (default 3, max 50)" },
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
        ? Math.min(50, Math.floor(args.maxResults))
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
          run: async (log, signal) => {
            const result = await runFetchJob(jobArgs, refreshKeys, log, signal);
            const ingest = signal.aborted ? undefined : await handOffStaged(ctx, exec, "papersearch_fetch", result.results, log);
            return fetchJobDetail(result, ingest);
          },
        },
        async (signal) => {
          const log = new LineLog();
          const result = await runFetchJob(jobArgs, refreshKeys, log, signal);
          const ingest = await handOffStaged(ctx, exec, "papersearch_fetch", result.results, log);
          return {
            ...result,
            ...(ingest !== undefined ? { ingest } : {}),
            nextStep: ingestNextStep(stagedFiles(result.results).length, ingest, FETCH_TAIL),
          };
        },
      ));
    },
    presentCall: (args) => present("Papersearch fetch", "execute", args.query),
  }));

  // ── papersearch_acquire ──────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "papersearch_acquire",
    description:
      "Batch-acquire full-text PDFs by DOI into the OKF sources dir (OKF/sources/pdfs). Each DOI is resolved through a DOI-anchored chain: Semantic Scholar's openAccessPdf first, then open repositories (openaire/core/europepmc/pmc) + the unpaywall OA resolver, then Sci-Hub as the last resort (on by default; skipped when the installation turns useScihub off — the job log states whether it was consulted). THE full-text acquisition step after csw_research / csw_deep_research / papersearch_search hands you DOIs — acquiring full text BEFORE writing is what lets okf_ingest extract citable claims (abstract-only records starve the evidence gates). Long-running: defaults to a background job that returns a job id, with per-DOI progress in the job output and the staged file names + unresolvable DOIs in the completion detail. A DOI that yields no PDF carries a diagnosis (located-but-blocked / inconclusive / no-open-access-copy, plus what each step answered): only no-open-access-copy means a paywall — relay inconclusive and located-but-blocked results to the user as they are, with the settings or manual download they name. You are notified in-session when it finishes — do NOT poll in a loop; when genuinely blocked, call job_output once with wait=true and timeout_ms=600000 (the maximum). background=false runs synchronously and returns the per-DOI manifest. DOIs the OKF library already covers are answered status 'in-library' (libraryPaper = papers/…) without any download — use that paper through okf_search / okf_get instead of re-acquiring it. A payload whose bytes are already stored under a different DOI is refused (identityConflict) — one of the two DOIs is not this document. The staged PDFs are handed to okf for automatic ingest when the run ends (sync: the result's `ingest` field; background: the completion detail names the ingest job) — do NOT call okf_ingest on them again; call it yourself only when ingest did not start. Then okf_search / csw writing.",
    parameters: {
      dois: { type: "array", items: { type: "string" }, required: true, description: `DOIs to acquire (bare or https://doi.org/… form; deduplicated, max ${MAX_ACQUIRE_COUNT} per call)` },
      dir: { type: "string", description: "Optional save dir, confined to the OKF sources dir: relative paths resolve against it; absolute paths and .. escapes are rejected (move the root via the pdfDir setting)." },
      background: {
        type: "boolean",
        description:
          "Default true. Returns a job id immediately. You are notified in-session on completion — end the turn or do other work; when blocked, job_output with wait=true and timeout_ms=600000. job_kill cancels. false runs the whole batch synchronously in this call.",
      },
    },
    output: jsonOutput,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const raw = Array.isArray(args.dois) ? args.dois : [];
      const seen = new Set<string>();
      const dois: string[] = [];
      for (const item of raw) {
        const doi = typeof item === "string" ? bareDoi(item).toLowerCase() : "";
        if (!doi || seen.has(doi)) continue;
        seen.add(doi);
        dois.push(doi);
        if (dois.length >= MAX_ACQUIRE_COUNT) break;
      }
      if (dois.length === 0) throw new Error("papersearch_acquire: dois must contain at least one valid DOI");

      const base = pdfDirFor(exec);
      const rawDir = asString(args.dir);
      const dir = rawDir ? confineDirToBase(base, rawDir) : base;

      const jobArgs: AcquireJobArgs = {
        dois,
        dir,
        downloadTimeoutMs: downloadTimeout(),
      };
      return asJson(await maybeBackground(
        ctx,
        exec,
        args.background,
        {
          label: `papersearch_acquire ${dois.length} DOI(s)`,
          run: async (log, signal) => {
            const result = await runAcquireJob(jobArgs, refreshKeys, log, signal);
            const ingest = signal.aborted ? undefined : await handOffStaged(ctx, exec, "papersearch_acquire", result.results, log);
            return acquireJobDetail(result, ingest);
          },
        },
        async (signal) => {
          const log = new LineLog();
          const result = await runAcquireJob(jobArgs, refreshKeys, log, signal);
          const ingest = await handOffStaged(ctx, exec, "papersearch_acquire", result.results, log);
          return {
            ...result,
            ...(ingest !== undefined ? { ingest } : {}),
            nextStep: ingestNextStep(stagedFiles(result.results).length, ingest, ACQUIRE_TAIL),
          };
        },
      ));
    },
    presentCall: (args) => present("Papersearch acquire", "execute", `${Array.isArray(args.dois) ? args.dois.length : 0} DOI(s)`),
  }));
}
