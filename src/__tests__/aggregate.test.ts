import { afterEach, describe, expect, it, vi } from "vitest";
import { activeSourceIds, searchSources, SOURCE_IDS } from "../registry";
import { refreshSourceKeys } from "../keys";

/** Orchestration-level tests for the multi-source aggregate: roster shape,
 * key gating, selection semantics and per-source error isolation — the
 * network itself is stubbed so the merge behavior is what's under test. */

const ATOM = `<?xml version="1.0"?>
<feed><entry>
  <id>http://arxiv.org/abs/2404.18021v2</id>
  <title>Stubbed arxiv entry</title>
  <link rel="alternate" type="application/pdf" href="https://arxiv.org/pdf/2404.18021v2"/>
</entry></feed>`;

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.PAPERSEARCH_IEEE_API_KEY;
  delete process.env.PAPERSEARCH_ACM_API_KEY;
  await refreshSourceKeys({});
});

describe("catalog roster", () => {
  it("is the 21 core sources plus the two key-gated connectors, in order", () => {
    expect(SOURCE_IDS).toEqual([
      "arxiv", "pubmed", "biorxiv", "medrxiv", "google_scholar", "iacr", "semantic",
      "crossref", "openalex", "pmc", "core", "europepmc", "dblp", "openaire",
      "citeseerx", "doaj", "base", "zenodo", "hal", "ssrn", "unpaywall", "ieee", "acm",
    ]);
  });

  it("hides ieee/acm until their keys resolve, then reveals them", async () => {
    expect(activeSourceIds()).not.toContain("ieee");
    process.env.PAPERSEARCH_IEEE_API_KEY = "k";
    await refreshSourceKeys({});
    expect(activeSourceIds()).toContain("ieee");
    expect(activeSourceIds()).not.toContain("acm");
  });
});

describe("searchSources", () => {
  it("honors an explicit source list and returns its papers merged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(ATOM, { status: 200 })));
    const result = await searchSources({ query: "q", sources: ["arxiv"] });
    expect(result.sourcesUsed).toEqual(["arxiv"]);
    expect(result.errors).toEqual({});
    expect(result.total).toBe(1);
    expect(result.papers[0]).toMatchObject({ source: "arxiv", paperId: "2404.18021v2" });
  });

  it("collects per-source failures into errors while the rest still returns", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) =>
      String(url).includes("export.arxiv.org")
        ? new Response(ATOM, { status: 200 })
        : new Response("gone", { status: 404 }),
    ));
    const result = await searchSources({ query: "q", sources: ["arxiv", "crossref"] });
    expect(result.sourcesUsed).toEqual(["arxiv", "crossref"]);
    expect(result.errors.crossref).toMatch(/HTTP 404/);
    expect(result.errors.arxiv).toBeUndefined();
    expect(result.papers).toHaveLength(1);
  });

  it("treats an unknown source id as an empty selection, not a throw", async () => {
    const result = await searchSources({ query: "q", sources: ["nope"] });
    expect(result.sourcesUsed).toEqual([]);
    expect(result.papers).toEqual([]);
    expect(result.errors).toEqual({});
  });

  it("defaults to the active roster when no sources are requested", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 404 })));
    const result = await searchSources({ query: "q" });
    expect(result.sourcesUsed).toEqual(activeSourceIds());
    expect(result.sourcesUsed).not.toContain("ieee");
    expect(Object.keys(result.errors)).toHaveLength(result.sourcesUsed.length);
  });

  it("clamps maxResults into the 1..50 window", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return new Response(ATOM, { status: 200 });
    }));
    await searchSources({ query: "q", sources: ["arxiv"], maxResults: 99 });
    expect(calls[0]).toContain("max_results=50");
  });
});
