import { useMemo, useState } from "react";
import type { ToolCallOwnerProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import type { PapersearchLocaleKey } from "./locales.ts";
import { searchCardView, type SearchCardSource } from "./search-card-view.ts";

/**
 * Keyed toolview for papersearch_search — renders the citation list from the
 * settled result's persisted presentation meta: per paper a title link, the
 * source line, and [PDF]/[DOI] chips when the meta carries the direct PDF
 * link or the DOI. Registering this slot claims ALL papersearch_search calls
 * (the generic tool row no longer renders for them), so every state stays
 * presentable: running placeholder, error/stopped detail, and a generic
 * fallback row when the meta is absent or malformed. Self-contained React
 * only (react is a platform module); `t` degrades to the identity when the
 * locale seat is missing, so the card renders untranslated instead of
 * crashing.
 */
export type SearchCardProps = ToolCallOwnerProps & {
  t?: (key: PapersearchLocaleKey) => string;
};

/** Shrink-to-fit, mirroring the other plugin cards: a citation list inside a
 *  full-width panel would read as dead space to both sides. */
const CARD_STYLE: React.CSSProperties = {
  display: "inline-block",
  maxWidth: "100%",
  border: "1px solid var(--border, #ddd)",
  borderRadius: "8px",
  padding: "6px 10px",
  margin: "4px 0",
  fontSize: "13px",
  background: "var(--dsw-alias-bg-layer-1, transparent)",
  color: "var(--foreground, inherit)",
};

/** Outbound link chip ([PDF] / [DOI]) pinned beside the citation link. */
const CHIP_STYLE: React.CSSProperties = {
  marginLeft: "6px",
  padding: "0 6px",
  borderRadius: "8px",
  border: "1px solid var(--border, #ccc)",
  background: "var(--dsw-alias-bg-layer-2, transparent)",
  color: "var(--okf-accent, #2563eb)",
  fontSize: "0.8em",
  textDecoration: "none",
  whiteSpace: "nowrap",
};

const ACTION_CHIP_STYLE: React.CSSProperties = {
  marginLeft: "6px",
  padding: "1px 6px",
  borderRadius: "8px",
  border: "1px solid var(--border, #ccc)",
  background: "var(--dsw-alias-bg-layer-2, transparent)",
  color: "var(--foreground, inherit)",
  fontSize: "0.8em",
  cursor: "pointer",
  whiteSpace: "nowrap",
  lineHeight: 1.3,
};

const INITIAL_SHOWN = 5;

export function SearchCard(props: SearchCardProps): React.JSX.Element {
  const { block } = props;
  // The fallback t wraps in a memo so its reference is stable — it is a
  // dependency of the view-model memo below.
  const t = useMemo<(key: PapersearchLocaleKey) => string>(() => props.t ?? ((key) => key), [props.t]);
  const view = useMemo(() => searchCardView(block, t), [block, t]);
  const [expanded, setExpanded] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const sources = view.sources ?? [];
  const hasMore = sources.length > INITIAL_SHOWN;
  const displayedSources = expanded || !hasMore ? sources : sources.slice(0, INITIAL_SHOWN);

  const onCopyIngest = (source: SearchCardSource, key: string): void => {
    const target = source.doiUrl || source.url || source.title || "";
    const prompt = `把 ${target} 编进 OKF`;
    void navigator.clipboard.writeText(prompt);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr));
    }, 2000);
  };

  return (
    <div style={CARD_STYLE} data-papersearch-search={view.badge}>
      <strong style={{ fontSize: "0.92em" }}>{view.title}</strong>
      {view.detail !== undefined && (
        <div
          style={{
            margin: "6px 0 0",
            whiteSpace: "pre-wrap",
            color: view.badge === "fallback" ? "var(--text-muted, #888)" : "var(--text-danger, #c66)",
            fontSize: "0.9em",
          }}
        >
          {view.detail}
        </div>
      )}
      {view.sources !== undefined && (
        <>
          <ol style={{ margin: "6px 0 0", paddingLeft: "18px", textAlign: "left" }}>
            {displayedSources.map((source, index) => {
              const itemKey = `${source.url}#${index}`;
              const isCopied = copiedKey === itemKey;
              return (
                <li key={itemKey} style={{ marginBottom: "6px" }}>
                  {source.url !== "" ? (
                    <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title ?? source.url}</a>
                  ) : (
                    <span>{source.title ?? source.url}</span>
                  )}
                  {source.pdfUrl !== undefined && source.pdfUrl !== "" && (
                    <a href={source.pdfUrl} target="_blank" rel="noopener noreferrer" style={CHIP_STYLE}>
                      [{t("search.pdf")}]
                    </a>
                  )}
                  {source.doiUrl !== undefined && (
                    <a href={source.doiUrl} target="_blank" rel="noopener noreferrer" style={CHIP_STYLE}>
                      [{t("search.doi")}]
                    </a>
                  )}
                  <button
                    type="button"
                    style={ACTION_CHIP_STYLE}
                    onClick={() => onCopyIngest(source, itemKey)}
                    title={isCopied ? t("search.copied") : t("search.copyIngest")}
                  >
                    [{isCopied ? t("search.copied") : t("search.copyIngest")}]
                  </button>
                  {source.snippet !== undefined && source.snippet !== "" && (
                    <div style={{ color: "var(--text-muted, #888)", fontSize: "0.85em" }}>{source.snippet}</div>
                  )}
                </li>
              );
            })}
          </ol>
          {hasMore && (
            <div style={{ margin: "4px 0 2px 18px" }}>
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                style={{
                  border: "none",
                  background: "none",
                  padding: 0,
                  color: "var(--okf-accent, #2563eb)",
                  cursor: "pointer",
                  fontSize: "0.85em",
                }}
              >
                {expanded
                  ? t("search.showLess")
                  : t("search.showMore").replace("{n}", String(sources.length - INITIAL_SHOWN))}
              </button>
            </div>
          )}
        </>
      )}
      {view.sources !== undefined && view.truncated && (
        <div style={{ color: "var(--text-warning, #a65)", fontSize: "0.85em", marginTop: "4px" }}>{t("search.truncated")}</div>
      )}
    </div>
  );
}
