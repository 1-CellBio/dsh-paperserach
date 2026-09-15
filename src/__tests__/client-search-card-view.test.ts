import { describe, expect, it } from "vitest";
import { searchCardLifecycle, searchCardView } from "../client/search-card-view.ts";
import type { SearchCardBlock } from "../client/search-card-view.ts";
import { zh } from "../client/locales.ts";

/**
 * SearchCard state-machine tests: the repo has no client render setup
 * (vitest runs node-side only; no jsdom/react-dom/testing-library), so the
 * view-model layer is the testable surface. `t` uses the real zh dictionary,
 * which also pins the new search.* locale keys as registered.
 */
const t = (key: keyof typeof zh): string => zh[key];

const META_SOURCES = [
  {
    url: "https://x/p",
    title: "A Paper",
    snippet: "crossref 2024 — Alice; Bob",
    pdfUrl: "https://x/p.pdf",
    doi: "10.1/x",
  },
  { url: "https://x/q", title: "B Paper", snippet: "arxiv 2023" },
];

function settled(overrides: Partial<SearchCardBlock> = {}): SearchCardBlock {
  return {
    callId: "c1",
    kind: "tool-result",
    call: { name: "papersearch_search", argsRaw: JSON.stringify({ query: "crispr" }) },
    content: [{ type: "text", text: '{\n  "papers": []\n}' }],
    isError: false,
    meta: { sources: META_SOURCES, truncated: false },
    ...overrides,
  };
}

describe("searchCardView — running state", () => {
  it("shows the localized placeholder annotated with the query from the call args", () => {
    const block: SearchCardBlock = {
      callId: "c2",
      name: "papersearch_search",
      argsRaw: JSON.stringify({ query: "crispr", sources: "arxiv" }),
    };
    const view = searchCardView(block, t);
    expect(view.badge).toBe("running");
    expect(view.title).toBe("正在检索文献… · crispr");
    expect(view.sources).toBeUndefined();
    expect(view.detail).toBeUndefined();
  });

  it("keeps the bare placeholder when the args are missing or unparsable", () => {
    expect(searchCardView({ callId: "c3", name: "papersearch_search" }, t).title).toBe("正在检索文献…");
    expect(searchCardView({ callId: "c4", argsRaw: "{oops" }, t).title).toBe("正在检索文献…");
    expect(searchCardView({ callId: "c5", argsRaw: JSON.stringify({ query: "  " }) }, t).title)
      .toBe("正在检索文献…");
  });
});

describe("searchCardView — settled ok with usable meta", () => {
  it("renders the citation rows with pdf and doi chip targets", () => {
    const view = searchCardView(settled(), t);
    expect(view.badge).toBe("ok");
    expect(view.title).toBe("文献检索 · crispr");
    expect(view.sources).toEqual([
      {
        url: "https://x/p",
        title: "A Paper",
        snippet: "crossref 2024 — Alice; Bob",
        pdfUrl: "https://x/p.pdf",
        doiUrl: "https://doi.org/10.1/x",
      },
      { url: "https://x/q", title: "B Paper", snippet: "arxiv 2023", pdfUrl: undefined, doiUrl: undefined },
    ]);
    expect(view.truncated).toBe(false);
    expect(view.detail).toBeUndefined();
  });

  it("narrows old-shape meta (no pdfUrl/doi) into rows without chip targets", () => {
    const view = searchCardView(settled({
      meta: { sources: [{ url: "https://x/p", title: "A Paper" }], truncated: true },
    }), t);
    expect(view.badge).toBe("ok");
    expect(view.sources).toEqual([{ url: "https://x/p", title: "A Paper", snippet: undefined, pdfUrl: undefined, doiUrl: undefined }]);
    expect(view.truncated).toBe(true);
  });
});

describe("searchCardView — generic fallback (settled without usable meta)", () => {
  it("falls back to the generic row with the result head when the meta is malformed", () => {
    const view = searchCardView(settled({ meta: { sources: "nope" } }), t);
    expect(view.badge).toBe("fallback");
    expect(view.title).toBe("文献检索 · crispr");
    expect(view.detail).toBe('{ "papers": [] }');
  });

  it("falls back when the meta is absent or the source list is empty", () => {
    expect(searchCardView(settled({ meta: undefined }), t).badge).toBe("fallback");
    expect(searchCardView(settled({ meta: { sources: [], truncated: false } }), t).badge).toBe("fallback");
  });

  it("omits the detail when the fallback result carries no text", () => {
    const view = searchCardView(settled({ meta: undefined, content: [] }), t);
    expect(view.badge).toBe("fallback");
    expect(view.detail).toBeUndefined();
  });
});

describe("searchCardView — failure states", () => {
  it("shows the failure title and the result text on an isError result", () => {
    const view = searchCardView(settled({
      isError: true,
      content: [{ type: "text", text: "papersearch_search: source timeout after 120000ms" }],
    }), t);
    expect(view.badge).toBe("error");
    expect(view.title).toBe("检索失败 · crispr");
    expect(view.detail).toBe("papersearch_search: source timeout after 120000ms");
  });

  it("falls back to the structured error code, then a marker, when no text arrives", () => {
    expect(searchCardView(settled({ isError: true, content: [], error: { name: "TimeoutError", code: "timeout" } }), t).detail)
      .toBe("timeout");
    expect(searchCardView(settled({ isError: true, content: [] }), t).detail).toBe("unknown error");
  });

  it("collapses and caps long error text to one 400-character line", () => {
    const view = searchCardView(settled({
      isError: true,
      content: [{ type: "text", text: `${"x".repeat(300)}\n${"y".repeat(300)}` }],
    }), t);
    expect(view.detail).toHaveLength(400);
    expect(view.detail).not.toContain("\n");
  });

  it("renders the interrupt copy for a stopped call", () => {
    const block = settled({ error: { name: "AbortError", code: "interrupted" } });
    expect(searchCardLifecycle(block)).toBe("stopped");
    const view = searchCardView(block, t);
    expect(view.badge).toBe("stopped");
    expect(view.title).toBe("检索已中断");
    expect(view.detail).toBe("工具调用被中断，未返回检索结果");
    expect(view.sources).toBeUndefined();
  });
});
