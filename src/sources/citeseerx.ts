import { getJson, qs } from "../http";
import type { Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** CiteSeerX — the old AI/CS literature index. The public JSON endpoint is
 * occasionally protected by aggressive bot filtering; per-source failures
 * are expected behavior and land in the search errors map. */

const SEARCH_URL = "https://citeseerx.ist.psu.edu/search";

interface CiteSeerxDoc {
  id?: string | number;
  title?: string;
  authors?: string[] | string;
  abstract?: string;
  year?: string | number;
  venue?: string;
  URLs?: string;
}

interface CiteSeerxResponse {
  response?: { docs?: CiteSeerxDoc[] };
}

function toPaper(doc: CiteSeerxDoc): Paper {
  const paperId = String(doc.id ?? "");
  const raw = doc.authors ?? [];
  const authors = Array.isArray(raw) ? raw : raw.split(/[;,]/);
  return {
    paperId,
    title: (doc.title ?? "").trim(),
    authors: authors.map((author) => author.trim()).filter(Boolean),
    abstract: (doc.abstract ?? "").replace(/\s+/g, " ").trim(),
    doi: "",
    publishedDate: doc.year ? String(doc.year) : "",
    pdfUrl: paperId ? `https://citeseerx.ist.psu.edu/document?repid=rep1&type=pdf&doi=${paperId}` : "",
    url: doc.URLs ?? "",
    source: "citeseerx",
    categories: [doc.venue ?? ""].filter(Boolean),
    citations: 0,
  };
}

export const citeseerxSource: SourceAdapter = {
  id: "citeseerx",
  canDownload: false,
  async search(args: SearchArgs): Promise<Paper[]> {
    const query = qs({ q: args.query, format: "json", size: args.maxResults });
    const payload = await getJson<CiteSeerxResponse>(`${SEARCH_URL}?${query}`, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    });
    return (payload.response?.docs ?? []).map(toPaper).filter((paper) => paper.paperId && paper.title);
  },
};
