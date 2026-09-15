import { getJson, qs } from "../http";
import type { Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** HAL — the French open archive (hal.science). The search API returns
 * JSON with docid ids and fileMain_s direct PDF links; the /document
 * endpoint of any hal id serves its PDF, so downloads are native. */

const SEARCH_URL = "https://api.archives-ouvertes.fr/search";

interface HalDoc {
  docid?: string | number;
  label_s?: string;
  uri_s?: string;
  title_s?: string[];
  authFullName_s?: string[];
  abstract_s?: string[];
  doiId_s?: string;
  publicationDate_s?: string;
  submittedDate_s?: string;
  journalTitle_s?: string;
  docType_s?: string;
  fileMain_s?: string;
}

interface HalResponse {
  response?: { docs?: HalDoc[] };
}

function toPaper(doc: HalDoc): Paper {
  const paperId = String(doc.docid ?? "");
  const pdfUrl = doc.fileMain_s ?? "";
  return {
    paperId,
    title: (doc.title_s ?? [])[0] ?? (doc.label_s ?? ""),
    authors: (doc.authFullName_s ?? []).filter(Boolean),
    abstract: ((doc.abstract_s ?? [])[0] ?? "").replace(/\s+/g, " ").trim(),
    doi: doc.doiId_s ?? "",
    publishedDate: (doc.publicationDate_s ?? doc.submittedDate_s ?? "").slice(0, 10),
    pdfUrl,
    url: doc.uri_s ?? (paperId ? `https://hal.science/hal-${paperId.replace(/^hal-/i, "")}` : ""),
    source: "hal",
    categories: [doc.docType_s ?? "", doc.journalTitle_s ?? ""].filter(Boolean),
    citations: 0,
  };
}

export const halSource: SourceAdapter = {
  id: "hal",
  canDownload: true,
  async search(args: SearchArgs): Promise<Paper[]> {
    const params = qs({
      q: args.query,
      rows: args.maxResults,
      wt: "json",
      fl: [
        "docid",
        "label_s",
        "uri_s",
        "title_s",
        "authFullName_s",
        "abstract_s",
        "doiId_s",
        "publicationDate_s",
        "fileMain_s",
        "docType_s",
        "journalTitle_s",
      ].join(","),
    });
    const payload = await getJson<HalResponse>(`${SEARCH_URL}?${params}`, {
      signal: args.signal,
      timeoutMs: args.timeoutMs,
    });
    return (payload.response?.docs ?? []).map(toPaper).filter((paper) => paper.paperId && paper.title);
  },
  async download(paperId) {
    const id = paperId.replace(/^hal-/i, "");
    return { url: `https://hal.science/hal-${id}/document`, baseName: `hal-${id}` };
  },
};
