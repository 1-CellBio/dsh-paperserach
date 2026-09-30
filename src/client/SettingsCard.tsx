/**
 * The papersearch bundle page's settings form: source credential keys
 * (write-only, through the credentials domain) plus the volatile section
 * fields (dirs, timeouts, Scholar proxy, Sci-Hub). Rendered on the bundle's
 * Plugins-page detail view through the `plugins.bundle.config` slot; only a
 * save writes, and leaving the page drops every staged edit.
 */

import { SettingsForm, SettingsSecretField, SettingsValueField } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PapersearchLocaleKey } from "./locales.ts";
import type {
  CredentialField, PapersearchCardFace, PapersearchCardState,
} from "./settings-form-controller.ts";

/** Props the renderer binds for the bundle config page. */
export type PapersearchCardProps = {
  /** The view the Plugins page asks for; bundle config renders `page` only. */
  view?: "summary" | "page";
  /** Locale seat; degrades to the identity so the card renders untranslated instead of crashing. */
  t?: (key: PapersearchLocaleKey) => string;
  /** Snapshot hook the renderer binds from the injected face. */
  usePapersearchSettings?: <S>(selector: (state: PapersearchCardState) => S) => S;
} & Omit<PapersearchCardFace, "hooks">;

const SECTION_STYLE: React.CSSProperties = {
  margin: "10px 0 4px",
  fontSize: "12px",
  fontWeight: 600,
  opacity: 0.7,
  // Section captions span the whole field grid, not one cell.
  gridColumn: "1 / -1",
};

/** Two-column field grid for the wide bundle page; collapses to one column on narrow widths. */
const GRID_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
  columnGap: 24,
  alignItems: "start",
};

/** Section caption row, mirroring the old card's credentials/general grouping. */
function SectionTitle(props: { title: string }) {
  return <p style={SECTION_STYLE}>{props.title}</p>;
}

/**
 * Render the papersearch settings form.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the form.
 */
export function SettingsCard(props: PapersearchCardProps) {
  const t = props.t ?? ((key: PapersearchLocaleKey) => key);
  const useSettings = props.usePapersearchSettings;
  if (props.view === "summary") return t("settings.description");
  // The inject face always lands with the registration; a missing seat means
  // the renderer mounted the entry without its face — render nothing rather
  // than crash the whole Plugins page.
  if (useSettings === undefined) return null;
  const state = useSettings(snapshot => snapshot);
  const disabled = !state.writable;
  const labels = {
    unavailable: t("settings.unavailable"),
    readOnly: t("settings.readOnly"),
    saveFailed: t("settings.saveFailed"),
    save: t("settings.save"),
    saving: t("settings.saving"),
  };
  const secret = (field: CredentialField, labelKey: PapersearchLocaleKey, hintKey: PapersearchLocaleKey) => {
    const view = state.credentials[field];
    return (
      <SettingsSecretField
        id={`plugin-config-papersearch-${field}`}
        label={t(labelKey)}
        hint={t(hintKey)}
        disabled={!view.writable}
        text={view.text}
        configured={view.configured}
        stateLabel={view.configured ? t("settings.keyConfigured") : t("settings.keyNotConfigured")}
        onEdit={(text) => { props.edit(field, text); }}
      />
    );
  };
  return (
    <SettingsForm labels={labels} state={state} onSave={props.save} onDiscard={props.discard}>
      <div style={GRID_STYLE}>
        <SectionTitle title={t("settings.sectionCredentials")} />
        {secret("coreApiKey", "settings.coreApiKey", "settings.coreApiKeyHint")}
        {secret("doajApiKey", "settings.doajApiKey", "settings.doajApiKeyHint")}
        {secret("zenodoAccessToken", "settings.zenodoAccessToken", "settings.zenodoAccessTokenHint")}
        {secret("semanticScholarApiKey", "settings.semanticScholarApiKey", "settings.semanticScholarApiKeyHint")}
        {secret("ieeeApiKey", "settings.ieeeApiKey", "settings.ieeeApiKeyHint")}
        {secret("acmApiKey", "settings.acmApiKey", "settings.acmApiKeyHint")}
        <SectionTitle title={t("settings.sectionGeneral")} />
      <SettingsValueField
        id="plugin-config-papersearch-pdf-dir"
        label={t("settings.pdfDir")}
        hint={t("settings.pdfDirHint")}
        overriddenLabel={t("settings.overridden")}
        resetLabel={t("settings.reset")}
        invalidLabel={t("settings.invalidNumber")}
        disabled={disabled}
        {...state.pdfDir}
        onEdit={(text) => { props.edit("pdfDir", text); }}
        onReset={() => { props.resetField("pdfDir"); }}
      />
      <SettingsValueField
        id="plugin-config-papersearch-unpaywall-email"
        label={t("settings.unpaywallEmail")}
        hint={t("settings.unpaywallEmailHint")}
        overriddenLabel={t("settings.overridden")}
        resetLabel={t("settings.reset")}
        invalidLabel={t("settings.invalidNumber")}
        disabled={disabled}
        {...state.unpaywallEmail}
        onEdit={(text) => { props.edit("unpaywallEmail", text); }}
        onReset={() => { props.resetField("unpaywallEmail"); }}
      />
      <SettingsValueField
        id="plugin-config-papersearch-contact-email"
        label={t("settings.contactEmail")}
        hint={t("settings.contactEmailHint")}
        overriddenLabel={t("settings.overridden")}
        resetLabel={t("settings.reset")}
        invalidLabel={t("settings.invalidNumber")}
        disabled={disabled}
        {...state.contactEmail}
        onEdit={(text) => { props.edit("contactEmail", text); }}
        onReset={() => { props.resetField("contactEmail"); }}
      />
      <SettingsValueField
        id="plugin-config-papersearch-search-timeout"
        label={t("settings.searchTimeoutMs")}
        hint={t("settings.searchTimeoutMsHint")}
        overriddenLabel={t("settings.overridden")}
        resetLabel={t("settings.reset")}
        invalidLabel={t("settings.invalidNumber")}
        numeric
        disabled={disabled}
        {...state.searchTimeoutMs}
        onEdit={(text) => { props.edit("searchTimeoutMs", text); }}
        onReset={() => { props.resetField("searchTimeoutMs"); }}
      />
      <SettingsValueField
        id="plugin-config-papersearch-download-timeout"
        label={t("settings.downloadTimeoutMs")}
        hint={t("settings.downloadTimeoutMsHint")}
        overriddenLabel={t("settings.overridden")}
        resetLabel={t("settings.reset")}
        invalidLabel={t("settings.invalidNumber")}
        numeric
        disabled={disabled}
        {...state.downloadTimeoutMs}
        onEdit={(text) => { props.edit("downloadTimeoutMs", text); }}
        onReset={() => { props.resetField("downloadTimeoutMs"); }}
      />
      <SettingsValueField
        id="plugin-config-papersearch-scholar-proxy"
        label={t("settings.scholarProxyUrl")}
        hint={t("settings.scholarProxyUrlHint")}
        overriddenLabel={t("settings.overridden")}
        resetLabel={t("settings.reset")}
        invalidLabel={t("settings.invalidNumber")}
        disabled={disabled}
        {...state.scholarProxyUrl}
        onEdit={(text) => { props.edit("scholarProxyUrl", text); }}
        onReset={() => { props.resetField("scholarProxyUrl"); }}
      />
      <SettingsValueField
        id="plugin-config-papersearch-use-scihub"
        label={t("settings.useScihub")}
        hint={t("settings.useScihubHint")}
        overriddenLabel={t("settings.overridden")}
        resetLabel={t("settings.reset")}
        invalidLabel={t("settings.invalidBoolean")}
        disabled={disabled}
        {...state.useScihub}
        onEdit={(text) => { props.edit("useScihub", text); }}
        onReset={() => { props.resetField("useScihub"); }}
      />
      <SettingsValueField
        id="plugin-config-papersearch-scihub-base-url"
        label={t("settings.scihubBaseUrl")}
        hint={t("settings.scihubBaseUrlHint")}
        overriddenLabel={t("settings.overridden")}
        resetLabel={t("settings.reset")}
        invalidLabel={t("settings.invalidNumber")}
        disabled={disabled}
        {...state.scihubBaseUrl}
        onEdit={(text) => { props.edit("scihubBaseUrl", text); }}
        onReset={() => { props.resetField("scihubBaseUrl"); }}
      />
      </div>
    </SettingsForm>
  );
}
