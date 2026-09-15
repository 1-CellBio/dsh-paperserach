import { getJson, qs } from "../http";
import { currentSourceKeys } from "../keys";
import type { Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** OpenAlex works index. Abstracts ship as an inverted index (word →
 * positions); reconstructing the sentence is a small index-flip. pdfUrl
 * joins the fetch pool even though the source cannot download itself. */

const WORKS_URL = "https://api.openalex.org/works";

type InvertedIndex = Record<string, number[]>;

interface OpenAlexAuthorship {
  author?: { display_name?: string };
}

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  cited_by_count?: number | null;
  type?: string | null;
  primary_location?: {
    source?: { display_name?: string | null } | null;
    landing_page_url?: string | null;
    pdf_url?: string | null;
  } | null;
  authorships?: OpenAlexAuthorship[];
  abstract_inverted_index?: InvertedIndex | null;
}

interface OpenAlexResponse {
  results?: OpenAlexWork[];
  meta?: { count?: number };
}

/** Rebuild the abstract sentence from OpenAlex's inverted index. */
export function rebuildAbstract(index: InvertedIndex | null | undefined): string {
  if (!index) return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions ?? []) {
      words[position] = word;
    }
  }
  return words.filter(Boolean).join(" ");
}

/** The work id is a full URL — keep only the trailing W... token. */
function shortId(work: OpenAlexWork): string {
  const full = work.id ?? "";
  return full.split("/").pop() ?? full;
}

function toPaper(work: OpenAlexWork): Paper {
  const doi = (work.doi ?? "").replace(/^https?:\/\/doi\.org\//i, "");
  const location = work.primary_location ?? {};
  return {
    paperId: shortId(work),
    title: work.title ?? work.display_name ?? "",
    authors: (work.authorships ?? []).map((authorship) => authorship.author?.display_name ?? "").filter(Boolean),
    abstract: rebuildAbstract(work.abstract_inverted_index),
    doi,
    publishedDate: work.publication_year ? String(work.publication_year) : "",
    pdfUrl: location.pdf_url ?? "",
    url: location.landing_page_url ?? (doi ? `https://doi.org/${doi}` : work.id ?? ""),
    source: "openalex",
    categories: [work.type ?? "", location.source?.display_name ?? ""].filter(Boolean) as string[],
    citations: work.cited_by_count ?? 0,
  };
}

export const openalexSource: SourceAdapter = {
  id: "openalex",
  canDownload: false,
  async search(args: SearchArgs): Promise<Paper[]> {
    const params: Record<string, string | number | undefined> = {
      search: args.query,
      per_page: Math.min(50, args.maxResults),
     mailto: currentSourceKeys().contactEmail.trim() || undefined,
    };
    const payload = await getJson<OpenAlexResponse>(`${WORKS_URL}?${qs(params)}`, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    });
    return (payload.results ?? []).map(toPaper);
  },
};
