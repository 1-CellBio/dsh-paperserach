import { describe, expect, it, vi } from "vitest";
import { PapersearchSettingsForm, type CredentialsRemoteFace } from "../client/settings-form.ts";
import type { PapersearchSettingsScope, PapersearchScopeSnapshot } from "../client/settings-form.ts";

/** In-memory settings scope the form stages against. */
function fakeScope(initial: Record<string, unknown> = {}): PapersearchSettingsScope & { user: Record<string, unknown> } {
  const user: Record<string, unknown> = { ...initial };
  let snapshot: PapersearchScopeSnapshot = { status: "ready", writable: true, value: { ...initial }, user: { ...user } };
  const listeners = new Set<() => void>();
  const publish = () => { snapshot = { ...snapshot, value: { ...user }, user: { ...user } }; for (const l of listeners) l(); };
  return {
    user,
    getSnapshot: () => snapshot,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    set: async (field, value) => { user[field] = value; publish(); },
    unset: async (field) => { delete user[field]; publish(); },
  };
}

/** In-memory credentials domain recording every call. */
function fakeCredentials(store = new Map<string, string>()): CredentialsRemoteFace & {
  setCalls: Array<{ ref: string; value: string }>;
  unsetCalls: string[];
} {
  const setCalls: Array<{ ref: string; value: string }> = [];
  const unsetCalls: string[] = [];
  return {
    setCalls,
    unsetCalls,
    describe: vi.fn(async (refs: string[]) => ({
      ok: true as const,
      value: Object.fromEntries(refs.map((ref) => [ref, { configured: store.has(ref), writable: true }])),
    })),
    set: vi.fn(async (ref: string, value: string) => {
      setCalls.push({ ref, value });
      store.set(ref, value);
      return { ok: true as const, value: undefined };
    }),
    unset: vi.fn(async (ref: string) => {
      unsetCalls.push(ref);
      store.delete(ref);
      return { ok: true as const, value: undefined };
    }),
  };
}

describe("PapersearchSettingsForm credentials staging", () => {
  it("writes a staged key through the credentials domain at the default reference", async () => {
    const scope = fakeScope();
    const credentials = fakeCredentials();
    const form = new PapersearchSettingsForm(scope, credentials);
    const actions = form.actions();

    actions.editKey("coreApiKey", " secret ");
    await form.save();

    expect(credentials.setCalls).toEqual([{ ref: "CORE_API_KEY", value: "secret" }]);
    // A landed save clears the stage and re-describes: the badge flips to configured.
    expect(form.snapshot().dirty).toBe(false);
    expect(form.snapshot().credentials.coreApiKey.configured).toBe(true);
  });

  it("addresses credential writes by the reference the just-saved section names", async () => {
    const scope = fakeScope();
    const credentials = fakeCredentials();
    const form = new PapersearchSettingsForm(scope, credentials);
    const actions = form.actions();

    actions.edit("coreApiKeyEnv", "MY_CORE_KEY");
    actions.editKey("coreApiKey", "k");
    await form.save();

    expect(scope.user.coreApiKeyEnv).toBe("MY_CORE_KEY");
    expect(credentials.setCalls).toEqual([{ ref: "MY_CORE_KEY", value: "k" }]);
  });

  it("stages a removal as an unset and reports the reference unconfigured afterwards", async () => {
    const store = new Map([["IEEE_API_KEY", "old"]]);
    const scope = fakeScope();
    const credentials = fakeCredentials(store);
    const form = new PapersearchSettingsForm(scope, credentials);
    const actions = form.actions();

    await vi.waitFor(() => expect(form.snapshot().credentials.ieeeApiKey.configured).toBe(true));
    actions.clearKey("ieeeApiKey");
    await form.save();

    expect(credentials.unsetCalls).toEqual(["IEEE_API_KEY"]);
    expect(form.snapshot().credentials.ieeeApiKey.configured).toBe(false);
  });

  it("keeps a blank key input as no-change", async () => {
    const scope = fakeScope();
    const credentials = fakeCredentials();
    const form = new PapersearchSettingsForm(scope, credentials);
    const actions = form.actions();

    actions.editKey("acmApiKey", "   ");
    expect(form.snapshot().dirty).toBe(false);
    await form.save();
    expect(credentials.setCalls).toEqual([]);
  });
});
