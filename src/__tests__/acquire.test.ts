import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireByDoi, downloadByDoi } from "../registry";
import { resetSciHubHealth } from "../sources/sci_hub";
import { refreshSourceKeys } from "../keys";

const pdfMagic = Buffer.concat([
  Buffer.from("%PDF-1.7 fake content for tests\n"),
  Buffer.from("x".repeat(2048)),
]);

function fakePdfResponse(buffer: Buffer = pdfMagic) {
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

function htmlResponse(body: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null) },
    text: async () => body,
  };
}

function httpError(status: number) {
  return { ok: false, status, headers: { get: () => null } };
}

/** The repository / unpaywall / sci-hub tail all miss; S2 is routed by the caller. */
function tailAllMiss(raw: string) {
  if (raw.startsWith("https://api.openaire.eu/search/publications")) return jsonResponse({ response: { results: 0, result: [] } });
  if (raw.startsWith("https://api.core.ac.uk/")) return jsonResponse({ results: [] });
  if (raw.startsWith("https://www.ebi.ac.uk/")) return jsonResponse({ resultList: { result: [] } });
  if (raw.startsWith("https://eutils.ncbi.nlm.nih.gov/")) return jsonResponse({ esearchresult: { idlist: [] } });
  if (raw.startsWith("https://api.unpaywall.org/")) return jsonResponse({ doi: "10.9/x", is_oa: false, oa_locations: [] });
  if (/^https:\/\/sci-hub\./.test(raw)) return htmlResponse("<html>Sorry, article not found.</html>");
  return undefined;
}

async function readSidecarFile(pdfPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(`${pdfPath}.meta.json`, "utf8")) as Record<string, unknown>;
}

describe("downloadByDoi", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-acquire-"));
    resetSciHubHealth();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await refreshSourceKeys({});
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects a non-DOI input without touching the network", async () => {
    const fetchMock = vi.fn(async () => fakePdfResponse());
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await downloadByDoi("not-a-doi", { dir });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("not a DOI");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S2 openAccessPdf hit wins first with identity doi-url", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      calls.push(raw);
      if (raw.startsWith("https://api.semanticscholar.org/graph/v1/paper/DOI:")) {
        return jsonResponse({ title: "A Paper", openAccessPdf: { url: "https://oa.example/paper.pdf" } });
      }
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));

    const outcome = await downloadByDoi("10.1038/s41586-021-03819-2", { dir });
    expect(outcome.status).toBe("downloaded");
    expect(outcome.path).toBe(path.join(dir, "doi-10.1038_s41586-021-03819-2.pdf"));
    expect(outcome.title).toBe("A Paper");
    // The DOI-exact S2 lookup led the chain and its link won the download.
    expect(calls[0]).toContain("api.semanticscholar.org/graph/v1/paper/DOI:10.1038");
    const sidecar = await readSidecarFile(outcome.path!);
    expect(sidecar.identity).toBe("doi-url");
    expect(sidecar.source).toBe("doi");
    expect(sidecar.doi).toBe("10.1038/s41586-021-03819-2");
    expect(sidecar.sourceUrl).toBe("https://oa.example/paper.pdf");
  });

  it("S2 miss (404) falls through to the unpaywall OA resolver", async () => {
    await refreshSourceKeys({ unpaywallEmail: "t@example.org" });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) return httpError(404);
      if (raw.startsWith("https://api.unpaywall.org/")) {
        return jsonResponse({ doi: "10.1234/x", is_oa: true, best_oa_location: { url_for_pdf: "https://oa.example/x.pdf" }, oa_locations: [] });
      }
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));

    const outcome = await downloadByDoi("10.1234/x", { dir });
    expect(outcome.status).toBe("downloaded");
    const sidecar = await readSidecarFile(outcome.path!);
    expect(sidecar.identity).toBe("doi-url");
    expect(sidecar.sourceUrl).toBe("https://oa.example/x.pdf");
  });

  it("S2 + OA chain all miss → Sci-Hub last resort with identity scihub", async () => {
    await refreshSourceKeys({ unpaywallEmail: "t@example.org" });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) return httpError(404);
      if (/^https:\/\/sci-hub\./.test(raw)) {
        return htmlResponse('<html><embed type="application/pdf" src="https://d1.sci-hub.se/paper.pdf"></html>');
      }
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));

    const outcome = await downloadByDoi("10.5678/paywalled", { dir });
    expect(outcome.status).toBe("downloaded");
    const sidecar = await readSidecarFile(outcome.path!);
    expect(sidecar.identity).toBe("scihub");
    expect(sidecar.sourceUrl).toBe("https://d1.sci-hub.se/paper.pdf");
  });

  it("reports failed with the full chain named when nothing resolves", async () => {
    await refreshSourceKeys({ unpaywallEmail: "t@example.org" });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) return httpError(404);
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));

    const outcome = await downloadByDoi("10.5678/nowhere", { dir });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("Semantic Scholar");
    expect(outcome.error).toContain("Sci-Hub");
  });

  it("is idempotent: a sidecar-verified file reports exists with zero network calls", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) {
        return jsonResponse({ title: "A Paper", openAccessPdf: { url: "https://oa.example/paper.pdf" } });
      }
      return fakePdfResponse();
    }));
    const first = await downloadByDoi("10.1038/s41586-021-03819-2", { dir });
    expect(first.status).toBe("downloaded");

    const fetchMock = vi.fn(async () => fakePdfResponse());
    vi.stubGlobal("fetch", fetchMock);
    const second = await downloadByDoi("10.1038/s41586-021-03819-2", { dir });
    expect(second.status).toBe("exists");
    expect(second.path).toBe(first.path);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes doi.org URLs and bare DOIs to the same destination", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) {
        return jsonResponse({ title: "A Paper", openAccessPdf: { url: "https://oa.example/paper.pdf" } });
      }
      return fakePdfResponse();
    }));
    const first = await downloadByDoi("10.1038/S41586-021-03819-2", { dir });
    const second = await downloadByDoi("https://doi.org/10.1038/s41586-021-03819-2", { dir });
    expect(first.status).toBe("downloaded");
    expect(second.status).toBe("exists");
    expect(second.path).toBe(first.path);
  });
});

describe("acquireByDoi", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-acquire-"));
    resetSciHubHealth();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await refreshSourceKeys({});
    await rm(dir, { recursive: true, force: true });
  });

  it("settles every DOI and fires onOutcome per DOI, failures included", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/graph/v1/paper/DOI:10.1234%2Fok")) {
        return jsonResponse({ title: "Ok Paper", openAccessPdf: { url: "https://oa.example/ok.pdf" } });
      }
      if (raw.startsWith("https://api.semanticscholar.org/")) return httpError(404);
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));

    const seen: string[] = [];
    const results = await acquireByDoi(["10.1234/ok", "10.5678/missing", "garbage"], {
      dir,
      onOutcome: (outcome) => seen.push(`${outcome.paperId}:${outcome.status}`),
    });
    expect(results).toHaveLength(3);
    expect(seen).toHaveLength(3);
    expect(seen).toContain("10.1234/ok:downloaded");
    expect(seen).toContain("10.5678/missing:failed");
    expect(seen).toContain("garbage:failed");
  });
});
