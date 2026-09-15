import {
  PapersearchSettingsForm,
  type CredentialsRemoteFace,
  type PapersearchCardState,
  type PapersearchFieldName,
  type PapersearchSettingsScope,
  type CredentialField,
} from "./settings-form.ts";

export type PapersearchCardFace = {
  hooks: {
    papersearchSettings: {
      getSnapshot: () => PapersearchCardState;
      subscribe: (listener: () => void) => () => void;
    };
  };
  edit: (field: PapersearchFieldName, text: string) => void;
  resetField: (field: PapersearchFieldName) => void;
  editKey: (field: CredentialField, text: string) => void;
  clearKey: (field: CredentialField) => void;
  resetKeyStage: (field: CredentialField) => void;
  save: () => void;
  discard: () => void;
};

export class PapersearchSettingsController {
  private readonly form: PapersearchSettingsForm;
  private readonly store: PapersearchCardFace["hooks"]["papersearchSettings"];

  /**
   * @param scope - the bound settings scope for the papersearch namespace.
   * @param credentials - the `ctx.remote.credentials` face backing the card's
   * write-only key controls.
   */
  constructor(scope: PapersearchSettingsScope, credentials: CredentialsRemoteFace) {
    this.form = new PapersearchSettingsForm(scope, credentials);
    this.store = this.form.bindStore();
  }

  inject(): PapersearchCardFace {
    return { hooks: { papersearchSettings: this.store }, ...this.form.actions() };
  }

  /**
   * Re-read credentials after the Host reports a reference changed elsewhere.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    this.form.refreshCredential(ref);
  }
}
