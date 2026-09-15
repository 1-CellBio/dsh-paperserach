/** Live-network tests for the public source APIs — deliberately excluded
 *  from the default suite (CI passes vitest an --exclude filter naming this
 *  file): they hit real academic endpoints and download real PDFs, so they
 *  are slow and occasionally rate-limited (arXiv answers 429 by IP). Run
 *  them explicitly when a wire contract is in doubt. The suite self-skips
 *  when the machine looks offline (3s DNS probe) so offline runs stay green
 *  without weakening any assertion. */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadPaper, searchSources } from "../registry";

const online = await Promise.race([
  lookup("export.arxiv.org").then(
    () => true,
    () => false,
  ),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
]);

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ps-live-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
describe.skipIf(!online)("live APIs", () => {
  it("searches arxiv and returns deduplicated paper cards", { timeout: 120_000 }, async () => {
    const result = await searchSources({
      query: "CRISPR base editing",
      sources: ["arxiv"],
      maxResults: 3,
      timeoutMs: 60_000,
    });
    expect(result.errors).toEqual({});
    expect(result.papers.length).toBeGreaterThan(0);
    expect(result.papers[0]?.paperId).toBeTruthy();
    expect(result.papers[0]?.source).toBe("arxiv");
    expect(result.papers[0]?.pdfUrl).toContain("arxiv.org/pdf/");
  });

  it("searches crossref metadata", async () => {
    const result = await searchSources({
      query: "single-cell RNA sequencing",
      sources: ["crossref"],
      maxResults: 3,
      timeoutMs: 60_000,
    });
    expect(result.papers.length).toBeGreaterThan(0);
    expect(result.papers[0]?.doi).toMatch(/^10\./);
  });

  it("downloads a real arxiv PDF and verifies the payload", { timeout: 180_000 }, async () => {
    // Small paper (~360KB) so slow links still finish inside the budget.
    const outcome = await downloadPaper("arxiv", "2106.15928v1", { dir, timeoutMs: 150_000 });
    expect(outcome.status).toBe("downloaded");
    expect(outcome.path).toBeTruthy();
    const info = await stat(outcome.path!);
    expect(info.size).toBeGreaterThan(10_000);

    const again = await downloadPaper("arxiv", "2106.15928v1", { dir });
    expect(again.status).toBe("exists");
  });
});
