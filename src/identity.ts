import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { bareDoi } from "./paper";

/**
 * Content identity checks for downloaded PDFs.
 *
 * A download's provenance `identity` only records how the URL was found; it
 * says nothing about what the bytes are. Two cheap checks that need no
 * network close the most damaging gap: byte-identical payloads claimed by two
 * different DOIs are refused (one of the two is wrong by construction), and a
 * DOI the OKF library already covers is answered from the library instead of
 * being fetched again.
 */

/** Lowercase bare DOI; empty when the input carries none. */
export function normalizeDoi(raw: string | undefined | null): string {
  return bareDoi(raw).toLowerCase();
}

/** Thrown by fetchPdf when the payload is byte-identical to a stored PDF that
 * is recorded under a different DOI. The new payload is never written. */
export class IdentityConflictError extends Error {
  /** DOI the caller asked for. */
  readonly requestedDoi: string;
  /** DOI recorded in the sidecar of the already-stored identical file. */
  readonly recordedDoi: string;
  /** Absolute path of the already-stored identical PDF. */
  readonly file: string;

  /**
   * @param requestedDoi - normalized DOI of the refused download.
   * @param recordedDoi - normalized DOI recorded for the stored file.
   * @param file - absolute path of the stored PDF with identical bytes.
   */
  constructor(requestedDoi: string, recordedDoi: string, file: string) {
    super(
      `identity conflict: these bytes are already stored as ${path.basename(file)} (recorded for DOI ${recordedDoi}) `
        + `and cannot also be ${requestedDoi}; at least one of the two DOIs does not match this document, so the new download was not saved`,
    );
    this.name = "IdentityConflictError";
    this.requestedDoi = requestedDoi;
    this.recordedDoi = recordedDoi;
    this.file = file;
  }
}

const SIDECAR_SUFFIX = ".meta.json";

/** Nearest ancestor (or the dir itself) that is an OKF `sources/pdfs` directory. */
export function pdfsRootOf(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    if (path.basename(current) === "pdfs" && path.basename(path.dirname(current)) === "sources") return current;
    const up = path.dirname(current);
    if (up === current) return undefined;
    current = up;
  }
}

/** Directories whose sidecars are compared: the save dir, plus the library's
 * `sources/pdfs` root when the save dir is nested below it. */
export function sidecarScanDirs(dir: string): string[] {
  const root = pdfsRootOf(dir);
  return root !== undefined && path.resolve(dir) !== root ? [dir, root] : [dir];
}

/**
 * Find a stored PDF whose sidecar records the same sha256 under a different,
 * non-empty DOI than `requestedDoi`. Sidecars without a DOI, sidecars whose
 * PDF is gone, and the sidecar about to be overwritten never count: none of
 * them proves the stored bytes belong to another paper.
 * @param dirs - directories to scan (non-recursive).
 * @param sha256 - lowercase hex digest of the new payload.
 * @param requestedDoi - DOI the new payload is saved for.
 * @param ownSidecar - sidecar path of the destination file, excluded from the scan.
 * @returns the conflicting stored file and its recorded DOI, or undefined.
 */
export async function findSha256Conflict(
  dirs: readonly string[],
  sha256: string,
  requestedDoi: string,
  ownSidecar: string,
): Promise<{ file: string; doi: string } | undefined> {
  const wanted = normalizeDoi(requestedDoi);
  if (!wanted) return undefined;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      void error; // directory not created yet: nothing stored there
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(`.pdf${SIDECAR_SUFFIX}`)) continue;
      const sidecarPath = path.join(dir, name);
      if (path.resolve(sidecarPath) === path.resolve(ownSidecar)) continue;
      let recorded: { sha256?: unknown; doi?: unknown };
      try {
        recorded = JSON.parse(await readFile(sidecarPath, "utf8")) as { sha256?: unknown; doi?: unknown };
      } catch (error) {
        void error; // corrupt sidecar: same as no sidecar
        continue;
      }
      if (typeof recorded.sha256 !== "string" || recorded.sha256.toLowerCase() !== sha256) continue;
      const storedDoi = normalizeDoi(typeof recorded.doi === "string" ? recorded.doi : "");
      if (!storedDoi || storedDoi === wanted) continue;
      const pdfPath = sidecarPath.slice(0, -SIDECAR_SUFFIX.length);
      const info = await stat(pdfPath).catch(() => undefined);
      if (!info?.isFile()) continue;
      return { file: pdfPath, doi: storedDoi };
    }
  }
  return undefined;
}

/** Library root (the parent of `sources/pdfs`) for a save dir, when it is one. */
export function okfRootOf(dir: string): string | undefined {
  const root = pdfsRootOf(dir);
  return root === undefined ? undefined : path.dirname(path.dirname(root));
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const DOI_LINE_RE = /^doi:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m;
const MISMATCH_LINE_RE = /^identityMismatch:[ \t]*true[ \t]*$/m;

/**
 * DOI → Paper page index of an OKF library, read from `papers/*.md`
 * frontmatter. A Paper page exists only after a PDF was ingested and compiled,
 * so a hit means full text is already in the library. Pages flagged
 * `identityMismatch` are skipped: their content is not the paper they claim.
 * @param dir - the PDF save dir; the library is located from it.
 * @returns normalized DOI → `papers/<file>.md`; empty when `dir` is not inside an OKF library.
 */
export async function loadLibraryDoiIndex(dir: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const root = okfRootOf(dir);
  if (root === undefined) return index;
  const papersDir = path.join(root, "papers");
  let names: string[];
  try {
    names = await readdir(papersDir);
  } catch (error) {
    void error; // no papers/ yet: empty library
    return index;
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    let text: string;
    try {
      text = await readFile(path.join(papersDir, name), "utf8");
    } catch (error) {
      void error; // unreadable page: not indexed
      continue;
    }
    const frontmatter = FRONTMATTER_RE.exec(text)?.[1];
    if (frontmatter === undefined || MISMATCH_LINE_RE.test(frontmatter)) continue;
    const doi = normalizeDoi(DOI_LINE_RE.exec(frontmatter)?.[1]);
    if (doi && !index.has(doi)) index.set(doi, `papers/${name}`);
  }
  return index;
}

let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Run `task` after every earlier guarded task settled. fetchPdf's conflict
 * scan and the file/sidecar writes share one critical section, so two
 * concurrent downloads of identical bytes cannot both pass the scan before
 * either sidecar exists.
 * @param task - the guarded async work.
 * @returns the task's result.
 */
export function withStoreLock<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task);
  writeChain = run.catch((error: unknown) => {
    void error; // the caller of `run` sees the failure; the chain only sequences
  });
  return run;
}
