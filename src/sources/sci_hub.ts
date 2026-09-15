import { currentSourceKeys } from "../keys";
import { absoluteUrl, attrValue, decodeHtmlEntities, stripTags } from "../html";

/** Sci-Hub is the LAST resort of the download fallback chain: it serves
 * paywalled papers the open repositories and unpaywall could not resolve.
 * Mirrors are tried in order and kept honest by a small in-session health
 * store — a mirror that just failed is de-prioritized for a few minutes so
 * repeated lookups stop hammering the same dead host. */

/** Curated mirror list (2026-07 scansci-pdf measurements) — first one wins
 * until its health says otherwise. */
export const DEFAULT_SCIHUB_MIRRORS: readonly string[] = [
  "https://sci-hub.vg",
  "https://sci-hub.al",
  "https://sci-hub.mk",
  "https://sci-hub.ru",
];

const DIRECT = "direct";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** One mirror's rolling health. Failures (network or article-not-found)
 * push the mirror behind its peers for PENALTY_MS. */
interface MirrorHealth {
  failures: number;
  lastFailureAt: number;
  totalMs: number;
  successes: number;
}

const PENALTY_MS = 3 * 60_000;
const health = new Map<string, MirrorHealth>();

/** Test seam: forget everything learned this session. */
export function resetSciHubHealth(): void {
  health.clear();
}

function noteSuccess(mirror: string, ms: number): void {
  const entry = health.get(mirror) ?? { failures: 0, lastFailureAt: 0, totalMs: 0, successes: 0 };
  entry.successes += 1;
  entry.totalMs += Math.max(0, ms);
  health.set(mirror, entry);
}

function noteFailure(mirror: string): void {
  const entry = health.get(mirror) ?? { failures: 0, lastFailureAt: 0, totalMs: 0, successes: 0 };
  entry.failures += 1;
  entry.lastFailureAt = Date.now();
  health.set(mirror, entry);
}

/** Parse a comma-separated mirror setting: trim, drop empties, strip the
 * trailing slash so `${mirror}/${id}` concatenation stays canonical. */
function parseMirrorList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Effective mirror rotation: the scihubBaseUrl setting wins, then the
 * PAPERSEARCH_SCI_HUB_BASE_URL / SCI_HUB_BASE_URL env chain, else the
 * curated default list. */
export function sciHubMirrors(): string[] {
  const fromKeys = parseMirrorList(currentSourceKeys().scihubBaseUrl);
  if (fromKeys.length > 0) return fromKeys;
  const fromEnv = [
    ...parseMirrorList(process.env.PAPERSEARCH_SCI_HUB_BASE_URL),
    ...parseMirrorList(process.env.SCI_HUB_BASE_URL),
  ];
  if (fromEnv.length > 0) return fromEnv;
  return [...DEFAULT_SCIHUB_MIRRORS];
}

/** Primary mirror of the current rotation. */
export function sciHubBaseUrl(): string {
  return orderedMirrors()[0] ?? DEFAULT_SCIHUB_MIRRORS[0]!;
}

/** Mirrors in try-order: healthy peers keep their configured order, a mirror
 * that failed within the penalty window sinks to the back. */
function orderedMirrors(): string[] {
  const mirrors = sciHubMirrors();
  const now = Date.now();
  const rank = (mirror: string): number => {
    const entry = health.get(mirror);
    if (!entry || now - entry.lastFailureAt > PENALTY_MS) return 0;
    return 1;
  };
  return mirrors
    .map((mirror, index) => ({ mirror, index, rank: rank(mirror) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.mirror);
}

/** URL-level plausibility filter — a Sci-Hub page is full of links that are
 * definitively not PDFs (journal browse pages, provider lists); downloading
 * those wastes a round trip and lands an HTML error in the PDF slot. */
export function isPlausiblePdfUrl(raw: string): boolean {
  const value = (raw ?? "").trim();
  if (!/^https?:\/\//i.test(value)) return false;
  let path: string;
  let query: string;
  try {
    const parsed = new URL(value);
    path = parsed.pathname;
    query = parsed.search;
  } catch {
    return false;
  }
  if (/\/journals?\//i.test(path) || /\/providers?\//i.test(path) || /\/data-providers?\//i.test(path)) {
    return false;
  }
  if (/\.pdf(\?|#|$)/i.test(path)) return true;
  if (/\/pdf\/?$/i.test(path) || /\/download\/pdf(\/|$)/i.test(path)) return true;
  if (/[?&](format|type)=pdf(&|$)/i.test(query)) return true;
  // HAL and friends serve the document endpoint without a .pdf extension.
  if (/\/document(\?|#|$)/i.test(path)) return true;
  return false;
}

/** Not-found markers Sci-Hub emits (English and Russian variants) — a page
 * saying these has no PDF to extract, whatever else it contains. */
function isNotFoundPage(html: string): boolean {
  const lowered = html.toLowerCase();
  return (
    lowered.includes("article not found") ||
    lowered.includes("статья не найдена") ||
    lowered.includes("не найден")
  );
}

/** Pull the direct PDF link out of a Sci-Hub landing page. Priority:
 * <meta name=citation_pdf_url>, <embed type=application/pdf>, <iframe src>,
 * a button onclick=location.href, then any absolute pdf-looking anchor. */
export function extractPdfUrl(html: string, baseUrl: string): string {
  if (isNotFoundPage(html)) return "";

  const metaMatch = /<meta\s+[^>]*name\s*=\s*["']?citation_pdf_url["']?[^>]*>/i.exec(html);
  if (metaMatch) {
    const content = attrValue(metaMatch[0]!, "content");
    const metaUrl = absoluteUrl(decodeHtmlEntities(content), baseUrl);
    if (metaUrl && isPlausiblePdfUrl(metaUrl)) return metaUrl;
  }

  for (const embed of html.matchAll(/<embed\s+[^>]*>/gi)) {
    const tag = embed[0]!;
    if (!/type\s*=\s*["']?application\/pdf/i.test(tag)) continue;
    const src = absoluteUrl(decodeHtmlEntities(attrValue(tag, "src")), baseUrl);
    if (src && isPlausiblePdfUrl(src)) return src;
  }

  for (const iframe of html.matchAll(/<iframe\s+[^>]*>/gi)) {
    const src = absoluteUrl(decodeHtmlEntities(attrValue(iframe[0]!, "src")), baseUrl);
    if (src && isPlausiblePdfUrl(src)) return src;
  }

  const onclick = /(location\.href|window\.location)\s*=\s*['"]([^'"]+)['"]/i.exec(html);
  if (onclick) {
    const url = absoluteUrl(decodeHtmlEntities(onclick[2]!), baseUrl);
    if (url && isPlausiblePdfUrl(url)) return url;
  }

  for (const anchor of html.matchAll(/<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const url = absoluteUrl(decodeHtmlEntities(anchor[1]!), baseUrl);
    if (url && isPlausiblePdfUrl(url)) return url;
  }
  return "";
}

export interface ResolveSciHubOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Explicit rotation override (used by papersearch_download_scihub --baseUrl). */
  mirrors?: string[];
}

export interface ResolvedSciHubPdf {
  url: string;
  mirror: string;
}

/** Resolve an identifier (DOI / title / PMID / URL) to a direct PDF link by
 * walking the mirror rotation. Already-direct PDF URLs pass through; an
 * exhausted rotation resolves undefined — the caller decides what that means. */
export async function resolveSciHubPdfUrl(
  identifier: string,
  options: ResolveSciHubOptions = {},
): Promise<ResolvedSciHubPdf | undefined> {
  const id = (identifier ?? "").trim();
  if (!id) return undefined;
  if (/^https?:\/\//i.test(id) && isPlausiblePdfUrl(id)) {
    return { url: id, mirror: DIRECT };
  }

  const mirrors = options.mirrors?.length ? options.mirrors : orderedMirrors();
  for (const mirror of mirrors) {
    if (options.signal?.aborted) return undefined;
    const startedAt = Date.now();
    try {
      const response = await fetch(`${mirror}/${id}`, {
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
        redirect: "follow",
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 20_000)])
          : AbortSignal.timeout(options.timeoutMs ?? 20_000),
      });
      if (!response.ok) {
        noteFailure(mirror);
        continue;
      }
      const html = stripScripts(await response.text());
      const url = extractPdfUrl(html, mirror);
      if (url) {
        noteSuccess(mirror, Date.now() - startedAt);
        return { url, mirror };
      }
      noteFailure(mirror);
    } catch {
      noteFailure(mirror);
    }
  }
  return undefined;
}

/** The regexes above already ignore script bodies; stripping them here keeps
 * decodeHtmlEntities from ever seeing hostile inline payloads. */
function stripScripts(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ");
}

/** Exposed for the help text: the caption shown next to the scihub tool. */
export function sciHubMirrorSummary(): string {
  return stripTags(sciHubMirrors().join(", "));
}
