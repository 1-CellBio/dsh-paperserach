import { getText, qs } from "../http";
import { absoluteUrl, decodeHtmlEntities, stripTags } from "../html";
import { extractDoi, type Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** SSRN — the preprint network behind Elsevier. Only the abstract-listing
 * HTML is public; results are scraped conservatively and the source is
 * flagged fragile (bot walls are common). No native PDFs: delivery.cfm
 * links need a session, so downloads rely on the fallback chain. */

const SEARCH_URL = "https://papers.ssrn.com/sol3/results.cfm";

const SSRN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface SsrnRow {
  paperId: string;
  title: string;
  url: string;
  authors: string;
  date: string;
}

/** Parse one search-result row. */
function parseRow(block: string): SsrnRow | undefined {
  const link = /<a[^>]+href\s*=\s*["']([^"']*abstract[_-]?id[=_][^"']*)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block)
    ?? /<a[^>]+href\s*=\s*["']([^"']*\/abstract\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
  if (!link) return undefined;
  const url = absoluteUrl(decodeHtmlEntities(link[1]!), "https://papers.ssrn.com");
  const title = stripTags(link[2]!);
  if (!url || !title) return undefined;
  const idMatch = /abstract[_-]?id[=_](\d+)|\/abstract[=/](\d+)/i.exec(url);
  const text = stripTags(block.replace(link[0]!, " "));
  const date = /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+(?:19|20)\d{2})/i.exec(text)?.[1]
    ?? (/(?:19|20)\d{2}/.exec(text)?.[0] ?? "");
  return {
    paperId: idMatch?.[1] ?? idMatch?.[2] ?? url,
    title,
    url,
    authors: (text.split(date)[0] ?? "").split(/,|;/).map((part) => part.trim()).filter(Boolean).join(", "),
    date,
  };
}

/** Extract all result rows from a results.cfm page. */
export function parseSsrnHtml(html: string): Paper[] {
  return html
    .split(/class\s*=\s*["']?t-row|<tr[^>]*class\s*=\s*["'][^"']*result/i)
    .slice(1)
    .map((block) => parseRow(block))
    .filter((row): row is SsrnRow => Boolean(row))
    .map((row) => ({
      paperId: row.paperId,
      title: row.title,
      authors: row.authors.split(",").map((author) => author.trim()).filter(Boolean),
      abstract: "",
      doi: "",
      publishedDate: row.date,
      pdfUrl: "",
      url: row.url,
      source: "ssrn",
      categories: [],
      citations: 0,
    }));
}

export const ssrnSource: SourceAdapter = {
  id: "ssrn",
  canDownload: false,
  async search(args: SearchArgs): Promise<Paper[]> {
    const query = qs({ txtKey_Words: args.query, npage: 1 });
    const html = await getText(`${SEARCH_URL}?${query}`, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
      headers: { "User-Agent": SSRN_UA, Accept: "text/html,*/*" },
    });
    if (/captcha|are you a robot|access denied/i.test(html)) {
      throw new Error("ssrn is bot-blocking this IP (CAPTCHA/access-denied page) — retry later or use another source");
    }
    return parseSsrnHtml(html)
      .slice(0, args.maxResults)
      .map((paper) => ({ ...paper, doi: extractDoi(paper.url) }));
  },
};
