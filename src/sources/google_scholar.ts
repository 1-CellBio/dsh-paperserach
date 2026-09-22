import { getText, qs } from "../http";
import { currentSourceKeys } from "../keys";
import { parseProxyUrl, proxyFetchText } from "../proxy";
import { absoluteUrl, decodeHtmlEntities, stripTags } from "../html";
import type { Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** Google Scholar — HTML scraping against the classic results page. Fragile
 * by nature (CAPTCHAs, IP blocks); an optional forward proxy
 * (scholarProxyUrl, http:// or socks5://) routes every request around
 * datacenter/institutional blocks, exactly like the upstream connector. */

const SEARCH_URL = "https://scholar.google.com/scholar";

const SCHOLAR_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** One parsed result row: title link plus the metadata column beneath it. */
interface ScholarRow {
  title: string;
  url: string;
  authors: string;
  year: string;
  citations: number;
  snippet: string;
}

/** Split one result block into its heading link + free-text line. */
function parseRow(block: string): ScholarRow | undefined {
  const heading = /<h3[^>]*>\s*<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
  if (!heading) return undefined;
  const url = absoluteUrl(decodeHtmlEntities(heading[1]!), "https://scholar.google.com");
  const title = stripTags(heading[2]!);
  if (!url || !title) return undefined;
  // Remaining text: "R Chen, J Doe - journal, 2020 - publisher — cited by 123 — snippet…"
  const text = stripTags(block.replace(heading[0]!, " "));
  const dash = text.indexOf(" - ") >= 0 ? text.indexOf(" - ") : text.indexOf(" – ");
  const head = dash >= 0 ? text.slice(0, dash) : text;
  const tail = dash >= 0 ? text.slice(dash + 3) : "";
  // The year comes from the author segment only (after the title link,
  // before the first " - "). A four-digit year anywhere else — the snippet,
  // "cited by 2019" counts — must never masquerade as the publication year;
  // a segment without one leaves publishedDate empty.
  const year = dash >= 0 ? (/(?:19|20)\d{2}/.exec(head)?.[0] ?? "") : "";
  const authors = head.replace(/,?\s*(?:19|20)\d{2}$/, "").trim();
  const citations = Number(/cited by (\d+)/i.exec(tail)?.[1] ?? 0) || 0;
  return { title, url, authors, year, citations, snippet: tail.slice(0, 300) };
}

/** Extract every result row from a Scholar results page. */
export function parseScholarHtml(html: string): Paper[] {
  const papers: Paper[] = [];
  const blocks = html.split(/<div class="gs_r gs_or gs_scl"[^>]*>/i).slice(1);
  for (const block of blocks) {
    const row = parseRow(block);
    if (!row) continue;
    const pdfHref = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>\s*\[PDF\]/i.exec(block);
    papers.push({
      paperId: row.url,
      title: row.title,
      authors: row.authors.split(",").map((author) => author.trim()).filter(Boolean),
      abstract: row.snippet,
      doi: "",
      publishedDate: row.year,
      pdfUrl: pdfHref ? absoluteUrl(decodeHtmlEntities(pdfHref[1]!), "https://scholar.google.com") : "",
      url: row.url,
      source: "google_scholar",
      categories: [],
      citations: row.citations,
    });
  }
  return papers.filter((paper) => paper.title && paper.url);
}

export const googleScholarSource: SourceAdapter = {
  id: "google_scholar",
  canDownload: false,
  async search(args: SearchArgs): Promise<Paper[]> {
    const query = qs({ q: args.query, hl: "en", as_sdt: "0,5", num: Math.min(20, args.maxResults) });
    const url = `${SEARCH_URL}?${query}`;
    const proxyUrl = currentSourceKeys().scholarProxyUrl.trim();
    const html = proxyUrl && parseProxyUrl(proxyUrl)
      ? (await proxyFetchText(url, proxyUrl, { signal: args.signal, timeoutMs: args.timeoutMs, headers: { "User-Agent": SCHOLAR_UA } })).text
      : await getText(url, { signal: args.signal, timeoutMs: args.timeoutMs, headers: { "User-Agent": SCHOLAR_UA } });
    if (/id\s*=\s*["']?gs_captcha/i.test(html) || /unusual traffic/i.test(html)) {
      throw new Error("google_scholar is rate-limiting this IP (CAPTCHA page) — configure scholarProxyUrl or retry later");
    }
    return parseScholarHtml(html);
  },
};
