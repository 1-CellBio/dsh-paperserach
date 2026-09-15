import { getJson, qs } from "../http";
import { currentSourceKeys } from "../keys";
import { extractDoi, type Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** Crossref works API — metadata backbone for DOI-bearing literature.
 * Polite-pool mailto (contactEmail) when configured; no native PDFs, so
 * downloads ride the repository/unpaywall fallback chain. */

const WORKS_URL = "https://api.crossref.org/works";

interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string;
}

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  author?: CrossrefAuthor[];
  abstract?: string;
  "container-title"?: string[];
  type?: string;
  issued?: { "date-parts"?: number[][] };
  "is-referenced-by-count"?: number;
  URL?: string;
  link?: Array<{ URL?: string; "content-type"?: string }>;
}

interface CrossrefResponse {
  message?: { items?: CrossrefItem[] };
}

function authorName(author: CrossrefAuthor): string {
  if (author.name) return author.name;
  return [author.given, author.family].filter(Boolean).join(" ").trim();
}

/** Map one works item onto the shared paper card. */
function toPaper(item: CrossrefItem): Paper {
  const doi = (item.DOI ?? "").toLowerCase();
  const year = item.issued?.["date-parts"]?.[0]?.[0];
  const pdfLink = item.link?.find((link) => (link["content-type"] ?? "").includes("pdf"))?.URL ?? "";
  return {
    paperId: doi,
    title: (item.title ?? [])[0] ?? "",
    authors: (item.author ?? []).map(authorName).filter(Boolean),
    abstract: (item.abstract ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    doi,
    publishedDate: year ? String(year) : "",
    pdfUrl: pdfLink,
    url: item.URL ?? (doi ? `https://doi.org/${doi}` : ""),
    source: "crossref",
    categories: [item.type ?? "", (item["container-title"] ?? [])[0] ?? ""].filter(Boolean),
    citations: item["is-referenced-by-count"] ?? 0,
  };
}

export const crossrefSource: SourceAdapter = {
  id: "crossref",
  canDownload: false,
  async search(args: SearchArgs): Promise<Paper[]> {
    const params: Record<string, string | number | undefined> = {
      query: args.query,
      rows: args.maxResults,
      select: "DOI,title,author,abstract,container-title,type,issued,is-referenced-by-count,URL,link",
    };
    const email = currentSourceKeys().contactEmail.trim();
    if (email) params.mailto = email;
    const payload = await getJson<CrossrefResponse>(`${WORKS_URL}?${qs(params)}`, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    });
    const papers = (payload.message?.items ?? []).map(toPaper).filter((paper) => paper.paperId || paper.title);
    for (const paper of papers) {
      if (!paper.doi) paper.doi = extractDoi(paper.url);
    }
    return papers;
  },
};
