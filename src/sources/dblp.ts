import { getText, qs } from "../http";
import { findAll, nodeText, parseXml, type XmlNode } from "../xml";
import type { Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** dblp computer-science bibliography — the classic XML publication search.
 * Metadata only; records carry DOIs that feed the fallback download chain. */

const SEARCH_URL = "https://dblp.org/search/publ/api";

interface DblpHit {
  authors: string[];
  title: string;
  venue: string;
  year: string;
  doi: string;
  url: string;
  key: string;
}

/** Parse one <hit> block of the publ API XML response. */
function parseHit(hit: XmlNode): DblpHit | undefined {
  const info = findAll(hit, "info")[0];
  if (!info) return undefined;
  const title = nodeText(findAll(info, "title")[0]);
  if (!title) return undefined;
  return {
    authors: findAll(info, "authors").flatMap((node) => findAll(node, "author")).map((author) => nodeText(author)).filter(Boolean),
    title,
    venue: nodeText(findAll(info, "venue")[0]),
    year: nodeText(findAll(info, "year")[0]),
    doi: nodeText(findAll(info, "doi")[0]),
    url: nodeText(findAll(info, "url")[0]),
    key: nodeText(findAll(info, "key")[0]),
  };
}

/** Extract all publication hits from a dblp XML response. */
export function parseDblpXml(xml: string): Paper[] {
  const root = parseXml(xml);
  const papers: Paper[] = [];
  for (const hit of findAll(root, "hit")) {
    const parsed = parseHit(hit);
    if (!parsed?.key) continue;
    papers.push({
      paperId: parsed.key,
      title: parsed.title,
      authors: parsed.authors,
      abstract: "",
      doi: parsed.doi,
      publishedDate: parsed.year,
      pdfUrl: "",
      url: parsed.url,
      source: "dblp",
      categories: [parsed.venue].filter(Boolean),
      citations: 0,
    });
  }
  return papers;
}

export const dblpSource: SourceAdapter = {
  id: "dblp",
  canDownload: false,
  async search(args: SearchArgs): Promise<Paper[]> {
    const query = qs({ q: args.query, format: "xml", h: args.maxResults });
    const xml = await getText(`${SEARCH_URL}?${query}`, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    });
    return parseDblpXml(xml);
  },
};
