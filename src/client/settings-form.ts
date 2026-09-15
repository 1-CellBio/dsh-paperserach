// Type-only: pulls the ctx.remote merge (ClientRemote, with the credentials
// namespace) into this program without a runtime edge.
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type { ClientRemote } from "@deepseek-ai/dsh-api-remotes/client";

/** The `ctx.remote.credentials` face: describe/set/unset, values never ride it back. */
export type CredentialsRemoteFace = ClientRemote["credentials"];

export type PapersearchScopeSnapshot = {
  status: "loading" | "ready" | "unavailable";
  writable: boolean;
  value?: Record<string, unknown>;
  base?: Record<string, unknown>;
  user?: Record<string, unknown>;
};

export type PapersearchSettingsScope = {
  getSnapshot: () => PapersearchScopeSnapshot;
  subscribe: (listener: () => void) => () => void;
  set: (field: string, value: unknown) => Promise<void>;
  unset: (field: string) => Promise<void>;
};

/** Section fields: credential references (env-var names) plus plain settings. */
export type PapersearchFieldName =
  | "coreApiKeyEnv"
  | "doajApiKeyEnv"
  | "zenodoAccessTokenEnv"
  | "semanticScholarApiKeyEnv"
  | "unpaywallEmail"
  | "contactEmail"
  | "ieeeApiKeyEnv"
  | "acmApiKeyEnv"
  | "scholarProxyUrl"
  | "scihubBaseUrl"
  | "pdfDir";

/** Secrets written through the credentials domain, never the section. */
export type CredentialField =
  | "coreApiKey"
  | "doajApiKey"
  | "zenodoAccessToken"
  | "semanticScholarApiKey"
  | "ieeeApiKey"
  | "acmApiKey";

export type PapersearchFieldState = {
  text: string;
  overridden: boolean;
};

/** What one credential row renders: Host-reported facts plus its own staging. */
export type CredentialCardState = {
  /** Reference this answer describes (the section's `*Env` value or its default). */
  ref: string;
  /** Whether the Host holds a value for the reference. */
  configured: boolean;
  /** Whether the credentials domain accepts a write; false disables the control. */
  writable: boolean;
  /** Staged write-only input; blank means no change. */
  stagedText: string;
  /** Staged removal of the stored credential. */
  stagedClear: boolean;
};

export type PapersearchCardState = {
  available: boolean;
  writable: boolean;
  dirty: boolean;
  saving: boolean;
  failed: boolean;
} & Record<PapersearchFieldName, PapersearchFieldState> & {
  credentials: Record<CredentialField, CredentialCardState>;
};

type Staged = { text: string; clear: boolean };

const FIELDS: readonly PapersearchFieldName[] = [
  "coreApiKeyEnv",
  "doajApiKeyEnv",
  "zenodoAccessTokenEnv",
  "semanticScholarApiKeyEnv",
  "unpaywallEmail",
  "contactEmail",
  "ieeeApiKeyEnv",
  "acmApiKeyEnv",
  "scholarProxyUrl",
  "scihubBaseUrl",
  "pdfDir",
];

const CREDENTIAL_FIELDS: readonly CredentialField[] = [
  "coreApiKey",
  "doajApiKey",
  "zenodoAccessToken",
  "semanticScholarApiKey",
  "ieeeApiKey",
  "acmApiKey",
];

/** Section field naming each credential's reference. */
const REF_FIELD: Record<CredentialField, PapersearchFieldName> = {
  coreApiKey: "coreApiKeyEnv",
  doajApiKey: "doajApiKeyEnv",
  zenodoAccessToken: "zenodoAccessTokenEnv",
  semanticScholarApiKey: "semanticScholarApiKeyEnv",
  ieeeApiKey: "ieeeApiKeyEnv",
  acmApiKey: "acmApiKeyEnv",
};

/** Reference used when the section names none; mirrors the Host defaults. */
const DEFAULT_REF: Record<CredentialField, string> = {
  coreApiKey: "CORE_API_KEY",
  doajApiKey: "DOAJ_API_KEY",
  zenodoAccessToken: "ZENODO_ACCESS_TOKEN",
  semanticScholarApiKey: "SEMANTIC_SCHOLAR_API_KEY",
  ieeeApiKey: "IEEE_API_KEY",
  acmApiKey: "ACM_API_KEY",
};

/** The reference a credential row addresses, from the saved section.
 * @param field - the credential whose reference to read.
 * @param snapshot - the current scope snapshot.
 * @returns the section's reference name or the field's default. */
function refOf(field: CredentialField, snapshot: PapersearchScopeSnapshot): string {
  const declared = snapshot.value?.[REF_FIELD[field]];
  return typeof declared === "string" && declared.trim() ? declared.trim() : DEFAULT_REF[field]!;
}

export class PapersearchSettingsForm {
  private readonly staged = new Map<PapersearchFieldName, Staged>();
  private readonly stagedCredentials = new Map<CredentialField, Staged>();
  private readonly listeners = new Set<() => void>();
  private saving = false;
  private failed = false;
  private credentialState: Record<CredentialField, CredentialCardState>;

  /**
   * @param scope - the bound settings scope for the papersearch namespace.
   * @param credentials - the `ctx.remote.credentials` face answering for the
   * references the section names.
   */
  constructor(
    private readonly scope: PapersearchSettingsScope,
    private readonly credentials: CredentialsRemoteFace,
  ) {
    this.credentialState = Object.fromEntries(CREDENTIAL_FIELDS.map((field) => [
      field,
      { ref: "", configured: false, writable: true, stagedText: "", stagedClear: false },
    ])) as Record<CredentialField, CredentialCardState>;
    scope.subscribe(() => { void this.readCredentials(); });
    void this.readCredentials();
  }

  snapshot(): PapersearchCardState {
    const snapshot = this.scope.getSnapshot();
    // The per-field record is filled by the loops below, so the literal only
    // provides the flag half of the intersection — assert, then populate.
    const state = {
      available: snapshot.status === "ready",
      writable: snapshot.writable,
      dirty: this.dirty(),
      saving: this.saving,
      failed: this.failed,
      credentials: Object.fromEntries(CREDENTIAL_FIELDS.map((field) => {
        const staged = this.stagedCredentials.get(field);
        return [field, {
          ...this.credentialState[field]!,
          stagedText: staged !== undefined && !staged.clear ? staged.text : "",
          stagedClear: staged?.clear ?? false,
        }];
      })),
    } as PapersearchCardState;
    for (const field of FIELDS) {
      state[field] = this.field(field);
    }
    return state;
  }

  bindStore(): {
    getSnapshot: () => PapersearchCardState;
    subscribe: (listener: () => void) => () => void;
  } {
    let current = this.snapshot();
    const outer = new Set<() => void>();
    this.listeners.add(() => {
      current = this.snapshot();
      for (const listener of outer) listener();
    });
    return {
      getSnapshot: () => current,
      subscribe: (listener) => {
        outer.add(listener);
        return () => { outer.delete(listener); };
      },
    };
  }

  actions(): {
    edit: (field: PapersearchFieldName, text: string) => void;
    resetField: (field: PapersearchFieldName) => void;
    editKey: (field: CredentialField, text: string) => void;
    clearKey: (field: CredentialField) => void;
    resetKeyStage: (field: CredentialField) => void;
    save: () => void;
    discard: () => void;
  } {
    return {
      edit: (field, text) => {
        this.staged.set(field, { text, clear: false });
        this.failed = false;
        this.publish();
      },
      resetField: (field) => {
        this.staged.set(field, { text: this.baseText(field), clear: true });
        this.failed = false;
        this.publish();
      },
      editKey: (field, text) => {
        this.stagedCredentials.set(field, { text, clear: false });
        this.failed = false;
        this.publish();
      },
      clearKey: (field) => {
        this.stagedCredentials.set(field, { text: "", clear: true });
        this.failed = false;
        this.publish();
      },
      resetKeyStage: (field) => {
        this.stagedCredentials.delete(field);
        this.failed = false;
        this.publish();
      },
      save: () => { void this.save(); },
      discard: () => {
        if (!this.dirty() && !this.failed) return;
        this.staged.clear();
        this.stagedCredentials.clear();
        this.failed = false;
        this.publish();
      },
    };
  }

  async save(): Promise<void> {
    if (this.saving || !this.dirty()) return;
    this.saving = true;
    this.failed = false;
    this.publish();
    let landed = true;
    try {
      for (const field of FIELDS) {
        const staged = this.staged.get(field);
        if (!staged) continue;
        const ok = staged.clear || staged.text.trim() === ""
          ? await this.clear(field)
          : await this.store(field, staged.text.trim());
        landed = ok && landed;
      }
      // Credential writes address the references the JUST-SAVED section names,
      // so a staged reference rename and a staged key write land consistently.
      const snapshot = this.scope.getSnapshot();
      for (const field of CREDENTIAL_FIELDS) {
        const staged = this.stagedCredentials.get(field);
        if (!staged) continue;
        const ref = refOf(field, snapshot);
        const response = staged.clear
          ? await this.credentials.unset(ref)
          : await this.credentials.set(ref, staged.text.trim());
        landed = response.ok && landed;
      }
    } catch {
      landed = false;
    }
    await this.readCredentials();
    if (landed) {
      this.staged.clear();
      this.stagedCredentials.clear();
    }
    this.saving = false;
    this.failed = !landed;
    this.publish();
  }

  /**
   * Re-read after the Host reports a credential written elsewhere (another
   * settings surface addresses the same references).
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    for (const field of CREDENTIAL_FIELDS) {
      if (refOf(field, this.scope.getSnapshot()) === ref) {
        void this.readCredentials();
        return;
      }
    }
  }

  /**
   * Describe every reference the saved section names, in one batch. A response
   * is dropped unless it still answers for the section in force when it lands.
   */
  private async readCredentials(): Promise<void> {
    const requested = this.scope.getSnapshot();
    const refs = CREDENTIAL_FIELDS.map((field) => refOf(field, requested));
    const response = await this.credentials.describe(refs);
    if (!response.ok) return;
    const current = this.scope.getSnapshot();
    for (const field of CREDENTIAL_FIELDS) {
      const ref = refOf(field, current);
      if (!refs.includes(ref)) continue; // the section renamed the reference mid-flight
      const view = response.value[ref];
      this.credentialState[field] = {
        ...this.credentialState[field]!,
        ref,
        configured: view?.configured ?? false,
        // An unknown reference reads as writable: the control stays usable and
        // the Host is what refuses, rather than the card guessing a refusal.
        writable: view?.writable ?? true,
      };
    }
    this.publish();
  }

  private dirty(): boolean {
    const stagedCredential = CREDENTIAL_FIELDS.some((field) => {
      const staged = this.stagedCredentials.get(field);
      return staged !== undefined && (staged.clear || staged.text.trim() !== "");
    });
    return this.staged.size > 0 || stagedCredential;
  }

  private field(name: PapersearchFieldName): PapersearchFieldState {
    const staged = this.staged.get(name);
    if (!staged) {
      return { text: this.sectionText(name), overridden: this.stored(name) };
    }
    if (staged.clear) return { text: staged.text, overridden: false };
    return { text: staged.text, overridden: staged.text.trim() !== "" };
  }

  private sectionText(name: PapersearchFieldName): string {
    const value = this.scope.getSnapshot().value?.[name];
    return typeof value === "string" ? value : "";
  }

  private baseText(name: PapersearchFieldName): string {
    const value = this.scope.getSnapshot().base?.[name];
    return typeof value === "string" ? value : "";
  }

  private stored(name: PapersearchFieldName): boolean {
    const user = this.scope.getSnapshot().user;
    return user !== undefined && Object.hasOwn(user, name);
  }

  private async clear(field: PapersearchFieldName): Promise<boolean> {
    await this.scope.unset(field);
    return !this.stored(field);
  }

  private async store(field: PapersearchFieldName, value: string): Promise<boolean> {
    await this.scope.set(field, value);
    return this.scope.getSnapshot().user?.[field] === value;
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}
