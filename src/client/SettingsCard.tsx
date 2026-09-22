import { useState } from "react";
import type { PapersearchLocaleKey } from "./locales.ts";
import type {
  CredentialCardState,
  CredentialField,
  PapersearchCardState,
  PapersearchFieldName,
  PapersearchFieldState,
} from "./settings-form.ts";
import { ensureSettingsCardStyles } from "./settings-card-css.ts";

ensureSettingsCardStyles();

export type PapersearchSettingsCardProps = {
  t: (key: PapersearchLocaleKey) => string;
  usePapersearchSettings: (select: (state: PapersearchCardState) => PapersearchCardState) => PapersearchCardState;
  edit: (field: PapersearchFieldName, text: string) => void;
  resetField: (field: PapersearchFieldName) => void;
  editKey: (field: CredentialField, text: string) => void;
  clearKey: (field: CredentialField) => void;
  resetKeyStage: (field: CredentialField) => void;
  save: () => void;
  discard: () => void;
};

type CredentialSpec = {
  field: CredentialField;
  label: PapersearchLocaleKey;
  hint: PapersearchLocaleKey;
};

const CREDENTIALS: CredentialSpec[] = [
  { field: "coreApiKey", label: "settings.coreApiKey", hint: "settings.coreApiKeyHint" },
  { field: "doajApiKey", label: "settings.doajApiKey", hint: "settings.doajApiKeyHint" },
  { field: "zenodoAccessToken", label: "settings.zenodoAccessToken", hint: "settings.zenodoAccessTokenHint" },
  { field: "semanticScholarApiKey", label: "settings.semanticScholarApiKey", hint: "settings.semanticScholarApiKeyHint" },
  { field: "ieeeApiKey", label: "settings.ieeeApiKey", hint: "settings.ieeeApiKeyHint" },
  { field: "acmApiKey", label: "settings.acmApiKey", hint: "settings.acmApiKeyHint" },
];

const PLAIN_FIELDS: Array<{ field: PapersearchFieldName; label: PapersearchLocaleKey; hint: PapersearchLocaleKey }> = [
  { field: "unpaywallEmail", label: "settings.unpaywallEmail", hint: "settings.unpaywallEmailHint" },
  { field: "contactEmail", label: "settings.contactEmail", hint: "settings.contactEmailHint" },
  { field: "scholarProxyUrl", label: "settings.scholarProxyUrl", hint: "settings.scholarProxyUrlHint" },
  { field: "scihubBaseUrl", label: "settings.scihubBaseUrl", hint: "settings.scihubBaseUrlHint" },
  { field: "pdfDir", label: "settings.pdfDir", hint: "settings.pdfDirHint" },
];

const ADVANCED_ENV_FIELDS: Array<{ field: PapersearchFieldName; label: PapersearchLocaleKey; hint: PapersearchLocaleKey }> = [
  { field: "coreApiKeyEnv", label: "settings.coreApiKeyEnv", hint: "settings.coreApiKeyEnvHint" },
  { field: "doajApiKeyEnv", label: "settings.doajApiKeyEnv", hint: "settings.doajApiKeyEnvHint" },
  { field: "zenodoAccessTokenEnv", label: "settings.zenodoAccessTokenEnv", hint: "settings.zenodoAccessTokenEnvHint" },
  { field: "semanticScholarApiKeyEnv", label: "settings.semanticScholarApiKeyEnv", hint: "settings.semanticScholarApiKeyEnvHint" },
  { field: "ieeeApiKeyEnv", label: "settings.ieeeApiKeyEnv", hint: "settings.ieeeApiKeyEnvHint" },
  { field: "acmApiKeyEnv", label: "settings.acmApiKeyEnv", hint: "settings.acmApiKeyEnvHint" },
];

/**
 * One staged settings field in the host field rhythm: label + override badge
 * on one head line, 34px themed input, tertiary hint below. All colors ride
 * the --dsw-alias-* theme variables.
 */
function SettingsField(props: {
  id: string;
  label: string;
  hint: string;
  overriddenLabel: string;
  resetLabel: string;
  disabled: boolean;
  field: PapersearchFieldState;
  onChange: (text: string) => void;
  onReset: () => void;
}) {
  const { id, label, hint, overriddenLabel, resetLabel, disabled, field, onChange, onReset } = props;
  return (
    <div className="dshPsField">
      <div className="dshPsFieldHead">
        <label className="dshPsLabel" htmlFor={id}>{label}</label>
        {field.overridden && (
          <span className="dshPsBadges">
            <span className="dshPsBadge">{overriddenLabel}</span>
            <button type="button" className="dshPsReset" disabled={disabled} onClick={onReset}>
              {resetLabel}
            </button>
          </span>
        )}
      </div>
      <input
        id={id}
        className="dshPsInput"
        type="text"
        value={field.text}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint}
        autoComplete="off"
        spellCheck={false}
      />
      <p className="dshPsHint">{hint}</p>
    </div>
  );
}

/**
 * Write-only credential row (host SecretField rhythm): configured state as a
 * quiet badge on the SAME right axis as the undo link, clear demoted to a
 * text link that only exists when something stands to be cleared. The
 * write-semantics note lives once at section level, not under every key.
 */
function CredentialFieldRow(props: {
  id: string;
  label: string;
  placeholder: string;
  disabled: boolean;
  state: CredentialCardState;
  clearLabel: string;
  undoLabel: string;
  clearStagedLabel: string;
  configuredLabel: string;
  notConfiguredLabel: string;
  onEdit: (text: string) => void;
  onClear: () => void;
  onResetStage: () => void;
}) {
  const {
    id, label, placeholder, disabled, state,
    clearLabel, undoLabel, clearStagedLabel, configuredLabel, notConfiguredLabel,
    onEdit, onClear, onResetStage,
  } = props;
  const stagedClear = state.stagedClear;
  const staged = stagedClear || state.stagedText.trim() !== "";
  return (
    <div className="dshPsField">
      <div className="dshPsFieldHead">
        <label className="dshPsLabel" htmlFor={id}>{label}</label>
        <span className="dshPsBadges">
          {stagedClear && <span className="dshPsBadgeWarn">{clearStagedLabel}</span>}
          <span
            className={state.configured && !stagedClear ? "dshPsBadge" : "dshPsBadgeQuiet"}
            title={state.ref ? `ref: ${state.ref}` : undefined}
          >
            {state.configured && !stagedClear ? configuredLabel : notConfiguredLabel}
          </span>
          {staged && (
            <button type="button" className="dshPsReset" onClick={onResetStage} title={undoLabel}>
              ↩
            </button>
          )}
        </span>
      </div>
      <input
        id={id}
        className="dshPsInput"
        type="password"
        value={state.stagedText}
        disabled={disabled || !state.writable || stagedClear}
        onChange={(e) => onEdit(e.target.value)}
        placeholder={stagedClear ? "" : placeholder}
        autoComplete="new-password"
        spellCheck={false}
      />
      <p className="dshPsHint">
        {(state.configured || staged) && !stagedClear && (
          <button
            type="button"
            className="dshPsLinkBtn"
            disabled={disabled || !state.writable}
            onClick={onClear}
          >
            {clearLabel}
          </button>
        )}
        {stagedClear ? placeholder : ""}
      </p>
    </div>
  );
}

function Section(props: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="dshPsSection">
      <h4 className="dshPsSectionTitle">{props.title}</h4>
      {props.note && <p className="dshPsSectionNote">{props.note}</p>}
      {props.children}
    </section>
  );
}

export function PapersearchSettingsCard(props: PapersearchSettingsCardProps) {
  const { t } = props;
  const state = props.usePapersearchSettings((snapshot) => snapshot);
  const [open, setOpen] = useState(false);

  // 可用性守卫（对抗审查：同批 okf/prism 保留、csw/papersearch 误删——命名
  // 空间未挂载的宿主上会常驻渲染一张空白卡；恢复四卡一致语义）。
  if (!state.available) return null;

  const blocked = !state.dirty || state.saving;
  return (
    <li className={open ? "dshPsCard dshPsCardOpen" : "dshPsCard"}>
      <button
        type="button"
        className="dshPsHeader"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="dshPsHeadText">
          <span className="dshPsName">{t("settings.title")}</span>
          <span className="dshPsDescription">{t("settings.description")}</span>
        </span>
        {state.dirty && <span className="dshPsPending">{t("settings.unsaved")}</span>}
        <span className={open ? "dshPsChevron dshPsChevronOpen" : "dshPsChevron"} />
      </button>
      {open && (
        <div className="dshPsBody">
          {!state.writable && (
            <div className="dshPsSection">
              <p className="dshPsSectionNote">{t("settings.readOnly")}</p>
            </div>
          )}
          {/* 行内失败提示只在无 footer（只读卡）时出现——对抗审查：writable 时
              与 footer 横幅同时渲染，同一条消息叠两份。 */}
          {state.failed && !state.writable && <p className="dshPsFailedInline">{t("settings.saveFailed")}</p>}

          <Section title={t("settings.sectionCredentials")}>
            {CREDENTIALS.map((item) => (
              <CredentialFieldRow
                key={item.field}
                id={`ps-${item.field}`}
                label={t(item.label)}
                placeholder={t(item.hint)}
                disabled={!state.writable}
                state={state.credentials[item.field]}
                clearLabel={t("settings.keyClear")}
                undoLabel={t("settings.keyUndo")}
                clearStagedLabel={t("settings.keyClearStaged")}
                configuredLabel={t("settings.keyConfigured")}
                notConfiguredLabel={t("settings.keyNotConfigured")}
                onEdit={(text) => props.editKey(item.field, text)}
                onClear={() => props.clearKey(item.field)}
                onResetStage={() => props.resetKeyStage(item.field)}
              />
            ))}
            <p className="dshPsSectionNote">{t("settings.keyWriteHint")}</p>
          </Section>

          <Section title={t("settings.sectionGeneral")}>
            {PLAIN_FIELDS.map((item) => (
              <SettingsField
                key={item.field}
                id={`ps-${item.field}`}
                label={t(item.label)}
                hint={t(item.hint)}
                overriddenLabel={t("settings.overridden")}
                resetLabel={t("settings.reset")}
                disabled={!state.writable}
                field={state[item.field]}
                onChange={(text) => props.edit(item.field, text)}
                onReset={() => props.resetField(item.field)}
              />
            ))}
          </Section>

          <details className="dshPsAdvanced">
            <summary className="dshPsAdvancedSummary">{t("settings.advancedEnvTitle")}</summary>
            <p className="dshPsSectionNote">{t("settings.advancedEnvHint")}</p>
            {ADVANCED_ENV_FIELDS.map((item) => (
              <SettingsField
                key={item.field}
                id={`ps-${item.field}`}
                label={t(item.label)}
                hint={t(item.hint)}
                overriddenLabel={t("settings.overridden")}
                resetLabel={t("settings.reset")}
                disabled={!state.writable}
                field={state[item.field]}
                onChange={(text) => props.edit(item.field, text)}
                onReset={() => props.resetField(item.field)}
              />
            ))}
          </details>

          {state.writable && (
            <div className="dshPsFooter">
              {state.failed && <span className="dshPsFailed">{t("settings.saveFailed")}</span>}
              <button type="button" className="dshPsDiscard" disabled={!state.dirty} onClick={props.discard}>
                {t("settings.discard")}
              </button>
              <button type="button" className="dshPsSave" disabled={blocked} onClick={props.save}>
                {state.saving ? "…" : t("settings.save")}
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
