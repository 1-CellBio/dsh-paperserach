import { searchMetaFromResult } from "../presentation.ts";
import type { PapersearchLocaleKey } from "./locales.ts";

/**
 * SearchCard state-machine layer: every "what to show from the frozen tool
 * payload" decision — lifecycle, meta narrowing, title/query composition,
 * failure body — lives in this pure module, so the component is a plain
 * renderer of the view model and the states are unit-testable on the node
 * side (the repo has no client render test setup: no jsdom, react-dom, or
 * testing-library). The meta narrowing is shared with the host plane's
 * presentResult, so the card and the replayed presenter read one contract.
 */

/** Host-injected translate (same signature as the SearchCard `t` prop). */
export type SearchCardTranslate = (key: PapersearchLocaleKey) => string;

/** Frozen tool-call payload (running call or settled tool-result node). */
export type SearchCardBlock = {
  callId: string;
  name?: string;
  argsRaw?: string;
  kind?: string;
  call?: { name?: string; argsRaw?: string } | null;
  content?: ReadonlyArray<{ type?: string; text?: string }>;
  isError?: boolean;
  error?: { name?: string; code?: string };
  meta?: unknown;
};

/**
 * Card states: running (call in flight), ok (citation list renders from the
 * persisted meta), fallback (settled without usable meta — generic-row
 * material), error (isError result), stopped (interrupted result).
 */
export type SearchCardBadge = "running" | "ok" | "fallback" | "error" | "stopped";

/** One rendered citation row; `doiUrl` is the resolver link for the DOI chip. */
export type SearchCardSource = {
  url: string;
  title?: string;
  snippet?: string;
  /** Direct PDF chip target; absent when the source reported no PDF. */
  pdfUrl?: string;
  /** DOI chip target (`https://doi.org/<doi>`); absent when no DOI is known. */
  doiUrl?: string;
};

/** View model — the component renders these fields verbatim. */
export type SearchCardView = {
  /** DOM state anchor, used directly as the data-papersearch-search value. */
  badge: SearchCardBadge;
  /** Card headline (localized; annotated with the query when known). */
  title: string;
  /** Failure/interrupt body (error, stopped) or the settled result head
   *  (fallback); absent for running and ok. */
  detail?: string;
  /** Citation rows — ok only. */
  sources?: SearchCardSource[];
  /** Result-cap marker — ok only. */
  truncated?: boolean;
};

/** Lifecycle of the frozen call: running until a tool-result node settles it. */
export function searchCardLifecycle(block: SearchCardBlock): "running" | "ok" | "error" | "stopped" {
  if (block.kind !== "tool-result") return "running";
  if (block.error?.code === "interrupted") return "stopped";
  return block.isError ? "error" : "ok";
}

/**
 * Query from the frozen call args (running `argsRaw` or the settled call
 * head); undefined when absent or unparsable — never guessed.
 */
function queryOfCall(block: SearchCardBlock): string | undefined {
  const raw = typeof block.argsRaw === "string" ? block.argsRaw
    : typeof block.call?.argsRaw === "string" ? block.call.argsRaw
    : undefined;
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const query = (parsed as Record<string, unknown>).query;
      if (typeof query === "string" && query.trim()) return query;
    }
  } catch { /* not JSON */ }
  return undefined;
}

/** Collapse whitespace so pretty-printed result JSON reads as one line. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Error body: the first non-empty text content (capped), else the structured
 * error code, else a generic marker.
 */
function errorTextOf(block: SearchCardBlock): string {
  for (const item of block.content ?? []) {
    if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      return collapse(item.text.slice(0, 400));
    }
  }
  return block.error?.code ?? "unknown error";
}

/** Result head for the generic fallback row: the flattened content text
 *  collapsed and capped; undefined when the result carries no text. */
function resultHead(block: SearchCardBlock): string | undefined {
  const parts: string[] = [];
  for (const item of block.content ?? []) {
    if (item.type === "text" && typeof item.text === "string" && item.text) parts.push(item.text);
  }
  const head = collapse(parts.join("\n").slice(0, 400));
  return head || undefined;
}

/**
 * Frozen payload + translate -> card view model. Pure: same input, same
 * output, no IO. The ok arm narrows the persisted meta through the host
 * plane's searchMetaFromResult, so malformed or absent meta degrades to the
 * generic fallback row exactly as presentResult degrades to the generic card.
 * @param block - frozen running call or settled result node.
 * @param t - locale translate for the card copy.
 * @returns the view model; every lifecycle state is presentable.
 */
export function searchCardView(block: SearchCardBlock, t: SearchCardTranslate): SearchCardView {
  const lifecycle = searchCardLifecycle(block);
  const title = (base: string): string => {
    const query = queryOfCall(block);
    return query === undefined ? base : `${base} · ${query}`;
  };
  switch (lifecycle) {
    case "running":
      return { badge: "running", title: title(t("search.searching")) };
    case "stopped":
      return { badge: "stopped", title: t("search.stopped"), detail: t("search.stoppedDetail") };
    case "error":
      return { badge: "error", title: title(t("search.failed")), detail: errorTextOf(block) };
    case "ok": {
      const meta = searchMetaFromResult(block.meta);
      if (meta === undefined || meta.sources.length === 0) {
        return { badge: "fallback", title: title(t("search.title")), detail: resultHead(block) };
      }
      return {
        badge: "ok",
        title: title(t("search.title")),
        sources: meta.sources.map((source) => ({
          url: source.url,
          title: source.title,
          snippet: source.snippet,
          pdfUrl: source.pdfUrl,
          doiUrl: source.doi === undefined ? undefined : `https://doi.org/${source.doi}`,
        })),
        truncated: meta.truncated,
      };
    }
  }
}
