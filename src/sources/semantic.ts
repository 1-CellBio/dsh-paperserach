import { getJson, qs } from "../http";
import { currentSourceKeys } from "../keys";
import type { Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** Semantic Scholar Graph API. The optional API key (free) raises rate
 * limits; open-access papers carry an openAccessPdf link that feeds the
 * native download path. The year filter ('2023' or '2020-2024') maps to the
 * API's year= parameter. */

const SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search";

interface SemanticAuthor {
  name?: string;
}

interface SemanticPaper {
  paperId?: string;
  title?: string;
  abstract?: string;
  year?: number;
  doi?: string;
  url?: string;
  venue?: string;
  citationCount?: number;
  authors?: SemanticAuthor[];
  openAccessPdf?: { url?: string; status?: string } | null;
  externalIds?: { DOI?: string; ArXiv?: string; PubMed?: string; DBLP?: string };
}

/** The Semantic Scholar API key resolved through the credentials seam. */
function semanticScholarApiKey(): string {
  return currentSourceKeys().semanticScholarApiKey;
}

/** Map a Graph API record onto the shared paper card. */
function toPaper(record: SemanticPaper): Paper {
  const paperId = record.paperId ?? "";
  const doi = (record.doi ?? record.externalIds?.DOI ?? "").replace(/^https?:\/\/doi\.org\//i, "");
  return {
    paperId,
    title: record.title ?? "",
    authors: (record.authors ?? []).map((author) => author.name ?? "").filter(Boolean),
    abstract: record.abstract ?? "",
    doi,
    publishedDate: record.year ? String(record.year) : "",
    pdfUrl: record.openAccessPdf?.url ?? "",
    url: record.url ?? (doi ? `https://doi.org/${doi}` : ""),
    source: "semantic",
    categories: record.venue ? [record.venue] : [],
    citations: record.citationCount ?? 0,
  };
}

/** GET with the optional API key attached (x-api-key). */
async function getWithKey<T>(url: string, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
  const headers: Record<string, string> = {};
  const key = semanticScholarApiKey();
  if (key) headers["x-api-key"] = key;
  return getJson<T>(url, { signal: options.signal, timeoutMs: options.timeoutMs, headers });
}

/** The field projection every request asks for. */
const FIELDS = [
  "paperId",
  "title",
  "abstract",
  "year",
  "authors",
  "venue",
  "citationCount",
  "doi",
  "url",
  "openAccessPdf",
  "externalIds",
].join(",");

export const semanticSource: SourceAdapter = {
  id: "semantic",
  canDownload: true,
  async search(args: SearchArgs): Promise<Paper[]> {
    const params: Record<string, string | number | undefined> = {
      query: args.query,
      limit: Math.min(100, args.maxResults),
      fields: FIELDS,
    };
    if (args.year?.trim()) params.year = args.year.trim();
    const payload = await getWithKey<{ data?: SemanticPaper[] }>(`${SEARCH_URL}?${qs(params)}`, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    });
    return (payload.data ?? []).map(toPaper);
  },
};
