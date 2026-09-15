import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { DEFAULT_PDF_DIR } from "./paths";
import { setCredentialResolver } from "./keys";
import { installPapersearchSettings } from "./settings";
import { registerTools } from "./tools";

export const name = "dsh-papersearch";
export const inject = ["tools", "systemPrompt"];

export interface Config {
  /** Download dir for PDFs. Default ${cwd}/OKF/sources/pdfs (dsh-okf layout). */
  pdfDir?: string;
  /** Multi-source search timeout in ms. */
  searchTimeoutMs?: number;
  /** Per-paper download timeout in ms. */
  downloadTimeoutMs?: number;
  /** Credential reference (env-var name) for the CORE API key; default CORE_API_KEY. */
  coreApiKeyEnv?: string;
  /** Credential reference for the DOAJ API key; default DOAJ_API_KEY. */
  doajApiKeyEnv?: string;
  /** Credential reference for the Zenodo access token; default ZENODO_ACCESS_TOKEN. */
  zenodoAccessTokenEnv?: string;
  /** Credential reference for the Semantic Scholar API key; default SEMANTIC_SCHOLAR_API_KEY. */
  semanticScholarApiKeyEnv?: string;
  /** Unpaywall contact email (enables the OA download fallback). */
  unpaywallEmail?: string;
  /** Contact email for polite API pools (crossref/openalex). Optional. */
  contactEmail?: string;
  /** Credential reference for the IEEE Xplore API key; default IEEE_API_KEY. */
  ieeeApiKeyEnv?: string;
  /** Credential reference for the ACM key; default ACM_API_KEY. */
  acmApiKeyEnv?: string;
  /** Forward proxy (http:// or socks5://) for Google Scholar requests. */
  scholarProxyUrl?: string;
  /** Enable the Sci-Hub mirror as the last PDF fallback (default true). */
  useScihub?: boolean;
  /** Sci-Hub mirror base URL(s), comma-separated; empty = built-in list (rotated). */
  scihubBaseUrl?: string;
}

export const Config: z<Config> = z.object({
  pdfDir: z.string().default(DEFAULT_PDF_DIR),
  searchTimeoutMs: z.number().default(120_000),
  downloadTimeoutMs: z.number().default(300_000),
  coreApiKeyEnv: z.string().role("credential-ref").default("CORE_API_KEY"),
  doajApiKeyEnv: z.string().role("credential-ref").default("DOAJ_API_KEY"),
  zenodoAccessTokenEnv: z.string().role("credential-ref").default("ZENODO_ACCESS_TOKEN"),
  semanticScholarApiKeyEnv: z.string().role("credential-ref").default("SEMANTIC_SCHOLAR_API_KEY"),
  unpaywallEmail: z.string().default(""),
  contactEmail: z.string().default(""),
  ieeeApiKeyEnv: z.string().role("credential-ref").default("IEEE_API_KEY"),
  acmApiKeyEnv: z.string().role("credential-ref").default("ACM_API_KEY"),
  scholarProxyUrl: z.string().default(""),
  useScihub: z.boolean().default(true),
  scihubBaseUrl: z.string().default(""),
});

export function apply(ctx: Context, config: Config): void {
  // Reference half of the credentials seam when a provider is mounted; without
  // one the process environment stays the whole credential plane (keys.ts
  // falls back to direct env reads).
  setCredentialResolver(async (ref) => {
    // Resolved per call (not captured at apply time) so a provider mounted
    // later is picked up; the annotation checks the call against the real
    // CredentialProvider face instead of `any`.
    const credentials: Context["credentials"] | undefined = ctx.get("credentials");
    return (await credentials?.resolve(credentialRef(ref)))?.value;
  });
  const getConfig = installPapersearchSettings(ctx, Config, config);
  registerTools(ctx, getConfig);
}
