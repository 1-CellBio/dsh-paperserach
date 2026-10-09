import { getJson, qs } from "../http";
import { currentSourceKeys } from "../keys";
import { doiQuery, type Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** CORE aggregator — the world's largest collection of open-access
 * repository records. Anonymous use works within a shared rate limit; a
 * free API key (core.ac.uk/services/api) raises it. Native downloads when
 * the record carries a fulltext PDF link. */

const SEARCH_URL = "https://api.core.ac.uk/v3/search/works";

interface CoreAuthor {
  name?: string;
}

interface CoreOutput {
  id?: string | number;
  fullTextUrl?: string;
  downloadUrl?: string;
  documentType?: string;
}

interface CoreWork {
  id?: string | number;
  title?: string;
  abstract?: string;
  authors?: CoreAuthor[];
  publishedDate?: string;
  datePublished?: string;
  doi?: string;
  downloadUrl?: string;
  fullTextUrl?: string;
  sourceUrl?: string;
  links?: CoreOutput[];
  citationCount?: number;
  publisher?: string;
  journal?: { name?: string };
}

/** Build the search request; a stored key rides along as a Bearer token. */
async function searchWorks(args: SearchArgs): Promise<CoreWork[]> {
  // An unquoted DOI is parsed as a regex at its slash and answered with HTTP 500; field-quote it.
  const doi = doiQuery(args.query);
  const q = doi ? `doi:"${doi}"` : args.query;
  const url = `${SEARCH_URL}?${qs({ q, limit: args.maxResults })}`;
  const key = currentSourceKeys().coreApiKey;
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  const payload = await getJson<{ results?: CoreWork[] }>(url, {
    signal: args.signal,
    timeoutMs: args.timeoutMs,
    headers,
  });
  return payload.results ?? [];
}

/** First usable PDF link on a CORE record (dedup'd across shapes). */
function pdfUrlOf(work: CoreWork): string {
  const candidates = [
    work.downloadUrl,
    work.fullTextUrl,
    ...(work.links ?? []).map((link) => link.downloadUrl ?? link.fullTextUrl ?? ""),
  ];
  for (const candidate of candidates) {
    const value = (candidate ?? "").trim();
    if (value) return value;
  }
  return "";
}

function toPaper(work: CoreWork): Paper {
  const paperId = String(work.id ?? "");
  return {
    paperId,
    title: work.title ?? "",
    authors: (work.authors ?? []).map((author) => author.name ?? "").filter(Boolean),
    abstract: (work.abstract ?? "").replace(/\s+/g, " ").trim(),
    doi: work.doi ?? "",
    publishedDate: (work.publishedDate ?? work.datePublished ?? "").slice(0, 10),
    pdfUrl: pdfUrlOf(work),
    url: work.sourceUrl ?? pdfUrlOf(work),
    source: "core",
    categories: [work.journal?.name ?? work.publisher ?? ""].filter(Boolean),
    citations: work.citationCount ?? 0,
  };
}

export const coreSource: SourceAdapter = {
  id: "core",
  canDownload: true,
  async search(args: SearchArgs): Promise<Paper[]> {
    const works = await searchWorks(args);
    return works.map(toPaper).filter((paper) => paper.paperId && paper.title);
  },
  async download(paperId) {
    return { url: `https://core.ac.uk/download/${paperId}.pdf`, baseName: `core-${paperId}` };
  },
};
