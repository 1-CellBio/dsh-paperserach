import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-system-prompt";
import os from "node:os";
import path from "node:path";
import type { PapersearchConfig, PapersearchConfigEntry } from "./types";
import { papersearchPrompt } from "./help";

export type ConfigSource = () => PapersearchConfig;

/**
 * 0.1.7 设置面接线：可编辑字段在 Config schema 上以 .volatile() 声明，
 * settings 页自动表单直接编辑（写 profile 插件配置），插件实例不重载。
 * 本函数退化为两件事：
 * - 快照 ConfigSource：每次调用从 entry 的 Volatile 字段 .get() 组装
 *   PapersearchConfig 快照——下游（工具层）契约与 0.1.5 完全一致。
 * - system prompt：文本是纯静态（papersearchPrompt() 零参数），安装时
 *   发布一次即可——0.1.5 installSection onChange 的重发是同文本的无效
 *   重发（okf 侧早已删除同款 no-op），不再接线。
 */
export function installPapersearchSettings(
  ctx: Context,
  entry: PapersearchConfigEntry,
): ConfigSource {
  const getConfig: ConfigSource = () => ({
    pdfDir: entry.pdfDir?.get(),
    searchTimeoutMs: entry.searchTimeoutMs?.get(),
    downloadTimeoutMs: entry.downloadTimeoutMs?.get(),
    coreApiKeyEnv: entry.coreApiKeyEnv,
    doajApiKeyEnv: entry.doajApiKeyEnv,
    zenodoAccessTokenEnv: entry.zenodoAccessTokenEnv,
    semanticScholarApiKeyEnv: entry.semanticScholarApiKeyEnv,
    unpaywallEmail: entry.unpaywallEmail?.get(),
    contactEmail: entry.contactEmail?.get(),
    ieeeApiKeyEnv: entry.ieeeApiKeyEnv,
    acmApiKeyEnv: entry.acmApiKeyEnv,
    scholarProxyUrl: entry.scholarProxyUrl?.get(),
    useScihub: entry.useScihub?.get(),
    scihubBaseUrl: entry.scihubBaseUrl?.get(),
    allowTitleMatch: entry.allowTitleMatch?.get(),
  });

  ctx.systemPrompt.section({
    name: "plugin:papersearch",
    order: 120,
    text: papersearchPrompt(),
  });

  return getConfig;
}

/** Expand ${cwd}/${workspace}/${home}/${dshHome} tokens in a dir template. */
export function expandDirTemplate(raw: string, cwd?: string, env: NodeJS.ProcessEnv = process.env): string {
  const workspace = (cwd && cwd.trim()) || process.cwd();
  const home = os.homedir();
  const dshHome = env.DSH_HOME?.trim() ? path.resolve(env.DSH_HOME.trim()) : path.join(home, ".dsh");
  return raw
    .replaceAll("${cwd}", workspace)
    .replaceAll("${workspace}", workspace)
    .replaceAll("${home}", home)
    .replaceAll("${dshHome}", dshHome)
    .trim();
}

