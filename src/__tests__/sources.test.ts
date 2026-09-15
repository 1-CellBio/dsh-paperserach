import { afterEach, describe, expect, it, vi } from "vitest";
import { SOURCES, SOURCE_IDS } from "../registry";
import { refreshSourceKeys } from "../keys";
import type { SearchArgs, SourceAdapter } from "../sources/adapter";

/** Contract tests over the whole adapter roster: capabilities declared in
 * the README table and the download URL shapes the fallback chain relies
 * on. No network — download() resolvers are pure for every native source. */

afterEach(async () => {
  vi.unstubAllGlobals();
  await refreshSourceKeys({});
});

const byId = (id: string): SourceAdapter => {
  const source = SOURCES.find((entry) => entry.id === id);
  if (!source) throw new Error(`missing adapter ${id}`);
  return source;
};

const args = (query = "cell biology"): SearchArgs => ({ query, maxResults: 5 });

describe("declared capabilities", () => {
  it("native download sources match the documented table", () => {
    const native = ["arxiv", "biorxiv", "medrxiv", "iacr", "semantic", "pmc", "core", "zenodo", "hal"];
    for (const id of SOURCE_IDS) {
      expect(byId(id).canDownload, id).toBe(native.includes(id));
    }
  });

  it("every adapter shares the registry id it is registered under", () => {
    for (const source of SOURCES) {
      expect(source.id).toBe(SOURCE_IDS[SOURCES.indexOf(source)]);
    }
  });
});

describe("native download targets", () => {
  it("arxiv serves the canonical pdf link", async () => {
    expect(await byId("arxiv").download!("2106.15928v1")).toEqual({
      url: "https://arxiv.org/pdf/2106.15928v1",
      baseName: "2106.15928v1",
    });
  });

  it("biorxiv and medrxiv build server-specific full-pdf urls", async () => {
    expect(await byId("biorxiv").download!("2024.01.01.123456")).toEqual({
      url: "https://www.biorxiv.org/content/2024.01.01.123456v1.full.pdf",
      baseName: "biorxiv-2024.01.01.123456",
    });
    expect(await byId("medrxiv").download!("2024.01.01.654321")).toMatchObject({
      url: "https://www.medrxiv.org/content/2024.01.01.654321v1.full.pdf",
    });
  });

  it("iacr mirrors the ePrint id and slashes are sanitized in the file name", async () => {
    expect(await byId("iacr").download!("2026/1991")).toEqual({
      url: "https://eprint.iacr.org/2026/1991.pdf",
      baseName: "iacr-2026_1991",
    });
  });

  it("zenodo and hal point at their document endpoints", async () => {
    expect(await byId("zenodo").download!("12345")).toMatchObject({ url: expect.stringContaining("zenodo.org/records/12345") });
    expect(await byId("hal").download!("hal-01234567")).toEqual({
      url: "https://hal.science/hal-01234567/document",
      baseName: "hal-01234567",
    });
  });
});

describe("request shaping", () => {
  it("crossref joins the polite pool when a contact email is configured", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ message: { items: [] } }), { status: 200 });
    }));
    await refreshSourceKeys({ contactEmail: "team@example.org" });
    await byId("crossref").search(args());
    expect(calls[0]!.url).toContain("mailto=team%40example.org");
  });

  it("semantic scholar attaches the optional api key as x-api-key", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    process.env.PAPERSEARCH_SEMANTIC_SCHOLAR_API_KEY = "s2-key";
    await refreshSourceKeys({});
    await byId("semantic").search(args());
    expect(calls[0]!.headers["x-api-key"]).toBe("s2-key");
    expect(calls[0]!.url).toContain("api.semanticscholar.org");
  });

  it("semantic scholar forwards the year filter", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    await byId("semantic").search({ ...args(), year: "2020-2024" });
    expect(urls[0]).toContain("year=2020-2024");
  });

  it("unpaywall reads the query as a DOI and requires an email", async () => {
    let seen = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      seen = String(url);
      return new Response(JSON.stringify({ doi: "10.1038/nature12373", is_oa: true, title: "A famous paper" }), { status: 200 });
    }));
    await refreshSourceKeys({ unpaywallEmail: "team@example.org" });
    const papers = await byId("unpaywall").search(args("10.1038/nature12373"));
    expect(seen).toContain("api.unpaywall.org/v2/10.1038%2Fnature12373");
    expect(seen).toContain("email=team%40example.org");
    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({ source: "unpaywall", paperId: "10.1038/nature12373", title: "A famous paper" });
  });

  it("arxiv parses an Atom feed end to end", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(`<feed><entry><id>http://arxiv.org/abs/2404.18021v2</id>
        <title>Atom entry</title><published>2024-04-28T00:00:00Z</published>
        <link rel="alternate" type="application/pdf" href="https://arxiv.org/pdf/2404.18021v2"/>
      </entry></feed>`, { status: 200 }),
    ));
    const papers = await byId("arxiv").search(args());
    expect(papers[0]).toMatchObject({
      paperId: "2404.18021v2",
      title: "Atom entry",
      pdfUrl: "https://arxiv.org/pdf/2404.18021v2",
      source: "arxiv",
    });
  });
});
