import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "tsdown";

const root = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ID = "dsh-papersearch";

// Mirrors the harness baseline module-table seeds
// (deepseek-harness packages/client/web/src/platform.ts PLATFORM_MODULES).
// Anything outside this list must be bundled or declared via
// dsh.client.external — a require the module table cannot answer throws
// at materialization time.
const PLATFORM_MODULES = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
] as const;

const node: UserConfig = {
  name: PACKAGE_ID,
  entry: ["src/index.ts"],
  outDir: "lib",
  format: ["esm"],
  platform: "node",
  target: "es2024",
  fixedExtension: false,
  dts: false,
  clean: false,
  alias: {
    "@": path.resolve(root, "./src"),
  },
  deps: {
    neverBundle: [/^@deepseek-ai\//],
  },
};

const client: UserConfig = {
  name: `${PACKAGE_ID}/client`,
  entry: { client: "src/client/index.ts" },
  outDir: "lib",
  format: "cjs",
  platform: "browser",
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [...PLATFORM_MODULES],
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
  },
  plugins: [{
    name: "dsh-client-bundle-purity",
    resolveId(source: string) {
      if (!source.startsWith("@deepseek-ai/")) return null;
      if ((PLATFORM_MODULES as readonly string[]).includes(source)) return null;
      throw new Error(
        `client bundle purity: "${source}" is not a platform module — use type-only imports or cordis services`,
      );
    },
  }],
  outputOptions: {
    entryFileNames: "client.js",
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
    footer: "return module.exports; } });",
    intro: "var module = { exports: {} }; var exports = module.exports;",
  },
};

export default defineConfig([node, client]);
