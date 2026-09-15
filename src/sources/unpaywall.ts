import { getJson, qs } from "../http";
import { currentSourceKeys } from "../keys";
import { bareDoi, extractDoi, type Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** Unpaywall: DOI-keyed OA resolver. As a search source the query is read
 * as a DOI (the upstream contract); as the download fallback,
 * resolveOaPdfUrl maps any DOI to the best OA copy. Requires a contact
 * email per the API's polite-use policy — without one the source reports
 * a configuration error instead of hammering the endpoint anonymously. */

interface UnpaywallLocation {
  url_for_pdf?: string;
  url_for_landing_page?: string;
  host_type?: string;
}

interface UnpaywallResponse {
  doi: string;
  is_oa: boolean;
  best_oa_location?: UnpaywallLocation | null;
  oa_locations?: UnpaywallLocation[];
  title?: string;
  journal_name?: string;
  published_date?: string;
  z_authors?: Array<{ given?: string; family?: string; name?: string }>;
}

/** Contact email the API requires: unpaywallEmail first, then contactEmail. */
function unpaywallEmail(): string {
  const keys = currentSourceKeys();
  return (keys.unpaywallEmail || keys.contactEmail).trim();
}

/** Map one Unpaywall record to a paper card. */
function toPaper(record: UnpaywallResponse): Paper {
  const doi = record.doi ?? "";
  const pdfUrl = record.best_oa_location?.url_for_pdf ?? "";
  return {
    paperId: doi,
    title: record.title ?? "",
    authors: (record.z_authors ?? []).map((author) => author.name ?? [author.given, author.family].filter(Boolean).join(" ")).filter(Boolean),
    abstract: "",
    doi,
    publishedDate: (record.published_date ?? "").slice(0, 10),
    pdfUrl,
    url: pdfUrl || record.best_oa_location?.url_for_landing_page || `https://doi.org/${doi}`,
    source: "unpaywall",
    categories: record.journal_name ? [record.journal_name] : [],
    citations: 0,
  };
}

/** Query one DOI against the Unpaywall REST API. */
async function lookupDoi(doi: string, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<UnpaywallResponse> {
  const email = unpaywallEmail();
  if (!email) {
    throw new Error("unpaywall requires a contact email — set unpaywallEmail (or contactEmail) in the plugin settings card");
  }
  const query = qs({ email });
  return getJson<UnpaywallResponse>(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?${query}`, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

/** Fallback resolver used by the download chain: DOI → best OA PDF link.
 * Returns undefined when the DOI has no OA copy; HTTP failures propagate so
 * the chain can decide whether to fall through to Sci-Hub. */
export async function resolveOaPdfUrl(
  doi: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const bare = bareDoi(doi);
  if (!bare) return undefined;
  const record = await lookupDoi(bare, options);
  const pdf = record.best_oa_location?.url_for_pdf;
  if (pdf) return pdf;
  return record.oa_locations?.map((location) => location.url_for_pdf ?? "").find(Boolean) || undefined;
}

export const unpaywallSource: SourceAdapter = {
  id: "unpaywall",
  canDownload: false,
  async search(args: SearchArgs): Promise<Paper[]> {
    const doi = extractDoi(args.query) || bareDoi(args.query);
    if (!doi) return [];
    const record = await lookupDoi(doi, { signal: args.signal, timeoutMs: args.timeoutMs });
    return [toPaper(record)];
  },
};
