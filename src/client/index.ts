import { SearchCard } from "./SearchCard.tsx";
import { SettingsCard } from "./SettingsCard.tsx";
import { NS, en, zh } from "./locales.ts";
import {
  PAPERSEARCH_NS, PapersearchSettingsController, type CredentialsFace,
} from "./settings-form-controller.ts";
import type { SettingsFormScope } from "@deepseek-ai/dsh-client-ui-primitives";

/**
 * 0.1.7 设置面：settingsScope/settings.plugin.item 已删，插件自己的设置表单
 * 注册到宿主 Plugin Manager 页的 plugins.bundle.config 槽位（key = 包名）；
 * 值字段经 configForms 共享 scope 写 volatile 配置，密钥经 remote.credentials
 * 写凭据库。本半场另保留词典 + 检索工具卡。
 */
export const inject = ["slots", "locale", "remote", "remote.credentials", "configForms"];

type ClientApplyContext = {
  slots: {
    inject: (name: string, factory: () => Generator<unknown, void, unknown> | unknown) => () => void;
    register: (spec: Record<string, unknown>, component: unknown) => unknown;
  };
  locale: {
    register: (ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }) => () => void;
  };
  remote: {
    credentials: CredentialsFace;
    $on: (event: "credentials/reference-updated", listener: (ref: string) => void) => () => void;
  };
  configForms: {
    get: <T>(entryId: string) => SettingsFormScope<T>;
    whileServed: (namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) => () => void;
  };
  effect: (fn: () => (() => void) | void, label?: string) => void;
};

/** Browser half: locale dictionaries, the bundle settings form, and the chat-inline search card. */
export function apply(ctx: ClientApplyContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-papersearch: dictionaries");

  // Bundle settings form on the Plugins page. Registered only while the Host
  // serves the papersearch namespace, so a profile without the plugin shows
  // no trace of the page. The key is the npm package name the page keys the
  // slot by.
  const card = new PapersearchSettingsController(
    ctx.configForms.get(PAPERSEARCH_NS),
    ctx.remote.credentials,
  );
  ctx.effect(() => () => { card.dispose(); }, "dsh-papersearch: settings form");
  // The credential rows are not part of any settings section, so their scope
  // publishes nothing when a key is written elsewhere; this is the only signal.
  ctx.effect(
    () => ctx.remote.$on("credentials/reference-updated", (ref) => { card.refreshCredential(ref); }),
    "dsh-papersearch: credential invalidations",
  );
  ctx.effect(
    () => ctx.configForms.whileServed([PAPERSEARCH_NS], () => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register(
      { name: "plugins.bundle.config", key: "dsh-papersearch", locale: NS, inject: () => card.inject() },
      SettingsCard,
    ))),
    "dsh-papersearch: settings page",
  );

  // Chat-inline citation card for the search tool. The key domain of
  // 'tool.call.toolview' is open to any wire tool name (registering is
  // additive for our own tool); dsh.client.inject lists dsh-client-ui-tool
  // so the slot is declared before this entry registers.
  ctx.slots.inject("tool.call.toolview", function* () {
    yield ctx.slots.register(
      { name: "tool.call.toolview", key: "papersearch_search", locale: NS },
      SearchCard,
    );
  });
}
