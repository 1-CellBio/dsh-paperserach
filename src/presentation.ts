import type { ToolResult, WebSearchResultView, WebSource } from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import type { CompactPaper } from "./paper";

/**
 * Presentation projection for `papersearch_search`: the completed call renders
 * as a web search card (`card: 'web'`, `kind: 'search'`), whose citation-list
 * UI fits deduplicated paper cards. The projection rides the tool result's
 * `meta` (persisted with the session log), so `presentResult` reproduces the
 * card on replay; sessions logged before this projection carry no meta and
 * fall back to the generic card.
 */

/** One paper card's citation-line fields, projected from {@link CompactPaper}.
 *  A type-literal return (not the `WebSource` interface) so the result is
 *  assignable to `JsonValue`, which the persisted meta payload requires. */
function sourceOf(paper: CompactPaper): { url: string; title: string; snippet: string } {
  const url = paper.url || paper.pdfUrl || (paper.doi ? `https://doi.org/${paper.doi}` : "");
  const tag = [paper.source, paper.year].filter(Boolean).join(" ");
  const citations = paper.citations > 0 ? ` · ${paper.citations} citations` : "";
  return {
    url,
    title: paper.title,
    snippet: `${tag}${paper.authors ? ` — ${paper.authors}` : ""}${citations}`,
  };
}

/** Whether `value` is a {@link CompactPaper} (defensive narrowing from the opaque result value). */
function isCompactPaper(value: unknown): value is CompactPaper {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const paper = value as Record<string, unknown>
  return typeof paper.paperId === "string"
    && typeof paper.title === "string"
    && typeof paper.authors === "string"
    && typeof paper.year === "string"
    && typeof paper.doi === "string"
    && typeof paper.pdfUrl === "string"
    && typeof paper.url === "string"
    && typeof paper.source === "string"
    && typeof paper.citations === "number"
    && typeof paper.abstract === "string"
}

/**
 * Project a `papersearch_search` output value into its replayable
 * presentation meta: the per-paper sources and the result-cap flag.
 * @param value - the canonical search output value.
 * @returns `{ sources, truncated }`, or absent-shaped meta when the value does
 * not carry papers (older or unexpected results render as the generic card).
 */
export function searchMetaFromValue(value: JsonValue): JsonValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const papers = (value as Record<string, unknown>).papers
  const truncated = (value as Record<string, unknown>).truncated
  if (!Array.isArray(papers) || typeof truncated !== "boolean") return {}
  return {
    sources: papers.filter(isCompactPaper).map(sourceOf),
    truncated,
  }
}

/** The `meta` payload {@link presentSearchResult} narrows back into the view. */
interface SearchMeta {
  sources: WebSource[]
  truncated: boolean
}

/** Whether `value` is a valid {@link WebSource} (defensive narrowing from opaque `meta`). */
function isWebSource(value: unknown): value is WebSource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return typeof source.url === "string"
    && (source.title === undefined || typeof source.title === "string")
    && (source.snippet === undefined || typeof source.snippet === "string")
}

/**
 * Narrow opaque live or replayed result metadata to {@link SearchMeta};
 * malformed metadata returns `undefined` so presentation falls back to the
 * generic card instead of throwing during replay.
 * @param meta - result metadata.
 * @returns the validated meta, or `undefined` for absent or malformed data.
 */
function searchMetaFromResult(meta: unknown): SearchMeta | undefined {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined
  const { sources, truncated } = meta as Record<string, unknown>
  if (!Array.isArray(sources) || !sources.every(isWebSource)) return undefined
  if (typeof truncated !== "boolean") return undefined
  return { sources, truncated }
}

/**
 * Completed-call presentation for `papersearch_search`: a web search card
 * citing each paper. Malformed or absent meta returns `undefined` (generic
 * card), and so does a failed call.
 * @param args - the raw tool arguments; the query becomes the result title.
 * @param result - the final model-facing tool result; `meta` carries the sources.
 * @returns the web search result view, or `undefined` to keep the generic card.
 */
export function presentSearchResult(args: { query?: unknown }, result: ToolResult): WebSearchResultView | undefined {
  if (result.isError) return undefined
  const meta = searchMetaFromResult(result.meta)
  if (meta === undefined) return undefined
  return {
    card: "web",
    kind: "search",
    title: typeof args.query === "string" ? args.query : "",
    sources: meta.sources,
    truncated: meta.truncated,
  }
}
