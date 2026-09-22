import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fetchWithRetry, HttpError, USER_AGENT } from "./http";
import { currentSourceKeys, sciHubEnabled } from "./keys";
import { bareDoi, compactSearchResult, extractDoi, type CompactSearchResult, type Paper } from "./paper";
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
import { unpaywallSource, resolveOaPdfUrl } from "./sources/unpaywall";
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
  const maxResults = Math.max(1, Math.min(20, options.maxResults ?? 5));

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
   * replaced = a differing (or unverifiable) file was overwritten. */
  status: "downloaded" | "exists" | "replaced" | "failed";
  path?: string;
  bytes?: number;
  title?: string;
  doi?: string;
  error?: string;
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
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RepositoryCandidate[]> {
  const doi = bareDoi(identifiers.doi).toLowerCase();
  const title = identifiers.title?.trim();
  if (!doi && !title) return [];

  const out: RepositoryCandidate[] = [];
  const timeoutMs = Math.min(options.timeoutMs ?? REPOSITORY_SEARCH_TIMEOUT_MS, REPOSITORY_SEARCH_TIMEOUT_MS);
  const roomLeft = (): boolean => out.length < REPOSITORY_MAX_CANDIDATES;

  if (doi) {
    for (const source of sources) {
      if (!roomLeft()) break;
      let papers: Paper[] = [];
      try {
        papers = await source.search({ query: doi, maxResults: 3, signal: options.signal, timeoutMs });
      } catch {
        // repository unavailable — try the next one
        continue;
      }
      for (const paper of papers) {
        if (!roomLeft()) break;
        // A DOI-phase hit only counts when the result's own DOI matches the
        // request — anything else is exactly the misidentification this
        // reorder exists to prevent, so it is dropped rather than pooled.
        if (paper.pdfUrl?.startsWith("http") && bareDoi(paper.doi).toLowerCase() === doi) {
          out.push({ url: paper.pdfUrl, identity: "doi-url" });
        }
      }
    }
  }

  if (out.length === 0 && title) {
    for (const source of sources) {
      if (!roomLeft()) break;
      try {
        const papers = await source.search({ query: title, maxResults: 3, signal: options.signal, timeoutMs });
        for (const paper of papers) {
          if (!roomLeft()) break;
          if (!paper.pdfUrl?.startsWith("http")) continue;
          // A title-phase hit that nevertheless carries the requested DOI is
          // a verified match, not a fallback.
          const verified = Boolean(doi) && bareDoi(paper.doi).toLowerCase() === doi;
          out.push({ url: paper.pdfUrl, identity: verified ? "doi-url" : "title-fallback" });
        }
      } catch {
        // repository unavailable — try the next one
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
    sha256: sha256Hex(buffer),
    bytes: buffer.byteLength,
    doi: options.meta?.doi ?? "",
    title: options.meta?.title ?? "",
    source: options.meta?.source ?? "",
    sourceUrl: options.meta?.sourceUrl ?? url,
    retrievedAt: new Date().toISOString(),
    identity: options.meta?.identity ?? "unknown",
  });
  return { path: file, bytes: buffer.byteLength };
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
        if (fallback) candidates.push({ url: fallback, identity: "repository-unverified" });
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

  for (const candidate of candidates) {
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
      return outcome;
    } catch (error) {
      if (options.signal?.aborted) break;
      // try the next candidate
      void error;
    }
  }

  outcome.error = source.download || candidates.length > 0
    ? "no usable PDF found after OA repositories, unpaywall and Sci-Hub (paper may be paywalled or absent from the mirrors)"
    : `${sourceId} is metadata-only; no PDF download available`;
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
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      if (options.signal?.aborted) return;
      const task = tasks[cursor]!;
      cursor += 1;
      const outcome = await downloadPaper(task.source, task.paperId, options, task);
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
