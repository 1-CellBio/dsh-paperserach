import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { HttpError, USER_AGENT } from "./http";
import { currentSourceKeys, sciHubEnabled } from "./keys";
import { compactSearchResult, extractDoi, type CompactSearchResult, type Paper } from "./paper";
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
  status: "downloaded" | "exists" | "failed";
  path?: string;
  bytes?: number;
  title?: string;
  doi?: string;
  error?: string;
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

/** Query the open repositories by DOI (preferred) then title and collect
 * candidate PDF links. Failures are swallowed — the chain simply shrinks. */
export async function collectRepositoryCandidates(
  sources: readonly SourceAdapter[],
  identifiers: { doi?: string; title?: string },
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string[]> {
  const queries = [identifiers.doi?.trim(), identifiers.title?.trim()]
    .filter((value): value is string => Boolean(value));
  if (queries.length === 0) return [];

  const urls: string[] = [];
  const timeoutMs = Math.min(options.timeoutMs ?? REPOSITORY_SEARCH_TIMEOUT_MS, REPOSITORY_SEARCH_TIMEOUT_MS);
  for (const source of sources) {
    for (const query of queries) {
      if (urls.length >= REPOSITORY_MAX_CANDIDATES) return urls;
      try {
        const papers = await source.search({
          query,
          maxResults: 3,
          signal: options.signal,
          timeoutMs,
        });
        for (const paper of papers) {
          if (paper.pdfUrl?.startsWith("http")) urls.push(paper.pdfUrl);
        }
      } catch {
        // repository unavailable — try the next one
      }
    }
  }
  return urls;
}

function repositoryAdapters(): SourceAdapter[] {
  const byId = new Map(SOURCES.map((source) => [source.id, source]));
  return REPOSITORY_FALLBACK_IDS
    .map((id) => byId.get(id))
    .filter((source): source is SourceAdapter => Boolean(source));
}

/** Stream a PDF from `url` into `dir/<baseName>.pdf`. The %PDF- magic is
 * mandatory (content-type is a diagnostic signal only, never a pass); the
 * write is atomic — payload lands in a unique `<name>.pdf.<pid>-<uuid>.part`
 * first, then renames, so concurrent downloads of the same paper (a background
 * fetch job racing a foreground download) never share an inode. */
export async function fetchPdf(
  url: string,
  dir: string,
  baseName: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ path: string; bytes: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 300_000);
  const onOuterAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/pdf,*/*" },
      signal: controller.signal,
      redirect: "follow",
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
    return { path: file, bytes: buffer.byteLength };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Download one paper by source + id. Idempotent; per-paper failures are
 * returned, never thrown (except abort). */
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
  try {
    const info = await stat(expected);
    if (info.isFile()) {
      outcome.status = "exists";
      outcome.path = expected;
      outcome.bytes = info.size;
      return outcome;
    }
  } catch {
    // not present — proceed
  }

  const candidates: string[] = [];
  try {
    const target = await resolveTarget(source, paperId, options);
    if (target.url) candidates.push(target.url);
  } catch (error) {
    // fall through to pdfUrl / repositories / unpaywall below
    void error;
  }
  if (metadata.pdfUrl?.startsWith("http")) candidates.push(metadata.pdfUrl);
  const doi = metadata.doi?.trim() || extractDoi(paperId);
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
        if (fallback) candidates.push(fallback);
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
        if (resolved) candidates.push(resolved.url);
      }
    }
  }

  for (const url of candidates) {
    try {
      const saved = await fetchPdf(url, options.dir, fragment, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      outcome.status = "downloaded";
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
