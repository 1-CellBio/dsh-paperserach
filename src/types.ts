import type { Volatile } from "@deepseek-ai/cordis";

export interface PapersearchConfig {
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
  /** Keep PDFs found only by a title search (default true; they are saved with identity "title-fallback" and dsh-okf compares the requested DOI with the compiled paper after ingest). */
  allowTitleMatch?: boolean;
}

/**
 * 0.1.7 Loader entry 视图：可编辑字段是 Volatile 实例（settings 页自动表单
 * 直编，插件实例不重载），credential-ref 字段保持静态（部署期引用名，经
 * profile patch 修改后随重载生效）。快照类型见 PapersearchConfig。
 */
export interface PapersearchConfigEntry {
  pdfDir?: Volatile<string>;
  searchTimeoutMs?: Volatile<number>;
  downloadTimeoutMs?: Volatile<number>;
  coreApiKeyEnv?: string;
  doajApiKeyEnv?: string;
  zenodoAccessTokenEnv?: string;
  semanticScholarApiKeyEnv?: string;
  unpaywallEmail?: Volatile<string>;
  contactEmail?: Volatile<string>;
  ieeeApiKeyEnv?: string;
  acmApiKeyEnv?: string;
  scholarProxyUrl?: Volatile<string>;
  useScihub?: Volatile<boolean>;
  scihubBaseUrl?: Volatile<string>;
  allowTitleMatch?: Volatile<boolean>;
}
