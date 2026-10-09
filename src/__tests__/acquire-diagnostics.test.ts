import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __httpTestSeams } from "../http";
import { acquireJobDetail } from "../jobs";
import { refreshSourceKeys } from "../keys";
import { downloadByDoi, type DownloadOutcome } from "../registry";
import { resetSciHubHealth } from "../sources/sci_hub";

// run-9: 10 acquisitions, 7 "failed" with one generic sentence ("paper may be paywalled") — the
// real causes (rate limits, a missing Unpaywall email, a repository refusing the request, a host
// blocking the download) were swallowed. Every failure now names what each source answered.

const pdfMagic = Buffer.concat([Buffer.from("%PDF-1.7 fake content for tests\n"), Buffer.from("x".repeat(2048))]);

function fakePdfResponse(buffer: Buffer = pdfMagic) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/pdf" : null) },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

function htmlBytesResponse() {
  const html = Buffer.from(`<html>${"Please log in to read this article. ".repeat(60)}</html>`);
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null) },
    arrayBuffer: async () => html.buffer.slice(html.byteOffset, html.byteOffset + html.byteLength),
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

/** Repository / unpaywall / sci-hub endpoints that answer and hold nothing. */
function tailAllMiss(raw: string) {
  if (raw.startsWith("https://api.openaire.eu/search/publications")) return jsonResponse({ response: { results: 0, result: [] } });
  if (raw.startsWith("https://api.core.ac.uk/")) return jsonResponse({ results: [] });
  if (raw.startsWith("https://www.ebi.ac.uk/")) return jsonResponse({ resultList: { result: [] } });
  if (raw.startsWith("https://eutils.ncbi.nlm.nih.gov/")) return jsonResponse({ esearchresult: { idlist: [] } });
  if (raw.startsWith("https://api.unpaywall.org/")) return jsonResponse({ doi: "10.9/x", is_oa: false, oa_locations: [] });
  if (/^https:\/\/sci-hub\./.test(raw)) return htmlResponse("<html>Sorry, article not found.</html>");
  return undefined;
}

describe("downloadByDoi failure diagnosis", () => {
  const realSeams = { sleep: __httpTestSeams.sleep, now: __httpTestSeams.now };
  let dir: string;
  let clockSkew = 0;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-diag-"));
    resetSciHubHealth();
    // Instant backoff; a fresh clock window per test keeps one test's 429 cooldown from leaking into the next.
    clockSkew += 3_600_000;
    __httpTestSeams.sleep = async () => {};
    __httpTestSeams.now = () => Date.now() + clockSkew;
  });
  afterEach(async () => {
    __httpTestSeams.sleep = realSeams.sleep;
    __httpTestSeams.now = realSeams.now;
    vi.unstubAllGlobals();
    await refreshSourceKeys({});
    await rm(dir, { recursive: true, force: true });
  });

  it("S2 rate-limited while every other source answers none → inconclusive, never 'paywalled', with the API-key hint", async () => {
    await refreshSourceKeys({ unpaywallEmail: "t@example.org" });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) return httpError(429);
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));

    const outcome = await downloadByDoi("10.5678/limited", { dir });
    expect(outcome.status).toBe("failed");
    expect(outcome.diagnosis?.verdict).toBe("inconclusive");
    const s2 = outcome.diagnosis?.stages.find((s) => s.stage === "semantic-scholar");
    expect(s2).toMatchObject({ result: "unavailable" });
    expect(s2?.detail).toContain("429");
    expect(outcome.error).toContain("not proof of a paywall");
    expect(outcome.error).not.toContain("may be paywalled");
    expect(outcome.error).toContain("SEMANTIC_SCHOLAR_API_KEY");
    expect(outcome.diagnosis?.hints.join(" ")).toContain("SEMANTIC_SCHOLAR_API_KEY");
  });

  it("no Unpaywall contact email → the stage is 'unconfigured' and the setting is named", async () => {
    await refreshSourceKeys({});
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) return httpError(404);
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));

    const outcome = await downloadByDoi("10.5678/no-email", { dir });
    expect(outcome.status).toBe("failed");
    expect(outcome.diagnosis?.verdict).toBe("inconclusive");
    expect(outcome.diagnosis?.stages.find((s) => s.stage === "unpaywall")).toMatchObject({ result: "unconfigured" });
    expect(outcome.error).toContain("unpaywallEmail");
    expect(outcome.error).not.toContain("may be paywalled");
  });

  it("an open-access link that the host refuses → located-but-blocked, naming the host, the status and the manual route", async () => {
    await refreshSourceKeys({ unpaywallEmail: "t@example.org" });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) {
        return jsonResponse({ title: "Blocked Paper", openAccessPdf: { url: "https://oa.example.org/paper.pdf" } });
      }
      if (raw.startsWith("https://oa.example.org/")) return httpError(403);
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));

    const outcome = await downloadByDoi("10.5678/blocked", { dir });
    expect(outcome.status).toBe("failed");
    expect(outcome.diagnosis?.verdict).toBe("located-but-blocked");
    const download = outcome.diagnosis?.stages.find((s) => s.stage === "download");
    expect(download).toMatchObject({ result: "unavailable" });
    expect(download?.detail).toContain("oa.example.org");
    expect(download?.detail).toContain("403");
    expect(outcome.error).toContain("open-access copy was located");
    expect(outcome.error).toContain("save the PDF");
    expect(outcome.error).not.toContain("may be paywalled");
  });

  it("a login/landing page served instead of a PDF is reported as 'not a PDF'", async () => {
    await refreshSourceKeys({ unpaywallEmail: "t@example.org" });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) {
        return jsonResponse({ title: "Landing", openAccessPdf: { url: "https://publisher.example.com/landing" } });
      }
      if (raw.startsWith("https://publisher.example.com/")) return htmlBytesResponse();
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));

    const outcome = await downloadByDoi("10.5678/landing", { dir });
    expect(outcome.diagnosis?.verdict).toBe("located-but-blocked");
    expect(outcome.error).toContain("publisher.example.com");
    expect(outcome.error).toContain("not a PDF");
  });

  it("a repository that errors makes the verdict inconclusive and names the repository and the CORE key", async () => {
    await refreshSourceKeys({ unpaywallEmail: "t@example.org" });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) return httpError(404);
      if (raw.startsWith("https://api.core.ac.uk/")) return httpError(401);
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));

    const outcome = await downloadByDoi("10.5678/core-refused", { dir });
    expect(outcome.diagnosis?.verdict).toBe("inconclusive");
    const repos = outcome.diagnosis?.stages.find((s) => s.stage === "repositories");
    expect(repos).toMatchObject({ result: "unavailable" });
    expect(repos?.detail).toContain("core: HTTP 401");
    expect(outcome.error).toContain("CORE_API_KEY");
  });

  it("every consulted source answers none → no-open-access-copy, with the established paywall wording", async () => {
    await refreshSourceKeys({ unpaywallEmail: "t@example.org" });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) return httpError(404);
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));

    const outcome = await downloadByDoi("10.5678/closed", { dir });
    expect(outcome.diagnosis?.verdict).toBe("no-open-access-copy");
    expect(outcome.diagnosis?.stages.map((s) => `${s.stage}:${s.result}`)).toEqual([
      "semantic-scholar:none",
      "repositories:none",
      "unpaywall:none",
      "sci-hub:none",
    ]);
    expect(outcome.error).toContain("may be paywalled");
    expect(outcome.error).toContain("absent from the mirrors");
    expect(outcome.error).not.toContain("Sci-Hub is off");
  });

  it("an installation that turned Sci-Hub off gets the same verdict with the sci-hub stage reported as off", async () => {
    await refreshSourceKeys({ unpaywallEmail: "t@example.org", useScihub: false });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) return httpError(404);
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));

    const outcome = await downloadByDoi("10.5678/closed-off", { dir });
    expect(outcome.diagnosis?.verdict).toBe("no-open-access-copy");
    expect(outcome.diagnosis?.stages.map((s) => `${s.stage}:${s.result}`)).toEqual([
      "semantic-scholar:none",
      "repositories:none",
      "unpaywall:none",
      "sci-hub:off",
    ]);
    expect(outcome.error).toContain("Sci-Hub is off");
  });

  it("a successful download carries no diagnosis", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) {
        return jsonResponse({ title: "Fine", openAccessPdf: { url: "https://oa.example.org/fine.pdf" } });
      }
      return fakePdfResponse();
    }));
    const outcome = await downloadByDoi("10.5678/fine", { dir });
    expect(outcome.status).toBe("downloaded");
    expect(outcome.diagnosis).toBeUndefined();
  });
});

describe("acquireJobDetail", () => {
  it("lists every missed DOI with its verdict and the first concrete reason", () => {
    const outcomes: DownloadOutcome[] = [
      {
        source: "doi", paperId: "10.1234/limited", doi: "10.1234/limited", status: "failed", error: "x",
        diagnosis: {
          verdict: "inconclusive",
          stages: [{ stage: "semantic-scholar", result: "unavailable", detail: "HTTP 429 (rate-limited)" }],
          hints: [],
        },
      },
      {
        source: "doi", paperId: "10.1234/closed", doi: "10.1234/closed", status: "failed", error: "y",
        diagnosis: { verdict: "no-open-access-copy", stages: [{ stage: "semantic-scholar", result: "none" }], hints: [] },
      },
      { source: "doi", paperId: "10.1234/plain", doi: "10.1234/plain", status: "failed", error: "z" },
    ];
    const detail = acquireJobDetail({ requested: 3, results: outcomes, dir: "/tmp/pdfs" });
    expect(detail).toContain("10.1234/limited (inconclusive: semantic-scholar HTTP 429 (rate-limited))");
    expect(detail).toContain("10.1234/closed (no-open-access-copy)");
    expect(detail).toContain("10.1234/plain");
    expect(detail).toContain("inconclusive is not proof of a paywall");
  });
});
