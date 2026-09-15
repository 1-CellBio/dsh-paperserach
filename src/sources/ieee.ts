import { getJson, qs } from "../http";
import { currentSourceKeys } from "../keys";
import type { Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** IEEE Xplore metadata API (v1) — key-gated: the connector only appears in
 * the source list while an API key is configured, mirroring the upstream
 * gating contract. Metadata only; PDFs flow through the fallback chain. */

const SEARCH_URL = "http://ieeexploreapi.ieee.org/api/v1/search/articles";

interface IeeeArticle {
  article_number?: string;
  article_title?: string;
  publication_title?: string;
  publication_year?: string;
  content_type?: string;
  abstract?: string;
  doi?: string;
  authors?: { authors?: Array<{ full_name?: string }> };
}

interface IeeeResponse {
  total_records?: number;
  articles?: IeeeArticle[];
}

/** The IEEE Xplore API key resolved through the credentials seam. */
function ieeeApiKey(): string {
  return currentSourceKeys().ieeeApiKey;
}

/** Map an Xplore response to paper cards; titleless records are dropped and
 * the id degrades from article_number to DOI. */
export function parseIeeeResponse(payload: IeeeResponse): Paper[] {
  const papers: Paper[] = [];
  for (const article of payload.articles ?? []) {
    const title = (article.article_title ?? "").trim();
    if (!title) continue;
    const doi = (article.doi ?? "").trim();
    const paperId = (article.article_number ?? "").trim() || doi;
    if (!paperId) continue;
    papers.push({
      paperId,
      title,
      authors: (article.authors?.authors ?? []).map((author) => author.full_name ?? "").filter(Boolean),
      abstract: article.abstract ?? "",
      doi,
      publishedDate: (article.publication_year ?? "").trim(),
      pdfUrl: "",
      url: doi ? `https://doi.org/${doi}` : `https://ieeexplore.ieee.org/document/${paperId}`,
      source: "ieee",
      categories: [article.publication_title, article.content_type].filter(Boolean) as string[],
      citations: 0,
    });
  }
  return papers;
}

export const ieeeSource: SourceAdapter = {
  id: "ieee",
  canDownload: false,
  async search(args: SearchArgs): Promise<Paper[]> {
    const apiKey = ieeeApiKey();
    if (!apiKey) {
      throw new Error(
        "ieee requires an IEEE Xplore API key — store one via the plugin settings card (credential reference ieeeApiKeyEnv, env PAPERSEARCH_IEEE_API_KEY / IEEE_API_KEY)",
      );
    }
    const query = qs({
      apikey: apiKey,
      querytext: args.query,
      max_records: args.maxResults,
      sort_field: "article_number",
      sort_order: "asc",
    });
    const payload = await getJson<IeeeResponse>(`${SEARCH_URL}?${query}`, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    });
    return parseIeeeResponse(payload);
  },
};
