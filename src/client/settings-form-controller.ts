/**
 * The papersearch bundle page's staged settings form, 0.1.7 style: the value
 * fields write the profile entry's volatile config through the shared
 * ConfigForms scope (namespace = the patch entry id, `papersearch`), while the
 * source API keys are write-only and go through the credentials domain at the
 * reference each `*Env` field names — a key literal never rides a response.
 *
 * The `*Env` reference fields themselves are static deployment-time config in
 * 0.1.7 (no longer volatile), so the form reads them but edits only the
 * volatile section fields plus the secrets.
 */

import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions,
  type SettingsFormScope, type SettingsFormShell,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { SnapshotStore } from "@deepseek-ai/dsh-client-store";
// Type-only: pulls the ctx.remote merge (credentials domain) into this program.
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type { ClientRemote } from "@deepseek-ai/dsh-api-remotes/client";

/** Profile entry id of the papersearch plugin; the settings namespace the Host serves. */
export const PAPERSEARCH_NS = "papersearch";

/** The `ctx.remote.credentials` face: describe/set; values never ride it back. */
export type CredentialsFace = ClientRemote["credentials"];

/** The section fields this form reads (volatile values plus the static `*Env` references). */
export interface PapersearchSection {
  pdfDir?: string;
  searchTimeoutMs?: number;
  downloadTimeoutMs?: number;
  unpaywallEmail?: string;
  contactEmail?: string;
  scholarProxyUrl?: string;
  useScihub?: boolean;
  scihubBaseUrl?: string;
  allowTitleMatch?: boolean;
  coreApiKeyEnv?: string;
  doajApiKeyEnv?: string;
  zenodoAccessTokenEnv?: string;
  semanticScholarApiKeyEnv?: string;
  ieeeApiKeyEnv?: string;
  acmApiKeyEnv?: string;
}

/** Write-only credential controls, addressed by the section's `*Env` references. */
export type CredentialField =
  | "coreApiKey"
  | "doajApiKey"
  | "zenodoAccessToken"
  | "semanticScholarApiKey"
  | "ieeeApiKey"
  | "acmApiKey";

/** What one credential row renders on top of its staged text. */
export interface CredentialView extends SettingsFieldState {
  /** Whether the Host reports a credential configured for the referenced key. */
  configured: boolean;
  /** Whether the credentials domain accepts a write for it; false disables the control. */
  writable: boolean;
}

/** What the papersearch settings page renders. */
export interface PapersearchCardState extends SettingsFormShell {
  pdfDir: SettingsFieldState;
  searchTimeoutMs: SettingsFieldState;
  downloadTimeoutMs: SettingsFieldState;
  unpaywallEmail: SettingsFieldState;
  contactEmail: SettingsFieldState;
  scholarProxyUrl: SettingsFieldState;
  useScihub: SettingsFieldState;
  scihubBaseUrl: SettingsFieldState;
  allowTitleMatch: SettingsFieldState;
  credentials: Record<CredentialField, CredentialView>;
}

/** The registration-side face the page's slot entry injects. */
export interface PapersearchCardFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as usePapersearchSettings. */
    papersearchSettings: SnapshotStore<PapersearchCardState>;
  };
}

const CREDENTIAL_FIELDS: readonly CredentialField[] = [
  "coreApiKey",
  "doajApiKey",
  "zenodoAccessToken",
  "semanticScholarApiKey",
  "ieeeApiKey",
  "acmApiKey",
];

/** Section field naming each credential's reference. */
const REF_FIELD: Record<CredentialField, keyof PapersearchSection> = {
  coreApiKey: "coreApiKeyEnv",
  doajApiKey: "doajApiKeyEnv",
  zenodoAccessToken: "zenodoAccessTokenEnv",
  semanticScholarApiKey: "semanticScholarApiKeyEnv",
  ieeeApiKey: "ieeeApiKeyEnv",
  acmApiKey: "acmApiKeyEnv",
};

/** Reference used when the section names none; mirrors the Host schema defaults. */
const DEFAULT_REF: Record<CredentialField, string> = {
  coreApiKey: "CORE_API_KEY",
  doajApiKey: "DOAJ_API_KEY",
  zenodoAccessToken: "ZENODO_ACCESS_TOKEN",
  semanticScholarApiKey: "SEMANTIC_SCHOLAR_API_KEY",
  ieeeApiKey: "IEEE_API_KEY",
  acmApiKey: "ACM_API_KEY",
};

/** What the credentials domain last reported, and for which reference. */
interface CredentialState {
  /** Reference this answer describes; a stale response for another one is dropped. */
  ref: string;
  configured: boolean;
  writable: boolean;
}

/**
 * A true/false text field. An empty draft clears the field; anything that is
 * not literally true/false blocks the save (the control hints the keypad only,
 * never silently rewrites what the user typed).
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
function settingsBooleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === "boolean" ? (value ? "true" : "false") : "",
    parse: (text) => {
      const trimmed = text.trim().toLowerCase();
      if (trimmed === "") return { kind: "clear" };
      if (trimmed === "true") return { kind: "set", value: true };
      if (trimmed === "false") return { kind: "set", value: false };
      return undefined;
    },
  };
}

/** The reference a credential row addresses, from the saved section. */
function refOf(field: CredentialField, value: PapersearchSection | undefined): string {
  const declared = value?.[REF_FIELD[field]];
  return typeof declared === "string" && declared.trim() ? declared.trim() : DEFAULT_REF[field];
}

/** Build a fully-keyed credential record without Object.fromEntries' widening. */
function credentialViews(
  fields: readonly CredentialField[],
  view: (field: CredentialField) => CredentialView,
): Record<CredentialField, CredentialView> {
  const out = {} as Record<CredentialField, CredentialView>;
  for (const field of fields) out[field] = view(field);
  return out;
}

/** Every credential starts unanswered, addressed at no reference yet. */
function initialCredentials(): Record<CredentialField, CredentialState> {
  const out = {} as Record<CredentialField, CredentialState>;
  for (const field of CREDENTIAL_FIELDS) out[field] = { ref: "", configured: false, writable: true };
  return out;
}

/** Bridges the `papersearch` scope and the credentials domain onto the bundle page. */
export class PapersearchSettingsController {
  private readonly form: SettingsFormModel<PapersearchSection>;
  private readonly store: SnapshotStore<PapersearchCardState>;
  private readonly unsubscribe: () => void;
  // Field initializer, not a constructor-body assignment: the form's bind()
  // projects immediately during construction, and the projection reads this
  // record — assigning it after bind() crashed the web boot (FiberState.FAILED).
  private credential: Record<CredentialField, CredentialState> = initialCredentials();

  /**
   * @param scope - the bound settings scope for the `papersearch` namespace.
   * @param credentials - the `ctx.remote.credentials` face answering for the
   * references the section names.
   */
  constructor(
    private readonly scope: SettingsFormScope<PapersearchSection>,
    private readonly credentials: CredentialsFace,
  ) {
    this.form = new SettingsFormModel(
      scope,
      [
        settingsTextField("pdfDir"),
        settingsNumberField("searchTimeoutMs"),
        settingsNumberField("downloadTimeoutMs"),
        settingsTextField("unpaywallEmail"),
        settingsTextField("contactEmail"),
        settingsTextField("scholarProxyUrl"),
        settingsBooleanField("useScihub"),
        settingsTextField("scihubBaseUrl"),
        settingsBooleanField("allowTitleMatch"),
      ],
      CREDENTIAL_FIELDS.map(field => ({ field, write: text => this.writeKey(field, text) })),
    );
    this.store = this.form.bind(() => this.projection());
    this.unsubscribe = scope.subscribe(() => { void this.readCredentials(); });
    void this.readCredentials();
  }

  private projection(): PapersearchCardState {
    return {
      ...this.form.shell(),
      pdfDir: this.form.field("pdfDir"),
      searchTimeoutMs: this.form.field("searchTimeoutMs"),
      downloadTimeoutMs: this.form.field("downloadTimeoutMs"),
      unpaywallEmail: this.form.field("unpaywallEmail"),
      contactEmail: this.form.field("contactEmail"),
      scholarProxyUrl: this.form.field("scholarProxyUrl"),
      useScihub: this.form.field("useScihub"),
      scihubBaseUrl: this.form.field("scihubBaseUrl"),
      allowTitleMatch: this.form.field("allowTitleMatch"),
      credentials: credentialViews(CREDENTIAL_FIELDS, field => ({ ...this.form.field(field), ...this.credential[field] })),
    };
  }

  /**
   * Ask the credentials domain about every reference the section names, in one
   * call. Answers are stored with the reference they describe: an `*Env` value
   * can change between request and response, so a response is published only
   * while it still answers for the reference in force.
   */
  private async readCredentials(): Promise<void> {
    const value = this.scope.getSnapshot().value;
    const refs = new Map(CREDENTIAL_FIELDS.map(field => [field, refOf(field, value)]));
    let stale = false;
    for (const field of CREDENTIAL_FIELDS) {
      const ref = refs.get(field)!;
      if (ref !== this.credential[field].ref) {
        // A new reference knows nothing yet; keeping the old answer would claim
        // the key is configured under a name nobody has checked.
        this.credential[field] = { ref, configured: false, writable: true };
        stale = true;
      }
    }
    if (stale) this.store.set(this.projection());
    const response = await this.credentials.describe([...refs.values()]);
    if (!response.ok) return;
    let changed = false;
    for (const field of CREDENTIAL_FIELDS) {
      const ref = refs.get(field)!;
      if (ref !== refOf(field, this.scope.getSnapshot().value)) continue;
      const view = response.value?.[ref];
      const next: CredentialState = {
        ref,
        configured: view?.configured ?? false,
        // An unknown reference is treated as writable: the control stays usable
        // and the Host is what refuses, rather than the page guessing a refusal.
        writable: view?.writable ?? true,
      };
      const current = this.credential[field];
      if (next.configured === current.configured && next.writable === current.writable) continue;
      this.credential[field] = next;
      changed = true;
    }
    if (changed) this.store.set(this.projection());
  }

  /**
   * Re-read after the Host reports a change to one of the references this page
   * watches (a key can be written from another surface).
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    if (!CREDENTIAL_FIELDS.some(field => this.credential[field].ref === ref)) return;
    void this.readCredentials();
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the page's snapshot and its form actions.
   */
  inject(): PapersearchCardFace {
    return { hooks: { papersearchSettings: this.store }, ...this.form.actions() };
  }

  /**
   * Write the staged key, then re-read whether the Host now holds one.
   * @param field - the credential being written.
   * @param text - the staged credential literal.
   * @returns whether the Host reports a configured credential afterwards.
   */
  private async writeKey(field: CredentialField, text: string): Promise<boolean> {
    // Refusals surface through the re-read below: the Host is the only
    // authority on whether the key now exists.
    await this.credentials.set(refOf(field, this.scope.getSnapshot().value), text);
    await this.readCredentials();
    return this.credential[field].configured;
  }

  /** Release configuration subscriptions. */
  dispose(): void {
    this.unsubscribe();
    this.form.dispose();
  }
}
