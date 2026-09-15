import { getJson, qs } from "../http";
import { currentSourceKeys } from "../keys";
import { extractDoi, type Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** DOAJ — the Directory of Open Access Journals. Article search returns
 * fulltext links that join the fetch pool; an API key (free) raises the
 * anonymous hourly limit. */

const SEARCH_URL = "https://doaj.org/api/search/articles";

interface DoajBibjson {
  title?: string;
  author?: Array<{ name?: string }>;
  abstract?: string;
  year?: string;
  month?: string;
  date?: string;
  doi?: string;
  journal?: { title?: string; volume?: string };
  link?: Array<{ url?: string; type?: string }>;
  identifier?: Array<{ type?: string; id?: string }>;
}

interface DoajRecord {
  id?: string;
  bibjson?: DoajBibjson;
}

interface DoajResponse {
  results?: DoajRecord[];
}

function toPaper(record: DoajRecord): Paper {
  const bib = record.bibjson ?? {};
  const fulltext = (bib.link ?? []).find((link) => (link.type ?? "").includes("fulltext"))?.url ?? "";
  const doi = bib.doi ?? extractDoi((bib.identifier ?? []).map((identifier) => identifier.id ?? "").join(" "));
  const date = bib.date ?? (bib.year ? `${bib.year}${bib.month ? `-${bib.month}` : ""}` : "");
  return {
    paperId: record.id ?? doi,
    title: (bib.title ?? "").replace(/\s+/g, " ").trim(),
    authors: (bib.author ?? []).map((author) => author.name ?? "").filter(Boolean),
    abstract: (bib.abstract ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    doi,
    publishedDate: date.slice(0, 10),
    pdfUrl: fulltext,
    url: fulltext || (doi ? `https://doi.org/${doi}` : ""),
    source: "doaj",
    categories: [bib.journal?.title ?? ""].filter(Boolean),
    citations: 0,
  };
}

export const doajSource: SourceAdapter = {
  id: "doaj",
  canDownload: false,
  async search(args: SearchArgs): Promise<Paper[]> {
    const key = currentSourceKeys().doajApiKey;
    const params: Record<string, string | number | undefined> = {
      pageSize: args.maxResults,
      apiKey: key || undefined,
    };
    const url = `${SEARCH_URL}/${encodeURIComponent(args.query)}?${qs(params)}`;
    const payload = await getJson<DoajResponse>(url, { signal: args.signal, timeoutMs: args.timeoutMs });
    return (payload.results ?? []).map(toPaper).filter((paper) => paper.paperId && paper.title);
  },
};
