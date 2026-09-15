import { useMemo } from "react";
import type { ToolCallOwnerProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import type { PapersearchLocaleKey } from "./locales.ts";
import { searchCardView } from "./search-card-view.ts";

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
};

/** Outbound link chip ([PDF] / [DOI]) pinned beside the citation link. */
const CHIP_STYLE: React.CSSProperties = {
  marginLeft: "6px",
  padding: "0 6px",
  borderRadius: "8px",
  border: "1px solid var(--border, #ccc)",
  fontSize: "0.8em",
  textDecoration: "none",
  whiteSpace: "nowrap",
};

export function SearchCard(props: SearchCardProps): React.JSX.Element {
  const { block } = props;
  // The fallback t wraps in a memo so its reference is stable — it is a
  // dependency of the view-model memo below.
  const t = useMemo<(key: PapersearchLocaleKey) => string>(() => props.t ?? ((key) => key), [props.t]);
  const view = useMemo(() => searchCardView(block, t), [block, t]);

  return (
    <div style={CARD_STYLE} data-papersearch-search={view.badge}>
      <strong style={{ fontSize: "0.92em" }}>{view.title}</strong>
      {view.detail !== undefined && (
        <div
          style={{
            margin: "6px 0 0",
            whiteSpace: "pre-wrap",
            color: view.badge === "fallback" ? "#888" : "#c66",
            fontSize: "0.9em",
          }}
        >
          {view.detail}
        </div>
      )}
      {view.sources !== undefined && (
        <ol style={{ margin: "6px 0 0", paddingLeft: "18px", textAlign: "left" }}>
          {view.sources.map((source, index) => (
            <li key={`${source.url}#${index}`} style={{ marginBottom: "6px" }}>
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
              {source.snippet !== undefined && source.snippet !== "" && (
                <div style={{ color: "#888", fontSize: "0.85em" }}>{source.snippet}</div>
              )}
            </li>
          ))}
        </ol>
      )}
      {view.sources !== undefined && view.truncated && (
        <div style={{ color: "#a65", fontSize: "0.85em", marginTop: "4px" }}>{t("search.truncated")}</div>
      )}
    </div>
  );
}
