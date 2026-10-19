import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAcquireJob } from "../jobs";
import { LineLog } from "../log-buffer";
import { __httpTestSeams } from "../http";
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

  it("S2 + OA chain all miss → Sci-Hub last resort with identity scihub (on by default)", async () => {
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

  it("reports failed naming the sources actually consulted: Sci-Hub is listed unless the installation turned it off", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) return httpError(404);
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));

    await refreshSourceKeys({ unpaywallEmail: "t@example.org" });
    const on = await downloadByDoi("10.5678/nowhere", { dir });
    expect(on.status).toBe("failed");
    expect(on.error).toContain("Semantic Scholar, OA repositories, unpaywall and Sci-Hub");
    expect(on.error).not.toContain("Sci-Hub is off");

    await refreshSourceKeys({ unpaywallEmail: "t@example.org", useScihub: false });
    const off = await downloadByDoi("10.5678/nowhere", { dir });
    expect(off.status).toBe("failed");
    expect(off.error).toContain("Semantic Scholar, OA repositories and unpaywall");
    expect(off.error).toContain("Sci-Hub is off");
    expect(off.error).not.toContain("and Sci-Hub");
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

describe("downloadByDoi sciHub modes (two-round acquisition)", () => {
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

  const sciHubServes = '<html><embed type="application/pdf" src="https://d1.sci-hub.se/paper.pdf"></html>';

  it("off: open-access sources only — Sci-Hub is never contacted, even when it is on and would have served the paper", async () => {
    await refreshSourceKeys({ unpaywallEmail: "t@example.org" });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      calls.push(raw);
      if (raw.startsWith("https://api.semanticscholar.org/")) return httpError(404);
      if (/^https:\/\/sci-hub\./.test(raw)) return htmlResponse(sciHubServes);
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));

    const outcome = await downloadByDoi("10.5678/paywalled", { dir, sciHub: "off" });
    expect(outcome.status).toBe("failed");
    expect(calls.some((call) => /sci-hub\./.test(call))).toBe(false);
    expect(outcome.diagnosis?.stages.find((stage) => stage.stage === "sci-hub")?.result).toBe("off");
    expect(outcome.error).toContain("Semantic Scholar, OA repositories and unpaywall");
    expect(outcome.error).toContain("Sci-Hub was not consulted in this call (scihub=off)");
    expect(outcome.error).not.toContain("absent from the mirrors");
    expect(outcome.error).not.toContain("Sci-Hub is off");
  });

  it("off: an open-access hit still downloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/graph/v1/paper/DOI:")) {
        return jsonResponse({ title: "A Paper", openAccessPdf: { url: "https://oa.example/paper.pdf" } });
      }
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));
    const outcome = await downloadByDoi("10.1038/s41586-021-03819-2", { dir, sciHub: "off" });
    expect(outcome.status).toBe("downloaded");
    expect((await readSidecarFile(outcome.path!)).identity).toBe("doi-url");
  });

  it("only: Sci-Hub alone — Semantic Scholar, repositories and unpaywall are not contacted; the paper arrives with identity scihub", async () => {
    await refreshSourceKeys({ unpaywallEmail: "t@example.org" });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      calls.push(raw);
      if (/^https:\/\/sci-hub\./.test(raw)) return htmlResponse(sciHubServes);
      return fakePdfResponse();
    }));

    const outcome = await downloadByDoi("10.5678/paywalled", { dir, sciHub: "only" });
    expect(outcome.status).toBe("downloaded");
    expect(calls.some((call) => /semanticscholar|openaire|core\.ac\.uk|ebi\.ac\.uk|eutils|unpaywall/.test(call))).toBe(false);
    const sidecar = await readSidecarFile(outcome.path!);
    expect(sidecar.identity).toBe("scihub");
    expect(sidecar.sourceUrl).toBe("https://d1.sci-hub.se/paper.pdf");
  });

  it("only: a Sci-Hub miss fails naming Sci-Hub as the only source consulted, with the skipped stages marked off", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => tailAllMiss(String(url)) ?? fakePdfResponse()));

    const outcome = await downloadByDoi("10.5678/nowhere", { dir, sciHub: "only" });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("no usable PDF found after Sci-Hub (paper may be paywalled or absent from the mirrors)");
    expect(outcome.diagnosis?.verdict).toBe("no-open-access-copy");
    expect(outcome.diagnosis?.stages.map((stage) => `${stage.stage}:${stage.result}`)).toEqual([
      "semantic-scholar:off",
      "repositories:off",
      "unpaywall:off",
      "sci-hub:none",
    ]);
  });

  it("only: mirrors that all refuse to answer make the step unavailable — inconclusive, not an absence — and point at scihubBaseUrl", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => (/^https:\/\/sci-hub\./.test(String(url)) ? httpError(403) : fakePdfResponse())));

    const outcome = await downloadByDoi("10.5678/blocked", { dir, sciHub: "only" });
    expect(outcome.status).toBe("failed");
    const stage = outcome.diagnosis?.stages.find((entry) => entry.stage === "sci-hub");
    expect(stage?.result).toBe("unavailable");
    expect(stage?.detail).toBe(
      "no Sci-Hub mirror answered (sci-hub.ee: HTTP 403; sci-hub.ru: HTTP 403; sci-hub.se: HTTP 403; sci-hub.vg: HTTP 403; sci-hub.al: HTTP 403; sci-hub.mk: HTTP 403)",
    );
    expect(outcome.diagnosis?.verdict).toBe("inconclusive");
    expect(outcome.error).toContain("this is not proof of a paywall");
    expect(outcome.error).not.toContain("absent from the mirrors");
    expect(outcome.diagnosis?.hints.some((hint) => hint.includes("scihubBaseUrl"))).toBe(true);
  });

  it("only: one mirror answering \"article not found\" makes the step none, while naming the mirrors that were silent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://sci-hub.ee/")) return httpError(403);
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));

    const outcome = await downloadByDoi("10.5678/absent", { dir, sciHub: "only" });
    const stage = outcome.diagnosis?.stages.find((entry) => entry.stage === "sci-hub");
    expect(stage?.result).toBe("none");
    expect(stage?.detail).toBe('5 of 6 mirrors answered "article not found"; 1 did not answer (sci-hub.ee: HTTP 403)');
    expect(outcome.diagnosis?.verdict).toBe("no-open-access-copy");
  });

  it("auto (the default) keeps the full chain: Semantic Scholar → repositories → unpaywall → Sci-Hub", async () => {
    await refreshSourceKeys({ unpaywallEmail: "t@example.org" });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) return httpError(404);
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));
    const outcome = await downloadByDoi("10.5678/nowhere", { dir, sciHub: "auto" });
    expect(outcome.diagnosis?.stages.map((stage) => stage.stage)).toEqual(["semantic-scholar", "repositories", "unpaywall", "sci-hub"]);
    expect(outcome.diagnosis?.stages.map((stage) => stage.result)).not.toContain("off");
  });
});

describe("downloadByDoi Semantic Scholar pacing", () => {
  let dir: string;
  const sleeps: number[] = [];
  const productionSleep = __httpTestSeams.sleep;
  const productionNow = __httpTestSeams.now;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-acquire-"));
    resetSciHubHealth();
    sleeps.length = 0;
    __httpTestSeams.sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    __httpTestSeams.now = () => 9_000_000_000_000; // frozen clock: slots are deterministic
    __httpTestSeams.resetPacing();
  });
  afterEach(async () => {
    __httpTestSeams.sleep = productionSleep;
    __httpTestSeams.now = productionNow;
    __httpTestSeams.resetPacing();
    vi.unstubAllGlobals();
    delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    await refreshSourceKeys({});
    await rm(dir, { recursive: true, force: true });
  });

  const lookupThreeDois = async (): Promise<void> => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) return httpError(404);
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));
    await Promise.all(["10.5678/a", "10.5678/b", "10.5678/c"].map((doi) => downloadByDoi(doi, { dir, sciHub: "off" })));
  };

  it("spreads concurrent DOI lookups 400 ms apart without an API key", async () => {
    await lookupThreeDois();
    expect(sleeps).toEqual([400, 800]);
  });

  it("spreads them 1100 ms apart with an API key (the free key allows one request per second)", async () => {
    process.env.SEMANTIC_SCHOLAR_API_KEY = "test-key";
    await refreshSourceKeys({});
    await lookupThreeDois();
    expect(sleeps).toEqual([1_100, 2_200]);
  });
});

describe("runAcquireJob chain line", () => {
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

  it("states the chain the run consults for each sciHub mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const raw = String(url);
      if (raw.startsWith("https://api.semanticscholar.org/")) return httpError(404);
      return tailAllMiss(raw) ?? fakePdfResponse();
    }));
    const lineFor = async (sciHub: "auto" | "off" | "only"): Promise<string> => {
      const log = new LineLog();
      await runAcquireJob({ dois: ["10.5678/nowhere"], dir, downloadTimeoutMs: 5_000, sciHub }, async () => {}, log, new AbortController().signal);
      return log.snapshot().split("\n")[0] ?? "";
    };
    expect(await lineFor("auto")).toContain("(chain: semantic-scholar → oa-repositories/unpaywall → sci-hub)");
    expect(await lineFor("off")).toContain("(chain: semantic-scholar → oa-repositories/unpaywall; sci-hub skipped (scihub=off))");
    expect(await lineFor("only")).toContain("(chain: sci-hub only (scihub=only))");
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
