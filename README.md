<div align="center">

# dsh-papersearch

**纯 TypeScript 搜索 21+2 个学术源，把 PDF 直接送进 OKF 文库。**

*发现 → 下载 → 收录，一个会话完成闭环。零运行时依赖，无 Python，无外部进程。API key 在插件设置卡片里填，或走环境变量。*

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-8257D0)](https://github.com/topics/dsh-plugin)

</div>

---

## 这是什么

[dsh-papersearch](https://github.com/1-CellBio/dsh-papersearch) 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的插件，把 [openags/paper-search-mcp](https://github.com/openags/paper-search-mcp) 的**全部 21 个源**用**原生 TypeScript 完全重写**：多源并行检索学术 API，并把 PDF 下载到 **dsh-okf 的源文件目录**（`OKF/sources/pdfs`）；落盘后自动交给 dsh-okf 摄取编译（见下文「自动摄取」）。

```text
papersearch_search / papersearch_fetch   ←  21 个学术源（纯 TS 适配器）
                 ↓  PDF 落盘 OKF/sources/pdfs，并发出 papersearch/staged 事件
        自动 okf-ingest 作业（dsh-okf）      ←  提取 / 编译 / 概念化
                 ↓
       okf_search / okf_graph / okf_coverage …
```

与 [dsh-okf](https://github.com/1-CellBio/dsh-okf)、[dsh-csw](https://github.com/1-CellBio/dsh-csw) 组成完整流水线：papersearch 是上游（找文献、下 PDF），okf 是文库（编译、图谱、综述），csw 是下游（成稿写作）。

## 工具

| 工具 | 用途 |
|---|---|
| `papersearch_search` | 多源并行检索，去重后返回论文卡片（标题 / 作者 / 年份 / DOI / pdf_url / 摘要节选） |
| `papersearch_fetch` | 一句话闭环：检索 → 挑选可下载的前 N 篇 → 批量下载进 OKF 源目录，返回逐篇清单 |
| `papersearch_download` | 按源 + paper_id 精确下载单篇（幂等，已存在则跳过；OA 回退链失败后走 Sci-Hub 末位兜底，`useScihub=false` 可关闭） |
| `papersearch_download_scihub` | 末位兜底：按 DOI / 标题 / PMID / URL 直接从 Sci-Hub 镜像下载（托管付费墙论文，谨慎使用） |
| `papersearch_acquire` | 按 DOI 批量获取全文 PDF（Semantic Scholar openAccessPdf → 开放仓库 + unpaywall → Sci-Hub；库内已覆盖的 DOI 直接答 `in-library`），后台作业，逐 DOI 诊断失败原因 |
| `papersearch_sources` | 列出可用的源连接器 |
| `papersearch_help` | 使用说明 + 可复制示例提问 |

### 自动摄取（papersearch → okf）

`papersearch_fetch` / `papersearch_acquire` / `papersearch_download` / `papersearch_download_scihub` 在 PDF 落盘后（状态 `downloaded` / `replaced` / `exists`）向宿主派发 `papersearch/staged` 事件（`ctx.serial`，载荷 = 触发的 agent、工具名、PDF 绝对路径列表）。**dsh-okf 响应该事件，自己启动一个 `okf-ingest` 后台作业**（归属同一 agent，完成时同样通知会话），模型不必再调用 `okf_ingest`：

- 同步结果的 `ingest` 字段（`{ status: "started", jobId, files }`）与后台作业完成详情都会点名该摄取作业，`nextStep` 明确要求「不要重复调用 `okf_ingest`」。
- 开关在 okf 一侧：okf 设置 `autoIngest`（默认开）。关闭、okf 未加载、文件不在 okf 自己的源目录（`pdfDir`）之内、或作业无法启动时，结果写明 `not-started` 及原因，并保留「手工 `okf_ingest`」的指示。
- papersearch 自身不依赖 dsh-okf（插件独立发布）；没有监听者时行为与以往一致。
- 被 `job_kill` 取消的后台作业不会派发事件。

## 源能力（21 核心 + 2 key 门控）

| 源 | 搜索 | 下载 | 说明 |
|---|---|---|---|
| arxiv | ✅ | ✅ | Atom API，PDF 直链 |
| pubmed | ✅ | — | eutils 元数据；DOI 走仓库/unpaywall 回退 |
| biorxiv / medrxiv | ✅（按 category） | ✅ | 详情 API；查询按上游语义作为类目名 |
| google_scholar | ✅ | — | HTML 解析，反爬敏感；支持正向代理绕过 IP 封锁 |
| iacr | ✅ | ✅ | ePrint 档案 HTML 解析，PDF 直链 |
| semantic | ✅ | ✅（OA） | Graph API；可选 API key 提升限额 |
| crossref | ✅ | — | works API 元数据 |
| openalex | ✅ | —（pdf_url 进 fetch 池） | 倒排索引摘要重建 |
| pmc | ✅ | ✅（OA） | eutils + PMC Open Access 桶（`pmc-oa-opendata`，AWS 开放数据，纯 HTTPS；旧 `oa.fcgi` 服务已退役） |
| core | ✅ | ✅ | 聚合仓；API key 免费申请，未配置走匿名限额 |
| europepmc | ✅ | —（OA pdf_url） | 生物医学，覆盖 MED + PMC |
| dblp | ✅ | — | 计算机科学书目，XML API |
| openaire | ✅ | —（fileMain_s 进 fetch 池） | 欧盟科研产物图谱；仓库回退源 |
| citeseerx | ✅ | — | JSON API，偶发反爬拦截 |
| doaj | ✅ | —（fulltext 链接进 fetch 池） | 开放期刊目录；API key 可选 |
| base | ✅ | — | 比勒菲尔德聚合索引，机构 IP 内更稳 |
| zenodo | ✅ | ✅ | Zenodo 仓；access token 解锁受限记录 |
| hal | ✅ | ✅ | 法国开放档案馆 |
| ssrn | ✅ | — | HTML 解析（abstract 页），反爬敏感 |
| unpaywall | ✅（DOI 查询） | 回退解析 | 需配置联系邮箱 |
| ieee | ✅（key 门控） | — | Xplore 元数据 API v1；配 key 才出现在源列表（上游同款门控，但为真实实现而非空壳） |
| acm | key 门控 | — | ACM 无公开元数据 API；配 key 后源可见但搜索会给出替代建议（crossref/semantic 覆盖 ACM） |

**下载回退链**（源无原生 PDF 时依次尝试，全部候选校验 PDF 魔数）：源原生直链 → 搜索卡片 pdf_url → 开放仓库按 DOI 检索（openaire → core → europepmc → pmc；只按标题命中的 PDF 默认保留，身份记为 `title-fallback`，入库后 okf 核对请求 DOI，不一致标记 `identityMismatch`；`allowTitleMatch=false` 则丢弃）→ unpaywall OA 解析 → **Sci-Hub 镜像列表**（默认开启，`useScihub=false` 可关闭；自动轮换 + 镜像健康评分，末位兜底）。

**仓库回退的实测要点**（2026-10 活体探测）：DOI 查询在 OpenAIRE 走 `doi=` 过滤（放进 `keywords=` 会得到 HTTP 409 语法错误），在 CORE 走带引号的 `doi:"…"` 字段查询（裸 DOI 的斜杠会被当作正则，返回 500）。Europe PMC 的 `?pdf=render` 链接在 Cloudflare 质询之后，脚本客户端一律 403；因此 Europe PMC / PMC 命中且 DOI 一致、带 PMCID 时，先取 **PMC Open Access 桶**里的 PDF（`<PMCID>.<版本>/<PMCID>.<版本>.pdf`，取最新版本），再退回仓库自己的链接。不在开放获取子集的文章在桶中没有 PDF，需手动下载后 `okf_ingest`。相同的候选链接只尝试一次。

**易碎源提示**：google_scholar / citeseerx / base / ssrn 属反爬型（验证码、机构 IP 限制），单源失败会出现在 errors map 里，属预期行为；搜索工具会照常返回其余源的结果。

**关于 Sci-Hub**：在开放仓库 + unpaywall 都失败时作为**最后手段**，按序轮换一组内置镜像（`sci-hub.vg/al/mk/ru/...`，借鉴 scansci-pdf 2026-07 实测清单），解析 `<镜像>/<DOI|标题|PMID|URL>` 页面里的 PDF 直链（`src/sources/sci_hub.ts`，纯 TS：meta citation_pdf_url / embed / iframe / button / a + URL 级 plausibility 过滤 + EN/RU 文章不存在 + 空 embed 检测）。会话内按镜像记录成败/延迟并打分排序，刚失败的镜像几分钟内排后，避免反复撞墙。Sci-Hub 分发的是未经出版商授权的受版权保护论文，仅建议对确实付费墙且必须获取的论文使用；`useScihub=false`（或 `PAPERSEARCH_USE_SCI_HUB=false`）可关闭，`scihubBaseUrl` 支持逗号分隔自定义镜像列表。`papersearch_download_scihub` 提供单次显式下载入口。

## 兼容性

| 方面 | 状态 |
|---|---|
| Harness | DeepSeek Harness，`dsh` CLI |
| Node | `>=20`（原生 fetch） |
| 运行时依赖 | 零（仅 harness peer 包 + Node 内置模块） |
| 下载目录 | 会话工作区 `OKF/sources/pdfs`（dsh-okf 布局） |

## 安装

```sh
dsh plugin --profile web add github:1-CellBio/dsh-papersearch
# 本地开发: dsh plugin --profile web add ./dsh-papersearch

# 安装 dsh-okf（下游闭环）
dsh plugin --profile web add dsh-okf
```

`--profile <name>` 必填（常用 `web`）。pnpm ≥10 从 git 安装时需在 profile 的 `pnpm-workspace.yaml` 授权 `allowBuilds: dsh-papersearch: true`。

## 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `pdfDir` | `${cwd}/OKF/sources/pdfs` | PDF 下载目录（对齐 dsh-okf） |
| `searchTimeoutMs` | 120000 | 单源检索超时 |
| `downloadTimeoutMs` | 300000 | 单篇下载超时 |
| `contactEmail` | 空 | 礼貌池邮箱（crossref / openalex / unpaywall），配置后启用 unpaywall 回退 |
| `coreApiKeyEnv` | `CORE_API_KEY` | CORE API key 的凭据引用（env 变量名） |
| `doajApiKeyEnv` | `DOAJ_API_KEY` | DOAJ API key 的凭据引用 |
| `zenodoAccessTokenEnv` | `ZENODO_ACCESS_TOKEN` | Zenodo token 的凭据引用 |
| `semanticScholarApiKeyEnv` | `SEMANTIC_SCHOLAR_API_KEY` | Semantic Scholar key 的凭据引用 |
| `unpaywallEmail` | 空 | unpaywall 专用邮箱（缺省回落 `contactEmail`） |
| `ieeeApiKeyEnv` | `IEEE_API_KEY` | IEEE Xplore key 的凭据引用（激活 ieee 源） |
| `acmApiKeyEnv` | `ACM_API_KEY` | ACM key 的凭据引用（源可见，无开放 API，仅提示） |
| `scholarProxyUrl` | 空 | Google Scholar 正向代理（http/socks5） |
| `useScihub` | `true` | 是否启用 Sci-Hub 末位回退（回退链第 5 步；`papersearch_download_scihub` 遵守同一开关） |
| `scihubBaseUrl` | 空（内置列表轮换） | Sci-Hub 镜像，逗号分隔多个即自动轮换 |
| `allowTitleMatch` | `true` | 开放仓库只按标题（没有 DOI 佐证）命中的 PDF 是否保存；标题相近的可能是另一篇论文，所以这类文件的 sidecar 身份是 `title-fallback`，okf 入库后会核对 DOI（环境变量 `PAPERSEARCH_ALLOW_TITLE_MATCH=false` 同效关闭） |

### 插件设置卡片（key 填入组件）

密钥全部为可选。配置里只存**凭据引用**（环境变量名），密钥值本身走 harness 凭据通道：

> **迁移说明**：旧版本设置文档里以字面量存的密钥（`coreApiKey` 等字段）在新 schema 下被忽略（不报错、也不生效），请在设置卡片重新录入一次（写入凭据存储）；环境变量 `PAPERSEARCH_*` 旧名继续有效。

1. **Web 设置卡片**（推荐）：`dsh` 设置 → 插件 → papersearch。每个密钥两行：引用名输入框（默认 `CORE_API_KEY` 等）+ 只写密钥框（值不回显，Save 即写入主机凭据存储 `~/.dsh/.credentials.yaml`，0600）；`已配置/未配置` 徽标显示主机当前状态，`清除` 按钮移除已存密钥。
2. **环境变量**：密钥按引用名直接读进程环境（也支持旧的 `PAPERSEARCH_*` 别名，两个名字都会尝试）：

```dotenv
CORE_API_KEY=                             # CORE（免费申请；旧名 PAPERSEARCH_CORE_API_KEY 仍有效）
DOAJ_API_KEY=                             # DOAJ（可选）
ZENODO_ACCESS_TOKEN=                      # Zenodo 受限记录
SEMANTIC_SCHOLAR_API_KEY=                 # Semantic Scholar 限额提升
IEEE_API_KEY=                             # IEEE Xplore（激活 ieee 源）
ACM_API_KEY=                              # ACM（源可见，仅提示）
PAPERSEARCH_GOOGLE_SCHOLAR_PROXY_URL=socks5://127.0.0.1:1080   # Scholar 代理
PAPERSEARCH_UNPAYWALL_EMAIL=you@example.com
PAPERSEARCH_CONTACT_EMAIL=you@example.com # 启用 unpaywall OA 回退
PAPERSEARCH_SCI_HUB_BASE_URL=sci-hub.vg,sci-hub.al  # Sci-Hub 镜像列表（逗号分隔即轮换；留空用内置）
PAPERSEARCH_USE_SCI_HUB=false                     # 关闭 Sci-Hub 末位回退（默认开启）
PAPERSEARCH_PDF_DIR=/absolute/dir         # 覆盖下载目录
```

**Google Scholar 代理**：`http://`（含 Clash/V2Ray 混合端口）或 `socks5://`（ssh -D 等）正向代理均可；https 目标走 CONNECT 隧道，http 目标走绝对 URI 转发，SOCKS5 按 RFC 1928 无鉴权握手（零依赖实现，见 `src/proxy.ts`）。

HTTP 层内置：礼貌 UA、超时、429/5xx 指数退避重试（Retry-After 优先）、AbortSignal 传播；下载校验 PDF 魔数防 HTML 误存。

## 示例

对话里直接说：

```
帮我搜索 CRISPR base editing 2023 年以来的论文，来源用 arxiv、pubmed、semantic
```

```
搜索并下载 5 篇 single-cell RNA-seq tumor microenvironment 的论文，直接进 OKF
```

下载完成后无需再说「编进文库」：PDF 会自动摄取（见下文），摄取作业结束时会话收到完成通知。

## 开发

```sh
pnpm install     # 自动链接宿主 @deepseek-ai/* 工作区包
pnpm test        # 208 个单元测试（fixture 驱动，含代理/仓库回退本地集成 + Sci-Hub 镜像轮换解析）+ live 集成（网络不可用时自动跳过）
pnpm run build   # tsdown 构建 lib/index.js + lib/client.js（设置卡片浏览器包）
pnpm run smoke   # stub Context 冒烟加载（双 bundle：工具注册 + key 门控 + 设置卡片）
```

## License

[MIT](LICENSE) © 2026 1-CellBio
