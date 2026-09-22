import path from "node:path";
import { expandDirTemplate } from "./settings";

/** pdfDir default: the dsh-okf PDF sources dir, so downloads are ingestible. */
export const DEFAULT_PDF_DIR = "${cwd}/OKF/sources/pdfs";

export type PluginPaths = {
  pdfDir: string;
};

/** Resolve the pdfDir against the session workspace. */
export function resolvePdfDir(raw: string, cwd?: string): string {
  const expanded = expandDirTemplate(raw || DEFAULT_PDF_DIR, cwd);
  if (!expanded) {
    throw new Error("dsh-papersearch: pdfDir is empty after expanding variables");
  }
  return path.resolve(expanded);
}

/** Resolve a user-supplied dir argument against the download base and confine
 *  it there: anything that resolves outside the base (absolute paths, `..`
 *  escapes — path.resolve normalizes them away) is rejected. The base is the
 *  pdfDir setting / OKF sources dir; moving it is a settings change, not a
 *  tool argument. */
export function confineDirToBase(base: string, raw: string): string {
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (resolved !== base && !resolved.startsWith(prefix)) {
    throw new Error(
      `dsh-papersearch: dir '${raw}' resolves outside the download root ${base}; use a relative subdir, or move the root via the pdfDir setting`,
    );
  }
  return resolved;
}
