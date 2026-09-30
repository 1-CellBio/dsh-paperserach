import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { DEFAULT_PDF_DIR } from "./paths";
import { setCredentialResolver } from "./keys";
import { installPapersearchSettings } from "./settings";
import type { PapersearchConfigEntry } from "./types";
import { registerTools } from "./tools";

export const name = "dsh-papersearch";
export const inject = ["tools", "systemPrompt"];

/**
 * 0.1.7：Config 是 Loader entry 视图（volatile 字段为 Volatile 实例，
 * settings.ts 组装 PapersearchConfig 快照供下游）；快照类型见 types.ts。
 */
export type Config = PapersearchConfigEntry;

// 0.1.7：volatile schema 裸声明（schemastery 的 volatile 输出类型与 z<T>
// 标注位不兼容，宿主 bash-local/ui-theme 同款），键位一致性靠
// PapersearchConfigEntry 与此字面量的同构评审维持。可编辑字段 volatile
// 化（settings 页自动表单直编）；credential-ref 字段保持静态。
export const Config = z.object({
  pdfDir: z.string().default(DEFAULT_PDF_DIR).volatile(),
  searchTimeoutMs: z.number().default(120_000).volatile(),
  downloadTimeoutMs: z.number().default(300_000).volatile(),
  coreApiKeyEnv: z.string().role("credential-ref").default("CORE_API_KEY"),
  doajApiKeyEnv: z.string().role("credential-ref").default("DOAJ_API_KEY"),
  zenodoAccessTokenEnv: z.string().role("credential-ref").default("ZENODO_ACCESS_TOKEN"),
  semanticScholarApiKeyEnv: z.string().role("credential-ref").default("SEMANTIC_SCHOLAR_API_KEY"),
  unpaywallEmail: z.string().default("").volatile(),
  contactEmail: z.string().default("").volatile(),
  ieeeApiKeyEnv: z.string().role("credential-ref").default("IEEE_API_KEY"),
  acmApiKeyEnv: z.string().role("credential-ref").default("ACM_API_KEY"),
  scholarProxyUrl: z.string().default("").volatile(),
  useScihub: z.boolean().default(true).volatile(),
  scihubBaseUrl: z.string().default("").volatile(),
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
  const getConfig = installPapersearchSettings(ctx, config);
  registerTools(ctx, getConfig);
}
