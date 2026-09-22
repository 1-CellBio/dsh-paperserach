import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import { registerTools } from "../tools";
import { confineDirToBase } from "../paths";
import type { ConfigSource } from "../settings";

const pdfMagic = Buffer.concat([
  Buffer.from("%PDF-1.7 fake content for tests\n"),
  Buffer.from("x".repeat(2048)),
]);

function fakePdfResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/pdf" : null) },
    arrayBuffer: async () => pdfMagic.buffer.slice(pdfMagic.byteOffset, pdfMagic.byteOffset + pdfMagic.byteLength),
  };
}

/** Minimal plugin context: records tool registrations. */
function harness(): { ctx: Context; tools: ToolDefinition[] } {
  const tools: ToolDefinition[] = [];
  const ctx = {
    tools: { register: (def: ToolDefinition): (() => void) => { tools.push(def); return () => {}; } },
  } as unknown as Context;
  return { ctx, tools };
}

/** Register the plugin tools and return one definition by name. */
function toolByName(name: string, getConfig: ConfigSource): ToolDefinition {
  const { ctx, tools } = harness();
  registerTools(ctx, getConfig);
  const def = tools.find((tool) => tool.name === name);
  if (!def) throw new Error(`${name} not registered`);
  return def;
}

/** Minimal tool execution context (only the fields the download tools read). */
function execWith(): ToolRunContext {
  return {
    callId: "call-1",
    name: "papersearch_download",
    arguments: {},
    signal: new AbortController().signal,
  } as ToolRunContext;
}

describe("confineDirToBase", () => {
  const base = path.resolve("/okf/ws/OKF/sources/pdfs");

  it("accepts the base itself and relative subdirs (.. segments normalize away)", () => {
    expect(confineDirToBase(base, ".")).toBe(base);
    expect(confineDirToBase(base, "sub")).toBe(path.join(base, "sub"));
    expect(confineDirToBase(base, "sub/../other")).toBe(path.join(base, "other"));
  });

  it("rejects .. escapes and absolute paths outside the base", () => {
    expect(() => confineDirToBase(base, "../evil")).toThrow(/outside the download root/);
    expect(() => confineDirToBase(base, "sub/../../evil")).toThrow(/outside the download root/);
    expect(() => confineDirToBase(base, "/tmp")).toThrow(/outside the download root/);
  });

  it("accepts an absolute path that resolves inside the base", () => {
    expect(confineDirToBase(base, path.join(base, "sub"))).toBe(path.join(base, "sub"));
  });
});

describe("papersearch_download dir confinement", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-dir-"));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(base, { recursive: true, force: true });
  });

  it("rejects dir values that escape the download root before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const download = toolByName("papersearch_download", () => ({ pdfDir: base, useScihub: false }));
    for (const dir of ["../evil", "/tmp"]) {
      await expect(
        download.execute({ source: "arxiv", paperId: "2401.00001", dir }, execWith()),
      ).rejects.toThrow(/outside the download root.*pdfDir setting/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads into a relative subdir of the download root", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse()));
    const download = toolByName("papersearch_download", () => ({ pdfDir: base, useScihub: false }));
    const outcome = await download.execute(
      { source: "arxiv", paperId: "2401.00001", dir: "staging" },
      execWith(),
    ) as { status: string; path: string };
    expect(outcome.status).toBe("downloaded");
    expect(outcome.path).toBe(path.join(base, "staging", "arxiv-2401.00001.pdf"));
  });
});

describe("papersearch_download_scihub dir confinement", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-scihub-"));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(base, { recursive: true, force: true });
  });

  it("rejects dir values that escape the download root before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const scihub = toolByName("papersearch_download_scihub", () => ({ pdfDir: base, useScihub: false }));
    for (const dir of ["../evil", "/tmp"]) {
      await expect(
        scihub.execute({ identifier: "10.1000/fake", dir }, execWith()),
      ).rejects.toThrow(/outside the download root.*pdfDir setting/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads into a relative subdir when given a direct PDF url", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse()));
    const scihub = toolByName("papersearch_download_scihub", () => ({ pdfDir: base, useScihub: false }));
    const outcome = await scihub.execute(
      { identifier: "https://example.com/paper.pdf", dir: "scihub-staging" },
      execWith(),
    ) as { status: string; path: string };
    expect(outcome.status).toBe("downloaded");
    expect(path.dirname(outcome.path)).toBe(path.join(base, "scihub-staging"));
  });
});
