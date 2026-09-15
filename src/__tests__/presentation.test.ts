import { describe, expect, it } from "vitest";
import type { ToolResult } from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import { presentSearchResult, searchMetaFromValue } from "../presentation";
import type { SearchMetaSource } from "../presentation";
import type { CompactPaper, CompactSearchResult } from "../paper";

const PAPER: CompactPaper = {
  paperId: "10.1/x",
  title: "A Paper",
  authors: "Alice; Bob",
  year: "2024",
  doi: "10.1/x",
  pdfUrl: "https://x/p.pdf",
  url: "https://x/p",
  source: "crossref",
  citations: 7,
  abstract: "abs",
};

/** The value as execute returns it (the tools layer's asJson copy lands it on
 *  the JsonValue plane, where the meta projector reads it). */
function searchValue(overrides: Partial<CompactSearchResult> = {}): JsonValue {
  const value: CompactSearchResult = {
    query: "q",
    sourcesUsed: ["crossref"],
    sourceResults: { crossref: 1 },
    errors: {},
    total: 1,
    returned: 1,
    truncated: false,
    papers: [PAPER],
    ...overrides,
  };
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function sourcesOf(meta: JsonValue): SearchMetaSource[] {
  return (meta as { sources: SearchMetaSource[] }).sources;
}

describe("searchMetaFromValue", () => {
  it("projects each paper card into a citation source carrying pdfUrl and doi", () => {
    const meta = searchMetaFromValue(searchValue());
    expect(meta).toEqual({
      sources: [{
        url: "https://x/p",
        title: "A Paper",
        snippet: "crossref 2024 — Alice; Bob · 7 citations",
        pdfUrl: "https://x/p.pdf",
        doi: "10.1/x",
      }],
      truncated: false,
    });
  });

  it("omits pdfUrl and doi when the paper reports none", () => {
    const bare = searchValue({ papers: [{ ...PAPER, pdfUrl: "", doi: "" }] });
    expect(sourcesOf(searchMetaFromValue(bare))[0]).toEqual({
      url: "https://x/p",
      title: "A Paper",
      snippet: "crossref 2024 — Alice; Bob · 7 citations",
    });
  });

  it("falls back to the pdf url, then the doi link, for the citation url", () => {
    const noLanding = searchValue({ papers: [{ ...PAPER, url: "" }] });
    const noLandingSource = sourcesOf(searchMetaFromValue(noLanding))[0]!;
    expect(noLandingSource.url).toBe("https://x/p.pdf");
    // The fallback chain feeds the citation link only; the chips keep their
    // own explicit fields.
    expect(noLandingSource.pdfUrl).toBe("https://x/p.pdf");
    expect(noLandingSource.doi).toBe("10.1/x");

    const noWeb = searchValue({ papers: [{ ...PAPER, url: "", pdfUrl: "" }] });
    const noWebSource = sourcesOf(searchMetaFromValue(noWeb))[0]!;
    expect(noWebSource.url).toBe("https://doi.org/10.1/x");
    expect(noWebSource.pdfUrl).toBeUndefined();
    expect(noWebSource.doi).toBe("10.1/x");
  });

  it("returns shapeless meta for values without papers, so the generic card renders", () => {
    expect(searchMetaFromValue({ total: 0 } as JsonValue)).toEqual({});
  });
});

describe("presentSearchResult", () => {
  const ok: ToolResult = {
    content: [{ type: "text", text: "..." }],
    isError: false,
    meta: { sources: [{ url: "https://x/p", title: "A Paper", snippet: "s" }], truncated: true },
  };

  it("narrows persisted meta into a web search card titled by the query", () => {
    const view = presentSearchResult({ query: "crispr" }, ok);
    expect(view).toEqual({
      card: "web",
      kind: "search",
      title: "crispr",
      sources: [{ url: "https://x/p", title: "A Paper", snippet: "s" }],
      truncated: true,
    });
  });

  it("narrows meta whose sources carry the pdfUrl/doi fields (logged after the extension)", () => {
    const view = presentSearchResult({ query: "crispr" }, {
      ...ok,
      meta: {
        sources: [{ url: "https://x/p", title: "A Paper", snippet: "s", pdfUrl: "https://x/p.pdf", doi: "10.1/x" }],
        truncated: false,
      },
    });
    expect(view?.sources[0]).toEqual({
      url: "https://x/p",
      title: "A Paper",
      snippet: "s",
      pdfUrl: "https://x/p.pdf",
      doi: "10.1/x",
    });
  });

  it("keeps the generic card for failures and malformed meta (replay safety)", () => {
    expect(presentSearchResult({ query: "q" }, { ...ok, isError: true })).toBeUndefined();
    expect(presentSearchResult({ query: "q" }, { ...ok, meta: { sources: "nope" } })).toBeUndefined();
    expect(presentSearchResult({ query: "q" }, { ...ok, meta: undefined })).toBeUndefined();
    // A malformed chip field is malformed meta, not a chip to ignore.
    expect(presentSearchResult({ query: "q" }, {
      ...ok,
      meta: { sources: [{ url: "https://x/p", pdfUrl: 42 }], truncated: true },
    })).toBeUndefined();
  });
});
