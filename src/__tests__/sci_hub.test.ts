import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SCIHUB_MIRRORS,
  extractPdfUrl,
  isPlausiblePdfUrl,
  resetSciHubHealth,
  resolveSciHubPdfUrl,
  sciHubBaseUrl,
  sciHubMirrors,
} from "../sources/sci_hub";
import { sciHubEnabled, refreshSourceKeys } from "../keys";

const BASE = "https://sci-hub.vg";
const PDF = "https://d1.sci-hub.se/10.1038/nature12373.pdf";

function htmlResponse(body: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null) },
    text: async () => body,
  };
}

/** Page with a working embed PDF link. */
const embedPage = `<html><embed type="application/pdf" src="${PDF}"></html>`;
const notFoundPage = `<html>Sorry, article not found.</html>`;

beforeEach(() => {
  resetSciHubHealth();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.PAPERSEARCH_SCI_HUB_BASE_URL;
  delete process.env.SCI_HUB_BASE_URL;
  delete process.env.PAPERSEARCH_USE_SCI_HUB;
  await refreshSourceKeys({});
});

describe("sciHubMirrors / sciHubBaseUrl", () => {
  it("defaults to the curated mirror list", () => {
    expect(sciHubMirrors()).toEqual([...DEFAULT_SCIHUB_MIRRORS]);
    expect(sciHubMirrors()[0]).toBe("https://sci-hub.vg");
  });

  it("sciHubBaseUrl returns the primary mirror", () => {
    expect(sciHubBaseUrl()).toBe("https://sci-hub.vg");
  });

  it("a single setting wins and drives rotation", async () => {
    await refreshSourceKeys({ scihubBaseUrl: "https://sci-hub.ren" });
    expect(sciHubMirrors()).toEqual(["https://sci-hub.ren"]);
    expect(sciHubBaseUrl()).toBe("https://sci-hub.ren");
  });

  it("a comma-separated setting defines a rotation list", async () => {
    await refreshSourceKeys({ scihubBaseUrl: "https://sci-hub.ren, https://sci-hub.ru/ ," });
    expect(sciHubMirrors()).toEqual(["https://sci-hub.ren", "https://sci-hub.ru"]);
  });

  it("falls back to env when no setting is stored", () => {
    process.env.PAPERSEARCH_SCI_HUB_BASE_URL = "https://sci-hub.ru, https://sci-hub.st";
    expect(sciHubMirrors()).toEqual(["https://sci-hub.ru", "https://sci-hub.st"]);
  });
});

describe("isPlausiblePdfUrl", () => {
  it("accepts .pdf, /pdf, download/pdf and format/type=pdf URLs", () => {
    expect(isPlausiblePdfUrl("https://cdn.example.com/a/paper.pdf")).toBe(true);
    expect(isPlausiblePdfUrl("https://sci.bban.top/pdf/10.1038/nature12373.pdf#view=FitH")).toBe(true);
    expect(isPlausiblePdfUrl("https://x.example/download/pdf?id=1")).toBe(true);
    expect(isPlausiblePdfUrl("https://x.example/paper?format=pdf")).toBe(true);
    expect(isPlausiblePdfUrl("https://x.example/paper?type=pdf")).toBe(true);
    expect(isPlausiblePdfUrl("https://hal.science/hal-01234567/document")).toBe(true);
  });

  it("rejects browse/journals pages and non-http URLs", () => {
    expect(isPlausiblePdfUrl("https://x.example/journals/vol3/article")).toBe(false);
    expect(isPlausiblePdfUrl("https://x.example/providers/elsevier/1")).toBe(false);
    expect(isPlausiblePdfUrl("https://x.example/data-providers/1")).toBe(false);
    expect(isPlausiblePdfUrl("//cdn.example.com/a.pdf")).toBe(false);
    expect(isPlausiblePdfUrl("not a url")).toBe(false);
  });
});

describe("extractPdfUrl", () => {
  it("finds the direct PDF from an <embed type=application/pdf> tag (src first)", () => {
    const html = `<html><embed type="application/pdf" src="//d1.sci-hub.se/abc/paper.pdf#view=FitH"></html>`;
    expect(extractPdfUrl(html, BASE)).toBe("https://d1.sci-hub.se/abc/paper.pdf#view=FitH");
  });

  it("finds the embed src regardless of attribute order", () => {
    expect(extractPdfUrl(`<embed src="//cdn.sci-hub.se/x/y.pdf" type="application/pdf">`, BASE))
      .toBe("https://cdn.sci-hub.se/x/y.pdf");
    expect(extractPdfUrl(`<embed type="application/pdf" src="//cdn.sci-hub.se/x/y.pdf">`, BASE))
      .toBe("https://cdn.sci-hub.se/x/y.pdf");
  });

  it("prefers <meta name=citation_pdf_url> over embed/iframe", () => {
    const html = `<head><meta name="citation_pdf_url" content="https://meta.sci-hub.se/meta.pdf"></head>
      <embed type="application/pdf" src="//d1.sci-hub.se/embed.pdf">`;
    expect(extractPdfUrl(html, BASE)).toBe("https://meta.sci-hub.se/meta.pdf");
  });

  it("resolves root-relative embed src against the base url", () => {
    const html = `<embed type="application/pdf" src="/downloads/10.1038/nature12373.pdf">`;
    expect(extractPdfUrl(html, BASE)).toBe(`${BASE}/downloads/10.1038/nature12373.pdf`);
  });

  it("falls back to an iframe src when no embed/meta is present", () => {
    const html = `<iframe src="//mirror.sci-hub.se/paper.pdf"></iframe>`;
    expect(extractPdfUrl(html, BASE)).toBe("https://mirror.sci-hub.se/paper.pdf");
  });

  it("extracts a PDF URL from a button onclick", () => {
    const html = `<button onclick="location.href='//btn.sci-hub.se/paper.pdf'">Download</button>`;
    expect(extractPdfUrl(html, BASE)).toBe("https://btn.sci-hub.se/paper.pdf");
  });

  it("finds an absolute anchor pdf href", () => {
    const html = `<a href="https://anchor.sci-hub.se/full/paper.pdf">PDF</a>`;
    expect(extractPdfUrl(html, BASE)).toBe("https://anchor.sci-hub.se/full/paper.pdf");
  });

  it("returns empty for article-not-found pages (English and Russian)", () => {
    expect(extractPdfUrl("<html>Article not found</html>", BASE)).toBe("");
    expect(extractPdfUrl("<html>Статья не найдена</html>", BASE)).toBe("");
    expect(extractPdfUrl("<html>не найден</html>", BASE)).toBe("");
  });

  it("returns empty for an empty embed (not in the mirror database)", () => {
    expect(extractPdfUrl(`<html><embed type="application/pdf" src=""></html>`, BASE)).toBe("");
  });

  it("returns empty when nothing looks like a plausible pdf link", () => {
    const html = `<html><a href="/index">Home</a><button onclick="window.close()">x</button></html>`;
    expect(extractPdfUrl(html, BASE)).toBe("");
  });

  it("skips candidates that fail the plausibility filter", () => {
    const html = `<iframe src="https://x.example/journals/vol3/article"></iframe>
      <a href="https://anchor.sci-hub.se/full/paper.pdf">PDF</a>`;
    expect(extractPdfUrl(html, BASE)).toBe("https://anchor.sci-hub.se/full/paper.pdf");
  });
});

describe("resolveSciHubPdfUrl", () => {
  it("passes through an already-direct pdf url", async () => {
    const direct = "https://publisher.org/files/paper.pdf";
    const result = await resolveSciHubPdfUrl(direct);
    expect(result).toEqual({ url: direct, mirror: "direct" });
  });

  it("returns undefined for an empty identifier", async () => {
    expect(await resolveSciHubPdfUrl("   ")).toBeUndefined();
  });

  it("rotates across mirrors and returns the winning mirror", async () => {
    const fetchMock = vi.fn(async () => htmlResponse(embedPage));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveSciHubPdfUrl("10.1038/nature12373", {});
    expect(result).toEqual({ url: PDF, mirror: "https://sci-hub.vg" });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}/10.1038/nature12373`);
    expect(String(fetchMock.mock.calls[0]![1].headers["User-Agent"])).toContain("Chrome");
  });

  it("returns undefined when every mirror says article not found", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(notFoundPage)));
    const result = await resolveSciHubPdfUrl("10.1234/invalid.doi", {});
    expect(result).toBeUndefined();
  });

  it("falls through a failing first mirror to the next one", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      return htmlResponse(url.startsWith(`${BASE}/`) ? notFoundPage : embedPage);
    }));
    const result = await resolveSciHubPdfUrl("10.1038/nature12373", {});
    expect(result?.mirror).toBe("https://sci-hub.al");
    expect(calls[0]).toBe(`${BASE}/10.1038/nature12373`);      // sci-hub.vg first
    expect(calls[1]).toBe("https://sci-hub.al/10.1038/nature12373");
  });

  it("de-prioritizes a mirror that just failed (health store)", async () => {
    // First resolution: vg fails, al succeeds → only vg is recorded as down.
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      htmlResponse(String(url).startsWith(`${BASE}/`) ? notFoundPage : embedPage),
    ));
    const first = await resolveSciHubPdfUrl("10.1/one", {});
    expect(first?.mirror).toBe("https://sci-hub.al");
    vi.unstubAllGlobals();

    // Second resolution: vg must NOT be tried first anymore.
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      return htmlResponse(url.includes("sci-hub.al") ? embedPage : notFoundPage);
    }));
    const result = await resolveSciHubPdfUrl("10.1/two", {});
    expect(result?.mirror).toBe("https://sci-hub.al");
    expect(calls[0]).toBe("https://sci-hub.al/10.1/two"); // vg skipped
  });
});

describe("sciHubEnabled", () => {
  it("is on by default", () => {
    expect(sciHubEnabled()).toBe(true);
  });

  it("is disabled by a false env var", () => {
    process.env.PAPERSEARCH_USE_SCI_HUB = "false";
    expect(sciHubEnabled()).toBe(false);
  });

  it("is disabled by the settings boolean", async () => {
    await refreshSourceKeys({ useScihub: false });
    process.env.PAPERSEARCH_USE_SCI_HUB = "true";
    expect(sciHubEnabled()).toBe(false);
  });

  it("is enabled by the settings boolean even when env is false", async () => {
    await refreshSourceKeys({ useScihub: true });
    process.env.PAPERSEARCH_USE_SCI_HUB = "false";
    expect(sciHubEnabled()).toBe(true);
  });
});
