import { currentSourceKeys } from "../keys";
import type { Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "./adapter";

/** ACM has no open metadata API. The connector stays key-gated visible (a
 * stored key proves intent) but search always explains the alternatives —
 * crossref and semantic cover ACM venues well. */
function acmApiKey(): string {
  return currentSourceKeys().acmApiKey;
}

export const acmSource: SourceAdapter = {
  id: "acm",
  canDownload: false,
  async search(_args: SearchArgs): Promise<Paper[]> {
    const hasKey = Boolean(acmApiKey());
    throw new Error(
      hasKey
        ? "ACM exposes no open metadata API — search crossref or semantic instead (both cover ACM venues)"
        : "ACM exposes no open metadata API (and no ACM API key is stored) — search crossref or semantic instead",
    );
  },
};
