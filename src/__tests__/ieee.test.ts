import { describe, expect, it } from "vitest";
import { parseIeeeResponse, ieeeSource } from "../sources/ieee";
import { acmSource } from "../sources/acm";
import { refreshSourceKeys } from "../keys";

describe("ieee parseIeeeResponse", () => {
  it("maps Xplore articles to paper cards", () => {
    const payload = {
      totalRecords: 1,
      articles: [{
        article_number: "9123456",
        article_title: "A Deep Learning Survey",
        publication_title: "IEEE Transactions on Pattern Analysis",
        publication_year: "2021",
        content_type: "Journals",
        abstract: "We survey deep learning methods.",
        doi: "10.1109/TPAMI.2021.9123456",
        authors: { authors: [{ full_name: "Alice Chen" }, { full_name: "Bob Li" }] },
      }],
    };
    const paper = parseIeeeResponse(payload)[0]!;
    expect(paper.paperId).toBe("9123456");
    expect(paper.title).toBe("A Deep Learning Survey");
    expect(paper.authors).toEqual(["Alice Chen", "Bob Li"]);
    expect(paper.doi).toBe("10.1109/TPAMI.2021.9123456");
    expect(paper.url).toBe("https://doi.org/10.1109/TPAMI.2021.9123456");
    expect(paper.publishedDate).toBe("2021");
    expect(paper.source).toBe("ieee");
    expect(paper.categories).toEqual(["IEEE Transactions on Pattern Analysis", "Journals"]);
  });

  it("falls back to doi/title as the paper id and drops titleless records", () => {
    const papers = parseIeeeResponse({
      articles: [
        { article_title: "No number", doi: "10.1109/x.1" },
        { abstract: "orphan record without a title" },
      ],
    });
    expect(papers).toHaveLength(1);
    expect(papers[0]!.paperId).toBe("10.1109/x.1");
  });
});

describe("key-gated sources", () => {
  it("ieee search throws a configuration hint without a key", async () => {
    await refreshSourceKeys({});
    await expect(ieeeSource.search({ query: "q", maxResults: 5 }))
      .rejects.toThrow(/PAPERSEARCH_IEEE_API_KEY/);
  });

  it("acm search reports the missing API even with a key stored", async () => {
    process.env.PAPERSEARCH_ACM_API_KEY = "k";
    try {
      await refreshSourceKeys({});
      await expect(acmSource.search({ query: "q", maxResults: 5 }))
        .rejects.toThrow(/no open metadata API/i);
    } finally {
      delete process.env.PAPERSEARCH_ACM_API_KEY;
    }
  });
});
