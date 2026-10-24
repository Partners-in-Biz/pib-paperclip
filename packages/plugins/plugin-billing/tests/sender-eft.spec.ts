/**
 * Sender and EFT bank details as company preferences: a bank-detail change needs the owner's confirmation,
 * PiB's saved details render byte-identical documents and emails, and a company with no settings never prints PiB.
 */
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { billingSettings, type BillingSettings } from "../src/config.js";
import { documentPdfSpec, FALLBACK_SENDER_NAME, type DocView } from "../src/documents.js";
import { reminderVars } from "../src/dunning.js";
import { senderFrom } from "../src/invoices.js";
import { invoiceEmail, quoteEmail, statementEmail } from "../src/mail.js";
import manifest from "../src/manifest.js";
import { computeDocument } from "../src/money.js";
import { BANK_PREFERENCE_IDS } from "../src/preference-ids.js";
import { BILLING_PREFERENCES, PREFERENCES_ACTIONS, PREFERENCES_LOAD_ACTION, PREFERENCES_SAVE_ACTION } from "../src/preferences.js";

const CO = "co-1";
const OWNER = "u-owner";
const member = (principalId: string, membershipRole: string) =>
  ({ id: `${CO}:${principalId}`, companyId: CO, principalType: "user", principalId, status: "active", membershipRole, grants: [] }) as never;

function boot(config: Record<string, unknown>, companyName = "Partners in Biz") {
  const h = createTestHarness({ manifest, config });
  h.seed({ companies: [{ id: CO, name: companyName, issuePrefix: "PAR" } as never], accessMembers: [member(OWNER, "owner")] });
  return h;
}
type Result = { ok: boolean; error?: string; needsConfirmation?: string[]; values?: Record<string, unknown>; previous?: Record<string, unknown> };
const save = (h: ReturnType<typeof boot>, patch: Record<string, unknown>, confirmed?: boolean) =>
  PREFERENCES_ACTIONS[PREFERENCES_SAVE_ACTION]!(h.ctx, { companyId: CO, actor: { type: "user", userId: OWNER } } as never, { patch, ...(confirmed === undefined ? {} : { confirmed }) }) as Promise<Result>;

/** PiB's details as they were saved in the host form before preferences existed. */
const PAR_CONFIG = {
  sender: { name: "Partners in Biz", address: "1 Main Rd\nBallito", email: "billing@pib.test", vatNumber: "4123456789", registrationNumber: "2020/123456/07" },
  payment: { bankName: "FNB", accountName: "Partners in Biz (Pty) Ltd", accountNumber: "62000000123", branchCode: "250655", accountType: "Cheque" },
};

const totals = computeDocument([{ quantity: 2, unitAmountMinor: 50_000, taxCode: "za_std_15" }], {});
function docView(kind: "invoice" | "quote", settings: BillingSettings): DocView {
  return {
    kind, number: kind === "invoice" ? "LUM-001" : "Q-LUM-001", status: "sent", currency: "ZAR", issuedAt: "2026-09-26T10:00:00Z", dueAt: "2026-10-10T00:00:00Z",
    sender: senderFrom(settings, undefined), customer: { name: "Lumen Digital", email: "ap@lumen.test" },
    lines: totals.lines.map((l) => ({ description: "SEO sprint", quantity: 2, unitAmountMinor: 50_000, ...l })), groups: totals.groups,
    subtotalMinor: totals.subtotalMinor, vatMinor: totals.vatMinor, totalMinor: totals.totalMinor, pricesIncludeVat: false, legacy: false,
    paidMinor: 0, creditedMinor: 0, outstandingMinor: totals.totalMinor, payment: settings.payment ?? null, notes: null,
  };
}
/** Every text a customer can read from the sender and EFT settings. */
function rendered(settings: BillingSettings) {
  const invoice = docView("invoice", settings);
  const quote = docView("quote", settings);
  const statement = statementEmail({ customer: { name: "Lumen" }, sender: invoice.sender, from: "2026-07-01", to: "2026-09-30", dueMinor: 5000, currency: "ZAR", payment: settings.payment, hasAttachment: true });
  const vars = reminderVars({ invoice: { number: "LUM-001", currency: "ZAR", total_minor: 1000, customer: { name: "Lumen" }, due_at: null }, outstandingMinor: 1000 } as never, 3, settings);
  return JSON.stringify({ invoicePdf: documentPdfSpec(invoice), quotePdf: documentPdfSpec(quote), invoiceMail: invoiceEmail(invoice, { hasAttachment: true }), quoteMail: quoteEmail(quote, { hasAttachment: true }), statement, vars });
}

describe("bank details need the owner's confirmation", () => {
  it("lists exactly the bank fields the page asks about, and they are all preference fields", () => {
    expect(BANK_PREFERENCE_IDS.every((id) => Object.hasOwn(BILLING_PREFERENCES.fields, id))).toBe(true);
    expect(BANK_PREFERENCE_IDS).toContain("payment.accountNumber");
  });

  it("refuses a bank-detail save without confirmation, stores nothing and names what would change", async () => {
    const h = boot(PAR_CONFIG);
    const refused = await save(h, { "payment.accountNumber": "99999999999", "payment.branchCode": "111111" });
    expect(refused.ok).toBe(false);
    expect(refused.needsConfirmation).toEqual(["payment.branchCode", "payment.accountNumber"].sort((a, b) => BANK_PREFERENCE_IDS.indexOf(a as never) - BANK_PREFERENCE_IDS.indexOf(b as never)));
    expect(refused.error).toContain("Confirm the change to the bank details");
    expect((await billingSettings(h.ctx, CO)).payment).toEqual(PAR_CONFIG.payment);
    expect((await save(h, { "payment.accountNumber": "99999999999" }, false)).ok).toBe(false);
    expect((await billingSettings(h.ctx, CO)).payment).toEqual(PAR_CONFIG.payment);
  });

  it("saves with confirmation and the response shows the previous value", async () => {
    const h = boot(PAR_CONFIG);
    const saved = await save(h, { "payment.accountNumber": "99999999999" }, true);
    expect(saved.ok).toBe(true);
    expect(saved.previous!["payment.accountNumber"]).toBe("62000000123");
    expect(saved.values!["payment.accountNumber"]).toBe("99999999999");
    expect((await billingSettings(h.ctx, CO)).payment).toEqual({ ...PAR_CONFIG.payment, accountNumber: "99999999999" });
  });

  it("does not ask about the sender fields", async () => {
    const h = boot(PAR_CONFIG);
    expect((await save(h, { "sender.phone": "031 555 0100" })).ok).toBe(true);
    expect((await billingSettings(h.ctx, CO)).sender).toEqual({ ...PAR_CONFIG.sender, phone: "031 555 0100" });
  });

  it("clearing a bank field also needs confirmation, and an empty value removes the key", async () => {
    const h = boot(PAR_CONFIG);
    expect((await save(h, { "payment.accountType": "" })).ok).toBe(false);
    expect((await save(h, { "payment.accountType": "" }, true)).ok).toBe(true);
    expect("accountType" in ((await billingSettings(h.ctx, CO)).payment ?? {})).toBe(false);
  });
});

describe("the old host form is the fallback", () => {
  it("the panel shows the saved host-form values until a person saves", async () => {
    const h = boot(PAR_CONFIG);
    const loaded = (await PREFERENCES_ACTIONS[PREFERENCES_LOAD_ACTION]!(h.ctx, { companyId: CO, actor: { type: "user", userId: OWNER } } as never, {})) as { values: Record<string, unknown> };
    expect(loaded.values).toMatchObject({ "sender.name": "Partners in Biz", "sender.vatNumber": "4123456789", "payment.bankName": "FNB", "payment.branchCode": "250655" });
    expect((await billingSettings(h.ctx, CO)).sender).toEqual(PAR_CONFIG.sender);
  });

  it("a saved sender field wins; the other host-form keys stay", async () => {
    const h = boot(PAR_CONFIG);
    await save(h, { "sender.address": "2 Beach Rd" });
    expect((await billingSettings(h.ctx, CO)).sender).toEqual({ ...PAR_CONFIG.sender, address: "2 Beach Rd" });
  });
});

describe("what customers read", () => {
  it("PiB's saved details render the same documents and emails before and after the change", async () => {
    const h = boot(PAR_CONFIG);
    const before = rendered(PAR_CONFIG as BillingSettings);
    expect(rendered(await billingSettings(h.ctx, CO))).toBe(before);
    expect(before).toContain("Invoice LUM-001 from Partners in Biz");
    expect(before).toContain("62000000123");
  });

  it("the same holds after PiB's own values are saved through the panel", async () => {
    const h = boot(PAR_CONFIG);
    const before = rendered(PAR_CONFIG as BillingSettings);
    await save(h, { "sender.name": "Partners in Biz", "payment.bankName": "FNB" }, true);
    expect(rendered(await billingSettings(h.ctx, CO))).toBe(before);
  });

  it("a company with no settings sends as its own name and never prints PiB", async () => {
    const h = boot({}, "Acme Roofing");
    const settings = await billingSettings(h.ctx, CO);
    expect(settings.sender?.name).toBe("Acme Roofing");
    const text = rendered(settings);
    expect(text).toContain("Invoice LUM-001 from Acme Roofing");
    expect(text).not.toMatch(/PiB|Partners in Biz/);
  });

  it("with no company name either, the neutral fallback is used, still not PiB", () => {
    const text = rendered({});
    expect(text).toContain(`from ${FALLBACK_SENDER_NAME}`);
    expect(text).not.toMatch(/PiB|Partners in Biz/);
  });

  it("a name a person saved beats the company name, and clearing it returns to the company name", async () => {
    const h = boot({}, "Acme Roofing");
    await save(h, { "sender.name": "Acme Roofing (Pty) Ltd" });
    expect((await billingSettings(h.ctx, CO)).sender?.name).toBe("Acme Roofing (Pty) Ltd");
    await save(h, { "sender.name": null });
    expect((await billingSettings(h.ctx, CO)).sender?.name).toBe("Acme Roofing");
  });
});
