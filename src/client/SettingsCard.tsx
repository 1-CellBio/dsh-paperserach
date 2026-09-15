import { useState } from "react";
import type { PapersearchLocaleKey } from "./locales.ts";
import type {
  CredentialCardState,
  CredentialField,
  PapersearchCardState,
  PapersearchFieldName,
  PapersearchFieldState,
} from "./settings-form.ts";

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

/** One section row; `credential` renders the write-only key control that
 *  belongs under a `*Env` reference row. */
type RowSpec = {
  field: PapersearchFieldName;
  label: PapersearchLocaleKey;
  hint: PapersearchLocaleKey;
  credential?: {
    field: CredentialField;
    label: PapersearchLocaleKey;
    hint: PapersearchLocaleKey;
  };
};

const ROWS: RowSpec[] = [
  {
    field: "coreApiKeyEnv", label: "settings.coreApiKeyEnv", hint: "settings.coreApiKeyEnvHint",
    credential: { field: "coreApiKey", label: "settings.coreApiKey", hint: "settings.coreApiKeyHint" },
  },
  {
    field: "doajApiKeyEnv", label: "settings.doajApiKeyEnv", hint: "settings.doajApiKeyEnvHint",
    credential: { field: "doajApiKey", label: "settings.doajApiKey", hint: "settings.doajApiKeyHint" },
  },
  {
    field: "zenodoAccessTokenEnv", label: "settings.zenodoAccessTokenEnv", hint: "settings.zenodoAccessTokenEnvHint",
    credential: { field: "zenodoAccessToken", label: "settings.zenodoAccessToken", hint: "settings.zenodoAccessTokenHint" },
  },
  {
    field: "semanticScholarApiKeyEnv", label: "settings.semanticScholarApiKeyEnv", hint: "settings.semanticScholarApiKeyEnvHint",
    credential: { field: "semanticScholarApiKey", label: "settings.semanticScholarApiKey", hint: "settings.semanticScholarApiKeyHint" },
  },
  { field: "unpaywallEmail", label: "settings.unpaywallEmail", hint: "settings.unpaywallEmailHint" },
  { field: "contactEmail", label: "settings.contactEmail", hint: "settings.contactEmailHint" },
  {
    field: "ieeeApiKeyEnv", label: "settings.ieeeApiKeyEnv", hint: "settings.ieeeApiKeyEnvHint",
    credential: { field: "ieeeApiKey", label: "settings.ieeeApiKey", hint: "settings.ieeeApiKeyHint" },
  },
  {
    field: "acmApiKeyEnv", label: "settings.acmApiKeyEnv", hint: "settings.acmApiKeyEnvHint",
    credential: { field: "acmApiKey", label: "settings.acmApiKey", hint: "settings.acmApiKeyHint" },
  },
  { field: "scholarProxyUrl", label: "settings.scholarProxyUrl", hint: "settings.scholarProxyUrlHint" },
  { field: "scihubBaseUrl", label: "settings.scihubBaseUrl", hint: "settings.scihubBaseUrlHint" },
  { field: "pdfDir", label: "settings.pdfDir", hint: "settings.pdfDirHint" },
];

function SettingsField(props: {
  id: string;
  label: string;
  hint: string;
  disabled: boolean;
  field: PapersearchFieldState;
  onChange: (text: string) => void;
}) {
  const { id, label, hint, disabled, field, onChange } = props;
  return (
    <div style={{ marginBottom: "12px" }}>
      <label htmlFor={id} style={{ display: "block", fontWeight: 500, marginBottom: "4px" }}>
        {label}
        {field.overridden && <span style={{ fontSize: "0.8em", marginLeft: "8px", color: "#888" }}>(overridden)</span>}
      </label>
      <input
        id={id}
        type="text"
        value={field.text}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint}
        autoComplete="off"
        spellCheck={false}
        style={{
          width: "100%", padding: "6px 8px", borderRadius: "4px",
          border: "1px solid var(--border, #ccc)",
          background: "var(--input-bg, #fff)",
          color: "var(--foreground, #111)",
          fontSize: "13px", boxSizing: "border-box",
        }}
      />
      <span style={{ fontSize: "0.8em", color: "#888" }}>{hint}</span>
    </div>
  );
}

/** Write-only credential control: the value never rides a response, so the
 *  row shows Host-reported configured/writable facts and stages a write or a
 *  removal through the credentials domain on save. */
function CredentialFieldRow(props: {
  id: string;
  label: string;
  hint: string;
  disabled: boolean;
  state: CredentialCardState;
  writeHint: string;
  clearLabel: string;
  clearStagedLabel: string;
  configuredLabel: string;
  notConfiguredLabel: string;
  onEdit: (text: string) => void;
  onClear: () => void;
  onResetStage: () => void;
}) {
  const {
    id, label, hint, disabled, state, writeHint,
    clearLabel, clearStagedLabel, configuredLabel, notConfiguredLabel,
    onEdit, onClear, onResetStage,
  } = props;
  const staged = state.stagedClear || state.stagedText.trim() !== "";
  return (
    <div style={{ marginBottom: "12px", marginLeft: "12px", borderLeft: "2px solid var(--border, #eee)", paddingLeft: "10px" }}>
      <label htmlFor={id} style={{ display: "block", fontWeight: 500, marginBottom: "4px" }}>
        {label}
        <span
          style={{
            fontSize: "0.75em", marginLeft: "8px", padding: "1px 6px", borderRadius: "8px",
            color: state.configured ? "#2a7" : "#999",
            border: `1px solid ${state.configured ? "#2a7" : "#ccc"}`,
          }}
          title={state.ref}
        >
          {state.configured ? configuredLabel : notConfiguredLabel}
        </span>
        {state.stagedClear && <span style={{ fontSize: "0.8em", marginLeft: "8px", color: "#e77" }}>{clearStagedLabel}</span>}
      </label>
      <div style={{ display: "flex", gap: "8px" }}>
        <input
          id={id}
          type="password"
          value={state.stagedText}
          disabled={disabled || !state.writable || state.stagedClear}
          onChange={(e) => onEdit(e.target.value)}
          placeholder={hint}
          autoComplete="new-password"
          spellCheck={false}
          style={{
            flex: 1, padding: "6px 8px", borderRadius: "4px",
            border: "1px solid var(--border, #ccc)",
            background: "var(--input-bg, #fff)",
            color: "var(--foreground, #111)",
            fontSize: "13px", boxSizing: "border-box",
          }}
        />
        <button
          type="button"
          disabled={disabled || !state.writable || !state.configured}
          onClick={onClear}
          style={{
            padding: "6px 10px", borderRadius: "4px", border: "1px solid #ccc",
            background: "transparent", cursor: "pointer", fontSize: "12px",
            color: "#e77",
          }}
        >
          {clearLabel}
        </button>
      </div>
      {staged && (
        <button
          type="button"
          onClick={onResetStage}
          style={{
            marginTop: "4px", padding: "2px 8px", borderRadius: "4px", border: "none",
            background: "transparent", cursor: "pointer", fontSize: "0.8em", color: "#888",
            textDecoration: "underline",
          }}
        >
          ↩
        </button>
      )}
      <span style={{ display: "block", fontSize: "0.8em", color: "#888" }}>{writeHint}</span>
    </div>
  );
}

export function PapersearchSettingsCard(props: PapersearchSettingsCardProps) {
  const { t } = props;
  const state = props.usePapersearchSettings((s) => s);
  const [open, setOpen] = useState(false);
  if (!state.available) return null;

  const blocked = !state.dirty || state.saving;
  return (
    <li style={{ listStyle: "none", border: "1px solid var(--border, #ddd)", borderRadius: "8px", marginBottom: "8px" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center",
          padding: "12px 16px", border: "none", background: "transparent", cursor: "pointer",
          fontSize: "14px", textAlign: "left",
        }}
      >
        <span>
          <strong>{t("settings.title")}</strong>
          <br />
          <span style={{ fontSize: "0.85em", color: "#888" }}>{t("settings.description")}</span>
        </span>
        {state.dirty && <span style={{ fontSize: "0.8em", color: "#e77" }}>{t("settings.unsaved")}</span>}
        <span style={{ transform: open ? "rotate(180deg)" : "none", transition: "0.2s" }}>▼</span>
      </button>
      {open && (
        <div style={{ padding: "0 16px 16px" }}>
          {!state.writable && <p style={{ color: "#888", fontSize: "0.85em" }}>{t("settings.readOnly")}</p>}
          {state.failed && <p style={{ color: "#e77", fontSize: "0.85em" }}>{t("settings.saveFailed")}</p>}
          {ROWS.map((item) => (
            <div key={item.field}>
              <SettingsField
                id={`papersearch-${item.field}`}
                label={t(item.label)}
                hint={t(item.hint)}
                disabled={!state.writable}
                field={state[item.field]}
                onChange={(text) => props.edit(item.field, text)}
              />
              {item.credential && (
                <CredentialFieldRow
                  id={`papersearch-${item.credential.field}`}
                  label={t(item.credential.label)}
                  hint={t(item.credential.hint)}
                  disabled={!state.writable}
                  state={state.credentials[item.credential.field]}
                  writeHint={t("settings.keyWriteHint")}
                  clearLabel={t("settings.keyClear")}
                  clearStagedLabel={t("settings.keyClearStaged")}
                  configuredLabel={t("settings.keyConfigured")}
                  notConfiguredLabel={t("settings.keyNotConfigured")}
                  onEdit={(text) => props.editKey(item.credential!.field, text)}
                  onClear={() => props.clearKey(item.credential!.field)}
                  onResetStage={() => props.resetKeyStage(item.credential!.field)}
                />
              )}
            </div>
          ))}
          {state.writable && (
            <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
              <button type="button" disabled={blocked} onClick={props.save}
                style={{ padding: "6px 16px", borderRadius: "4px", border: "none", background: blocked ? "#ccc" : "#4CAF50", color: "#fff", cursor: blocked ? "default" : "pointer" }}>
                {state.saving ? "..." : "Save"}
              </button>
              <button type="button" disabled={!state.dirty} onClick={props.discard}
                style={{ padding: "6px 16px", borderRadius: "4px", border: "1px solid #ccc", background: "transparent", cursor: state.dirty ? "pointer" : "default" }}>
                Discard
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
