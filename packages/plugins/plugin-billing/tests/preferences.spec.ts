/**
 * Company preferences in Billing: where they merge over the saved settings, that a company on its old settings
 * behaves exactly as before, and that saving is wired to the capability it needs.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { billingSettings, defaultTaxCode, reportingCurrency, vatRegistered, type BillingSettings } from "../src/config.js";
import { defaultDueAt, defaultTax } from "../src/invoices.js";
import manifest from "../src/manifest.js";
import { computeDocument } from "../src/money.js";
import { PREFERENCES_ACTIONS, PREFERENCES_LOAD_ACTION, PREFERENCES_SAVE_ACTION } from "../src/preferences.js";

const CO = "co-pib";
const OWNER = "u-owner";
const member = (principalId: string, membershipRole: string) =>
  ({ id: `${CO}:${principalId}`, companyId: CO, principalType: "user", principalId, status: "active", membershipRole, grants: [] }) as never;

function boot(config: Record<string, unknown>, m: PaperclipPluginManifestV1 = manifest) {
  const h = createTestHarness({ manifest: m, config });
  h.seed({ companies: [{ id: CO, name: "Partners in Biz", issuePrefix: "PAR" } as never], accessMembers: [member(OWNER, "owner"), member("u-operator", "operator")] });
  return h;
}
const as = (userId: string, type = "user") => ({ companyId: CO, actor: { type, userId } }) as never;
const save = (h: ReturnType<typeof boot>, patch: Record<string, unknown>, userId = OWNER, type = "user") =>
  PREFERENCES_ACTIONS[PREFERENCES_SAVE_ACTION]!(h.ctx, as(userId, type), { patch }) as Promise<{ ok: boolean; error?: string; values?: Record<string, unknown> }>;

/** The PiB-like settings that were saved before preferences existed: every moved field set. */
const PAR_CONFIG = {
  defaultCurrency: "ZAR", reportingCurrency: "ZAR", vatRegistered: true, defaultTaxRate: 15, defaultTaxCode: "za_std_15",
  pricesIncludeVat: false, defaultDueDays: 14, invoiceNotes: "Thank you. Pay by EFT.",
  sender: { name: "Partners in Biz", vatNumber: "4123456789" }, payment: { bankName: "FNB" }, defaultHourlyRateMinor: 85000,
};
const MOVED = ["defaultCurrency", "reportingCurrency", "vatRegistered", "defaultTaxRate", "defaultTaxCode", "pricesIncludeVat", "defaultDueDays", "invoiceNotes"] as const;

describe("capability", () => {
  it("the manifest has access.members.read because the plugin registers preferences-save", () => {
    expect(Object.keys(PREFERENCES_ACTIONS)).toContain(PREFERENCES_SAVE_ACTION);
    expect(Object.keys(PREFERENCES_ACTIONS)).toContain(PREFERENCES_LOAD_ACTION);
    expect(readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8")).toContain("...PREFERENCES_ACTIONS");
    expect(manifest.capabilities).toContain("access.members.read");
  });

  it("a host that withholds it refuses every save and stores nothing", async () => {
    const without = { ...manifest, capabilities: manifest.capabilities.filter((c) => c !== "access.members.read") } as PaperclipPluginManifestV1;
    const h = boot({}, without);
    expect(await save(h, { defaultDueDays: 30 })).toEqual({ ok: false, error: "Cannot verify your role" });
    expect((await billingSettings(h.ctx, CO)).defaultDueDays).toBeUndefined();
  });
});

describe("precedence at the one merge point", () => {
  it("a saved preference beats the saved setting, clearing it falls back to the setting", async () => {
    const h = boot({ defaultDueDays: 14, invoiceNotes: "Old notes" });
    expect((await billingSettings(h.ctx, CO)).defaultDueDays).toBe(14);
    expect((await save(h, { defaultDueDays: 30, invoiceNotes: "New notes" })).ok).toBe(true);
    const saved = await billingSettings(h.ctx, CO);
    expect([saved.defaultDueDays, saved.invoiceNotes]).toEqual([30, "New notes"]);
    expect((await save(h, { defaultDueDays: null })).ok).toBe(true);
    expect((await billingSettings(h.ctx, CO)).defaultDueDays).toBe(14);
  });

  it("an empty tax code or notes text means unset, as it was before", async () => {
    const h = boot({ defaultTaxCode: "za_zero", invoiceNotes: "Old notes" });
    await save(h, { defaultTaxCode: "", invoiceNotes: "" });
    const s = await billingSettings(h.ctx, CO);
    expect("defaultTaxCode" in s).toBe(false);
    expect("invoiceNotes" in s).toBe(false);
  });

  it("settings that are not preferences pass through untouched", async () => {
    const h = boot(PAR_CONFIG);
    const s = await billingSettings(h.ctx, CO);
    expect(s.sender).toEqual(PAR_CONFIG.sender);
    expect(s.payment).toEqual(PAR_CONFIG.payment);
    expect(s.defaultHourlyRateMinor).toBe(85000);
  });
});

describe("a company that never opens the panel", () => {
  const effective = (s: BillingSettings) => ({
    tax: defaultTax(s), code: defaultTaxCode(s), vat: vatRegistered(s), book: reportingCurrency(s),
    due: defaultDueAt(s, Date.UTC(2026, 9, 24)), currency: s.defaultCurrency ?? "ZAR", inclusive: Boolean(s.pricesIncludeVat), notes: s.invoiceNotes ?? null,
  });
  const totals = (s: BillingSettings) =>
    computeDocument(
      [{ quantity: 2, unitAmountMinor: 150_000, taxCode: defaultTaxCode(s) }, { quantity: 1, unitAmountMinor: 33_333, taxCode: defaultTaxCode(s) }],
      { pricesIncludeVat: Boolean(s.pricesIncludeVat), taxRatePercent: defaultTax(s) },
    );

  it("PiB's saved settings give the same values and the same invoice and quote totals before and after", async () => {
    const h = boot(PAR_CONFIG);
    const after = await billingSettings(h.ctx, CO);
    for (const key of MOVED) expect(after[key]).toEqual(PAR_CONFIG[key]);
    expect(effective(after)).toEqual(effective(PAR_CONFIG as BillingSettings));
    expect(totals(after)).toEqual(totals(PAR_CONFIG as BillingSettings));
  });

  it("a prices-include-VAT, zero-rated, three-day company keeps its totals too", async () => {
    const config = { ...PAR_CONFIG, pricesIncludeVat: true, defaultTaxRate: 0, defaultTaxCode: "za_zero", defaultDueDays: 3, defaultCurrency: "USD" };
    const h = boot(config);
    const after = await billingSettings(h.ctx, CO);
    expect(effective(after)).toEqual(effective(config as BillingSettings));
    expect(totals(after)).toEqual(totals(config as BillingSettings));
  });

  it("no settings and no preferences: exactly what the old code did, including a 0 tax rate with the 15% code", async () => {
    const h = boot({});
    const s = await billingSettings(h.ctx, CO);
    // Only the sender name is new: a company with no saved name sends as its company name (this one is named for PiB).
    expect(s).toEqual({ sender: { name: "Partners in Biz" } });
    expect(effective(s)).toEqual({ tax: 0, code: "za_std_15", vat: true, book: "ZAR", due: null, currency: "ZAR", inclusive: false, notes: null });
    expect(await PREFERENCES_ACTIONS[PREFERENCES_LOAD_ACTION]!(h.ctx, as(OWNER), {})).toMatchObject({ values: { defaultCurrency: "ZAR", defaultDueDays: 0, vatRegistered: true, defaultTaxRate: 15 } });
  });

  it("a rate a person saves counts, even when it equals the form default", async () => {
    const h = boot({});
    await save(h, { defaultTaxRate: 15 });
    expect(defaultTax(await billingSettings(h.ctx, CO))).toBe(15);
  });

  it("a saved rate the kit would drop (7.5) is kept until a person saves another", async () => {
    const h = boot({ ...PAR_CONFIG, defaultTaxRate: 7.5 });
    await save(h, { defaultDueDays: 30 });
    const s = await billingSettings(h.ctx, CO);
    expect([s.defaultTaxRate, s.defaultDueDays]).toEqual([7.5, 30]);
  });
});

describe("saving", () => {
  it("is for an owner or admin; an operator and an agent are refused", async () => {
    const h = boot({});
    expect((await save(h, { defaultDueDays: 30 }, "u-operator")).ok).toBe(false);
    expect((await save(h, { defaultDueDays: 30 }, "agent-1", "agent")).ok).toBe(false);
    expect((await billingSettings(h.ctx, CO)).defaultDueDays).toBeUndefined();
  });

  it("checks money fields: currency codes, the VAT rate range and the VAT code", async () => {
    const h = boot({});
    for (const patch of [{ defaultCurrency: "RAND" }, { reportingCurrency: "z1" }, { defaultTaxRate: 101 }, { defaultTaxRate: -1 }, { defaultTaxRate: 7.5 }, { defaultTaxCode: "nope" }, { defaultDueDays: 366 }]) {
      const result = await save(h, patch);
      expect(result.ok, JSON.stringify(patch)).toBe(false);
    }
    expect((await billingSettings(h.ctx, CO)).defaultTaxRate).toBeUndefined();
    const ok = await save(h, { defaultCurrency: " usd ", defaultTaxRate: 0 });
    expect(ok.ok).toBe(true);
    const s = await billingSettings(h.ctx, CO);
    expect([s.defaultCurrency, s.defaultTaxRate]).toEqual(["USD", 0]);
  });

  it("refuses an unknown field and a patch that is not an object", async () => {
    const h = boot({});
    expect((await save(h, { sender: "x" })).ok).toBe(false);
    expect(await PREFERENCES_ACTIONS[PREFERENCES_SAVE_ACTION]!(h.ctx, as(OWNER), { patch: [1] })).toMatchObject({ ok: false });
  });
});
