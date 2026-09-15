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
