import { getText } from "../http";
import { stripTags } from "../html";
import { extractDoi, type Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** IACR ePrint archive — the Cryptology ePrint Archive serves simple HTML
 * search results with direct PDF links, so search and download are both
 * native. */

const SEARCH_URL = "https://eprint.iacr.org/search";

interface EprintRow {
  paperId: string;
  title: string;
  authors: string;
  abstract: string;
  date: string;
  pdfUrl: string;
}

/** Parse one search hit block into a row. */
function parseRow(block: string): EprintRow | undefined {
  const idMatch = /href\s*=\s*["']\/(\d{4}\/\d+)["']/i.exec(block);
  if (!idMatch) return undefined;
  const paperId = idMatch[1]!;
  const titleMatch = /class\s*=\s*["']?searchhit["']?[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    ?? /<strong[^>]*>([\s\S]*?)<\/strong>/i.exec(block);
  const title = titleMatch ? stripTags(titleMatch[1]!) : "";
  if (!title) return undefined;
  const authors = stripTags(/class\s*=\s*["']?searchauthors["']?[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? "");
  const abstract = stripTags(/class\s*=\s*["']?abstract["']?[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? "");
  const date = /(\d{4}-\d{2}-\d{2})/.exec(block)?.[1] ?? "";
  return { paperId, title, authors, abstract, date, pdfUrl: `https://eprint.iacr.org/${paperId}.pdf` };
}

/** Extract all hits from an ePrint results page. */
export function parseEprintHtml(html: string): Paper[] {
  return html
    .split(/class\s*=\s*["']?searchhitbox["']?/i)
    .slice(1)
    .map((block) => parseRow(block))
    .filter((row): row is EprintRow => Boolean(row))
    .map((row) => ({
      paperId: row.paperId,
      title: row.title,
      authors: row.authors.split(/,|;/).map((author) => author.trim()).filter(Boolean),
      abstract: row.abstract,
      doi: extractDoi(row.abstract),
      publishedDate: row.date,
      pdfUrl: row.pdfUrl,
      url: `https://eprint.iacr.org/${row.paperId}`,
      source: "iacr",
      categories: [],
      citations: 0,
    }));
}

export const iacrSource: SourceAdapter = {
  id: "iacr",
  canDownload: true,
  async search(args: SearchArgs): Promise<Paper[]> {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(args.query)}`;
    const html = await getText(url, { signal: args.signal, timeoutMs: args.timeoutMs });
    return parseEprintHtml(html).slice(0, args.maxResults);
  },
  async download(paperId) {
    const id = paperId.replace(/\.pdf$/i, "");
    return { url: `https://eprint.iacr.org/${id}.pdf`, baseName: `iacr-${id.replace("/", "_")}` };
  },
};
