/**
 * The page can only call an action the worker registered (a typo or a missing handler fails in front of a person,
 * not in a test), and the online-payment cards read the shapes the worker returns.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import plugin from "../src/worker.js";
import { COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();

/** The keys in the page's fixed action list (src/ui/parts.tsx), read from the source so the test cannot drift from it. */
function pageActionKeys(): string[] {
  const source = readFileSync(new URL("../src/ui/parts.tsx", import.meta.url), "utf8");
  const block = /const ACTION_KEYS = \[([\s\S]*?)\] as const;/.exec(source);
  if (!block) throw new Error("ACTION_KEYS not found in parts.tsx");
  return [...block[1]!.matchAll(/"(billing\.[a-z-]+)"/g)].map((m) => m[1]!);
}

describe("the page's action list", () => {
  it("is read correctly, has no duplicates and includes the online-payment actions", () => {
    const keys = pageActionKeys();
    expect(keys.length).toBeGreaterThan(60);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of ["billing.create-payment-link", "billing.payment-links", "billing.cancel-payment-link", "billing.record-refund", "billing.simulate-payment", "billing.payments"]) expect(keys).toContain(key);
  });
});

describe.skipIf(!available)("page actions (postgres)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    await plugin.definition.setup(h.ctx);
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  beforeEach(async () => {
    await h.reset();
    h.config.set(COMPANY, { ...SETTINGS });
    await seedClient(h, { id: "ct-lumen", name: "Lumen Digital", email: "ap@lumen.test" });
  });

  it("every action the page lists is registered by the worker", () => {
    const missing = pageActionKeys().filter((key) => !h.actions.has(key));
    expect(missing).toEqual([]);
  });

  it("billing.payments answers the shape the Payments tab reads, with no provider on", async () => {
    const status = await h.call<{ providers: Array<{ key: string; enabled: boolean; blocker: string | null }>; attention: unknown[]; events: unknown[] }>("billing.payments", {});
    expect(Array.isArray(status.attention)).toBe(true);
    expect(Array.isArray(status.events)).toBe(true);
    const stripe = status.providers.find((p) => p.key === "stripe");
    expect(stripe).toMatchObject({ enabled: false });
    expect(stripe!.blocker).toBeTruthy();
    expect(status.providers.some((p) => p.enabled)).toBe(false);
  });

  it("the snapshot carries the provider list for the invoice card, and no secret", async () => {
    const snapshot = await h.call<{ payments?: { providers: Array<Record<string, unknown>> } }>("billing.load", {});
    const providers = snapshot.payments?.providers ?? [];
    expect(providers.map((p) => p.key)).toContain("stripe");
    expect(providers.map((p) => p.key)).toContain("payfast");
    expect(JSON.stringify(providers)).not.toMatch(/whsec_|sk_(test|live)_|rk_(test|live)_/);
  });
});
