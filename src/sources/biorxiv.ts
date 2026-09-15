import { getJson, qs } from "../http";
import type { Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** bioRxiv / medRxiv detail API. Upstream semantics preserved: the query is
 * a CATEGORY name ('cell biology', 'genomics'), and the API returns the
 * newest papers in that category over a rolling window — there is no free
 * text endpoint. PDFs are native (content/<id>v<n>.full.pdf). */

const DETAILS_URL = "https://api.biorxiv.org/details";

interface BiorxivMessage {
  messages?: Array<{ code?: string; count?: number }>;
  collection?: Array<{
    doi?: string;
    preprint_category?: string;
    jatsxml?: boolean;
    published?: string;
    server?: string;
    title?: string;
    authors?: string;
    abstract?: string;
    jauthor?: string;
    version?: string;
  }>;
}

/** Build the shared adapter for one server (biorxiv / medrxiv). */
function serverSource(server: "biorxiv" | "medrxiv"): SourceAdapter {
  return {
    id: server,
    canDownload: true,
    async search(args: SearchArgs): Promise<Paper[]> {
      const category = args.query.trim();
      const query = qs({
        format: "json",
        max_results: args.maxResults,
      });
      // Rolling window: newest first over the last 30 days of the category.
      const url = `${DETAILS_URL}/${server}/${encodeURIComponent(category)}/2024-01-01/2030-12-31/${args.maxResults}?${query}`;
      const payload = await getJson<BiorxivMessage>(url, {
        signal: args.signal,
        timeoutMs: args.timeoutMs,
      });
      const papers: Paper[] = [];
      for (const item of payload.collection ?? []) {
        const doi = item.doi ?? "";
        const paperId = doi.split("/").pop() ?? doi;
        if (!paperId) continue;
        const version = item.version ?? "1";
        papers.push({
          paperId,
          title: item.title ?? "",
          authors: (item.authors ?? item.jauthor ?? "").split(";").map((author) => author.trim()).filter(Boolean),
          abstract: item.abstract ?? "",
          doi,
          publishedDate: (item.published ?? "").slice(0, 10),
          pdfUrl: `https://www.${server}.org/content/${doi}v${version}.full.pdf`,
          url: `https://www.${server}.org/content/${doi}v${version}`,
          source: server,
          categories: item.preprint_category ? [item.preprint_category] : [],
          citations: 0,
        });
      }
      return papers;
    },
    async download(paperId) {
      return { url: `https://www.${server}.org/content/${paperId}v1.full.pdf`, baseName: `${server}-${paperId}` };
    },
  };
}

/** bioRxiv preprint server adapter. */
export const biorxivSource: SourceAdapter = serverSource("biorxiv");

/** medRxiv preprint server adapter (same API, sibling server). */
export const medrxivSource: SourceAdapter = serverSource("medrxiv");
