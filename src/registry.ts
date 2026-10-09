import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fetchWithRetry, getJson, HttpError, USER_AGENT } from "./http";
import {
  findSha256Conflict,
  IdentityConflictError,
  loadLibraryDoiIndex,
  normalizeDoi,
  sidecarScanDirs,
  withStoreLock,
} from "./identity";
import { currentSourceKeys, sciHubEnabled, titleMatchAllowed } from "./keys";
import { bareDoi, compactSearchResult, extractDoi, type CompactSearchResult, type Paper } from "./paper";
import { resolvePmcOpenDataPdfUrl } from "./sources/pmc_open_data";
import { arxivSource } from "./sources/arxiv";
import { baseSource } from "./sources/base";
import { biorxivSource, medrxivSource } from "./sources/biorxiv";
import { citeseerxSource } from "./sources/citeseerx";
import { coreSource } from "./sources/core";
import { crossrefSource } from "./sources/crossref";
import { dblpSource } from "./sources/dblp";
import { doajSource } from "./sources/doaj";
import { europepmcSource } from "./sources/europepmc";
import { googleScholarSource } from "./sources/google_scholar";
import { halSource } from "./sources/hal";
import { iacrSource } from "./sources/iacr";
import { openaireSource } from "./sources/openaire";
import { openalexSource } from "./sources/openalex";
import { pmcSource } from "./sources/pmc";
import { pubmedSource } from "./sources/pubmed";
import { semanticSource } from "./sources/semantic";
import { ssrnSource } from "./sources/ssrn";
import { unpaywallSource, unpaywallConfigured, resolveOaPdfUrl } from "./sources/unpaywall";
import { resolveSciHubPdfUrl } from "./sources/sci_hub";
import { zenodoSource } from "./sources/zenodo";
import { acmSource } from "./sources/acm";
import { ieeeSource } from "./sources/ieee";
import { safeFileFragment, type SourceAdapter } from "./sources/adapter";

/** All registered source adapters, in catalog order (mirrors the upstream
 * 21-source catalog plus the key-gated ieee/acm connectors, pure TypeScript). */
export const SOURCES: SourceAdapter[] = [
  arxivSource,
  pubmedSource,
  biorxivSource,
  medrxivSource,
  googleScholarSource,
  iacrSource,
  semanticSource,
  crossrefSource,
  openalexSource,
  pmcSource,
  coreSource,
  europepmcSource,
  dblpSource,
  openaireSource,
  citeseerxSource,
  doajSource,
  baseSource,
  zenodoSource,
  halSource,
  ssrnSource,
  unpaywallSource,
  ieeeSource,
  acmSource,
];

export const SOURCE_IDS = SOURCES.map((source) => source.id);

/** Sources usable right now: ieee/acm appear only when their API key is
 * configured (upstream gating contract — without a key they are absent
 * from the default 'all' set rather than erroring). */
export function activeSourceIds(): string[] {
  const keys = currentSourceKeys();
  return SOURCES
    .filter((source) => {
      if (source.id === "ieee") return Boolean(keys.ieeeApiKey);
      if (source.id === "acm") return Boolean(keys.acmApiKey);
      return true;
    })
    .map((source) => source.id);
}

export interface SearchOptions {
  query: string;
  sources?: string[];
  maxResults?: number;
  year?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Concurrent multi-source search; per-source failures land in errors. */
export async function searchSources(options: SearchOptions): Promise<CompactSearchResult> {
  const query = options.query.trim();
  const requested = (options.sources ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  // Default (no sources given) runs the active set; an explicit request is
  // honored literally so asking for ieee without a key surfaces a clear
  // per-source error instead of silence.
  const active = new Set(activeSourceIds());
  const selected = SOURCES.filter(
    (source) => requested.length === 0 ? active.has(source.id) : requested.includes(source.id),
  );
  const maxResults = Math.max(1, Math.min(50, options.maxResults ?? 5));

  const settled = await Promise.all(
    selected.map(async (source) => {
      try {
        const papers = await source.search({
          query,
          maxResults,
          year: options.year,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        });
        return { ok: true as const, papers };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false as const, message };
      }
    }),
  );

  const papers: Paper[][] = [];
  const errors: Record<string, string> = {};
  selected.forEach((source, index) => {
    const result = settled[index]!;
    if (result.ok) {
      papers.push(result.papers);
    } else {
      papers.push([]);
      errors[source.id] = result.message;
    }
  });

  return compactSearchResult(
    query,
    selected.map((source) => source.id),
    papers,
    errors,
  );
}

export interface DownloadOutcome {
  source: string;
  paperId: string;
  /** downloaded = new file; exists = sidecar-verified unchanged file;
   * replaced = a differing (or unverifiable) file was overwritten;
   * in-library = the OKF library already holds a Paper page for this DOI, so
   * nothing was fetched (see `libraryPaper`). */
  status: "downloaded" | "exists" | "replaced" | "in-library" | "failed";
  path?: string;
  bytes?: number;
  title?: string;
  doi?: string;
  error?: string;
  /** Provenance identity of the saved file (downloaded / replaced only). */
  identity?: DownloadIdentity;
  /** in-library only: the covering Paper page, relative to the OKF library root. */
  libraryPaper?: string;
  /** Set when a candidate was refused because its bytes are already stored
   * under a different DOI (the message names the stored file). */
  identityConflict?: string;
  /** Candidates dropped because they matched by title only and the
   * allowTitleMatch setting is off. */
  titleMatchSkipped?: number;
  /** failed DOI acquisitions only: what each step of the chain answered. */
  diagnosis?: AcquisitionDiagnosis;
}

/** One consulted step of the DOI acquisition chain. */
export interface AcquisitionStage {
  stage: "semantic-scholar" | "repositories" | "unpaywall" | "sci-hub" | "download";
  /** candidate — produced a PDF link; none — answered and holds no open-access copy;
   * unavailable — could not answer (HTTP error, timeout, rate limit) or its link could not be fetched;
   * unconfigured — not queried because a required setting is missing; off — deliberately disabled. */
  result: "candidate" | "none" | "unavailable" | "unconfigured" | "off";
  detail?: string;
}

/** Why a DOI acquisition failed, in terms the user can act on. */
export interface AcquisitionDiagnosis {
  /** located-but-blocked — an open-access link existed but no PDF could be fetched from it;
   * inconclusive — a step could not answer, so a paywall is not established;
   * no-open-access-copy — every consulted step answered and none holds an open copy. */
  verdict: "located-but-blocked" | "inconclusive" | "no-open-access-copy";
  stages: AcquisitionStage[];
  /** Concrete next steps (settings to fill in, manual download route). */
  hints: string[];
}

/** Provenance identity of a saved PDF — how strongly the delivered bytes are
 * tied to the requested paper. Decided by the registry when the winning URL
 * is picked, never invented by an adapter:
 *   doi-url               — the source's own resolution of a DOI-bearing card,
 *                           or a repository hit whose DOI equals the request
 *   repository-unverified — repository/card/native URL without a DOI cross-check
 *   title-fallback        — repository hit matched by title only
 *   scihub                — Sci-Hub mirror
 *   unknown               — provenance not recorded (legacy files predating
 *                           sidecars, bare fetchPdf callers) */
export type DownloadIdentity = "doi-url" | "repository-unverified" | "title-fallback" | "scihub" | "unknown";

/** `<name>.pdf.meta.json` — the sidecar written next to every fetched PDF.
 * Lets a later download tell "same paper, unchanged bytes" (exists) from
 * "same file name, changed payload" (replaced). */
export interface DownloadSidecar {
  /** SHA-256 over the full file bytes, lowercase hex — the same digest as
   * dsh-okf's pipeline/hash.ts sha256Hex (crypto.subtle over all bytes). */
  sha256: string;
  bytes: number;
  doi: string;
  title: string;
  source: string;
  sourceUrl: string;
  /** ISO timestamp of the successful fetch. */
  retrievedAt: string;
  identity: DownloadIdentity;
}

/** Provenance fields the caller supplies to fetchPdf; the digest, size and
 * timestamp come from the payload itself. */
export interface SidecarMeta {
  doi?: string;
  title?: string;
  source?: string;
  sourceUrl?: string;
  identity: DownloadIdentity;
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function sidecarPathOf(pdfPath: string): string {
  return `${pdfPath}.meta.json`;
}

/** Read a sidecar; a missing or corrupt file (and any digest that is not a
 * 64-char hex string) yields undefined so the caller treats the PDF as
 * unverified rather than trusting garbage. */
async function readSidecar(pdfPath: string): Promise<DownloadSidecar | undefined> {
  let parsed: Partial<DownloadSidecar>;
  try {
    parsed = JSON.parse(await readFile(sidecarPathOf(pdfPath), "utf8")) as Partial<DownloadSidecar>;
  } catch {
    return undefined;
  }
  if (typeof parsed.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(parsed.sha256)) return undefined;
  return {
    sha256: parsed.sha256,
    bytes: typeof parsed.bytes === "number" ? parsed.bytes : 0,
    doi: parsed.doi ?? "",
    title: parsed.title ?? "",
    source: parsed.source ?? "",
    sourceUrl: parsed.sourceUrl ?? "",
    retrievedAt: parsed.retrievedAt ?? "",
    identity: parsed.identity ?? "unknown",
  };
}

async function writeSidecar(pdfPath: string, sidecar: DownloadSidecar): Promise<void> {
  await writeFile(sidecarPathOf(pdfPath), `${JSON.stringify(sidecar, null, 2)}\n`);
}

async function sha256OfFile(pdfPath: string): Promise<string> {
  return sha256Hex(await readFile(pdfPath));
}

export interface DownloadOptions {
  dir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Enable the unpaywall DOI fallback (needs contact email configured). */
  allowFallback?: boolean;
  /** Normalized DOI → Paper page of the OKF library (see loadLibraryDoiIndex).
   * A DOI found here is answered `in-library` without any network call.
   * downloadAll / acquireByDoi load it once per batch when absent. */
  libraryIndex?: ReadonlyMap<string, string>;
}

/** The `in-library` outcome when the library already covers `doi`, else undefined. */
function inLibraryOutcome(
  outcome: DownloadOutcome,
  doi: string,
  index: ReadonlyMap<string, string> | undefined,
): DownloadOutcome | undefined {
  const page = doi ? index?.get(normalizeDoi(doi)) : undefined;
  if (page === undefined) return undefined;
  outcome.status = "in-library";
  outcome.libraryPaper = page;
  return outcome;
}

/** Drop repeated links (several stages often offer the same PDF; a failing link would otherwise
 * be retried once per stage) and, when the allowTitleMatch setting is off, title-only
 * candidates; the title-only count lands on the outcome so a failure can say why. The first
 * occurrence of a link keeps its place and identity. */
function admitCandidates(
  candidates: Array<{ url: string; identity: DownloadIdentity }>,
  outcome: DownloadOutcome,
): Array<{ url: string; identity: DownloadIdentity }> {
  const seen = new Set<string>();
  const distinct = candidates.filter((candidate) => !seen.has(candidate.url) && seen.add(candidate.url));
  if (titleMatchAllowed()) return distinct;
  const kept = distinct.filter((candidate) => candidate.identity !== "title-fallback");
  if (kept.length < distinct.length) outcome.titleMatchSkipped = distinct.length - kept.length;
  return kept;
}

/** Name the sources a failed fallback chain actually consulted: Sci-Hub is listed only when `useScihub` is enabled (the default). */
function consultedSources(open: readonly string[]): string {
  const names = sciHubEnabled() ? [...open, "Sci-Hub"] : [...open];
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}

/** Append the identity facts (byte conflict, skipped title-only hits) to a failure message. */
function withIdentityNotes(message: string, outcome: DownloadOutcome): string {
  const notes: string[] = [];
  if (outcome.identityConflict) notes.push(outcome.identityConflict);
  if (outcome.titleMatchSkipped) {
    notes.push(
      `${outcome.titleMatchSkipped} title-only candidate(s) skipped because the allowTitleMatch setting is off — `
        + "a title hit can be a different paper; turn the setting back on to try them (okf_ingest flags a DOI mismatch afterwards)",
    );
  }
  return notes.length > 0 ? `${message}; ${notes.join("; ")}` : message;
}

/** Resolve a download target for source+id, with the unpaywall fallback for
 * sources without native PDFs (or when a native lookup fails). */
async function resolveTarget(
  source: SourceAdapter,
  paperId: string,
  options: DownloadOptions,
): Promise<{ url: string; baseName: string; via: string }> {
  if (source.download) {
    const target = await source.download(paperId, { signal: options.signal, timeoutMs: options.timeoutMs });
    return { ...target, via: source.id };
  }
  return { url: "", baseName: "", via: source.id };
}

/** Open repositories consulted (in order) when a source cannot serve the
 * PDF itself — the upstream `_try_repository_fallback` chain. */
export const REPOSITORY_FALLBACK_IDS = ["openaire", "core", "europepmc", "pmc"] as const;

const REPOSITORY_SEARCH_TIMEOUT_MS = 30_000;
const REPOSITORY_MAX_CANDIDATES = 3;

/** One repository-fallback candidate: a direct PDF link plus how well it is
 * anchored to the requested paper. */
export interface RepositoryCandidate {
  url: string;
  identity: "doi-url" | "title-fallback";
}

/** PMC id of a repository hit that carries one (PMC adapter: numeric paperId; Europe PMC: the article url). */
function pmcidOf(paper: Paper): string | undefined {
  if (paper.source === "pmc" && /^\d+$/.test(paper.paperId)) return `PMC${paper.paperId}`;
  const match = paper.source === "europepmc" ? /\/article\/PMC\/(\d+)/.exec(paper.url) : null;
  return match ? `PMC${match[1]}` : undefined;
}

/** What one repository answered to one query (reported through collectRepositoryCandidates' onSource). */
export interface RepositoryProbe {
  source: string;
  ok: boolean;
  /** Failure description when !ok. */
  detail?: string;
}

/** Query the open repositories and collect candidate PDF links, DOI matches
 * first. The DOI phase keeps only results whose DOI equals the requested one
 * (normalized, case-insensitive); when it yields at least one hit the title
 * query never runs, so a verified link is never crowded out of the pool by
 * weaker ones. Only when the DOI phase comes up empty does the title phase
 * fill the pool. The global total stays capped at 3 candidates. Failures
 * are swallowed — the chain simply shrinks. */
export async function collectRepositoryCandidates(
  sources: readonly SourceAdapter[],
  identifiers: { doi?: string; title?: string },
  options: { signal?: AbortSignal; timeoutMs?: number; onSource?: (probe: RepositoryProbe) => void } = {},
): Promise<RepositoryCandidate[]> {
  const doi = bareDoi(identifiers.doi).toLowerCase();
  const title = identifiers.title?.trim();
  if (!doi && !title) return [];

  const out: RepositoryCandidate[] = [];
  const timeoutMs = Math.min(options.timeoutMs ?? REPOSITORY_SEARCH_TIMEOUT_MS, REPOSITORY_SEARCH_TIMEOUT_MS);
  const roomLeft = (): boolean => out.length < REPOSITORY_MAX_CANDIDATES;
  /** Pool a link unless it is already pooled (Europe PMC and the PMC adapter often offer the same bucket PDF). */
  const pool = (url: string, identity: RepositoryCandidate["identity"]): void => {
    if (roomLeft() && !out.some((candidate) => candidate.url === url)) out.push({ url, identity });
  };
  /** The PMC Open Access bucket PDF of a DOI-verified PMC hit (failures are reported, never thrown). */
  const bucketPdfUrl = async (paper: Paper): Promise<string | undefined> => {
    const pmcid = pmcidOf(paper);
    if (pmcid === undefined) return undefined;
    try {
      const url = await resolvePmcOpenDataPdfUrl(pmcid, { signal: options.signal, timeoutMs });
      options.onSource?.({ source: "pmc-open-data", ok: true });
      return url;
    } catch (error) {
      options.onSource?.({ source: "pmc-open-data", ok: false, detail: describeFailure(error) });
      return undefined;
    }
  };

  if (doi) {
    for (const source of sources) {
      if (!roomLeft()) break;
      let papers: Paper[] = [];
      try {
        papers = await source.search({ query: doi, maxResults: 3, signal: options.signal, timeoutMs });
        options.onSource?.({ source: source.id, ok: true });
      } catch (error) {
        // repository unavailable — try the next one
        options.onSource?.({ source: source.id, ok: false, detail: describeFailure(error) });
        continue;
      }
      for (const paper of papers) {
        if (!roomLeft()) break;
        // A DOI-phase hit only counts when the result's own DOI matches the
        // request — anything else is exactly the misidentification this
        // reorder exists to prevent, so it is dropped rather than pooled.
        if (bareDoi(paper.doi).toLowerCase() !== doi) continue;
        const bucketUrl = await bucketPdfUrl(paper);
        if (bucketUrl) pool(bucketUrl, "doi-url");
        if (paper.pdfUrl?.startsWith("http")) pool(paper.pdfUrl, "doi-url");
      }
    }
  }

  if (out.length === 0 && title) {
    for (const source of sources) {
      if (!roomLeft()) break;
      try {
        const papers = await source.search({ query: title, maxResults: 3, signal: options.signal, timeoutMs });
        options.onSource?.({ source: source.id, ok: true });
        for (const paper of papers) {
          if (!roomLeft()) break;
          if (!paper.pdfUrl?.startsWith("http")) continue;
          // A title-phase hit that nevertheless carries the requested DOI is
          // a verified match, not a fallback.
          const verified = Boolean(doi) && bareDoi(paper.doi).toLowerCase() === doi;
          const bucketUrl = verified ? await bucketPdfUrl(paper) : undefined;
          if (bucketUrl) pool(bucketUrl, "doi-url");
          pool(paper.pdfUrl, verified ? "doi-url" : "title-fallback");
        }
      } catch (error) {
        // repository unavailable — try the next one
        options.onSource?.({ source: source.id, ok: false, detail: describeFailure(error) });
      }
    }
  }
  return out;
}

function repositoryAdapters(): SourceAdapter[] {
  const byId = new Map(SOURCES.map((source) => [source.id, source]));
  return REPOSITORY_FALLBACK_IDS
    .map((id) => byId.get(id))
    .filter((source): source is SourceAdapter => Boolean(source));
}

/** Stream a PDF from `url` into `dir/<baseName>.pdf` and record the
 * provenance sidecar. The request rides the shared retry/cooldown layer so a
 * transient 429/503 retries THIS url instead of letting the caller slide to
 * a lower-identity fallback. The %PDF- magic is mandatory (content-type is a
 * diagnostic signal only, never a pass); the write is atomic — payload lands
 * in a unique `<name>.pdf.<pid>-<uuid>.part` first, then renames, so
 * concurrent downloads of the same paper (a background fetch job racing a
 * foreground download) never share an inode. */
export async function fetchPdf(
  url: string,
  dir: string,
  baseName: string,
  options: { signal?: AbortSignal; timeoutMs?: number; meta?: SidecarMeta } = {},
): Promise<{ path: string; bytes: number }> {
  // PDF payloads are large and slow hosts stall — keep fetchPdf's generous
  // default timeout rather than the JSON layer's 30s.
  const response = await fetchWithRetry(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/pdf,*/*" },
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 300_000,
  });
  if (!response.ok) throw new HttpError(response.status, url);
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength < 1024) {
    throw new Error(`not a PDF (${buffer.byteLength} bytes, content-type ${contentType || "unknown"})`);
  }
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error(`not a PDF (content-type ${contentType || "unknown"}, missing %PDF- magic)`);
  }
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeFileFragment(baseName)}.pdf`);
  const digest = sha256Hex(buffer);
  // The conflict scan and the writes are one critical section: two concurrent
  // downloads of identical bytes must not both pass the scan before either
  // sidecar exists.
  return withStoreLock(async () => {
    const requestedDoi = options.meta?.doi ?? "";
    if (requestedDoi) {
      const conflict = await findSha256Conflict(sidecarScanDirs(dir), digest, requestedDoi, sidecarPathOf(file));
      if (conflict) throw new IdentityConflictError(normalizeDoi(requestedDoi), conflict.doi, conflict.file);
    }
    // Unique tmp name: same dir keeps the rename on one filesystem (atomic),
    // pid+uuid keeps concurrent writers off each other's inode.
    const part = `${file}.${process.pid}-${randomUUID()}.part`;
    try {
      await writeFile(part, buffer);
      await rename(part, file);
    } catch (error) {
      await rm(part, { force: true }).catch(() => {});
      throw error;
    }
    await writeSidecar(file, {
      sha256: digest,
      bytes: buffer.byteLength,
      doi: requestedDoi,
      title: options.meta?.title ?? "",
      source: options.meta?.source ?? "",
      sourceUrl: options.meta?.sourceUrl ?? url,
      retrievedAt: new Date().toISOString(),
      identity: options.meta?.identity ?? "unknown",
    });
    return { path: file, bytes: buffer.byteLength };
  });
}

/** Download one paper by source + id. Idempotent — "exists" is only reported
 * when the on-disk file's digest matches its sidecar (same paper, unchanged
 * bytes); a hash mismatch or a legacy file without a sidecar is re-downloaded,
 * overwritten and reported "replaced". Per-paper failures are returned, never
 * thrown (except abort). */
export async function downloadPaper(
  sourceId: string,
  paperId: string,
  options: DownloadOptions,
  metadata: { title?: string; doi?: string; pdfUrl?: string } = {},
): Promise<DownloadOutcome> {
  const source = SOURCES.find((s) => s.id === sourceId);
  const outcome: DownloadOutcome = {
    source: sourceId,
    paperId,
    status: "failed",
    title: metadata.title,
    doi: metadata.doi,
  };
  if (!source) {
    outcome.error = `unknown source ${sourceId} (available: ${SOURCE_IDS.join(", ")})`;
    return outcome;
  }

  const fragment = safeFileFragment(`${sourceId}-${paperId}`);
  const expected = path.join(options.dir, `${fragment}.pdf`);
  const doi = metadata.doi?.trim() || extractDoi(paperId);
  const covered = inLibraryOutcome(outcome, doi, options.libraryIndex);
  if (covered) return covered;
  let destinationTaken = false;
  try {
    const info = await stat(expected);
    if (info.isFile()) {
      destinationTaken = true;
      const sidecar = await readSidecar(expected);
      if (sidecar && sidecar.sha256 === (await sha256OfFile(expected))) {
        outcome.status = "exists";
        outcome.path = expected;
        outcome.bytes = info.size;
        return outcome;
      }
      // Differing bytes, or a legacy file with no verifiable sidecar
      // (identity "unknown"): fall through, overwrite, rewrite the sidecar.
      // The stale file is never deleted outright — the rename replaces it.
    }
  } catch {
    // not present — proceed
  }

  const candidates: Array<{ url: string; identity: DownloadIdentity }> = [];
  try {
    const target = await resolveTarget(source, paperId, options);
    // The source resolved its own id — with a DOI-bearing card the link is
    // DOI-anchored; without one it is still source-vouched but unverified.
    if (target.url) candidates.push({ url: target.url, identity: doi ? "doi-url" : "repository-unverified" });
  } catch (error) {
    // fall through to pdfUrl / repositories / unpaywall below
    void error;
  }
  if (metadata.pdfUrl?.startsWith("http")) candidates.push({ url: metadata.pdfUrl, identity: "repository-unverified" });
  if (options.allowFallback !== false) {
    // open repositories by DOI/title first (upstream order), then unpaywall
    const title = metadata.title?.trim();
    if (doi || title) {
      const repositoryUrls = await collectRepositoryCandidates(
        repositoryAdapters(),
        { doi, title },
        { signal: options.signal, timeoutMs: options.timeoutMs },
      );
      candidates.push(...repositoryUrls);
    }
    if (doi) {
      try {
        const fallback = await resolveOaPdfUrl(doi, { signal: options.signal, timeoutMs: options.timeoutMs });
        // [终审修复] Unpaywall 按 DOI 精确解析（绑定强度与仓库 DOI 相等命中等价）
      // ——与 collectRepositoryCandidates 的 doi-url 档一致，不再低标。
      if (fallback) candidates.push({ url: fallback, identity: "doi-url" });
      } catch {
        // unpaywall unavailable — skip silently
      }
    }
    // Sci-Hub is the last resort: only after OA repositories + unpaywall fail.
    // resolveSciHubPdfUrl rotates across mirrors and feeds its health store.
    if (sciHubEnabled()) {
      const sciHubIdentifier = doi || title || paperId;
      if (sciHubIdentifier) {
        const resolved = await resolveSciHubPdfUrl(sciHubIdentifier, {
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        });
        if (resolved) candidates.push({ url: resolved.url, identity: "scihub" });
      }
    }
  }

  for (const candidate of admitCandidates(candidates, outcome)) {
    try {
      const saved = await fetchPdf(candidate.url, options.dir, fragment, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        meta: {
          doi,
          title: metadata.title,
          source: sourceId,
          sourceUrl: candidate.url,
          identity: candidate.identity,
        },
      });
      outcome.status = destinationTaken ? "replaced" : "downloaded";
      outcome.path = saved.path;
      outcome.bytes = saved.bytes;
      outcome.identity = candidate.identity;
      return outcome;
    } catch (error) {
      if (options.signal?.aborted) break;
      // try the next candidate; a byte conflict is remembered for the failure message
      if (error instanceof IdentityConflictError) outcome.identityConflict = error.message;
    }
  }

  outcome.error = withIdentityNotes(
    source.download || candidates.length > 0
      ? `no usable PDF found after ${consultedSources(["OA repositories", "unpaywall"])} (paper may be paywalled${sciHubEnabled() ? " or absent from the mirrors" : "; Sci-Hub is off"})`
      : `${sourceId} is metadata-only; no PDF download available`,
    outcome,
  );
  return outcome;
}

/** Pick papers a fetch can download: native capability, a pdf_url, or a DOI
 * (repository + unpaywall fallback chain). Preserves extra fields (title). */
export function pickDownloadable<T extends { paperId: string; source: string; pdfUrl: string; doi?: string }>(
  papers: T[],
  count: number,
): T[] {
  const byId = new Map(SOURCES.map((source) => [source.id, source]));
  const picked: T[] = [];
  for (const paper of papers) {
    if (picked.length >= count) break;
    if (!paper.paperId || !paper.source) continue;
    const adapter = byId.get(paper.source);
    const doi = paper.doi?.trim();
    if (adapter?.download || paper.pdfUrl || doi) {
      picked.push(paper);
    }
  }
  return picked;
}

/** Bounded-concurrency batch download. Throws AbortError on abort.
 *  onOutcome fires once per settled paper (any status), in completion order. */
export async function downloadAll(
  tasks: Array<{ source: string; paperId: string; title?: string; doi?: string; pdfUrl?: string }>,
  options: DownloadOptions & {
    concurrency?: number;
    onOutcome?: (outcome: DownloadOutcome) => void;
  },
): Promise<DownloadOutcome[]> {
  const concurrency = Math.max(1, Math.min(5, options.concurrency ?? 3));
  const results: DownloadOutcome[] = [];
  const shared: DownloadOptions = { ...options, libraryIndex: options.libraryIndex ?? (await loadLibraryDoiIndex(options.dir)) };
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      if (options.signal?.aborted) return;
      const task = tasks[cursor]!;
      cursor += 1;
      const outcome = await downloadPaper(task.source, task.paperId, shared, task);
      results.push(outcome);
      options.onOutcome?.(outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  if (options.signal?.aborted) {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }
  return results;
}

/** Short, actionable description of a failed request (status, timeout or message). */
function describeFailure(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 429) return "HTTP 429 (rate-limited)";
    if (error.status === 401 || error.status === 403) return `HTTP ${error.status} (access refused)`;
    return `HTTP ${error.status}`;
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timed out";
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 120 ? `${message.slice(0, 117)}...` : message;
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Semantic Scholar DOI-exact lookup for the acquisition chain: the card's
 * openAccessPdf link plus its title, and what the lookup answered. A 404
 * (S2 does not know the DOI) counts as "none"; any other failure counts as
 * "unavailable" — the repository / unpaywall / Sci-Hub chain below still
 * applies. The metadata call is capped at 30s (JSON endpoint), never the
 * generous PDF download timeout. */
async function resolveSemanticScholarOaPdf(
  doi: string,
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ title: string; pdfUrl: string; stage: AcquisitionStage }> {
  const key = currentSourceKeys().semanticScholarApiKey;
  const headers: Record<string, string> = {};
  if (key) headers["x-api-key"] = key;
  const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=title,openAccessPdf`;
  try {
    const record = await getJson<{ title?: string; openAccessPdf?: { url?: string } | null }>(url, {
      signal: options.signal,
      timeoutMs: Math.min(options.timeoutMs ?? 30_000, 30_000),
      headers,
    });
    const pdfUrl = record.openAccessPdf?.url ?? "";
    return {
      title: record.title?.trim() ?? "",
      pdfUrl,
      stage: pdfUrl
        ? { stage: "semantic-scholar", result: "candidate" }
        : { stage: "semantic-scholar", result: "none", detail: "Semantic Scholar lists no open-access PDF for this DOI" },
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof HttpError && error.status === 404) {
      return { title: "", pdfUrl: "", stage: { stage: "semantic-scholar", result: "none", detail: "Semantic Scholar does not know this DOI" } };
    }
    return { title: "", pdfUrl: "", stage: { stage: "semantic-scholar", result: "unavailable", detail: describeFailure(error) } };
  }
}

/** The repositories step as one stage: a link found wins; otherwise any repository that
 * failed to answer makes the step "unavailable" (its silence is not an absence). */
function repositoriesStage(probes: readonly RepositoryProbe[], links: number): AcquisitionStage {
  if (links > 0) return { stage: "repositories", result: "candidate", detail: `${links} link(s)` };
  const failures = new Map<string, string>();
  for (const probe of probes) if (!probe.ok && !failures.has(probe.source)) failures.set(probe.source, probe.detail ?? "failed");
  if (failures.size === 0) return { stage: "repositories", result: "none", detail: "no open repository holds a PDF for this DOI" };
  const asked = new Set(probes.map((probe) => probe.source)).size;
  const named = [...failures].map(([source, detail]) => `${source}: ${detail}`).join("; ");
  return { stage: "repositories", result: "unavailable", detail: `${failures.size} of ${asked} repositories did not answer (${named})` };
}

/** Unpaywall as one stage; the link is set only when it answered with an open-access PDF. */
async function unpaywallStage(
  doi: string,
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ url?: string; stage: AcquisitionStage }> {
  if (!unpaywallConfigured()) {
    return { stage: { stage: "unpaywall", result: "unconfigured", detail: "no contact email configured (unpaywallEmail / contactEmail)" } };
  }
  try {
    const url = await resolveOaPdfUrl(doi, { signal: options.signal, timeoutMs: options.timeoutMs });
    return url
      ? { url, stage: { stage: "unpaywall", result: "candidate" } }
      : { stage: { stage: "unpaywall", result: "none", detail: "Unpaywall records no open-access PDF for this DOI" } };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof HttpError && error.status === 404) {
      return { stage: { stage: "unpaywall", result: "none", detail: "Unpaywall does not know this DOI" } };
    }
    return { stage: { stage: "unpaywall", result: "unavailable", detail: describeFailure(error) } };
  }
}

const STAGE_LABEL: Record<AcquisitionStage["stage"], string> = {
  "semantic-scholar": "Semantic Scholar",
  repositories: "OA repositories",
  unpaywall: "unpaywall",
  "sci-hub": "Sci-Hub",
  download: "download",
};

/** Verdict, next steps and the failure sentence for a DOI acquisition that produced no PDF. */
function diagnoseAcquisition(
  outcome: DownloadOutcome,
  stages: AcquisitionStage[],
  located: boolean,
  dir: string,
): { diagnosis: AcquisitionDiagnosis; message: string } {
  const problems = stages.filter((stage) => stage.result === "unavailable" || stage.result === "unconfigured");
  const keys = currentSourceKeys();
  const hints: string[] = [];
  for (const problem of problems) {
    if (problem.stage === "semantic-scholar" && !keys.semanticScholarApiKey) {
      hints.push("set SEMANTIC_SCHOLAR_API_KEY (a free key) to lift the shared rate limit of the Semantic Scholar API");
    }
    if (problem.stage === "unpaywall" && problem.result === "unconfigured") {
      hints.push("set unpaywallEmail (any valid email) in the papersearch settings");
    }
    if (problem.stage === "repositories" && /\bcore: /.test(problem.detail ?? "") && !keys.coreApiKey) {
      hints.push("set CORE_API_KEY (a free key) so the CORE repository accepts the request");
    }
  }
  if (problems.some((problem) => problem.result === "unavailable" && problem.stage !== "download")) {
    hints.push("transient failures are not cached — retry the failed DOIs later");
  }
  if (located) {
    hints.push(`open the located link in a browser, save the PDF into ${dir} and okf_ingest it (or ask the user to supply the PDF)`);
  }

  const verdict: AcquisitionDiagnosis["verdict"] = located ? "located-but-blocked" : problems.length > 0 ? "inconclusive" : "no-open-access-copy";
  const diagnosis: AcquisitionDiagnosis = { verdict, stages, hints: [...new Set(hints)] };
  const answeredNone = stages.filter((stage) => stage.result === "none").map((stage) => STAGE_LABEL[stage.stage]);
  const problemText = problems.map((problem) => `${STAGE_LABEL[problem.stage]}: ${problem.detail ?? problem.result}`).join("; ");

  let message: string;
  if (verdict === "located-but-blocked") {
    const download = stages.find((stage) => stage.stage === "download");
    message = `an open-access copy was located but could not be downloaded${download?.detail ? ` (${download.detail})` : ""}`;
  } else if (verdict === "inconclusive") {
    message = `no usable PDF found, but ${problemText} — this is not proof of a paywall`
      + (answeredNone.length > 0 ? ` (${answeredNone.join(", ")} reported no open-access copy)` : "");
  } else {
    const consulted = stages.filter((stage) => stage.result === "none" || stage.result === "candidate").map((stage) => STAGE_LABEL[stage.stage]);
    const names = consulted.length > 1 ? `${consulted.slice(0, -1).join(", ")} and ${consulted[consulted.length - 1]}` : (consulted[0] ?? "");
    message = `no usable PDF found after ${names} (paper may be paywalled${sciHubEnabled() ? " or absent from the mirrors" : "; Sci-Hub is off"})`;
  }
  if (diagnosis.hints.length > 0) message += `; ${diagnosis.hints.join("; ")}`;
  return { diagnosis, message: withIdentityNotes(message, outcome) };
}

/** Download one paper by bare DOI — the papersearch_acquire engine. The
 * chain is DOI-anchored end to end: Semantic Scholar's openAccessPdf first
 * (the user's requested S2 pass), then the open repositories + unpaywall OA
 * resolver, then Sci-Hub as the last resort. Files land as doi-<doi>.pdf
 * with the same sidecar contract as downloadPaper; the exists/replaced
 * idempotency semantics are identical. Per-DOI failures are returned, never
 * thrown (except abort). */
export async function downloadByDoi(
  doiInput: string,
  options: DownloadOptions,
  metadata: { title?: string } = {},
): Promise<DownloadOutcome> {
  const doi = bareDoi(doiInput).toLowerCase();
  const outcome: DownloadOutcome = {
    source: "doi",
    paperId: doi || doiInput,
    status: "failed",
    title: metadata.title,
    doi: doi || undefined,
  };
  // bareDoi normalizes but never validates — a non-DOI string would otherwise
  // burn the whole chain (S2 404 → repository miss → sci-hub miss) before
  // failing. Reject up front: DOI body = 10.<registrant>/<suffix>.
  if (!/^10\.\d{4,}\//.test(doi)) {
    outcome.error = `not a DOI: ${doiInput}`;
    return outcome;
  }

  const covered = inLibraryOutcome(outcome, doi, options.libraryIndex);
  if (covered) return covered;

  const fragment = safeFileFragment(`doi-${doi}`);
  const expected = path.join(options.dir, `${fragment}.pdf`);
  let destinationTaken = false;
  try {
    const info = await stat(expected);
    if (info.isFile()) {
      destinationTaken = true;
      const sidecar = await readSidecar(expected);
      if (sidecar && sidecar.sha256 === (await sha256OfFile(expected))) {
        outcome.status = "exists";
        outcome.path = expected;
        outcome.bytes = info.size;
        return outcome;
      }
    }
  } catch {
    // not present — proceed
  }

  const candidates: Array<{ url: string; identity: DownloadIdentity }> = [];
  const stages: AcquisitionStage[] = [];
  // Step 1 (requested S2 pass): DOI-exact card → openAccessPdf is DOI-anchored.
  const s2 = await resolveSemanticScholarOaPdf(doi, options);
  stages.push(s2.stage);
  const title = (metadata.title?.trim() || s2.title || "").trim();
  if (title && !outcome.title) outcome.title = title;
  if (s2.pdfUrl.startsWith("http")) candidates.push({ url: s2.pdfUrl, identity: "doi-url" });

  if (options.allowFallback !== false) {
    // Step 2: open repositories (openaire/core/europepmc/pmc) by DOI, then
    // unpaywall — both DOI-anchored.
    const probes: RepositoryProbe[] = [];
    const repositoryUrls = await collectRepositoryCandidates(
      repositoryAdapters(),
      { doi, title },
      { signal: options.signal, timeoutMs: options.timeoutMs, onSource: (probe) => probes.push(probe) },
    );
    candidates.push(...repositoryUrls);
    stages.push(repositoriesStage(probes, repositoryUrls.length));
    const unpaywall = await unpaywallStage(doi, options);
    stages.push(unpaywall.stage);
    if (unpaywall.url) candidates.push({ url: unpaywall.url, identity: "doi-url" });
    // Step 3: Sci-Hub last resort (mirror rotation + health store inside).
    if (sciHubEnabled()) {
      const resolved = await resolveSciHubPdfUrl(doi, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      if (resolved) candidates.push({ url: resolved.url, identity: "scihub" });
      stages.push(resolved
        ? { stage: "sci-hub", result: "candidate" }
        : { stage: "sci-hub", result: "none", detail: "no Sci-Hub mirror served this paper" });
    } else {
      stages.push({ stage: "sci-hub", result: "off", detail: "useScihub is off" });
    }
  } else {
    stages.push({ stage: "repositories", result: "off", detail: "allowFallback is off" });
  }

  const admitted = admitCandidates(candidates, outcome);
  const fetchFailures: string[] = [];
  for (const candidate of admitted) {
    try {
      const saved = await fetchPdf(candidate.url, options.dir, fragment, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        meta: {
          doi,
          title,
          source: "doi",
          sourceUrl: candidate.url,
          identity: candidate.identity,
        },
      });
      outcome.status = destinationTaken ? "replaced" : "downloaded";
      outcome.path = saved.path;
      outcome.bytes = saved.bytes;
      outcome.identity = candidate.identity;
      return outcome;
    } catch (error) {
      if (options.signal?.aborted) break;
      // try the next candidate; a byte conflict is remembered for the failure message
      if (error instanceof IdentityConflictError) outcome.identityConflict = error.message;
      else fetchFailures.push(`${hostOfUrl(candidate.url)}: ${describeFailure(error)}`);
    }
  }
  if (admitted.length > 0) {
    stages.push({ stage: "download", result: "unavailable", detail: fetchFailures.length > 0 ? fetchFailures.join("; ") : "no candidate could be saved" });
  }

  const failure = diagnoseAcquisition(outcome, stages, admitted.length > 0, options.dir);
  outcome.diagnosis = failure.diagnosis;
  outcome.error = failure.message;
  return outcome;
}

/** Bounded-concurrency batch acquisition by DOI (the papersearch_acquire
 *  engine). Mirrors downloadAll: AbortError on abort, onOutcome fires once
 *  per settled DOI in completion order. */
export async function acquireByDoi(
  dois: string[],
  options: DownloadOptions & {
    concurrency?: number;
    onOutcome?: (outcome: DownloadOutcome) => void;
  },
): Promise<DownloadOutcome[]> {
  const concurrency = Math.max(1, Math.min(5, options.concurrency ?? 3));
  const results: DownloadOutcome[] = [];
  const shared: DownloadOptions = { ...options, libraryIndex: options.libraryIndex ?? (await loadLibraryDoiIndex(options.dir)) };
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < dois.length) {
      if (options.signal?.aborted) return;
      const doi = dois[cursor]!;
      cursor += 1;
      const outcome = await downloadByDoi(doi, shared);
      results.push(outcome);
      options.onOutcome?.(outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, dois.length) }, () => worker()));
  if (options.signal?.aborted) {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }
  return results;
}
