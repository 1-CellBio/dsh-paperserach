import { describe, expect, it } from "vitest";
import { collectRepositoryCandidates, pickDownloadable, REPOSITORY_FALLBACK_IDS } from "../registry";
import { refreshSourceKeys } from "../keys";
import type { Paper } from "../paper";
import type { SearchArgs, SourceAdapter } from "../sources/adapter";

function stubAdapter(id: string, behavior: {
  papers?: (query: string) => Paper[];
  error?: string;
}): SourceAdapter {
  return {
    id,
    canDownload: false,
    async search(args: SearchArgs): Promise<Paper[]> {
      if (behavior.error) throw new Error(behavior.error);
      return behavior.papers?.(args.query) ?? [];
    },
  };
}

const withPdf = (url: string): Paper => ({
  paperId: "x",
  title: "t",
  authors: [],
  abstract: "",
  doi: "",
  publishedDate: "",
  pdfUrl: url,
  url: url,
  source: "stub",
  categories: [],
  citations: 0,
});

describe("collectRepositoryCandidates", () => {
  it("queries doi first then title, in repository order", async () => {
    const seen: Array<{ id: string; query: string }> = [];
    const sources = REPOSITORY_FALLBACK_IDS.map((id) => stubAdapter(id, {
      papers: (query) => {
        seen.push({ id, query });
        return [withPdf(`https://${id}.example/${query.includes("/") ? "doi" : "title"}.pdf`)];
      },
    }));

    const urls = await collectRepositoryCandidates(sources, {
      doi: "10.1/x",
      title: "A Paper",
    });

    // per-source doi→title order (upstream `for repo: for query:` shape);
    // the candidate cap stops collection after openaire/core
    expect(urls).toEqual([
      "https://openaire.example/doi.pdf",
      "https://openaire.example/title.pdf",
      "https://core.example/doi.pdf",
    ]);
    expect(seen.map((entry) => entry.id)).toEqual(["openaire", "openaire", "core"]);
    expect(seen.map((entry) => entry.query)).toEqual(["10.1/x", "A Paper", "10.1/x"]);
  });

  it("survives repository failures and still collects later hits", async () => {
    const sources = [
      stubAdapter("broken", { error: "network down" }),
      stubAdapter("ok", { papers: () => [withPdf("https://ok.example/a.pdf")] }),
    ];
    const urls = await collectRepositoryCandidates(sources, { title: "t" });
    expect(urls).toEqual(["https://ok.example/a.pdf"]);
  });

  it("returns nothing without doi or title", async () => {
    const urls = await collectRepositoryCandidates([stubAdapter("any", { papers: () => [withPdf("u")] })], {});
    expect(urls).toEqual([]);
  });
});

describe("pickDownloadable", () => {
  it("keeps papers with native download, pdf_url, or a doi for the fallback chain", async () => {
    await refreshSourceKeys({}); // no unpaywall email — doi alone must still qualify
    const papers = [
      { paperId: "a", source: "crossref", pdfUrl: "", doi: "10.1/a" },
      { paperId: "b", source: "openalex", pdfUrl: "https://x/b.pdf", doi: "" },
      { paperId: "c", source: "openalex", pdfUrl: "", doi: "" },
    ];
    const picked = pickDownloadable(papers, 5);
    expect(picked.map((paper) => paper.paperId)).toEqual(["a", "b"]);
  });
});
