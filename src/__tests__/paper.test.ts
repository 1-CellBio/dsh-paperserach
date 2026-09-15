import { describe, expect, it } from "vitest";
import {
  bareDoi,
  compactPaper,
  compactSearchResult,
  dedupePapers,
  extractDoi,
  paperKey,
  yearOf,
  type Paper,
} from "../paper";

const base: Paper = {
  paperId: "2404.18021v2",
  title: "A Study of Everything",
  authors: ["Alice Chen", "Bob Li", "Carol Wu"],
  abstract: "  We   study   everything.  ",
  doi: "10.1000/example.1",
  publishedDate: "2024-04-28",
  pdfUrl: "https://x/paper.pdf",
  url: "https://x/paper",
  source: "arxiv",
  categories: ["cs.AI"],
  citations: 7,
};

describe("compactPaper", () => {
  it("flattens authors, extracts the year and squeezes whitespace", () => {
    const card = compactPaper(base);
    expect(card).toEqual({
      paperId: "2404.18021v2",
      title: "A Study of Everything",
      authors: "Alice Chen; Bob Li; Carol Wu",
      year: "2024",
      doi: "10.1000/example.1",
      pdfUrl: "https://x/paper.pdf",
      url: "https://x/paper",
      source: "arxiv",
      citations: 7,
      abstract: "We study everything.",
    });
  });

  it("caps long author lists and abstracts with an ellipsis", () => {
    const many = { ...base, authors: Array.from({ length: 20 }, (_, i) => `Author ${i}`), abstract: "x".repeat(700) };
    const card = compactPaper(many);
    expect(card.authors.length).toBe(201);
    expect(card.authors.endsWith("…")).toBe(true);
    expect(card.abstract.length).toBe(601);
    expect(card.abstract.endsWith("…")).toBe(true);
  });

  it("keeps an exactly-at-cap abstract untouched", () => {
    const card = compactPaper({ ...base, abstract: "y".repeat(600) });
    expect(card.abstract).toBe("y".repeat(600));
  });

  it("degrades gracefully on missing fields", () => {
    const card = compactPaper({ ...base, authors: [], abstract: "", publishedDate: "", citations: undefined as unknown as number });
    expect(card.authors).toBe("");
    expect(card.abstract).toBe("");
    expect(card.year).toBe("");
    expect(card.citations).toBe(0);
  });
});

describe("yearOf", () => {
  it("takes the leading 4-digit year from any ISO-ish shape", () => {
    expect(yearOf({ publishedDate: "2021" })).toBe("2021");
    expect(yearOf({ publishedDate: "2021-06" })).toBe("2021");
    expect(yearOf({ publishedDate: "n.d." })).toBe("");
  });
});

describe("paperKey / dedupePapers", () => {
  it("prefers doi, then title+first author, then id", () => {
    expect(paperKey(base)).toBe("doi:10.1000/example.1");
    expect(paperKey({ ...base, doi: "" })).toBe("title:a study of everything|alice chen");
    expect(paperKey({ ...base, doi: "", title: "" })).toBe("id:2404.18021v2");
  });

  it("dedupes across sources preserving first-seen order", () => {
    const clone = { ...base, source: "semantic", paperId: "abc" };
    const other = { ...base, doi: "", title: "Another Paper", authors: ["Dana"], paperId: "xyz", source: "crossref" };
    expect(dedupePapers([base, clone, other]).map((paper) => paper.source)).toEqual(["arxiv", "crossref"]);
  });

  it("matches DOIs case-insensitively across sources", () => {
    const upper = { ...base, doi: "10.1000/EXAMPLE.1", source: "semantic", paperId: "s2" };
    expect(dedupePapers([base, upper])).toHaveLength(1);
  });
});

describe("extractDoi / bareDoi", () => {
  it("finds a DOI in prose, links and ids and trims punctuation", () => {
    expect(extractDoi("see https://doi.org/10.1016/j.cell.2023.01.002, discussed")).toBe("10.1016/j.cell.2023.01.002");
    expect(extractDoi("DOI: 10.1109/TPAMI.2021.9123456.")).toBe("10.1109/TPAMI.2021.9123456");
    expect(extractDoi("no identifier here")).toBe("");
  });

  it("normalizes doi.org links to bare DOIs", () => {
    expect(bareDoi("https://doi.org/10.1000/example.1")).toBe("10.1000/example.1");
    expect(bareDoi("http://dx.doi.org/10.1000/example.1")).toBe("10.1000/example.1");
    expect(bareDoi("")).toBe("");
  });
});

describe("compactSearchResult", () => {
  it("merges per-source lists, dedupes and reports counts", () => {
    const result = compactSearchResult("q", ["arxiv", "semantic"], [[base], [{ ...base, source: "semantic", paperId: "s1" }]], {});
    expect(result.sourceResults).toEqual({ arxiv: 1, semantic: 1 });
    expect(result.total).toBe(1);
    expect(result.returned).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.papers[0]!.source).toBe("arxiv");
  });

  it("keeps errors and marks truncation past the 40-card cap", () => {
    const fill = Array.from({ length: 45 }, (_, i) => ({ ...base, doi: `10.1/x${i}`, paperId: `p${i}` }));
    const result = compactSearchResult("q", ["arxiv"], [fill], { arxiv: "HTTP 429" });
    expect(result.errors).toEqual({ arxiv: "HTTP 429" });
    expect(result.total).toBe(45);
    expect(result.returned).toBe(40);
    expect(result.truncated).toBe(true);
  });
});
