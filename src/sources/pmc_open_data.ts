import { getText, qs } from "../http";

/** PMC Open Access bucket (AWS Open Data, `pmc-oa-opendata`): every open-access
 * article is stored as `<PMCID>.<version>/<PMCID>.<version>.pdf` and served over
 * plain HTTPS. This is the route that works for scripted clients: Europe PMC's
 * `?pdf=render` links sit behind a Cloudflare challenge (HTTP 403) and the old
 * `oa.fcgi` web service answers 404. Articles outside the open-access subset
 * have no PDF key here. */
const BUCKET_URL = "https://pmc-oa-opendata.s3.amazonaws.com";

/**
 * PDF link of an article in the PMC Open Access bucket, newest version first.
 * @param pmcid - `PMC1234567` or the bare digits.
 * @param options - abort signal and timeout of the listing request.
 * @returns the PDF URL, or undefined when the article is not in the bucket.
 * @throws HttpError (or a network error) when the bucket listing fails — the caller reports it as an unavailable source.
 */
export async function resolvePmcOpenDataPdfUrl(
  pmcid: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const id = `PMC${pmcid.replace(/^PMC/i, "")}`;
  const listing = await getText(`${BUCKET_URL}/?${qs({ "list-type": 2, prefix: `${id}.`, "max-keys": 100 })}`, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  let best: { version: number; key: string } | undefined;
  for (const match of listing.matchAll(/<Key>(PMC\d+\.(\d+)\/PMC\d+\.\d+\.pdf)<\/Key>/g)) {
    const version = Number(match[2]);
    if (best === undefined || version > best.version) best = { version, key: match[1]! };
  }
  return best ? `${BUCKET_URL}/${best.key}` : undefined;
}
