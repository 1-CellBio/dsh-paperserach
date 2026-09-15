import type { Context } from "@deepseek-ai/cordis";
import type z from "@deepseek-ai/schemastery";
import type {} from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/dsh-system-prompt";
import os from "node:os";
import path from "node:path";
import type { PapersearchConfig } from "./types";
import { papersearchPrompt } from "./help";

/** Namespace this plugin owns in the user-settings document. */
export const PAPERSEARCH_SETTINGS_NS = "papersearch";

export type ConfigSource = () => PapersearchConfig;

export function installPapersearchSettings<T extends PapersearchConfig>(
  ctx: Context,
  schema: z<T>,
  entry: T,
): ConfigSource {
  let source: () => T = () => entry;
  const getConfig: ConfigSource = () => source();

  let disposePrompt = (): void => {};
  const publishPrompt = (): void => {
    disposePrompt();
    disposePrompt = ctx.systemPrompt.section({
      name: "plugin:papersearch",
      order: 120,
      text: papersearchPrompt(),
    });
  };
  publishPrompt();

  ctx.inject(["settings"], (sctx) => {
    // Same fallback contract as dsh-csw: when no settings provider is
    // present the composition entry stays the config source.
    sctx.settings.installSection(ctx, PAPERSEARCH_SETTINGS_NS, schema, entry, {
      setSource: (current) => {
        source = current;
      },
      onChange: publishPrompt,
    });
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

