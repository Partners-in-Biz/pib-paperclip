import { describe, expect, it } from "vitest";
import { canaryAccountId, canaryContactId } from "../src/canary-flag.js";
import { BOARD, bootCare, careSeed, CO, tool } from "./helpers/care.js";
import { contact, deal } from "./helpers/crm.js";

const BILLING = "plugin.partnersinbiz.billing";
const ACCOUNT = canaryAccountId(CO);
const CONTACT = canaryContactId(CO);
const NOW = () => new Date().toISOString();

const paid = (key: string, extra: Record<string, unknown> = {}) => ({ key: `billing:invoice:${key}:paid`, invoiceId: key, number: `INV-${key}`, dealId: null, clientKind: "company", clientRef: "acme", totalMinor: 99_900, currency: "ZAR", paidAt: NOW(), ...extra });

/** Our own report for the last 30 days: the total money paid and deals won, first touch. */
async function totals(booted: Awaited<ReturnType<typeof bootCare>>) {
  const report = await tool<Record<string, any>>(booted.harness, "attribution-report", { days: 30 });
  return { report, revenue: report.totals.firstTouch.revenueMinor as Record<string, number>, won: report.totals.firstTouch.won as number, wonValue: report.totals.firstTouch.wonValueMinor as Record<string, number> };
}

/** The journey's leftovers in the CRM: the canary client with a won deal, as the quote and invoice steps leave it. */
async function withCanary() {
  const store = careSeed();
  const booted = await bootCare({ store });
  await tool(booted.harness, "create-canary-client", {});
  store.deals!.push(deal("canary-deal", "Canary retainer", { account_id: ACCOUNT, contact_id: CONTACT, stage_id: "st-won", amount_minor: 123_400, won_at: NOW() }));
  return { booted, store };
}

describe("the canary's test payment is a rehearsal, never revenue", () => {
  it("is logged on the canary client like any payment, but leaves no revenue row and no number in our report", async () => {
    const { booted, store } = await withCanary();
    await booted.harness.emit(`${BILLING}.invoice.paid`, paid("c1", { dealId: "canary-deal", clientRef: ACCOUNT, totalMinor: 123_400 }), { companyId: CO });
    // The activity on the canary client is the journey's proof of payment: it still happens.
    expect(store.activities!.filter((row) => row.kind === "invoice_paid")).toEqual([expect.objectContaining({ record_id: ACCOUNT })]);
    expect(store.revenue_events ?? []).toEqual([]);
    const seen = await totals(booted);
    expect(seen.revenue).toEqual({});
    // Its won deal is not a sale either, while the journey is still on.
    expect(seen.won).toBe(0);
    expect(seen.wonValue).toEqual({});
    expect(seen.report.notes.join(" ")).toMatch(/canary client's test records .* are never counted/);
  });

  it("a payment that names only the canary's deal (no client on the invoice) is not revenue either", async () => {
    const { booted, store } = await withCanary();
    await booted.harness.emit(`${BILLING}.invoice.paid`, paid("c2", { dealId: "canary-deal", clientKind: null, clientRef: null }), { companyId: CO });
    expect(store.revenue_events ?? []).toEqual([]);
    expect((await totals(booted)).revenue).toEqual({});
  });

  it("a payment for the canary's contact (a sole trader canary) is not revenue", async () => {
    const { booted, store } = await withCanary();
    await booted.harness.emit(`${BILLING}.invoice.paid`, paid("c3", { clientKind: "contact", clientRef: CONTACT }), { companyId: CO });
    expect(store.revenue_events ?? []).toEqual([]);
  });

  it("each way the canary is recognised works on its own", async () => {
    const { booted, store } = await withCanary();
    // 1. Named by its id only: the client record is gone, nothing else says it is the canary.
    await booted.harness.emit(`${BILLING}.invoice.paid`, paid("w1", { clientRef: "canary-0000dead" }), { companyId: CO });
    // 2. A real client on the invoice, but the deal it pays is the canary's (by the deal's company).
    await booted.harness.emit(`${BILLING}.invoice.paid`, paid("w2", { dealId: "canary-deal", clientRef: "acme" }), { companyId: CO });
    // 3. A deal flagged canary by the plugin's own flag, with ordinary ids.
    store.deals!.push(deal("flagged-deal", "Flagged", { account_id: "acme", stage_id: "st-won", won_at: NOW(), custom: { canary: true } }));
    await booted.harness.emit(`${BILLING}.invoice.paid`, paid("w3", { dealId: "flagged-deal", clientRef: "acme" }), { companyId: CO });
    // 4. A person who carries the plugin's flag with an ordinary id (a canary contact made another way).
    store.contacts!.push(contact("tester", "Tester", { emails: ["t@canary.invalid"], custom: { canary: true } }));
    await booted.harness.emit(`${BILLING}.invoice.paid`, paid("w4", { clientKind: "contact", clientRef: "tester" }), { companyId: CO });
    expect(store.revenue_events ?? []).toEqual([]);
    // 5. The report leaves out a won deal that carries the flag, whatever its ids.
    const seen = await totals(booted);
    expect(seen.won).toBe(0);
    expect(seen.revenue).toEqual({});
  });

  it("a person's tag on a real client never hides its payment: only the plugin's own flag and the canary ids do", async () => {
    const { booted, store } = await withCanary();
    store.companies!.find((row) => row.id === "acme")!.tags = ["retainer", "canary"];
    await booted.harness.emit(`${BILLING}.invoice.paid`, paid("t1", { clientRef: "acme", totalMinor: 70_000 }), { companyId: CO });
    expect(store.revenue_events).toHaveLength(1);
    expect((await totals(booted)).revenue).toEqual({ ZAR: 70_000 });
  });

  it("a real client's payment still counts, with the canary's journey in the same company", async () => {
    const { booted, store } = await withCanary();
    await booted.harness.emit(`${BILLING}.invoice.paid`, paid("c4", { dealId: "canary-deal", clientRef: ACCOUNT, totalMinor: 123_400 }), { companyId: CO });
    await booted.harness.emit(`${BILLING}.invoice.paid`, paid("r1", { dealId: "d-acme", totalMinor: 450_000 }), { companyId: CO });
    expect(store.revenue_events).toHaveLength(1);
    expect(store.revenue_events![0]).toMatchObject({ key: "billing:invoice:r1:paid", client_ref: "acme", total_minor: 450_000 });
    expect((await totals(booted)).revenue).toEqual({ ZAR: 450_000 });
  });

  it("a stray canary revenue row (from before this rule) is left out of the report, and the cleanup deletes it, not just unlinks it", async () => {
    const { booted, store } = await withCanary();
    const row = (key: string, extra: Record<string, unknown>) => ({ id: `rev-${key}`, company_id: CO, key, invoice_id: key, number: key, deal_id: null, client_kind: null, client_ref: null, total_minor: 123_400, currency: "ZAR", paid_at: NOW(), ...extra });
    store.revenue_events = [
      row("by-client", { client_kind: "company", client_ref: ACCOUNT }),
      row("by-deal", { deal_id: "canary-deal" }),
      row("real", { client_kind: "company", client_ref: "acme", total_minor: 5_000 }),
    ];
    expect((await totals(booted)).revenue).toEqual({ ZAR: 5_000 });
    expect(await tool(booted.harness, "cleanup-canary", { confirm: true })).toMatchObject({ cleaned: true, deals: 1 });
    expect(store.revenue_events!.map((r) => r.key)).toEqual(["real"]);
    expect(store.deals!.some((d) => d.id === "canary-deal")).toBe(false);
    expect((await totals(booted)).revenue).toEqual({ ZAR: 5_000 });
  });

  it("the board action cleans up the same way", async () => {
    const { booted, store } = await withCanary();
    store.revenue_events = [{ id: "rev-x", company_id: CO, key: "k", invoice_id: "k", number: "k", deal_id: null, client_kind: "company", client_ref: ACCOUNT, total_minor: 1, currency: "ZAR", paid_at: NOW() }];
    await booted.harness.performAction("crm.cleanup-canary", { confirm: true }, { companyId: CO, actor: BOARD });
    expect(store.revenue_events).toEqual([]);
  });
});
