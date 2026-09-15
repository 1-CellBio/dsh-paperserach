import { getText, qs } from "../http";
import { absoluteUrl, decodeHtmlEntities, stripTags } from "../html";
import { extractDoi, type Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** BASE — Bielefeld Academic Search Engine, the big institutional
 * aggregator. The open HTML results page is stable from institutional IPs
 * and CAPTCHA-happy from datacenter ranges; per-source failures land in the
 * search errors map as with every fragile source. */

const SEARCH_URL = "https://www.base-search.net/Search/Results";

const BASE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface BaseRow {
  title: string;
  url: string;
  authors: string;
  year: string;
  snippet: string;
}

/** Parse one result record: the title link plus the description column. */
function parseRecord(block: string): BaseRow | undefined {
  const link = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*class\s*=\s*["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(block)
    ?? /<a[^>]+class\s*=\s*["'][^"']*title[^"']*["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
  if (!link) return undefined;
  const url = absoluteUrl(decodeHtmlEntities(link[1]!), "https://www.base-search.net");
  const title = stripTags(link[2]!);
  if (!url || !title) return undefined;
  const text = stripTags(block.replace(link[0]!, " "));
  const year = /(?:19|20)\d{2}/.exec(text)?.[0] ?? "";
  const dash = text.indexOf(" - ");
  const head = dash >= 0 ? text.slice(0, dash) : text;
  return {
    title,
    url,
    authors: head.replace(/,?\s*(?:19|20)\d{2}$/, "").trim(),
    year,
    snippet: (dash >= 0 ? text.slice(dash + 3) : text).slice(0, 300),
  };
}

/** Extract all result records from a BASE results page. */
export function parseBaseHtml(html: string): Paper[] {
  return html
    .split(/class\s*=\s*["']?record/i)
    .slice(1)
    .map((block) => parseRecord(block.split(/class\s*=\s*["']?record/i)[0]!))
    .filter((row): row is BaseRow => Boolean(row))
    .map((row) => ({
      paperId: row.url,
      title: row.title,
      authors: row.authors.split(",").map((author) => author.trim()).filter(Boolean),
      abstract: row.snippet,
      doi: extractDoi(row.url),
      publishedDate: row.year,
      pdfUrl: "",
      url: row.url,
      source: "base",
      categories: [],
      citations: 0,
    }));
}

export const baseSource: SourceAdapter = {
  id: "base",
  canDownload: false,
  async search(args: SearchArgs): Promise<Paper[]> {
    const query = qs({ lookfor: args.query, type: "all", page: 1 });
    const html = await getText(`${SEARCH_URL}?${query}`, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
      headers: { "User-Agent": BASE_UA, "Accept-Language": "en" },
    });
    if (/captcha/i.test(html)) {
      throw new Error("base is showing a CAPTCHA — institutional networks are the stable path for this source");
    }
    return parseBaseHtml(html).slice(0, args.maxResults);
  },
};
