import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findSha256Conflict, IdentityConflictError, loadLibraryDoiIndex, okfRootOf, pdfsRootOf } from "../identity";
import { acquireJobDetail } from "../jobs";
import { refreshSourceKeys, titleMatchAllowed } from "../keys";
import { acquireByDoi, downloadAll, downloadByDoi, fetchPdf } from "../registry";
import { resetSciHubHealth } from "../sources/sci_hub";

/** Distinct, valid PDF payloads: one per paper, as real documents are. */
function pdfBytes(label: string): Buffer {
  return Buffer.concat([Buffer.from(`%PDF-1.7 ${label}\n`), Buffer.from(label.repeat(2048))]);
}

const WRONG_CONTENT = pdfBytes("a-different-document");

function fakePdfResponse(buffer: Buffer) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/pdf" : null) },
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

/** One OpenAIRE API record: webresource urls plus a title; the DOI is read from a doi.org url. */
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

function httpError(status: number) {
  return { ok: false, status, headers: { get: () => null } };
}

/** S2 answers every DOI with an openAccessPdf link; the link's bytes come from `bytesFor`. */
function stubSemanticScholar(bytesFor: (pdfUrl: string) => Buffer): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const raw = String(url);
    if (raw.startsWith("https://api.semanticscholar.org/graph/v1/paper/DOI:")) {
      const doi = decodeURIComponent(raw.split("/paper/DOI:")[1]!.split("?")[0]!);
      return jsonResponse({ title: `Paper ${doi}`, openAccessPdf: { url: `https://oa.example/${encodeURIComponent(doi)}.pdf` } });
    }
    if (raw.startsWith("https://oa.example/")) return fakePdfResponse(bytesFor(raw));
    if (raw.startsWith("https://api.openaire.eu/search/publications")) return jsonResponse({ response: { results: 0, result: [] } });
    if (raw.startsWith("https://api.core.ac.uk/")) return jsonResponse({ results: [] });
    if (raw.startsWith("https://www.ebi.ac.uk/")) return jsonResponse({ resultList: { result: [] } });
    if (raw.startsWith("https://eutils.ncbi.nlm.nih.gov/")) return jsonResponse({ esearchresult: { idlist: [] } });
    if (raw.startsWith("https://api.unpaywall.org/")) return jsonResponse({ is_oa: false, oa_locations: [] });
    return httpError(404);
  }));
}

async function writeStored(dir: string, name: string, bytes: Buffer, sidecar: Record<string, unknown>): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, bytes);
  await writeFile(`${file}.meta.json`, JSON.stringify(sidecar));
  return file;
}

const SHA_A = "a".repeat(64);

describe("content identity: sha256 conflict scan", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-identity-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports a stored PDF with the same digest under a different DOI", async () => {
    const stored = await writeStored(dir, "doi-10.1001_a.pdf", pdfBytes("a"), { sha256: SHA_A, doi: "10.1001/a" });
    const conflict = await findSha256Conflict([dir], SHA_A, "https://doi.org/10.1001/B", path.join(dir, "doi-10.1001_b.pdf.meta.json"));
    expect(conflict).toEqual({ file: stored, doi: "10.1001/a" });
  });

  it("ignores the same DOI, an unknown DOI, a different digest, the file being replaced, and a sidecar whose PDF is gone", async () => {
    await writeStored(dir, "same-doi.pdf", pdfBytes("a"), { sha256: SHA_A, doi: "10.1001/B" });
    await writeStored(dir, "no-doi.pdf", pdfBytes("b"), { sha256: SHA_A, doi: "" });
    await writeStored(dir, "other-digest.pdf", pdfBytes("c"), { sha256: "b".repeat(64), doi: "10.1001/zzz" });
    const own = await writeStored(dir, "own.pdf", pdfBytes("d"), { sha256: SHA_A, doi: "10.1001/own" });
    await writeFile(path.join(dir, "gone.pdf.meta.json"), JSON.stringify({ sha256: SHA_A, doi: "10.1001/gone" }));
    const conflict = await findSha256Conflict([dir], SHA_A, "10.1001/b", `${own}.meta.json`);
    expect(conflict).toBeUndefined();
  });

  it("does nothing without a requested DOI (nothing to contradict)", async () => {
    await writeStored(dir, "doi-10.1001_a.pdf", pdfBytes("a"), { sha256: SHA_A, doi: "10.1001/a" });
    expect(await findSha256Conflict([dir], SHA_A, "", path.join(dir, "x.pdf.meta.json"))).toBeUndefined();
  });

  it("locates the OKF library root from a pdfs dir, including nested save dirs", () => {
    expect(pdfsRootOf("/lib/OKF/sources/pdfs")).toBe("/lib/OKF/sources/pdfs");
    expect(pdfsRootOf("/lib/OKF/sources/pdfs/batch1")).toBe("/lib/OKF/sources/pdfs");
    expect(okfRootOf("/lib/OKF/sources/pdfs/batch1")).toBe("/lib/OKF");
    expect(okfRootOf("/tmp/elsewhere")).toBeUndefined();
  });
});

describe("content identity: fetchPdf and the acquisition chain refuse byte duplicates under another DOI", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-identity-"));
    resetSciHubHealth();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await refreshSourceKeys({});
    await rm(dir, { recursive: true, force: true });
  });

  it("fetchPdf throws IdentityConflictError and writes nothing for the refused DOI", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse(WRONG_CONTENT)));
    await fetchPdf("https://x.example/1.pdf", dir, "doi-10.1016_j.cell.2021.04.015", {
      meta: { doi: "10.1016/j.cell.2021.04.015", identity: "scihub" },
    });
    const error = await fetchPdf("https://x.example/2.pdf", dir, "doi-10.1016_j.tins.2021.06.007", {
      meta: { doi: "10.1016/j.tins.2021.06.007", identity: "scihub" },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IdentityConflictError);
    expect((error as IdentityConflictError).recordedDoi).toBe("10.1016/j.cell.2021.04.015");
    expect((error as IdentityConflictError).requestedDoi).toBe("10.1016/j.tins.2021.06.007");
    expect(await readdir(dir)).toEqual(expect.not.arrayContaining(["doi-10.1016_j.tins.2021.06.007.pdf"]));
    expect(await readdir(dir)).toHaveLength(2); // the first PDF and its sidecar only
  });

  it("fetchPdf still replaces the same file for the same DOI (re-download is not a conflict)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse(WRONG_CONTENT)));
    const meta = { doi: "10.1001/a", identity: "doi-url" as const };
    await fetchPdf("https://x.example/1.pdf", dir, "doi-10.1001_a", { meta });
    await expect(fetchPdf("https://x.example/1.pdf", dir, "doi-10.1001_a", { meta })).resolves.toHaveProperty("path");
  });

  it("downloadByDoi: the second DOI that resolves to already-stored bytes fails before landing (Cacciari chain)", async () => {
    stubSemanticScholar(() => WRONG_CONTENT);
    const first = await downloadByDoi("10.1016/j.cell.2021.04.015", { dir });
    expect(first.status).toBe("downloaded");

    const second = await downloadByDoi("10.1016/j.tins.2021.06.007", { dir });
    expect(second.status).toBe("failed");
    expect(second.path).toBeUndefined();
    expect(second.identityConflict).toContain("doi-10.1016_j.cell.2021.04.015.pdf");
    expect(second.identityConflict).toContain("10.1016/j.cell.2021.04.015");
    expect(second.error).toContain("identity conflict");
    expect(await readdir(dir)).not.toContain("doi-10.1016_j.tins.2021.06.007.pdf");
  });

  it("a conflict does not end the chain: a later DOI-verified candidate with its own bytes is saved", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) {
        return jsonResponse({
          title: "B",
          openAccessPdf: { url: raw.includes("10.1001%2Fa") ? "https://oa.example/a.pdf" : "https://oa.example/b-wrong.pdf" },
        });
      }
      if (raw === "https://oa.example/a.pdf" || raw === "https://oa.example/b-wrong.pdf") return fakePdfResponse(WRONG_CONTENT);
      if (raw.startsWith("https://api.openaire.eu/search/publications")) {
        return raw.includes("10.1001%2Fb")
          ? jsonResponse({ response: { results: 1, result: [openaireRecord(["https://doi.org/10.1001/b", "https://repo.example/b-real.pdf"], "B")] } })
          : jsonResponse({ response: { results: 0, result: [] } });
      }
      if (raw === "https://repo.example/b-real.pdf") return fakePdfResponse(pdfBytes("b-real"));
      if (raw.startsWith("https://api.core.ac.uk/")) return jsonResponse({ results: [] });
      if (raw.startsWith("https://www.ebi.ac.uk/")) return jsonResponse({ resultList: { result: [] } });
      if (raw.startsWith("https://eutils.ncbi.nlm.nih.gov/")) return jsonResponse({ esearchresult: { idlist: [] } });
      if (raw.startsWith("https://api.unpaywall.org/")) return jsonResponse({ is_oa: false, oa_locations: [] });
      return httpError(404);
    }));
    expect((await downloadByDoi("10.1001/a", { dir })).status).toBe("downloaded");

    const second = await downloadByDoi("10.1001/b", { dir });
    expect(second.status).toBe("downloaded");
    expect(second.identity).toBe("doi-url");
    // the refused S2 payload stays on record even though a later candidate won
    expect(second.identityConflict).toContain("doi-10.1001_a.pdf");
    const sidecar = JSON.parse(await readFile(`${second.path}.meta.json`, "utf8")) as Record<string, unknown>;
    expect(sidecar.sourceUrl).toBe("https://repo.example/b-real.pdf");
  });

  it("concurrent downloads of identical bytes under two DOIs: exactly one is saved", async () => {
    stubSemanticScholar(() => WRONG_CONTENT);
    const results = await acquireByDoi(["10.1001/first", "10.1001/second"], { dir, concurrency: 2 });
    expect(results.map((result) => result.status).sort()).toEqual(["downloaded", "failed"]);
    const failed = results.find((result) => result.status === "failed")!;
    expect(failed.identityConflict).toBeDefined();
    expect((await readdir(dir)).filter((name) => name.endsWith(".pdf"))).toHaveLength(1);
  });

  it("the job detail names DOIs refused for identical bytes", async () => {
    stubSemanticScholar(() => WRONG_CONTENT);
    const results = await acquireByDoi(["10.1001/first", "10.1001/second"], { dir, concurrency: 1 });
    const detail = acquireJobDetail({ requested: 2, results, dir });
    expect(detail).toContain("identical bytes already stored under another DOI (not saved): 10.1001/second");
  });
});

describe("content identity: library-first acquisition", () => {
  let root: string;
  let pdfs: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-library-"));
    pdfs = path.join(root, "OKF", "sources", "pdfs");
    await mkdir(pdfs, { recursive: true });
    await mkdir(path.join(root, "OKF", "papers"), { recursive: true });
    resetSciHubHealth();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await refreshSourceKeys({});
    await rm(root, { recursive: true, force: true });
  });

  async function paperPage(name: string, frontmatter: string[]): Promise<void> {
    await writeFile(path.join(root, "OKF", "papers", name), `---\ntype: Paper\n${frontmatter.join("\n")}\n---\n\nbody\n`);
  }

  it("indexes Paper pages by normalized DOI and skips identityMismatch pages", async () => {
    await paperPage("2021-a.md", ["title: A", "doi: 10.1016/J.Cell.2021.04.015"]);
    await paperPage("2021-b.md", ['title: B', 'doi: "10.1016/j.tins.2021.06.007"', "identityMismatch: true"]);
    await paperPage("2021-c.md", ["title: C"]);
    const index = await loadLibraryDoiIndex(pdfs);
    expect([...index.entries()]).toEqual([["10.1016/j.cell.2021.04.015", "papers/2021-a.md"]]);
  });

  it("returns an empty index outside an OKF layout", async () => {
    expect((await loadLibraryDoiIndex(root)).size).toBe(0);
  });

  it("acquireByDoi answers in-library for a covered DOI without any network call", async () => {
    await paperPage("2021-a.md", ["title: A", "doi: 10.1016/j.cell.2021.04.015"]);
    const fetchMock = vi.fn(async () => httpError(500));
    vi.stubGlobal("fetch", fetchMock);
    const seen: string[] = [];
    const results = await acquireByDoi(["https://doi.org/10.1016/J.CELL.2021.04.015"], {
      dir: pdfs,
      onOutcome: (outcome) => seen.push(outcome.status),
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "in-library", libraryPaper: "papers/2021-a.md", doi: "10.1016/j.cell.2021.04.015" });
    expect(results[0]!.path).toBeUndefined();
    expect(seen).toEqual(["in-library"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(pdfs)).toEqual([]);
  });

  it("a DOI flagged identityMismatch is acquired again (its page does not count as coverage)", async () => {
    await paperPage("2021-b.md", ["title: B", "doi: 10.1001/bad", "identityMismatch: true"]);
    stubSemanticScholar(() => pdfBytes("right-paper"));
    const results = await acquireByDoi(["10.1001/bad"], { dir: pdfs });
    expect(results[0]!.status).toBe("downloaded");
  });

  it("the job detail lists in-library DOIs and counts them", async () => {
    await paperPage("2021-a.md", ["title: A", "doi: 10.1001/covered"]);
    stubSemanticScholar(() => pdfBytes("new-paper"));
    const results = await acquireByDoi(["10.1001/covered", "10.1001/new"], { dir: pdfs });
    const detail = acquireJobDetail({ requested: 2, results, dir: pdfs });
    expect(detail).toContain("downloaded 1, replaced 0, exists 0, in-library 1, failed 0");
    expect(detail).toContain("already in the library, no download needed: 10.1001/covered → papers/2021-a.md");
  });

  it("downloadAll honours the library for cards that carry a DOI", async () => {
    await paperPage("2021-a.md", ["title: A", "doi: 10.1001/covered"]);
    const fetchMock = vi.fn(async () => httpError(500));
    vi.stubGlobal("fetch", fetchMock);
    const results = await downloadAll(
      [{ source: "openalex", paperId: "W1", title: "A", doi: "10.1001/covered", pdfUrl: "https://publisher.org/a.pdf" }],
      { dir: pdfs },
    );
    expect(results[0]).toMatchObject({ status: "in-library", libraryPaper: "papers/2021-a.md" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("title-match switch", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await refreshSourceKeys({});
  });

  it("is on by default, follows the setting, and the environment can switch it off", async () => {
    await refreshSourceKeys({});
    expect(titleMatchAllowed()).toBe(true);
    for (const off of ["false", "0", "off", "no", " FALSE "]) {
      vi.stubEnv("PAPERSEARCH_ALLOW_TITLE_MATCH", off);
      expect(titleMatchAllowed(), off).toBe(false);
    }
    vi.stubEnv("PAPERSEARCH_ALLOW_TITLE_MATCH", "true");
    expect(titleMatchAllowed()).toBe(true);
    vi.stubEnv("PAPERSEARCH_ALLOW_TITLE_MATCH", "false");
    await refreshSourceKeys({ allowTitleMatch: true });
    expect(titleMatchAllowed()).toBe(true); // the settings boolean wins over the environment
    vi.unstubAllEnvs();
    await refreshSourceKeys({ allowTitleMatch: false });
    expect(titleMatchAllowed()).toBe(false);
  });
});
