import { getJson, qs, type HttpOptions } from "../http";
import { currentSourceKeys } from "../keys";
import type { Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** Zenodo repository. Public records search anonymously; an access token
 * (free) also unlocks restricted records. Files are native downloads —
 * record files carry direct content links. */

const RECORDS_URL = "https://zenodo.org/api/records";

interface ZenodoFile {
  id?: string;
  key?: string;
  size?: number;
  links?: { self?: string; content?: string };
}

interface ZenodoMetadata {
  title?: string;
  creators?: Array<{ name?: string; affiliation?: string }>;
  description?: string;
  publication_date?: string;
  doi?: string;
  publication_type?: string;
  journal?: { name?: string };
}

interface ZenodoRecord {
  id?: number | string;
  doi?: string;
  metadata?: ZenodoMetadata;
  files?: ZenodoFile[];
  links?: { self_html?: string; latest_html?: string };
  stats?: { downloads?: number; views?: number };
}

interface ZenodoResponse {
  hits?: { hits?: ZenodoRecord[] };
}

/** Attach the optional bearer token to a Zenodo request. */
async function getZenodo<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const token = currentSourceKeys().zenodoAccessToken;
  return getJson<T>(url, { ...options, headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

function toPaper(record: ZenodoRecord): Paper {
  const paperId = String(record.id ?? "");
  const files = record.files ?? [];
  const pdf = files.find((file) => (file.key ?? "").toLowerCase().endsWith(".pdf"));
  const pdfUrl = pdf?.links?.content ?? pdf?.links?.self ?? "";
  const meta = record.metadata ?? {};
  return {
    paperId,
    title: (meta.title ?? "").trim(),
    authors: (meta.creators ?? []).map((creator) => creator.name ?? "").filter(Boolean),
    abstract: stripHtml(meta.description ?? "").slice(0, 600),
    doi: record.doi ?? meta.doi ?? "",
    publishedDate: (meta.publication_date ?? "").slice(0, 10),
    pdfUrl,
    url: record.links?.self_html ?? record.links?.latest_html ?? (paperId ? `https://zenodo.org/records/${paperId}` : ""),
    source: "zenodo",
    categories: [meta.publication_type ?? "", meta.journal?.name ?? ""].filter(Boolean) as string[],
    citations: record.stats?.downloads ?? 0,
  };
}

/** Zenodo descriptions are HTML; reduce to readable text for the abstract. */
function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
}

export const zenodoSource: SourceAdapter = {
  id: "zenodo",
  canDownload: true,
  async search(args: SearchArgs): Promise<Paper[]> {
    const query = qs({ q: args.query, size: args.maxResults, sort: "bestmatch" });
    const payload = await getZenodo<ZenodoResponse>(`${RECORDS_URL}?${query}`, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    });
    return (payload.hits?.hits ?? []).map(toPaper).filter((paper) => paper.paperId && paper.title);
  },
  async download(paperId) {
    return { url: `https://zenodo.org/records/${paperId}/files/pdf`, baseName: `zenodo-${paperId}` };
  },
};
