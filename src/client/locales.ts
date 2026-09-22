export const NS = "papersearch";

export type PapersearchLocaleKey =
  | "settings.title"
  | "settings.description"
  | "settings.unsaved"
  | "settings.sectionCredentials"
  | "settings.sectionGeneral"
  | "settings.overridden"
  | "settings.reset"
  | "settings.save"
  | "settings.discard"
  | "settings.keyUndo"
  | "settings.readOnly"
  | "settings.saveFailed"
  | "settings.coreApiKeyEnv"
  | "settings.coreApiKeyEnvHint"
  | "settings.doajApiKeyEnv"
  | "settings.doajApiKeyEnvHint"
  | "settings.zenodoAccessTokenEnv"
  | "settings.zenodoAccessTokenEnvHint"
  | "settings.semanticScholarApiKeyEnv"
  | "settings.semanticScholarApiKeyEnvHint"
  | "settings.unpaywallEmail"
  | "settings.unpaywallEmailHint"
  | "settings.contactEmail"
  | "settings.contactEmailHint"
  | "settings.ieeeApiKeyEnv"
  | "settings.ieeeApiKeyEnvHint"
  | "settings.acmApiKeyEnv"
  | "settings.acmApiKeyEnvHint"
  | "settings.scholarProxyUrl"
  | "settings.scholarProxyUrlHint"
  | "settings.scihubBaseUrl"
  | "settings.scihubBaseUrlHint"
  | "settings.pdfDir"
  | "settings.pdfDirHint"
  | "settings.coreApiKey"
  | "settings.coreApiKeyHint"
  | "settings.doajApiKey"
  | "settings.doajApiKeyHint"
  | "settings.zenodoAccessToken"
  | "settings.zenodoAccessTokenHint"
  | "settings.semanticScholarApiKey"
  | "settings.semanticScholarApiKeyHint"
  | "settings.ieeeApiKey"
  | "settings.ieeeApiKeyHint"
  | "settings.acmApiKey"
  | "settings.acmApiKeyHint"
  | "settings.keyConfigured"
  | "settings.keyNotConfigured"
  | "settings.keyWriteHint"
  | "settings.keyClear"
  | "settings.keyClearStaged"
  | "settings.advancedEnvTitle"
  | "settings.advancedEnvHint"
  | "search.title"
  | "search.searching"
  | "search.truncated"
  | "search.pdf"
  | "search.doi"
  | "search.failed"
  | "search.stopped"
  | "search.stoppedDetail"
  | "search.showMore"
  | "search.showLess"
  | "search.copyIngest"
  | "search.copied";

export const zh: Record<PapersearchLocaleKey, string> = {
  "settings.title": "Paper Search 源密钥",
  "settings.description": "学术源凭据引用与下载目录（全部可选，留空走免费档）",
  "settings.unsaved": "未保存",
  "settings.sectionCredentials": "数据源密钥",
  "settings.sectionGeneral": "常规设置",
  "settings.overridden": "已覆盖",
  "settings.reset": "重置",
  "settings.save": "保存",
  "settings.discard": "放弃更改",
  "settings.keyUndo": "撤销暂存",
  "settings.readOnly": "当前设置只读",
  "settings.saveFailed": "保存失败，请重试",
  "settings.coreApiKeyEnv": "CORE API Key 引用名（可选）",
  "settings.coreApiKeyEnvHint": "凭据引用（环境变量名），默认 CORE_API_KEY",
  "settings.doajApiKeyEnv": "DOAJ API Key 引用名（可选）",
  "settings.doajApiKeyEnvHint": "凭据引用（环境变量名），默认 DOAJ_API_KEY",
  "settings.zenodoAccessTokenEnv": "Zenodo Token 引用名（可选）",
  "settings.zenodoAccessTokenEnvHint": "凭据引用（环境变量名），默认 ZENODO_ACCESS_TOKEN",
  "settings.semanticScholarApiKeyEnv": "Semantic Scholar Key 引用名（可选）",
  "settings.semanticScholarApiKeyEnvHint": "凭据引用（环境变量名），默认 SEMANTIC_SCHOLAR_API_KEY",
  "settings.unpaywallEmail": "Unpaywall 邮箱（推荐）",
  "settings.unpaywallEmailHint": "任意有效邮箱；启用 OA 下载回退（unpaywall.org）",
  "settings.contactEmail": "礼貌池邮箱（可选）",
  "settings.contactEmailHint": "用于 crossref / openalex 礼貌池",
  "settings.ieeeApiKeyEnv": "IEEE Xplore Key 引用名（可选）",
  "settings.ieeeApiKeyEnvHint": "凭据引用（环境变量名），默认 IEEE_API_KEY",
  "settings.acmApiKeyEnv": "ACM Key 引用名（可选）",
  "settings.acmApiKeyEnvHint": "凭据引用（环境变量名），默认 ACM_API_KEY",
  "settings.scholarProxyUrl": "Google Scholar 代理（可选）",
  "settings.scholarProxyUrlHint": "http:// 或 socks5:// 正向代理，绕过 IP 封锁",
  "settings.scihubBaseUrl": "Sci-Hub 镜像地址（可选）",
  "settings.scihubBaseUrlHint": "逗号分隔多个镜像并自动轮换；留空用内置列表（sci-hub.vg/al/mk…）",
  "settings.pdfDir": "PDF 下载目录",
  "settings.pdfDirHint": "默认 ${cwd}/OKF/sources/pdfs（自动对齐 OKF 知识库来源目录）",
  "settings.coreApiKey": "CORE API Key",
  "settings.coreApiKeyHint": "免费申请：core.ac.uk/services/api，提升限额",
  "settings.doajApiKey": "DOAJ API Key",
  "settings.doajApiKeyHint": "免费申请：doaj.org/apply-for-api-key，提升每小时限额",
  "settings.zenodoAccessToken": "Zenodo Access Token",
  "settings.zenodoAccessTokenHint": "zenodo.org 账户设置创建，解锁受限记录",
  "settings.semanticScholarApiKey": "Semantic Scholar API Key",
  "settings.semanticScholarApiKeyHint": "免费申请：semanticscholar.org/product/api，提升限额（与科研写作 CSW 共享凭据）",
  "settings.ieeeApiKey": "IEEE Xplore API Key",
  "settings.ieeeApiKeyHint": "developer.ieee.org 申请；启用 ieee 源（仅元数据）",
  "settings.acmApiKey": "ACM API Key",
  "settings.acmApiKeyHint": "ACM 无公开元数据 API，存 key 后源会给出替代建议",
  "settings.keyConfigured": "已配置",
  "settings.keyNotConfigured": "未配置",
  "settings.keyWriteHint": "值不回显：留空保持不变，输入并保存即写入主机凭据存储",
  "settings.keyClear": "清除",
  "settings.keyClearStaged": "将清除",
  "settings.advancedEnvTitle": "高级：自定义环境变量名映射（可选）",
  "settings.advancedEnvHint": "通常无需修改；留空或使用默认值即可自动读取标准环境变量",
  "search.title": "文献检索",
  "search.searching": "正在检索文献…",
  "search.truncated": "命中结果超过上限，列表已截断",
  "search.pdf": "PDF",
  "search.doi": "DOI",
  "search.failed": "检索失败",
  "search.stopped": "检索已中断",
  "search.stoppedDetail": "工具调用被中断，未返回检索结果",
  "search.showMore": "展开其余 {n} 篇文献 ▾",
  "search.showLess": "收起 ▴",
  "search.copyIngest": "+ 入库",
  "search.copied": "已复制",
};

export const en: Record<PapersearchLocaleKey, string> = {
  "settings.title": "Paper Search source keys",
  "settings.description": "Academic source credential references and download dir (all optional; empty = free tier)",
  "settings.unsaved": "unsaved",
  "settings.sectionCredentials": "Source keys",
  "settings.sectionGeneral": "General",
  "settings.overridden": "Overridden",
  "settings.reset": "Reset",
  "settings.save": "Save",
  "settings.discard": "Discard",
  "settings.keyUndo": "Undo staged",
  "settings.readOnly": "Settings are read-only here",
  "settings.saveFailed": "Save failed, please retry",
  "settings.coreApiKeyEnv": "CORE API key reference (optional)",
  "settings.coreApiKeyEnvHint": "Credential reference (env-var name); default CORE_API_KEY",
  "settings.doajApiKeyEnv": "DOAJ API key reference (optional)",
  "settings.doajApiKeyEnvHint": "Credential reference (env-var name); default DOAJ_API_KEY",
  "settings.zenodoAccessTokenEnv": "Zenodo token reference (optional)",
  "settings.zenodoAccessTokenEnvHint": "Credential reference (env-var name); default ZENODO_ACCESS_TOKEN",
  "settings.semanticScholarApiKeyEnv": "Semantic Scholar key reference (optional)",
  "settings.semanticScholarApiKeyEnvHint": "Credential reference (env-var name); default SEMANTIC_SCHOLAR_API_KEY",
  "settings.unpaywallEmail": "Unpaywall email (recommended)",
  "settings.unpaywallEmailHint": "Any valid email; enables the OA download fallback (unpaywall.org)",
  "settings.contactEmail": "Contact email (optional)",
  "settings.contactEmailHint": "Polite pool for crossref / openalex",
  "settings.ieeeApiKeyEnv": "IEEE Xplore key reference (optional)",
  "settings.ieeeApiKeyEnvHint": "Credential reference (env-var name); default IEEE_API_KEY",
  "settings.acmApiKeyEnv": "ACM key reference (optional)",
  "settings.acmApiKeyEnvHint": "Credential reference (env-var name); default ACM_API_KEY",
  "settings.scholarProxyUrl": "Google Scholar proxy (optional)",
  "settings.scholarProxyUrlHint": "http:// or socks5:// forward proxy against IP blocks",
  "settings.scihubBaseUrl": "Sci-Hub mirror base URL (optional)",
  "settings.scihubBaseUrlHint": "Comma-separated mirrors, auto-rotated; empty = built-in list (sci-hub.vg/al/mk...)",
  "settings.pdfDir": "PDF download dir",
  "settings.pdfDirHint": "Default ${cwd}/OKF/sources/pdfs (aligned with OKF sources layout)",
  "settings.coreApiKey": "CORE API key",
  "settings.coreApiKeyHint": "Free at core.ac.uk/services/api — raises rate limits",
  "settings.doajApiKey": "DOAJ API key",
  "settings.doajApiKeyHint": "Free at doaj.org/apply-for-api-key — raises hourly limit",
  "settings.zenodoAccessToken": "Zenodo access token",
  "settings.zenodoAccessTokenHint": "Create in zenodo.org account settings; unlocks restricted records",
  "settings.semanticScholarApiKey": "Semantic Scholar API key",
  "settings.semanticScholarApiKeyHint": "Free at semanticscholar.org/product/api (shared with CSW)",
  "settings.ieeeApiKey": "IEEE Xplore API key",
  "settings.ieeeApiKeyHint": "Free tier at developer.ieee.org; enables the ieee source (metadata only)",
  "settings.acmApiKey": "ACM API key",
  "settings.acmApiKeyHint": "ACM has no open metadata API; the source reports alternatives when a key is stored",
  "settings.keyConfigured": "configured",
  "settings.keyNotConfigured": "not configured",
  "settings.keyWriteHint": "Write-only: leave blank to keep; saving a value writes it to the Host credential store",
  "settings.keyClear": "Clear",
  "settings.keyClearStaged": "will be cleared",
  "settings.advancedEnvTitle": "Advanced: Environment variable references (optional)",
  "settings.advancedEnvHint": "Usually not needed; defaults read standard environment variables",
  "search.title": "Paper search",
  "search.searching": "Searching papers…",
  "search.truncated": "Results exceeded the cap; the list was truncated",
  "search.pdf": "PDF",
  "search.doi": "DOI",
  "search.failed": "Search failed",
  "search.stopped": "Search interrupted",
  "search.stoppedDetail": "The tool call was interrupted before results returned",
  "search.showMore": "Show {n} more ▾",
  "search.showLess": "Show less ▴",
  "search.copyIngest": "+ Ingest",
  "search.copied": "Copied",
};
