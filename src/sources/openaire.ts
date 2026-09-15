import { getJson, qs } from "../http";
import { extractDoi, type Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** OpenAIRE research graph — EU project outputs aggregated from repositories.
 * Records expose fileMain_s direct links that join the fetch pool; the
 * source is also the FIRST stop of the repository fallback chain (by DOI,
 * then title), so its search tolerates both identifier shapes. */

const SEARCH_URL = "https://api.openaire.eu/search/publications";

interface OpenAireResultRecord {
  metadata?: {
    "oaf:entity"?: {
      "oaf:result"?: {
        title?: Array<{ content?: string | Array<string> }>;
        creator?: Array<{ content?: string }>;
        dateofacceptance?: Array<{ content?: string }>;
        description?: Array<{ content?: string | Array<string> }>;
        journal?: { name?: string };
        children?: Array<{
          instance?: Array<{
            webresource?: Array<{ url?: string }>;
          }>;
        }>;
      };
    };
  };
}

interface OpenAireResponse {
  response?: { results?: number; result?: OpenAireResultRecord[] };
}

/** Flatten OpenAIRE's repeated content-array wrappers. */
function contentOf(value: { content?: string | Array<string> } | undefined): string {
  if (!value?.content) return "";
  return Array.isArray(value.content) ? (value.content[0] ?? "") : value.content;
}

/** Collect the fileMain-style direct file URLs of a record. */
function fileUrls(record: OpenAireResultRecord): string[] {
  const result = record.metadata?.["oaf:entity"]?.["oaf:result"];
  const urls: string[] = [];
  for (const child of result?.children ?? []) {
    for (const instance of child.instance ?? []) {
      for (const resource of instance.webresource ?? []) {
        const url = resource.url?.trim();
        if (url?.startsWith("http")) urls.push(url);
      }
    }
  }
  return urls;
}

function toPaper(record: OpenAireResultRecord, index: number): Paper {
  const result = record.metadata?.["oaf:entity"]?.["oaf:result"] ?? {};
  const files = fileUrls(record);
  const title = contentOf(result.title?.[0]);
  const landing = files.find((file) => !file.endsWith(".pdf")) ?? files[0] ?? "";
  return {
    paperId: `openaire-${index}-${title.slice(0, 40)}`,
    title,
    authors: (result.creator ?? []).map((creator) => creator.content ?? "").filter(Boolean),
    abstract: contentOf(result.description?.[0]).replace(/\s+/g, " ").trim(),
    doi: extractDoi(landing),
    publishedDate: (contentOf(result.dateofacceptance?.[0]) ?? "").slice(0, 10),
    pdfUrl: files.find((file) => file.endsWith(".pdf")) ?? "",
    url: landing,
    source: "openaire",
    categories: [result.journal?.name ?? ""].filter(Boolean),
    citations: 0,
  };
}

export const openaireSource: SourceAdapter = {
  id: "openaire",
  canDownload: false,
  async search(args: SearchArgs): Promise<Paper[]> {
    const query = qs({ keywords: args.query, size: args.maxResults, format: "json" });
    const payload = await getJson<OpenAireResponse>(`${SEARCH_URL}?${query}`, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    });
    return (payload.response?.result ?? [])
      .map((record, index) => toPaper(record, index))
      .filter((paper) => paper.title);
  },
};
