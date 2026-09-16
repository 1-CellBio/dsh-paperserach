// Type-only: pulls the ctx.remote merge (ClientRemote with the credentials
// namespace and $on) into this program without a runtime edge.
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type { ClientRemote } from "@deepseek-ai/dsh-api-remotes/client";
import { PapersearchSettingsCard } from "./SettingsCard.tsx";
import { SearchCard } from "./SearchCard.tsx";
import { PapersearchSettingsController } from "./settings-controller.ts";
import type { PapersearchSettingsScope } from "./settings-form.ts";
import { NS, en, zh } from "./locales.ts";

export const inject = ["slots", "locale", "settingsScope", "remote", "remote.credentials"];

type ClientApplyContext = {
  slots: {
    inject: (name: string, factory: () => Generator<unknown, void, unknown> | unknown) => void;
    register: (spec: Record<string, unknown>, component: unknown) => unknown;
  };
  locale: {
    register: (ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }) => () => void;
  };
  settingsScope: {
    bind: (spec: { namespace: string }) => PapersearchSettingsScope;
  };
  remote: ClientRemote;
  effect: (fn: () => (() => void) | void, label?: string) => void;
};

/** Browser half: locale dictionaries + the plugin-settings key card. */
export function apply(ctx: ClientApplyContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-papersearch: dictionaries");

  const ctrl = new PapersearchSettingsController(
    ctx.settingsScope.bind({ namespace: NS }),
    ctx.remote.credentials,
  );

  // A credential can be written on another surface (it addresses the same
  // reference); without this the configured badge keeps reporting a state the
  // Host already replaced.
  ctx.effect(
    () => ctx.remote.$on("credentials/reference-updated", (ref) => { ctrl.refreshCredential(ref) }),
    "dsh-papersearch: credential invalidations",
  );

  ctx.slots.inject("settings.plugin.item", function* () {
    yield ctx.slots.register(
      {
        name: "settings.plugin.item",
        key: NS,
        // keyed 槽忽略 order，只按 priority 升序排（默认 0）。
        // 三个外部插件用 1/2/3 排在内置卡（0）之后并保证顺序：
        // Paper Search(1) → OKF(2) → CSW(3)。
        priority: 1,
        locale: NS,
        inject: () => ctrl.inject(),
      },
      PapersearchSettingsCard,
    );
  });

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
