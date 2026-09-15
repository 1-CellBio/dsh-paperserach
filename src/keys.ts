import type { PapersearchConfig } from "./types";

/**
 * Runtime view of the effective source credentials. Secret keys resolve
 * through the credentials seam (or the process environment without one);
 * non-secret settings use the settings layer first, then env. Source
 * adapters read these at CALL time, never at import time, so a settings or
 * credential change applies to the next tool call without a reload.
 */
export interface SourceKeys {
  coreApiKey: string;
  doajApiKey: string;
  zenodoAccessToken: string;
  semanticScholarApiKey: string;
  unpaywallEmail: string;
  contactEmail: string;
  ieeeApiKey: string;
  acmApiKey: string;
  scholarProxyUrl: string;
  scihubBaseUrl: string;
}

/** Secret fields resolved through the credentials seam. */
type CredentialField = "coreApiKey" | "doajApiKey" | "zenodoAccessToken" | "semanticScholarApiKey" | "ieeeApiKey" | "acmApiKey";

/** Non-secret settings that keep a plain settings → env fallback chain. */
type PlainField = "unpaywallEmail" | "contactEmail" | "scholarProxyUrl" | "scihubBaseUrl";

/** Config field naming each secret's credential reference, plus the reference
 * used when it carries no value and the historical PAPERSEARCH_* alias kept
 * so existing env-based deployments resolve unchanged. */
const CREDENTIAL_REFS: Record<CredentialField, { refField: keyof PapersearchConfig; fallbackRef: string; legacyAlias: string }> = {
  coreApiKey: { refField: "coreApiKeyEnv", fallbackRef: "CORE_API_KEY", legacyAlias: "PAPERSEARCH_CORE_API_KEY" },
  doajApiKey: { refField: "doajApiKeyEnv", fallbackRef: "DOAJ_API_KEY", legacyAlias: "PAPERSEARCH_DOAJ_API_KEY" },
  zenodoAccessToken: { refField: "zenodoAccessTokenEnv", fallbackRef: "ZENODO_ACCESS_TOKEN", legacyAlias: "PAPERSEARCH_ZENODO_ACCESS_TOKEN" },
  semanticScholarApiKey: { refField: "semanticScholarApiKeyEnv", fallbackRef: "SEMANTIC_SCHOLAR_API_KEY", legacyAlias: "PAPERSEARCH_SEMANTIC_SCHOLAR_API_KEY" },
  ieeeApiKey: { refField: "ieeeApiKeyEnv", fallbackRef: "IEEE_API_KEY", legacyAlias: "PAPERSEARCH_IEEE_API_KEY" },
  acmApiKey: { refField: "acmApiKeyEnv", fallbackRef: "ACM_API_KEY", legacyAlias: "PAPERSEARCH_ACM_API_KEY" },
};

const CREDENTIAL_FIELDS = Object.keys(CREDENTIAL_REFS) as CredentialField[];

const PLAIN_ENV_FALLBACK: Record<PlainField, string[]> = {
  unpaywallEmail: ["PAPERSEARCH_UNPAYWALL_EMAIL", "UNPAYWALL_EMAIL"],
  contactEmail: ["PAPERSEARCH_CONTACT_EMAIL"],
  scholarProxyUrl: ["PAPERSEARCH_GOOGLE_SCHOLAR_PROXY_URL", "GOOGLE_SCHOLAR_PROXY_URL"],
  scihubBaseUrl: ["PAPERSEARCH_SCI_HUB_BASE_URL", "SCI_HUB_BASE_URL"],
};

/** Installed by apply() when the plugin runs inside the harness; resolves one
 * credential reference through the mounted provider (which layers the process
 * environment, the credential store, and .env files). Absent in standalone
 * use and tests, where the process environment is read directly. */
let resolveRef: ((ref: string) => Promise<string | undefined>) | undefined;

/** @param resolve - seam resolver installed by the plugin's apply hook. */
export function setCredentialResolver(resolve: (ref: string) => Promise<string | undefined>): void {
  resolveRef = resolve;
}

let configured: PapersearchConfig = {};

/** Credential values resolved for the latest refresh; read synchronously by
 * source adapters during a tool execution. */
const resolved: Record<CredentialField, string> = {
  coreApiKey: "",
  doajApiKey: "",
  zenodoAccessToken: "",
  semanticScholarApiKey: "",
  ieeeApiKey: "",
  acmApiKey: "",
};

/** Reference names tried for one secret, in order: the configured (or
 * default) reference first, then the historical alias. */
function refNames(field: CredentialField): string[] {
  const spec = CREDENTIAL_REFS[field]!;
  const primary = (configured[spec.refField] as string | undefined)?.trim() || spec.fallbackRef;
  return primary === spec.legacyAlias ? [primary] : [primary, spec.legacyAlias];
}

async function resolveCredential(field: CredentialField): Promise<string> {
  const names = refNames(field);
  if (resolveRef !== undefined) {
    for (const name of names) {
      const value = (await resolveRef(name))?.trim();
      if (value) return value;
    }
    return "";
  }
  return fromEnv(names);
}

/**
 * Re-resolve every source credential from the current settings. Called by the
 * tools layer before each tool execution (settings → here), so a saved
 * settings change or credential-store write reaches the next call.
 * @param config - the currently authoritative settings section.
 */
export async function refreshSourceKeys(config: PapersearchConfig): Promise<void> {
  configured = config ?? {};
  await Promise.all(CREDENTIAL_FIELDS.map(async (field) => {
    resolved[field] = await resolveCredential(field);
  }));
}

function fromEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function pick(field: PlainField): string {
  const fromSettings = (configured[field] as string | undefined)?.trim();
  if (fromSettings) return fromSettings;
  return fromEnv(PLAIN_ENV_FALLBACK[field]!);
}

/** Effective credentials right now (snapshot of the latest refresh). */
export function currentSourceKeys(): SourceKeys {
  return {
    coreApiKey: resolved.coreApiKey,
    doajApiKey: resolved.doajApiKey,
    zenodoAccessToken: resolved.zenodoAccessToken,
    semanticScholarApiKey: resolved.semanticScholarApiKey,
    unpaywallEmail: pick("unpaywallEmail"),
    contactEmail: pick("contactEmail"),
    ieeeApiKey: resolved.ieeeApiKey,
    acmApiKey: resolved.acmApiKey,
    scholarProxyUrl: pick("scholarProxyUrl"),
    scihubBaseUrl: pick("scihubBaseUrl"),
  };
}

/** Whether the Sci-Hub fallback is enabled. Settings boolean wins; env
 * `PAPERSEARCH_USE_SCI_HUB=false` (also 0/off/no) disables; default on. */
export function sciHubEnabled(): boolean {
  const fromSettings = configured.useScihub;
  if (typeof fromSettings === "boolean") return fromSettings;
  const fromEnv = process.env.PAPERSEARCH_USE_SCI_HUB?.trim().toLowerCase();
  if (fromEnv === "0" || fromEnv === "false" || fromEnv === "off" || fromEnv === "no") return false;
  return true;
}
