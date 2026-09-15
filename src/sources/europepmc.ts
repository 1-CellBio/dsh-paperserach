import { getJson, qs } from "../http";
import type { Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** Europe PMC REST search — biomedical literature across MED and the PMC
 * OA subset. Full-text OA hits carry links to the PDF endpoint, which the
 * fetch pool (not the source itself) downloads. */

const SEARCH_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";

interface EuropeResult {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  title?: string;
  authorString?: string;
  abstractText?: string;
  doi?: string;
  journalTitle?: string;
  pubYear?: string;
  firstPublicationDate?: string;
  citedByCount?: number;
  isOpenAccess?: string;
  fullTextUrlList?: { fullTextUrl?: Array<{ availability?: string; documentStyle?: string; url?: string }> };
}

interface EuropeResponse {
  resultList?: { result?: EuropeResult[] };
}

/** Best OA/PDF URL from the fulltext link list. */
function pdfUrlOf(result: EuropeResult): string {
  const links = result.fullTextUrlList?.fullTextUrl ?? [];
  const pdf = links.find((link) => (link.documentStyle ?? "").toLowerCase() === "pdf" && link.url);
  return pdf?.url ?? "";
}

function toPaper(result: EuropeResult): Paper {
  const pmcid = (result.pmcid ?? "").replace(/^PMC/i, "");
  const paperId = pmcid || result.pmid || result.id || "";
  return {
    paperId,
    title: (result.title ?? "").replace(/\s*\.$/, ""),
    authors: (result.authorString ?? "").split(",").map((author) => author.trim()).filter(Boolean),
    abstract: (result.abstractText ?? "").replace(/\s+/g, " ").trim(),
    doi: result.doi ?? "",
    publishedDate: result.firstPublicationDate?.slice(0, 10) ?? (result.pubYear ?? ""),
    pdfUrl: pdfUrlOf(result),
    url: pmcid
      ? `https://europepmc.org/article/PMC/${pmcid}`
      : result.pmid
        ? `https://europepmc.org/article/MED/${result.pmid}`
        : "",
    source: "europepmc",
    categories: [result.journalTitle ?? ""].filter(Boolean),
    citations: result.citedByCount ?? 0,
  };
}

export const europepmcSource: SourceAdapter = {
  id: "europepmc",
  canDownload: false,
  async search(args: SearchArgs): Promise<Paper[]> {
    const query = qs({
      query: args.query,
      format: "json",
      pageSize: args.maxResults,
      resultType: "core",
    });
    const payload = await getJson<EuropeResponse>(`${SEARCH_URL}?${query}`, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    });
    return (payload.resultList?.result ?? []).map(toPaper).filter((paper) => paper.paperId && paper.title);
  },
};
