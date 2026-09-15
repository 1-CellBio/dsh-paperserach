import { getText, qs } from "../http";
import { extractDoi, type Paper } from "../paper";
import { findAll, nodeText, parseXml } from "../xml";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** arXiv Atom API — search + direct PDF downloads. */
const SEARCH_URL = "http://export.arxiv.org/api/query";

export function parseFeed(xml: string): Paper[] {
  const root = parseXml(xml);
  const papers: Paper[] = [];
  for (const entry of findAll(root, "entry")) {
    const entryUrl = nodeText(findAll(entry, "id")[0]);
    if (!entryUrl) continue;
    const paperId = entryUrl.split("/").pop() ?? "";
    if (!paperId) continue;

    const authors = findAll(entry, "author").map((author) => nodeText(findAll(author, "name")[0])).filter(Boolean);
    const links = findAll(entry, "link");
    const pdfUrl = links.find((link) => link.attrs.type === "application/pdf")?.attrs.href ?? "";

    let doi = "";
    for (const link of links) {
      if (link.attrs.title === "doi") {
        doi = extractDoi(link.attrs.href ?? "");
        if (doi) break;
      }
    }
    const summary = nodeText(findAll(entry, "summary")[0]);
    if (!doi) doi = extractDoi(summary);
    if (!doi) doi = extractDoi(entryUrl);

    papers.push({
      paperId,
      title: nodeText(findAll(entry, "title")[0]),
      authors,
      abstract: summary,
      doi,
      publishedDate: nodeText(findAll(entry, "published")[0]).slice(0, 10),
      pdfUrl,
      url: entryUrl,
      source: "arxiv",
      categories: findAll(entry, "category").map((cat) => cat.attrs.term ?? "").filter(Boolean),
      citations: 0,
    });
  }
  return papers;
}

export const arxivSource: SourceAdapter = {
  id: "arxiv",
  canDownload: true,
  async search(args: SearchArgs): Promise<Paper[]> {
    const query = qs({
      search_query: `all:${args.query}`,
      max_results: args.maxResults,
      sortBy: "relevance",
      sortOrder: "descending",
    });
    const xml = await getText(`${SEARCH_URL}?${query}`, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    });
    return parseFeed(xml);
  },
  async download(paperId) {
    return { url: `https://arxiv.org/pdf/${paperId}`, baseName: paperId };
  },
};
