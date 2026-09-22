import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPdf } from "../registry";

/** Partial node:fs/promises mock: writeFile and rm are spies that delegate to
 *  the real implementations by default (so mkdir/rename/stat and the test's
 *  own dir lifecycle behave normally); individual tests override one call. */
const { writeFileMock, rmMock } = vi.hoisted(() => ({ writeFileMock: vi.fn(), rmMock: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal: () => Promise<typeof import("node:fs/promises")>) => {
  const real = await importOriginal();
  writeFileMock.mockImplementation(real.writeFile);
  rmMock.mockImplementation(real.rm);
  return { ...real, writeFile: writeFileMock, rm: rmMock };
});

const pdfMagic = Buffer.concat([
  Buffer.from("%PDF-1.7 fake content for tests\n"),
  Buffer.from("x".repeat(2048)),
]);

function fakePdfResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/pdf" : null) },
    arrayBuffer: async () => pdfMagic.buffer.slice(pdfMagic.byteOffset, pdfMagic.byteOffset + pdfMagic.byteLength),
  };
}

/** .part tmp paths observed through the writeFile spy, e.g. for assertions on
 *  the `<final>.<pid>-<uuid>.part` shape and per-call uniqueness. Sidecar
 *  writes go through the same spy, so filter down to staging paths. */
function observedPartPaths(): string[] {
  return writeFileMock.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((file: string) => file.endsWith(".part"));
}

describe("fetchPdf .part handling", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dsh-papersearch-part-"));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
    // Cleared last so this cleanup's own rm(dir) call does not leak into the
    // next test's call log.
    writeFileMock.mockClear();
    rmMock.mockClear();
  });

  it("gives concurrent downloads of the same final name distinct .part files", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse()));
    const [first, second] = await Promise.all([
      fetchPdf("https://x/1.pdf", dir, "same", {}),
      fetchPdf("https://x/2.pdf", dir, "same", {}),
    ]);
    // Same final target, but the staging paths must never collide.
    expect(first.path).toBe(second.path);
    const parts = observedPartPaths();
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part).toMatch(/same\.pdf\.\d+-[0-9a-f-]{36}\.part$/);
    }
    expect(new Set(parts).size).toBe(2);
    expect((await readdir(dir)).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("cleans up and rethrows when writeFile itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakePdfResponse()));
    writeFileMock.mockRejectedValueOnce(new Error("disk full (simulated)"));
    await expect(fetchPdf("https://x/1.pdf", dir, "wfail", {})).rejects.toThrow("disk full (simulated)");
    // The failed staging path is removed with force, and the original error
    // surfaces (the cleanup .catch must not swallow or replace it).
    expect(rmMock).toHaveBeenCalledTimes(1);
    const rmCall = rmMock.mock.calls[0]!;
    expect(String(rmCall[0])).toMatch(/wfail\.pdf\.\d+-[0-9a-f-]{36}\.part$/);
    expect(rmCall[1]).toEqual({ force: true });
    expect((await readdir(dir)).filter((name) => name.endsWith(".part"))).toEqual([]);
  });
});
