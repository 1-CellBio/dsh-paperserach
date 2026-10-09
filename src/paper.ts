/** Normalized paper record shared by every source adapter. */

export interface Paper {
  /** Source-native id: arXiv id, PMID, DOI, Semantic Scholar hash, ... */
  paperId: string;
  title: string;
  authors: string[];
  abstract: string;
  doi: string;
  /** ISO-ish published date (YYYY / YYYY-MM / YYYY-MM-DD). */
  publishedDate: string;
  pdfUrl: string;
  url: string;
  source: string;
  categories: string[];
  citations: number;
}

/** Compact transport shape — what the tools return to the model. */
export interface CompactPaper {
  paperId: string;
  title: string;
  authors: string;
  year: string;
  doi: string;
  pdfUrl: string;
  url: string;
  source: string;
  citations: number;
  abstract: string;
  /** [F3，2026-09-22 可追溯性批] true = 摘要被截到 600 字符——检索卡片
   *  的 abstract 不是全文也不是可 snap 的原文，消费方（模型/UI）不得把
   *  半段摘要当全文对待。 */
  abstractTruncated?: true;
}

const ABSTRACT_CAP = 600;
const AUTHORS_CAP = 200;
const PAPERS_CAP = 40;

export function yearOf(paper: Pick<Paper, "publishedDate">): string {
  const m = /^(\d{4})/.exec((paper.publishedDate ?? "").trim());
  return m ? m[1]! : "";
}

export function compactPaper(paper: Paper): CompactPaper {
  const abstract = (paper.abstract ?? "").replace(/\s+/g, " ").trim();
  const authors = (paper.authors ?? []).join("; ");
  const truncated = abstract.length > ABSTRACT_CAP;
  return {
    paperId: paper.paperId.trim(),
    title: paper.title.trim(),
    authors: authors.length > AUTHORS_CAP ? `${authors.slice(0, AUTHORS_CAP)}…` : authors,
    year: yearOf(paper),
    doi: paper.doi.trim(),
    pdfUrl: paper.pdfUrl.trim(),
    url: paper.url.trim(),
    source: paper.source,
    citations: typeof paper.citations === "number" ? paper.citations : 0,
    abstract: truncated ? `${abstract.slice(0, ABSTRACT_CAP)}…` : abstract,
    ...(truncated ? { abstractTruncated: true as const } : {}),
  };
}

/** Dedup key: DOI wins, then normalized title+first author, then id. */
export function paperKey(paper: Pick<Paper, "doi" | "title" | "authors" | "paperId">): string {
  const doi = (paper.doi ?? "").trim().toLowerCase();
  if (doi) return `doi:${doi}`;
  const title = (paper.title ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const firstAuthor = (paper.authors?.[0] ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (title) return `title:${title}|${firstAuthor}`;
  return `id:${(paper.paperId ?? "").trim().toLowerCase()}`;
}

/** Order-preserving dedup across merged source results. */
export function dedupePapers(papers: Paper[]): Paper[] {
  const seen = new Set<string>();
  const out: Paper[] = [];
  for (const paper of papers) {
    const key = paperKey(paper);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(paper);
  }
  return out;
}

export interface CompactSearchResult {
  query: string;
  sourcesUsed: string[];
  sourceResults: Record<string, number>;
  errors: Record<string, string>;
  total: number;
  returned: number;
  truncated: boolean;
  papers: CompactPaper[];
}

export function compactSearchResult(
  query: string,
  sourcesUsed: string[],
  perSource: Paper[][],
  errors: Record<string, string>,
): CompactSearchResult {
  const sourceResults: Record<string, number> = {};
  const merged: Paper[] = [];
  sourcesUsed.forEach((id, index) => {
    const list = perSource[index] ?? [];
    sourceResults[id] = list.length;
    merged.push(...list);
  });
  const deduped = dedupePapers(merged);
  const capped = deduped.slice(0, PAPERS_CAP).map(compactPaper);
  return {
    query,
    sourcesUsed,
    sourceResults,
    errors,
    total: deduped.length,
    returned: capped.length,
    truncated: deduped.length > PAPERS_CAP,
    papers: capped,
  };
}

const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;

/** Extract a DOI from arbitrary text (abstracts, ids, links). */
export function extractDoi(text: string | undefined | null): string {
  if (!text) return "";
  const m = DOI_RE.exec(text);
  return m ? m[0]!.replace(/[.,;)]+$/, "") : "";
}

/** The lower-cased bare DOI when `query` is nothing but a DOI (bare, `doi:` or doi.org URL form);
 * "" for titles and keyword queries — a DOI embedded in other words does not count. */
export function doiQuery(query: string | undefined | null): string {
  const value = (query ?? "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  return /^10\.\d{4,}\/\S+$/.test(value) ? value.toLowerCase() : "";
}

/** Normalize https://doi.org/… to a bare DOI. */
export function bareDoi(raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  const stripped = value.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  return extractDoi(stripped) || stripped.toLowerCase();
}
