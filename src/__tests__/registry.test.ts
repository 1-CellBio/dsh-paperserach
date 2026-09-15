import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

function fakePdfResponse(buffer: Buffer = pdfMagic, contentType = "application/pdf") {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
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

  it("rejects tiny payloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse(Buffer.from("%PDF-x"), "application/pdf")));
    await expect(fetchPdf("https://x/1", dir, "tiny", {})).rejects.toThrow(/not a PDF/);
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

  it("is idempotent: an existing file reports status exists", async () => {
    await writeFile(path.join(dir, "arxiv-2305.05093v1.pdf"), pdfMagic);
    const outcome = await downloadPaper("arxiv", "2305.05093v1", { dir });
    expect(outcome.status).toBe("exists");
    expect(outcome.bytes).toBe(pdfMagic.byteLength);
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
