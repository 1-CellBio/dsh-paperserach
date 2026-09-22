// Standalone load smoke test: imports the built bundles (node + browser)
// and drives apply() with stub cordis Contexts — proves the plugin loads,
// registers its five tools + system prompt section, and the client bundle
// registers the settings key card — without a full harness.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const mod = await import("../lib/index.js");
assert.equal(mod.name, "dsh-papersearch");
assert.deepEqual(mod.inject, ["tools", "systemPrompt"]);

const registered = [];
let promptText = "";
const disposers = [];
const ctx = {
  // credentials/jobs services absent（与 settings 同契约）：cordis 的
  // Context.get 返回 undefined → 凭据 seam 落 env 兜底。stub 缺 get 会让
  // papersearch_help.execute（→refreshKeys→resolver）炸 TypeError。
  get: () => undefined,
  tools: {
    register(tool) {
      registered.push(tool);
      disposers.push(() => {});
    },
  },
  systemPrompt: {
    section({ name, order, text }) {
      promptText = text;
      assert.equal(name, "plugin:papersearch");
      assert.ok(order > 0);
      return () => {};
    },
  },
  inject(_deps, _fn) {
    // settings service absent — cordis never calls the callback, and the
    // entry config stays the source (the csw fallback contract).
  },
  effect(fn) {
    fn();
    return () => {};
  },
};

mod.apply(ctx, mod.Config({}));
assert.equal(registered.length, 6, `expected 6 tools, got ${registered.map((t) => t.name).join(",")}`);
const names = registered.map((t) => t.name).sort();
assert.deepEqual(names, [
  "papersearch_download",
  "papersearch_download_scihub",
  "papersearch_fetch",
  "papersearch_help",
  "papersearch_search",
  "papersearch_sources",
]);
assert.ok(promptText.includes("papersearch_search"));
assert.ok(promptText.includes("okf_ingest"));

// help tool returns the guide without touching Python
const help = registered.find((t) => t.name === "papersearch_help");
const helpJson = await help.execute({}, { signal: new AbortController().signal });
assert.ok(JSON.stringify(helpJson).includes("papersearch_fetch"));

// client bundle: the ModuleLoader banner + settings-card slot registration
const clientPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib/client.js");
const client = readFileSync(clientPath, "utf8");
// 横幅形态随 tsdown 输出格式（美化多行/压缩单行）变化——断言拆两段：
// load 协议包裹 + 正确的 loader id，不钉死换行位置。
assert.ok(client.includes("window.__ModuleLoader__.load("), "client banner missing");
assert.ok(client.includes('id: "dsh-papersearch"'), "client loader id missing");
assert.ok(client.includes("settings.plugin.item"), "settings card slot missing");
assert.ok(!client.includes("sources/sci_hub"), "client bundle must not ship node-side adapters");

console.log("dsh-papersearch smoke: node entry + client bundle OK");
