import { getJson, qs } from "../http";
import { extractDoi, type Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** PubMed via NCBI eutils (esearch → esummary). Metadata only: PMIDs carry
 * no native PDF path, so downloads ride the repository/unpaywall fallback
 * chain on the DOI. */

const ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const ESUMMARY_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";

interface ESearchResponse {
  esearchresult?: { idlist?: string[] };
}

interface ESummaryResponse {
  result?: {
    uids?: string[];
    [uid: string]: unknown;
  };
}

interface PubmedArticleSummary {
  uid?: string;
  title?: string;
  authors?: Array<{ name?: string }>;
  sortfirstauthor?: string;
  source?: string;
  pubdate?: string;
  fulljournalname?: string;
  articleids?: Array<{ idtype?: string; value?: string }>;
}

function toPaper(summary: PubmedArticleSummary): Paper {
  const paperId = summary.uid ?? "";
  const doi = summary.articleids?.find((id) => id.idtype === "doi")?.value ?? "";
  return {
    paperId,
    title: (summary.title ?? "").replace(/\s*\.$/, ""),
    authors: (summary.authors ?? []).map((author) => author.name ?? "").filter(Boolean),
    abstract: "",
    doi,
    publishedDate: (summary.pubdate ?? "").slice(0, 4),
    pdfUrl: "",
    url: paperId ? `https://pubmed.ncbi.nlm.nih.gov/${paperId}/` : "",
    source: "pubmed",
    categories: [summary.fulljournalname ?? summary.source ?? ""].filter(Boolean),
    citations: 0,
  };
}

/** esearch: resolve the query to an ordered PMID list. */
async function searchIds(args: SearchArgs): Promise<string[]> {
  const query = qs({
    db: "pubmed",
    term: args.query,
    retmax: args.maxResults,
    retmode: "json",
    sort: "relevance",
  });
  const payload = await getJson<ESearchResponse>(`${ESEARCH_URL}?${query}`, {
    signal: args.signal,
    timeoutMs: args.timeoutMs,
  });
  return payload.esearchresult?.idlist ?? [];
}

/** esummary: hydrate PMIDs into article summaries. */
async function summarize(ids: string[], args: SearchArgs): Promise<Paper[]> {
  if (ids.length === 0) return [];
  const query = qs({ db: "pubmed", id: ids.join(","), retmode: "json" });
  const payload = await getJson<ESummaryResponse>(`${ESUMMARY_URL}?${query}`, {
    signal: args.signal,
    timeoutMs: args.timeoutMs,
  });
  const uids = payload.result?.uids ?? [];
  const papers: Paper[] = [];
  for (const uid of uids) {
    const summary = (payload.result ?? {})[uid] as PubmedArticleSummary | undefined;
    if (!summary) continue;
    const paper = toPaper(summary);
    if (!paper.paperId || !paper.title) continue;
    if (!paper.doi) paper.doi = extractDoi(paper.title);
    papers.push(paper);
  }
  return papers;
}

export const pubmedSource: SourceAdapter = {
  id: "pubmed",
  canDownload: false,
  async search(args: SearchArgs): Promise<Paper[]> {
    const ids = await searchIds(args);
    return summarize(ids, args);
  },
};
