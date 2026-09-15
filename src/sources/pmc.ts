import { getJson, qs } from "../http";
import { type Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** PubMed Central via eutils esearch (pmc db) + the PMC OA web service.
 * OA articles expose a PDF through the oa.fcgi file list, so the source can
 * download natively; everything else is metadata. */

const ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const ESUMMARY_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
const OA_URL = "https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi";

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

/** Resolve a PMC id (PMCID or PMID) to an OA PDF link via the OA service. */
async function oaPdfUrl(id: string, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<string> {
  const query = qs({ id, format: "json" });
  try {
    const payload = await getJson<{ files?: Array<{ url?: string; download?: string }> }>(`${OA_URL}?${query}`, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return payload.files?.find((file) => file.download ?? file.url)?.download ?? payload.files?.[0]?.url ?? "";
  } catch {
    return "";
  }
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
    const pdf = await oaPdfUrl(`PMC${paperId.replace(/^PMC/i, "")}`, options ?? {});
    return { url: pdf, baseName: `pmc-${paperId}` };
  },
};
