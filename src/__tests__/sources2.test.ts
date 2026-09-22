import { describe, expect, it } from "vitest";
import { parseScholarHtml } from "../sources/google_scholar";
import { parseEprintHtml } from "../sources/iacr";
import { parseDblpXml } from "../sources/dblp";
import { parseBaseHtml } from "../sources/base";
import { parseSsrnHtml } from "../sources/ssrn";
import { rebuildAbstract } from "../sources/openalex";
import { parseIeeeResponse } from "../sources/ieee";

/** Parser-level tests for the scraping / reshaping adapters: every fixture
 * here is a trimmed shape of the real wire format, so regressions in the
 * regex layers surface without any network. */

describe("google_scholar parser", () => {
  it("extracts title link, authors, year and cited-by from a result block", () => {
    const html = `<div class="gs_r gs_or gs_scl"><div class="gs_ri">
      <h3 class="gs_rt"><a id="link1" href="https://example.org/paper">Deep learning for cells</a></h3>
      <div class="gs_a">R Chen, J Doe, 2021 - Journal of Cells - publisher.example</div>
      <div class="gs_rs">A survey of methods. cited by 123 Flaky text follows.</div>
    </div></div>`;
    const [paper] = parseScholarHtml(html);
    expect(paper).toMatchObject({
      title: "Deep learning for cells",
      url: "https://example.org/paper",
      source: "google_scholar",
      publishedDate: "2021",
      citations: 123,
    });
    expect(paper!.authors).toEqual(["R Chen", "J Doe"]);
  });

  it("never takes the year from snippet text (cited by 2019)", () => {
    const html = `<div class="gs_r gs_or gs_scl"><div class="gs_ri">
      <h3 class="gs_rt"><a href="https://example.org/p2">Another paper</a></h3>
      <div class="gs_a">R Chen - Journal of Cells - publisher.example</div>
      <div class="gs_rs">Methods from 2019 were limited. cited by 2019 readers agreed.</div>
    </div></div>`;
    // The author segment carries no four-digit year → publishedDate is empty,
    // even though the snippet mentions 2019 twice.
    expect(parseScholarHtml(html)[0]!.publishedDate).toBe("");
  });

  it("prefers the author-segment year over snippet years", () => {
    const html = `<div class="gs_r gs_or gs_scl"><div class="gs_ri">
      <h3 class="gs_rt"><a href="https://example.org/p3">Third paper</a></h3>
      <div class="gs_a">R Chen, 2020 - publisher.example</div>
      <div class="gs_rs">Builds on 2019 work and cites 2018 results.</div>
    </div></div>`;
    expect(parseScholarHtml(html)[0]!.publishedDate).toBe("2020");
  });

  it("keeps a [PDF] side link as the direct pdf url", () => {
    const html = `<div class="gs_r gs_or gs_scl"><div class="gs_ri">
      <h3 class="gs_rt"><a href="https://example.org/landing">Title</a></h3>
      <span><a href="https://cdn.example.org/paper.pdf">[PDF] cdn.example.org</a></span>
      <div class="gs_a">A Author - 2019</div>
    </div></div>`;
    expect(parseScholarHtml(html)[0]!.pdfUrl).toBe("https://cdn.example.org/paper.pdf");
  });
});

describe("iacr ePrint parser", () => {
  it("maps a search hit to a paper with a native pdf url", () => {
    const html = `<div class="searchhitbox">
      <span class="searchhit"><a href="/2026/1991">Lattice Signatures Revisited</a></span>
      <p class="searchauthors">Alice Chen; Bob Li</p>
      <p class="abstract">We revisit lattice signatures.</p>
      2026-09-01
    </div>`;
    const [paper] = parseEprintHtml(html);
    expect(paper).toMatchObject({
      paperId: "2026/1991",
      title: "Lattice Signatures Revisited",
      pdfUrl: "https://eprint.iacr.org/2026/1991.pdf",
      source: "iacr",
    });
    expect(paper!.authors).toEqual(["Alice Chen", "Bob Li"]);
  });
});

describe("dblp parser", () => {
  it("reads the publ API xml shape", () => {
    const xml = `<result><hits>
      <hit><info>
        <authors><author>Alice Chen</author><author>Bob Li</author></authors>
        <title>Graph Tools</title><venue>CONF</venue><year>2020</year>
        <doi>10.1000/gt</doi><url>https://dblp.org/rec/conf/gt</url><key>conf/gt</key>
      </info></hit>
    </hits></result>`;
    const [paper] = parseDblpXml(xml);
    expect(paper).toMatchObject({
      paperId: "conf/gt",
      title: "Graph Tools",
      doi: "10.1000/gt",
      publishedDate: "2020",
      source: "dblp",
    });
    expect(paper!.authors).toEqual(["Alice Chen", "Bob Li"]);
  });
});

describe("openalex abstract rebuild", () => {
  it("reorders the inverted index into the original sentence", () => {
    expect(rebuildAbstract({ We: [0], study: [1], cells: [3], the: [2] })).toBe("We study the cells");
    expect(rebuildAbstract(null)).toBe("");
    expect(rebuildAbstract({})).toBe("");
  });
});

describe("ieee response mapping", () => {
  it("keeps publication metadata and degrades ids gracefully", () => {
    const papers = parseIeeeResponse({
      articles: [
        {
          article_number: "9123456",
          article_title: "Survey",
          publication_title: "Trans",
          publication_year: "2021",
          content_type: "Journals",
          doi: "10.1109/x.1",
          authors: { authors: [{ full_name: "A Chen" }] },
        },
        { article_title: "No number", doi: "10.1109/y.2" },
        { abstract: "orphan" },
      ],
    });
    expect(papers).toHaveLength(2);
    expect(papers[0]).toMatchObject({ paperId: "9123456", url: "https://doi.org/10.1109/x.1", categories: ["Trans", "Journals"] });
    expect(papers[1]!.paperId).toBe("10.1109/y.2");
  });
});

describe("base / ssrn scraping fallbacks", () => {
  it("base tolerates attribute order in the title link", () => {
    const html = `<div class="record">
      <a class="title" href="https://example.org/doc">Institutional record</a>
      Smith, J. - 2022 - repository
    </div>`;
    const [paper] = parseBaseHtml(html);
    expect(paper).toMatchObject({ title: "Institutional record", url: "https://example.org/doc", publishedDate: "2022" });
  });

  it("ssrn pulls the abstract id out of either url shape", () => {
    const html = `<tr class="result"><td>
      <a href="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4801234">Market Effects</a>
    </td></tr>`;
    const [paper] = parseSsrnHtml(html);
    expect(paper).toMatchObject({ paperId: "4801234", title: "Market Effects", source: "ssrn" });
  });

  it("ssrn also parses the modern /abstract/ path form", () => {
    const html = `<tr class="result"><td>
      <a href="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1111111">Old</a>
    </td></tr>
    <tr class="result"><td>
      <a href="https://papers.ssrn.com/abstract/4809999">New</a>
    </td></tr>`;
    const papers = parseSsrnHtml(html);
    expect(papers.map((paper) => paper.paperId)).toEqual(["1111111", "4809999"]);
  });

  it("iacr drops blocks without a paper id", () => {
    const html = `<div class="searchhitbox"><span class="searchhit"><a href="/other">No numeric id</a></span></div>
      <div class="searchhitbox"><span class="searchhit"><a href="/2026/0123">Real</a></span></div>`;
    const papers = parseEprintHtml(html);
    expect(papers).toHaveLength(1);
    expect(papers[0]!.paperId).toBe("2026/0123");
  });

  it("empty pages parse to empty lists", () => {
    expect(parseBaseHtml("<html></html>")).toEqual([]);
    expect(parseSsrnHtml("<html></html>")).toEqual([]);
    expect(parseScholarHtml("<html></html>")).toEqual([]);
    expect(parseEprintHtml("<html></html>")).toEqual([]);
  });
});
