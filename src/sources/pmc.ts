import { getJson, qs } from "../http";
import { type Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";
import { resolvePmcOpenDataPdfUrl } from "./pmc_open_data";

/** PubMed Central via eutils esearch (pmc db). Open-access articles expose a
 * PDF in the PMC Open Access bucket (see pmc_open_data), so the source can
 * download natively; everything else is metadata. */

const ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const ESUMMARY_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";

interface ESearchResponse {
  esearchresult?: { idlist?: string[] };
}

interface ESummaryResponse {
  result?: { uids?: string[]; [uid: string]: unknown };
}

interface PmcSummary {
  uid?: string;
  title?: string;
  authors?: Array<{ name?: string }>;
  source?: string;
  pubdate?: string;
  articleids?: Array<{ idtype?: string; value?: string }>;
}

function toPaper(summary: PmcSummary): Paper {
  const paperId = (summary.uid ?? "").replace(/^PMC/i, "");
  const doi = summary.articleids?.find((id) => id.idtype === "doi")?.value ?? "";
  return {
    paperId,
    title: (summary.title ?? "").replace(/\s*\.$/, ""),
    authors: (summary.authors ?? []).map((author) => author.name ?? "").filter(Boolean),
    abstract: "",
    doi,
    publishedDate: (summary.pubdate ?? "").slice(0, 4),
    pdfUrl: "",
    url: paperId ? `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${paperId}/` : "",
    source: "pmc",
    categories: [summary.source ?? ""].filter(Boolean),
    citations: 0,
  };
}

export const pmcSource: SourceAdapter = {
  id: "pmc",
  canDownload: true,
  async search(args: SearchArgs): Promise<Paper[]> {
    const search = qs({ db: "pmc", term: args.query, retmax: args.maxResults, retmode: "json", sort: "relevance" });
    const found = await getJson<ESearchResponse>(`${ESEARCH_URL}?${search}`, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    });
    const ids = found.esearchresult?.idlist ?? [];
    if (ids.length === 0) return [];
    const summary = qs({ db: "pmc", id: ids.join(","), retmode: "json" });
    const payload = await getJson<ESummaryResponse>(`${ESUMMARY_URL}?${summary}`, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    });
    const papers: Paper[] = [];
    for (const uid of payload.result?.uids ?? []) {
      const record = (payload.result ?? {})[uid] as PmcSummary | undefined;
      if (!record?.title) continue;
      papers.push(toPaper(record));
    }
    return papers;
  },
  async download(paperId, options) {
    const pdf = await resolvePmcOpenDataPdfUrl(paperId, options ?? {});
    return { url: pdf ?? "", baseName: `pmc-${paperId}` };
  },
};
