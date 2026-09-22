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

const withPdf = (url: string, doi = ""): Paper => ({
  paperId: "x",
  title: "t",
  authors: [],
  abstract: "",
  doi,
  publishedDate: "",
  pdfUrl: url,
  url: url,
  source: "stub",
  categories: [],
  citations: 0,
});

describe("collectRepositoryCandidates", () => {
  it("keeps DOI-equal hits and never runs the title query once one lands", async () => {
    const seen: Array<{ id: string; query: string }> = [];
    const sources = REPOSITORY_FALLBACK_IDS.map((id) => stubAdapter(id, {
      papers: (query) => {
        seen.push({ id, query });
        if (id === "openaire" && query === "10.1/x") return [withPdf("https://openaire.example/doi.pdf", "10.1/x")];
        return [];
      },
    }));

    const urls = await collectRepositoryCandidates(sources, {
      doi: "10.1/x",
      title: "A Paper",
    });

    // The verified hit is the only candidate; the DOI queries of the other
    // repositories may run for backup links, but the title query never does.
    expect(urls).toEqual([{ url: "https://openaire.example/doi.pdf", identity: "doi-url" }]);
    expect(seen.some((entry) => entry.query === "A Paper")).toBe(false);
  });

  it("drops DOI-phase hits whose DOI does not match the request", async () => {
    const sources = [stubAdapter("openaire", {
      papers: () => [withPdf("https://openaire.example/wrong.pdf", "10.9/other")],
    })];
    const urls = await collectRepositoryCandidates(sources, { doi: "10.1/x" });
    expect(urls).toEqual([]);
  });

  it("fills from the title query only when the DOI phase found nothing", async () => {
    const seen: string[] = [];
    const sources = REPOSITORY_FALLBACK_IDS.map((id) => stubAdapter(id, {
      papers: (query) => {
        seen.push(`${id}:${query}`);
        return query === "A Paper" ? [withPdf(`https://${id}.example/title.pdf`)] : [];
      },
    }));

    const urls = await collectRepositoryCandidates(sources, {
      doi: "10.1/x",
      title: "A Paper",
    });

    expect(urls).toEqual([
      { url: "https://openaire.example/title.pdf", identity: "title-fallback" },
      { url: "https://core.example/title.pdf", identity: "title-fallback" },
      { url: "https://europepmc.example/title.pdf", identity: "title-fallback" },
    ]);
    // Every repository got the DOI query; the title query ran until the
    // global cap (3) stopped it inside europepmc.
    expect(seen).toEqual([
      "openaire:10.1/x",
      "core:10.1/x",
      "europepmc:10.1/x",
      "pmc:10.1/x",
      "openaire:A Paper",
      "core:A Paper",
      "europepmc:A Paper",
    ]);
  });

  it("marks a title-phase hit carrying the requested DOI as doi-url (normalized, case-insensitive)", async () => {
    const sources = [stubAdapter("openaire", {
      papers: (query) => (query === "A Paper" ? [withPdf("https://openaire.example/x.pdf", "https://doi.org/10.1/X")] : []),
    })];
    const urls = await collectRepositoryCandidates(sources, { doi: "10.1/x", title: "A Paper" });
    expect(urls).toEqual([{ url: "https://openaire.example/x.pdf", identity: "doi-url" }]);
  });

  it("runs only the title phase when no DOI is given", async () => {
    const seen: string[] = [];
    const sources = [stubAdapter("openaire", {
      papers: (query) => {
        seen.push(query);
        return [withPdf("https://openaire.example/t.pdf")];
      },
    })];
    const urls = await collectRepositoryCandidates(sources, { title: "t" });
    expect(urls).toEqual([{ url: "https://openaire.example/t.pdf", identity: "title-fallback" }]);
    expect(seen).toEqual(["t"]);
  });

  it("survives repository failures and still collects later hits", async () => {
    const sources = [
      stubAdapter("broken", { error: "network down" }),
      stubAdapter("ok", { papers: () => [withPdf("https://ok.example/a.pdf")] }),
    ];
    const urls = await collectRepositoryCandidates(sources, { title: "t" });
    expect(urls).toEqual([{ url: "https://ok.example/a.pdf", identity: "title-fallback" }]);
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
