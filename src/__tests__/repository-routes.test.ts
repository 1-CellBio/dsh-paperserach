import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __httpTestSeams } from "../http";
import { refreshSourceKeys } from "../keys";
import type { Paper } from "../paper";
import { collectRepositoryCandidates, downloadByDoi, SOURCES } from "../registry";
import type { SearchArgs, SourceAdapter } from "../sources/adapter";
import { resolvePmcOpenDataPdfUrl } from "../sources/pmc_open_data";
import { resetSciHubHealth } from "../sources/sci_hub";

// run-9 live probe (2026-10-01): of 7 "paywalled" DOIs, OpenAIRE answered 409 to every DOI query
// (the DOI went into `keywords=`), CORE answered 500/429, Europe PMC's pdf=render links sit behind
// a Cloudflare challenge (403 for every non-browser client), and the PMC repository adapter never
// produced a link. The one route that works for scripted clients is the PMC Open Access bucket.

const BUCKET = "https://pmc-oa-opendata.s3.amazonaws.com";
const pdfMagic = Buffer.concat([Buffer.from("%PDF-1.7 fake content for tests\n"), Buffer.from("x".repeat(2048))]);

function fakePdfResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/pdf" : null) },
    arrayBuffer: async () => pdfMagic.buffer.slice(pdfMagic.byteOffset, pdfMagic.byteOffset + pdfMagic.byteLength),
  };
}

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => payload,
  };
}

function textResponse(body: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/xml" : null) },
    text: async () => body,
  };
}

function httpError(status: number) {
  return { ok: false, status, headers: { get: () => null } };
}

const listing = (...keys: string[]): string =>
  `<?xml version="1.0"?><ListBucketResult>${keys.map((key) => `<Contents><Key>${key}</Key><Size>10</Size></Contents>`).join("")}</ListBucketResult>`;

const byId = (id: string): SourceAdapter => {
  const source = SOURCES.find((entry) => entry.id === id);
  if (!source) throw new Error(`missing adapter ${id}`);
  return source;
};

const args = (query: string): SearchArgs => ({ query, maxResults: 3 });

const paperOf = (overrides: Partial<Paper>): Paper => ({
  paperId: "x", title: "t", authors: [], abstract: "", doi: "", publishedDate: "", pdfUrl: "", url: "",
  source: "stub", categories: [], citations: 0, ...overrides,
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await refreshSourceKeys({});
});

describe("OpenAIRE / CORE DOI queries", () => {
  it("OpenAIRE: a DOI goes into the doi filter (keywords= rejects it with a syntax error); a title stays a keyword query", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return jsonResponse({ response: { results: 0, result: [] } });
    }));
    await byId("openaire").search(args("10.1038/s41467-020-15719-6"));
    await byId("openaire").search(args("https://doi.org/10.1038/S41467-020-15719-6"));
    await byId("openaire").search(args("senescence of stellate cells"));
    expect(urls[0]).toContain("doi=10.1038%2Fs41467-020-15719-6");
    expect(urls[0]).not.toContain("keywords=");
    expect(urls[1]).toContain("doi=10.1038%2Fs41467-020-15719-6");
    expect(urls[2]).toContain("keywords=senescence");
    expect(urls[2]).not.toContain("doi=");
  });

  it("CORE: a DOI is sent as a quoted doi: field query (an unquoted slash is parsed as a regex and answered with HTTP 500)", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return jsonResponse({ results: [] });
    }));
    await byId("core").search(args("10.1038/s41467-020-15719-6"));
    await byId("core").search(args("senescence of stellate cells"));
    expect(decodeURIComponent(urls[0]!.replace(/\+/g, " "))).toContain('q=doi:"10.1038/s41467-020-15719-6"');
    expect(urls[1]).toContain("q=senescence");
  });
});

describe("resolvePmcOpenDataPdfUrl", () => {
  it("lists the bucket under the exact PMC id and returns the newest version's PDF", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return textResponse(listing(
        "PMC3587431.1/PMC3587431.1.json", "PMC3587431.1/PMC3587431.1.pdf",
        "PMC3587431.2/PMC3587431.2.pdf", "PMC3587431.2/PMC3587431.2.xml",
      ));
    }));
    expect(await resolvePmcOpenDataPdfUrl("pmc3587431")).toBe(`${BUCKET}/PMC3587431.2/PMC3587431.2.pdf`);
    expect(urls[0]).toContain("prefix=PMC3587431.");
  });

  it("an article outside the open-access subset (no PDF key) resolves undefined; a bucket error propagates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(listing("PMC9.1/PMC9.1.xml"))));
    expect(await resolvePmcOpenDataPdfUrl("PMC9")).toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => httpError(503)));
    const realSleep = __httpTestSeams.sleep;
    __httpTestSeams.sleep = async () => {};
    try {
      await expect(resolvePmcOpenDataPdfUrl("PMC9")).rejects.toThrow(/503/);
    } finally {
      __httpTestSeams.sleep = realSleep;
    }
  });

  it("the PMC adapter's native download uses the bucket instead of the retired oa.fcgi service", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(listing("PMC3587431.1/PMC3587431.1.pdf"))));
    expect(await byId("pmc").download!("3587431")).toEqual({
      url: `${BUCKET}/PMC3587431.1/PMC3587431.1.pdf`,
      baseName: "pmc-3587431",
    });
  });
});

describe("collectRepositoryCandidates: PMC open-access bucket route", () => {
  const stub = (id: string, papers: Paper[]): SourceAdapter => ({
    id,
    canDownload: false,
    async search(_args: SearchArgs): Promise<Paper[]> {
      return papers;
    },
  });

  it("a DOI-verified PMC article contributes the bucket PDF ahead of its own (blocked) render link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(listing("PMC3587431.1/PMC3587431.1.pdf"))));
    const europepmc = stub("europepmc", [paperOf({
      source: "europepmc", paperId: "3587431", doi: "10.4161/cc.23549",
      url: "https://europepmc.org/article/PMC/3587431", pdfUrl: "https://europepmc.org/articles/PMC3587431?pdf=render",
    })]);
    const urls = await collectRepositoryCandidates([europepmc], { doi: "10.4161/cc.23549" });
    expect(urls).toEqual([
      { url: `${BUCKET}/PMC3587431.1/PMC3587431.1.pdf`, identity: "doi-url" },
      { url: "https://europepmc.org/articles/PMC3587431?pdf=render", identity: "doi-url" },
    ]);
  });

  it("the PMC adapter (no pdfUrl of its own) also yields the bucket link; a DOI mismatch yields nothing and costs no bucket call", async () => {
    const fetchMock = vi.fn(async () => textResponse(listing("PMC12190739.1/PMC12190739.1.pdf")));
    vi.stubGlobal("fetch", fetchMock);
    const pmc = stub("pmc", [
      paperOf({ source: "pmc", paperId: "12190739", doi: "10.3390/biom15060860", url: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12190739/" }),
      paperOf({ source: "pmc", paperId: "999", doi: "10.9999/other", url: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC999/" }),
    ]);
    const urls = await collectRepositoryCandidates([pmc], { doi: "10.3390/biom15060860" });
    expect(urls).toEqual([{ url: `${BUCKET}/PMC12190739.1/PMC12190739.1.pdf`, identity: "doi-url" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a bucket failure is reported to onSource and does not hide the repository's own link", async () => {
    const realSleep = __httpTestSeams.sleep;
    __httpTestSeams.sleep = async () => {};
    vi.stubGlobal("fetch", vi.fn(async () => httpError(500)));
    const probes: Array<{ source: string; ok: boolean; detail?: string }> = [];
    try {
      const europepmc = stub("europepmc", [paperOf({
        source: "europepmc", paperId: "3587431", doi: "10.4161/cc.23549",
        url: "https://europepmc.org/article/PMC/3587431", pdfUrl: "https://europepmc.org/articles/PMC3587431?pdf=render",
      })]);
      const urls = await collectRepositoryCandidates([europepmc], { doi: "10.4161/cc.23549" }, { onSource: (p) => probes.push(p) });
      expect(urls).toEqual([{ url: "https://europepmc.org/articles/PMC3587431?pdf=render", identity: "doi-url" }]);
      expect(probes).toContainEqual({ source: "pmc-open-data", ok: false, detail: "HTTP 500" });
    } finally {
      __httpTestSeams.sleep = realSleep;
    }
  });
});

describe("candidate de-duplication", () => {
  it("the same bucket link from Europe PMC and the PMC adapter is stored once and counts once against the cap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(listing("PMC12190739.1/PMC12190739.1.pdf"))));
    const stub = (id: string, papers: Paper[]): SourceAdapter => ({ id, canDownload: false, search: async () => papers });
    const common = { doi: "10.3390/biom15060860" };
    const europepmc = stub("europepmc", [paperOf({
      ...common, source: "europepmc", paperId: "12190739", url: "https://europepmc.org/article/PMC/12190739", pdfUrl: "https://europepmc.org/articles/PMC12190739?pdf=render",
    })]);
    const pmc = stub("pmc", [paperOf({ ...common, source: "pmc", paperId: "12190739", url: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12190739/" })]);
    const urls = await collectRepositoryCandidates([europepmc, pmc], { doi: "10.3390/biom15060860" });
    expect(urls.map((c) => c.url)).toEqual([
      `${BUCKET}/PMC12190739.1/PMC12190739.1.pdf`,
      "https://europepmc.org/articles/PMC12190739?pdf=render",
    ]);
  });

  it("a PDF link offered by two stages (Semantic Scholar and a repository) is tried once", async () => {
    await refreshSourceKeys({ useScihub: false }); // the unstubbed mirror lookups are not what this test covers
    const attempts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) {
        return jsonResponse({ title: "Cell cycle paper", openAccessPdf: { url: "https://pub.example/a.pdf" } });
      }
      if (raw.startsWith("https://api.openaire.eu/")) {
        return jsonResponse({
          response: {
            results: 1,
            result: [{
              metadata: { "oaf:entity": { "oaf:result": {
                title: [{ content: "Cell cycle paper" }],
                pid: { "@classid": "doi", "$": "10.4161/cc.23549" },
                children: [{ instance: [{ webresource: [{ url: "https://doi.org/10.4161/cc.23549" }, { url: "https://pub.example/a.pdf" }] }] }],
              } } },
            }],
          },
        });
      }
      if (raw.startsWith("https://api.core.ac.uk/")) return jsonResponse({ results: [] });
      if (raw.startsWith("https://www.ebi.ac.uk/")) return jsonResponse({ resultList: { result: [] } });
      if (raw.startsWith("https://eutils.ncbi.nlm.nih.gov/")) return jsonResponse({ esearchresult: { idlist: [] } });
      if (raw === "https://pub.example/a.pdf") {
        attempts.push(raw);
        return httpError(403);
      }
      throw new Error(`unexpected fetch ${raw}`);
    }));
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-dedupe-"));
    try {
      const outcome = await downloadByDoi("10.4161/cc.23549", { dir });
      expect(outcome.status).toBe("failed");
      expect(attempts).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("downloadByDoi through the PMC open-access bucket", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-pmcs3-"));
    resetSciHubHealth();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("Europe PMC finds the PMC id, the bucket serves the PDF, the blocked render link is never fetched", async () => {
    await refreshSourceKeys({ useScihub: false }); // the unstubbed mirror lookups are not what this test covers
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      fetched.push(raw);
      if (raw.startsWith("https://api.semanticscholar.org/")) return httpError(404);
      if (raw.startsWith("https://www.ebi.ac.uk/")) {
        return jsonResponse({
          resultList: {
            result: [{
              id: "23549", pmcid: "PMC3587431", doi: "10.4161/cc.23549", title: "Cell cycle paper",
              fullTextUrlList: { fullTextUrl: [{ documentStyle: "pdf", url: "https://europepmc.org/articles/PMC3587431?pdf=render" }] },
            }],
          },
        });
      }
      if (raw.startsWith(`${BUCKET}/?list-type=2`)) return textResponse(listing("PMC3587431.1/PMC3587431.1.pdf"));
      if (raw === `${BUCKET}/PMC3587431.1/PMC3587431.1.pdf`) return fakePdfResponse();
      if (raw.startsWith("https://api.openaire.eu/")) return jsonResponse({ response: { results: 0, result: [] } });
      if (raw.startsWith("https://api.core.ac.uk/")) return jsonResponse({ results: [] });
      if (raw.startsWith("https://eutils.ncbi.nlm.nih.gov/")) return jsonResponse({ esearchresult: { idlist: [] } });
      throw new Error(`unexpected fetch ${raw}`);
    }));

    const outcome = await downloadByDoi("10.4161/cc.23549", { dir });
    expect(outcome.status).toBe("downloaded");
    expect(outcome.identity).toBe("doi-url");
    const sidecar = JSON.parse(await readFile(`${outcome.path}.meta.json`, "utf8")) as Record<string, unknown>;
    expect(sidecar.sourceUrl).toBe(`${BUCKET}/PMC3587431.1/PMC3587431.1.pdf`);
    expect(fetched.some((u) => u.includes("pdf=render"))).toBe(false);
  });
});
