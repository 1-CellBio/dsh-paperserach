import type { Paper } from "../paper";

/** Arguments every source adapter receives per search call. */
export interface SearchArgs {
  query: string;
  maxResults: number;
  /** Optional year filter ('2023' or '2020-2024'); honored where an API supports it. */
  year?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Resolved download target returned by sources with native PDF delivery. */
export interface DownloadTarget {
  url: string;
  /** File-stem for the saved PDF (extension and sanitization applied downstream). */
  baseName: string;
}

/**
 * One academic source connector. `search` never throws for per-source
 * failures it can express — the registry aggregates those into errors —
 * but configuration problems (missing API key) SHOULD throw so the caller
 * sees a precise hint.
 */
export interface SourceAdapter {
  id: string;
  /** Whether the source can serve PDF bytes itself (native download path). */
  canDownload: boolean;
  search(args: SearchArgs): Promise<Paper[]>;
  /** Optional native PDF resolver; absent sources rely on the fallback chain. */
  download?(paperId: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<DownloadTarget>;
}

/** Sanitize a source+id pair into a safe cross-platform file-name fragment. */
export function safeFileFragment(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "paper";
  return trimmed.replace(/[\\/]+/g, "_").replace(/\s+/g, "_");
}
