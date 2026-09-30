import { describe, expect, it } from "vitest";
import { apply, inject as declaredInject } from "../client/index.ts";

/**
 * Reproduction guard for the loader-entry crash: the harness settings-UI
 * runtime enforces Cordis's exact-path property proxy — any ctx.<path>
 * access outside the declared inject set throws synchronously. This test
 * applies the whole client plugin against a strict proxy ctx and then
 * materializes EVERY registered slot entry's inject callback, so an
 * undeclared access anywhere (apply-time or slot-inject-time) fails here
 * instead of in the browser.
 */

type SlotRegistration = {
  options: { name: string; inject?: (...args: unknown[]) => unknown };
  component: unknown;
};

function makeStrictCtx() {
  const allowed = new Set<string>(declaredInject as readonly string[]);
  const slotsCalls: Array<{ slot: string; generator: () => Generator<SlotRegistration> | SlotRegistration }> = [];
  const registrations: SlotRegistration[] = [];

  const ctx: Record<string | symbol, unknown> = {};
  const proxy = new Proxy(ctx, {
    get(_t, prop: string | symbol) {
      if (typeof prop === "symbol") return ctx[prop as symbol];
      if (prop in ctx) return ctx[prop];
      if (!allowed.has(prop)) {
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      }
      return undefined;
    },
  });

  const slots = {
    inject: (slot: string, factory: () => Generator<SlotRegistration> | SlotRegistration) => {
      slotsCalls.push({ slot, generator: factory });
      return () => {};
    },
    register: (options: SlotRegistration["options"], component: unknown) => {
      registrations.push({ options, component });
      return { options, component };
    },
  };
  ctx.slots = slots;
  ctx.effect = () => () => {};
  ctx.locale = { t: (k: string) => k, bind: () => ((k: string) => k) };
  // Settings form (0.1.7): the shared ConfigForms scope plus the credentials
  // domain. whileServed fires its callback so the bundle.config registration
  // is materialized like every other slot entry below.
  const scope = {
    getSnapshot: () => ({ status: "ready", value: {}, base: {}, user: {}, writable: true, revision: 0 }),
    subscribe: () => () => {},
    mutate: async () => true,
  };
  ctx.configForms = {
    get: () => scope,
    whileServed: (namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) => {
      register(new Set(namespaces));
      return () => {};
    },
  };
  ctx.remote = {
    credentials: {
      describe: async () => ({ ok: true, value: {} }),
      set: async () => ({ ok: true }),
    },
    $on: () => () => {},
  };

  return { proxy, slotsCalls, registrations, allowed };
}

describe("client apply under strict Cordis property proxy", () => {
  it("declares every service path it touches and survives slot materialization", () => {
    const { proxy, slotsCalls } = makeStrictCtx();
    expect(() => apply(proxy as never)).not.toThrow();

    expect(slotsCalls.length).toBeGreaterThan(0);
    for (const { slot, generator } of slotsCalls) {
      const yielded = generator();
      const items: SlotRegistration[] = [];
      if (yielded && typeof (yielded as Generator).next === "function") {
        for (;;) {
          const step = (yielded as Generator<SlotRegistration>).next();
          if (step.done) break;
          if (step.value) items.push(step.value as SlotRegistration);
        }
      } else if (yielded) {
        items.push(yielded as SlotRegistration);
      }
      for (const item of items) {
        if (typeof item.options.inject === "function") {
          expect(
            () => item.options.inject!("session-1"),
            `slot ${slot} entry inject must not touch undeclared ctx paths`,
          ).not.toThrow();
        }
      }
    }
  });
});
