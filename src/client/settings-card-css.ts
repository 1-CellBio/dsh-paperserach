/**
 * Settings card styles, injected once as a <style> tag with a data-plugin
 * owner — the runtime twin of the css-modules inlining okf/prism do at build
 * time. All colors ride the host's --dsw-alias-* theme variables, so the card
 * follows the dark/light theme exactly like the native settings cards.
 * Class names are prefixed (dshPs) to stay collision-free inside the host page.
 */

const CSS = `
.dshPsCard {
  list-style: none;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color 0.16s, background 0.16s;
}

.dshPsCard:hover {
  border-color: var(--dsw-alias-label-dimmed);
}
.dshPsCardOpen {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-label-dimmed);
}
.dshPsHeader {
  width: 100%;
  appearance: none;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 12px;
}
.dshPsHeader:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.dshPsHeadText {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dshPsName {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
}
.dshPsDescription {
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dshPsChevron {
  flex: none;
  width: 8px;
  height: 8px;
  border-right: 2px solid var(--dsw-alias-label-tertiary);
  border-bottom: 2px solid var(--dsw-alias-label-tertiary);
  transform: rotate(45deg);
  transition: transform 160ms ease;
}
.dshPsChevronOpen {
  transform: rotate(225deg);
}
.dshPsPending {
  flex: none;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dshPsBody {
  border-top: 1px solid var(--dsw-alias-border-l2);
  padding-bottom: 8px;
}
.dshPsSection {
  padding: 4px 16px 8px;
}
.dshPsSection + .dshPsSection,
.dshPsSection + .dshPsAdvanced {
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin-top: 4px;
  padding-top: 12px;
}
.dshPsSectionTitle {
  margin: 8px 0 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: 0.02em;
  color: var(--dsw-alias-label-secondary);
}
.dshPsSectionNote {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dshPsField {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
.dshPsField + .dshPsField {
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dshPsFieldHead {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dshPsLabel {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dshPsBadges {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.dshPsBadge {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
  font-weight: 500;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dshPsBadgeQuiet {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
  font-weight: 500;
  background: none;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
}
.dshPsBadgeWarn {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
  font-weight: 500;
  background: none;
  border: 1px solid var(--dsw-alias-label-error);
  color: var(--dsw-alias-label-error);
}
.dshPsReset {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dshPsReset:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
}
.dshPsReset:disabled {
  cursor: default;
}
.dshPsInput {
  height: 34px;
  width: 100%;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
  box-sizing: border-box;
}
.dshPsInput:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dshPsInput:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.dshPsHint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dshPsLinkBtn {
  border: none;
  background: none;
  padding: 0;
  margin: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.dshPsLinkBtn:hover:not(:disabled) {
  color: var(--dsw-alias-label-error);
}
.dshPsLinkBtn:disabled {
  cursor: default;
  opacity: 0.5;
}
.dshPsFailedInline {
  margin: 8px 16px 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-error);
}
.dshPsAdvanced {
  margin: 12px 16px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 8px 12px 4px;
}
.dshPsAdvancedSummary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.dshPsAdvancedSummary::marker {
  color: var(--dsw-alias-label-tertiary);
}
.dshPsAdvanced .dshPsField:last-child {
  padding-bottom: 8px;
}
.dshPsFooter {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px 4px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.dshPsFailed {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-error);
}
.dshPsDiscard,
.dshPsSave {
  appearance: none;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}
.dshPsDiscard {
  border-color: var(--dsw-alias-border-l2);
  background: none;
  color: var(--dsw-alias-label-secondary);
}
.dshPsSave {
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
}
.dshPsDiscard:disabled,
.dshPsSave:disabled {
  opacity: 0.4;
  cursor: default;
}
.dshPsDiscard:focus-visible,
.dshPsSave:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  .dshPsChevron {
    transition: none;
  }
}
`;

const STYLE_TAG_ID = "dsh-papersearch/settings-card";

/** Inject the card stylesheet once per document. */
export function ensureSettingsCardStyles(): void {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-papersearch";
  tag.dataset.pluginCss = STYLE_TAG_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}
