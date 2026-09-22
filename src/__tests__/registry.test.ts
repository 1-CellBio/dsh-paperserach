import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadAll, downloadPaper, fetchPdf, pickDownloadable, SOURCE_IDS } from "../registry";
import { safeFileFragment } from "../sources/adapter";
import { qs } from "../http";
import { expandDirTemplate } from "../settings";

const pdfMagic = Buffer.concat([
  Buffer.from("%PDF-1.7 fake content for tests\n"),
  Buffer.from("x".repeat(2048)),
]);
/** Known digest of pdfMagic (sha256, full-length lowercase hex — the same
 * algorithm the sidecar contract shares with dsh-okf's pipeline/hash.ts). */
const PDF_MAGIC_SHA256 = "31689224d399255aa7916c75732c420713c64f1885010f8246587979c1c45179";

/** A second valid payload so a re-download genuinely changes the bytes. */
const changedPdf = Buffer.concat([
  Buffer.from("%PDF-1.7 v2 payload\n"),
  Buffer.from("y".repeat(2048)),
]);

function fakePdfResponse(buffer: Buffer = pdfMagic, contentType = "application/pdf") {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
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

function htmlResponse(body: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null) },
    text: async () => body,
  };
}

/** One OpenAIRE API record: fileMain-style webresources plus a title. */
function openaireRecord(urls: string[], title: string) {
  return {
    metadata: {
      "oaf:entity": {
        "oaf:result": {
          title: [{ content: title }],
          children: [{ instance: [{ webresource: urls.map((url) => ({ url })) }] }],
        },
      },
    },
  };
}

async function readSidecarFile(pdfPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(`${pdfPath}.meta.json`, "utf8")) as Record<string, unknown>;
}

describe("safeFileFragment", () => {
  it("replaces unsafe characters and trims", () => {
    expect(safeFileFragment("10.1101/2024.01.01.123456")).toBe("10.1101_2024.01.01.123456");
    expect(safeFileFragment("  ../escape  ")).toBe(".._escape");
    expect(safeFileFragment("")).toBe("paper");
  });
});

describe("qs", () => {
  it("skips empty values", () => {
    expect(qs({ a: "1", b: "", c: undefined, d: 2 })).toBe("a=1&d=2");
  });
});

describe("expandDirTemplate", () => {
  it("expands cwd/workspace/home tokens", () => {
    expect(expandDirTemplate("${cwd}/OKF/sources/pdfs", "/ws/session")).toBe("/ws/session/OKF/sources/pdfs");
    expect(expandDirTemplate("${workspace}/x", "/ws")).toBe("/ws/x");
    expect(expandDirTemplate("/abs/${nope}", "/ws")).toBe("/abs/${nope}");
  });
});

describe("pickDownloadable", () => {
  const papers = [
    { paperId: "a1", source: "arxiv", pdfUrl: "" },       // native download
    { paperId: "p1", source: "pubmed", pdfUrl: "" },      // metadata-only, no pdf
    { paperId: "c1", source: "crossref", pdfUrl: "https://x/1.pdf" }, // pdf_url
  ];

  it("keeps native-capable and pdf_url papers, drops metadata-only", () => {
    expect(pickDownloadable(papers, 10).map((p) => p.paperId)).toEqual(["a1", "c1"]);
  });

  it("honors the count cap", () => {
    expect(pickDownloadable(papers, 1).map((p) => p.paperId)).toEqual(["a1"]);
  });
});

describe("fetchPdf", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-"));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it("saves a PDF payload and reports the path and bytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse()));
    const saved = await fetchPdf("https://x/1.pdf", dir, "arxiv-2401.00001", {});
    expect(saved.path).toBe(path.join(dir, "arxiv-2401.00001.pdf"));
    expect(saved.bytes).toBe(pdfMagic.byteLength);
  });

  it("rejects payloads that are not PDFs (magic check)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse(Buffer.from("<html>not a pdf</html>"), "text/html")));
    await expect(fetchPdf("https://x/1", dir, "bad", {})).rejects.toThrow(/not a PDF/);
  });

  it("rejects an HTML error page served with a pdf content-type (magic is mandatory)", async () => {
    const html = Buffer.concat([Buffer.from("<html>error page</html>\n"), Buffer.from("x".repeat(2048))]);
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse(html, "application/pdf")));
    await expect(fetchPdf("https://x/1", dir, "fakepdf", {})).rejects.toThrow(/missing %PDF- magic/);
  });

  it("saves a payload with %PDF- magic regardless of the content-type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse(pdfMagic, "application/octet-stream")));
    const saved = await fetchPdf("https://x/1", dir, "oddbin", {});
    expect(saved.path).toBe(path.join(dir, "oddbin.pdf"));
  });

  it("leaves no .part file behind after a successful save", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse()));
    await fetchPdf("https://x/1", dir, "clean", {});
    await expect(stat(path.join(dir, "clean.pdf"))).resolves.toHaveProperty("size", pdfMagic.byteLength);
    const entries = await readdir(dir);
    expect(entries.filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("cleans up the .part file when the final rename fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse()));
    // A directory parked on the target name makes the file→target rename fail.
    await mkdir(path.join(dir, "blocked.pdf"));
    await expect(fetchPdf("https://x/1", dir, "blocked", {})).rejects.toThrow();
    const entries = await readdir(dir);
    expect(entries.filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("rejects tiny payloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse(Buffer.from("%PDF-x"), "application/pdf")));
    await expect(fetchPdf("https://x/1", dir, "tiny", {})).rejects.toThrow(/not a PDF/);
  });

  it("writes a provenance sidecar next to the PDF", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse()));
    const saved = await fetchPdf("https://x/1.pdf", dir, "arxiv-2401.00001", {
      meta: { doi: "10.1/x", title: "T", source: "arxiv", sourceUrl: "https://x/1.pdf", identity: "doi-url" },
    });
    const sidecar = await readSidecarFile(saved.path);
    expect(sidecar).toEqual({
      sha256: PDF_MAGIC_SHA256,
      bytes: pdfMagic.byteLength,
      doi: "10.1/x",
      title: "T",
      source: "arxiv",
      sourceUrl: "https://x/1.pdf",
      retrievedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
      identity: "doi-url",
    });
  });

  it("records identity unknown when no meta was supplied", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse()));
    const saved = await fetchPdf("https://x/2.pdf", dir, "bare", {});
    const sidecar = await readSidecarFile(saved.path);
    expect(sidecar.identity).toBe("unknown");
    expect(sidecar.sourceUrl).toBe("https://x/2.pdf");
  });
});

describe("downloadPaper", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-"));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it("is idempotent: a sidecar-verified file reports exists without refetching", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse()));
    await downloadPaper("arxiv", "2305.05093v1", { dir });
    const fetchMock = vi.fn(async () => {
      throw new Error("must not refetch an unchanged file");
    });
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await downloadPaper("arxiv", "2305.05093v1", { dir });
    expect(outcome.status).toBe("exists");
    expect(outcome.path).toBe(path.join(dir, "arxiv-2305.05093v1.pdf"));
    expect(outcome.bytes).toBe(pdfMagic.byteLength);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces a changed file (hash mismatch) and rewrites the sidecar", async () => {
    // A completed download (sidecar still describes pdfMagic) whose bytes on
    // disk later drifted to a different payload.
    await writeFile(path.join(dir, "arxiv-2305.05093v1.pdf"), changedPdf);
    await writeFile(path.join(dir, "arxiv-2305.05093v1.pdf.meta.json"), JSON.stringify({
      sha256: PDF_MAGIC_SHA256,
      bytes: pdfMagic.byteLength,
      doi: "",
      title: "",
      source: "arxiv",
      sourceUrl: "https://arxiv.org/pdf/2305.05093v1",
      retrievedAt: new Date().toISOString(),
      identity: "repository-unverified",
    }));
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse(pdfMagic)));

    const outcome = await downloadPaper("arxiv", "2305.05093v1", { dir });
    expect(outcome.status).toBe("replaced");
    expect(outcome.bytes).toBe(pdfMagic.byteLength);
    await expect(readFile(path.join(dir, "arxiv-2305.05093v1.pdf"))).resolves.toHaveProperty(
      "byteLength",
      pdfMagic.byteLength,
    );
    const sidecar = await readSidecarFile(path.join(dir, "arxiv-2305.05093v1.pdf"));
    expect(sidecar.sha256).toBe(PDF_MAGIC_SHA256);
    expect(sidecar.bytes).toBe(pdfMagic.byteLength);
  });

  it("treats a legacy file without a sidecar as unverified: re-downloads it and records one", async () => {
    await writeFile(path.join(dir, "arxiv-2305.05093v1.pdf"), pdfMagic);
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse()));
    const outcome = await downloadPaper("arxiv", "2305.05093v1", { dir });
    // Old bytes could not be verified — they were overwritten, not trusted.
    expect(outcome.status).toBe("replaced");
    const sidecar = await readSidecarFile(path.join(dir, "arxiv-2305.05093v1.pdf"));
    expect(sidecar.sha256).toBe(PDF_MAGIC_SHA256);
    expect(sidecar.identity).toBe("repository-unverified"); // arxiv native link, no card DOI
  });

  it("downloads via the source adapter and sanitizes the file name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse()));
    const outcome = await downloadPaper("arxiv", "2404.18021v2", { dir });
    expect(outcome.status).toBe("downloaded");
    expect(outcome.path).toBe(path.join(dir, "arxiv-2404.18021v2.pdf"));
    expect(outcome.bytes).toBeGreaterThan(0);
  });

  it("falls back to metadata.pdfUrl when the source has no downloader", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse()));
    const outcome = await downloadPaper("openalex", "W123", { dir }, {
      pdfUrl: "https://publisher.org/1.pdf",
    });
    expect(outcome.status).toBe("downloaded");
    expect(outcome.path).toBe(path.join(dir, "openalex-W123.pdf"));
    // A card pdf_url is a repository link without a DOI cross-check.
    const sidecar = await readSidecarFile(path.join(dir, "openalex-W123.pdf"));
    expect(sidecar.identity).toBe("repository-unverified");
    expect(sidecar.sourceUrl).toBe("https://publisher.org/1.pdf");
  });

  it("repository fallback: a DOI-equal hit wins with identity doi-url and skips the title query", async () => {
    const openaireQueries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.openaire.eu/search/publications")) {
        openaireQueries.push(raw);
        return jsonResponse({
          response: {
            results: 1,
            result: [openaireRecord(["https://doi.org/10.1109/test.2020", "https://repo.example/paper.pdf"], "A Paper")],
          },
        });
      }
      if (raw.startsWith("https://api.core.ac.uk/")) return jsonResponse({ results: [] });
      if (raw.startsWith("https://www.ebi.ac.uk/")) return jsonResponse({ resultList: { result: [] } });
      if (raw.startsWith("https://eutils.ncbi.nlm.nih.gov/")) return jsonResponse({ esearchresult: { idlist: [] } });
      if (raw.startsWith("https://api.unpaywall.org/")) return jsonResponse({ doi: "10.1109/test.2020", is_oa: false, oa_locations: [] });
      if (/^https:\/\/sci-hub\./.test(raw)) return htmlResponse("<html>article not found</html>");
      return fakePdfResponse();
    }));

    const outcome = await downloadPaper("openalex", "W123", { dir }, { doi: "10.1109/test.2020", title: "A Paper" });
    expect(outcome.status).toBe("downloaded");
    expect(outcome.path).toBe(path.join(dir, "openalex-W123.pdf"));
    // Only the DOI query ran against openaire — the title query never joined.
    expect(openaireQueries).toHaveLength(1);
    expect(openaireQueries[0]).toContain("keywords=10.1109%2Ftest.2020");
    const sidecar = await readSidecarFile(path.join(dir, "openalex-W123.pdf"));
    expect(sidecar.identity).toBe("doi-url");
    expect(sidecar.sourceUrl).toBe("https://repo.example/paper.pdf");
    expect(sidecar.doi).toBe("10.1109/test.2020");
    expect(sidecar.source).toBe("openalex");
  });

  it("repository fallback matched only by title is recorded as title-fallback", async () => {
    const openaireQueries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.openaire.eu/search/publications")) {
        openaireQueries.push(raw);
        return jsonResponse({
          response: { results: 1, result: [openaireRecord(["https://repo.example/only.pdf"], "A Paper")] },
        });
      }
      if (raw.startsWith("https://api.core.ac.uk/")) return jsonResponse({ results: [] });
      if (raw.startsWith("https://www.ebi.ac.uk/")) return jsonResponse({ resultList: { result: [] } });
      if (raw.startsWith("https://eutils.ncbi.nlm.nih.gov/")) return jsonResponse({ esearchresult: { idlist: [] } });
      if (/^https:\/\/sci-hub\./.test(raw)) return htmlResponse("<html>article not found</html>");
      return fakePdfResponse();
    }));

    const outcome = await downloadPaper("openalex", "W200", { dir }, { title: "A Paper" });
    expect(outcome.status).toBe("downloaded");
    // No DOI on the card → only the title phase ran.
    expect(openaireQueries).toHaveLength(1);
    expect(openaireQueries[0]).toContain("keywords=A+Paper");
    const sidecar = await readSidecarFile(path.join(dir, "openalex-W200.pdf"));
    expect(sidecar.identity).toBe("title-fallback");
    expect(sidecar.sourceUrl).toBe("https://repo.example/only.pdf");
    expect(sidecar.title).toBe("A Paper");
  });

  it("a Sci-Hub download is recorded as identity scihub", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.openaire.eu/search/publications")) return jsonResponse({ response: { results: 0, result: [] } });
      if (raw.startsWith("https://api.core.ac.uk/")) return jsonResponse({ results: [] });
      if (raw.startsWith("https://www.ebi.ac.uk/")) return jsonResponse({ resultList: { result: [] } });
      if (raw.startsWith("https://eutils.ncbi.nlm.nih.gov/")) return jsonResponse({ esearchresult: { idlist: [] } });
      if (raw.startsWith("https://api.unpaywall.org/")) return jsonResponse({ doi: "10.9/paywalled", is_oa: false, oa_locations: [] });
      if (/^https:\/\/sci-hub\./.test(raw)) {
        return htmlResponse('<html><embed type="application/pdf" src="https://d1.sci-hub.se/paper.pdf"></html>');
      }
      return fakePdfResponse();
    }));

    const outcome = await downloadPaper("openalex", "W300", { dir }, { doi: "10.9/paywalled" });
    expect(outcome.status).toBe("downloaded");
    const sidecar = await readSidecarFile(path.join(dir, "openalex-W300.pdf"));
    expect(sidecar.identity).toBe("scihub");
    expect(sidecar.sourceUrl).toBe("https://d1.sci-hub.se/paper.pdf");
  });

  it("reports a clear failure for metadata-only sources without pdf_url", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse()));
    const outcome = await downloadPaper("pubmed", "12345678", { dir, allowFallback: false });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("metadata-only");
  });

  it("rejects unknown sources", async () => {
    const outcome = await downloadPaper("nope", "1", { dir });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("unknown source");
  });
});

describe("downloadAll", () => {
  it("processes every task with bounded concurrency and throws on abort", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse()));
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-"));
    try {
      const results = await downloadAll(
        [
          { source: "arxiv", paperId: "2401.00001" },
          { source: "arxiv", paperId: "2401.00002", title: "T2" },
        ],
        { dir, concurrency: 2 },
      );
      expect(results).toHaveLength(2);
      // Concurrent completion order is unspecified — assert by id.
      const byId = new Map(results.map((r) => [r.paperId, r]));
      expect(byId.get("2401.00001")?.title).toBeUndefined();
      expect(byId.get("2401.00002")?.title).toBe("T2");
      expect(results.every((r) => r.status === "downloaded")).toBe(true);

      const controller = new AbortController();
      controller.abort();
      await expect(
        downloadAll([{ source: "arxiv", paperId: "2401.00003" }], { dir, signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      vi.unstubAllGlobals();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("searchSources (unit)", () => {
  it("exposes a unique, lowercase source catalog", () => {
    expect(SOURCE_IDS).toContain("arxiv");
    expect(SOURCE_IDS).toContain("unpaywall");
    expect(new Set(SOURCE_IDS).size).toBe(SOURCE_IDS.length);
    expect(SOURCE_IDS.every((id) => id === id.toLowerCase())).toBe(true);
  });
});
