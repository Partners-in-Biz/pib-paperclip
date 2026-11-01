/**
 * Hosted-client retainers: a draft invoice on the first of the month with one plan line per hosted CRM company,
 * priced from the plan label the CRM sends with company.upserted. Never sent, never twice for a month.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { HOSTED_PLAN_PRICES_MINOR, hostedPlan, hostedRetainerKey, runHostedRetainers } from "../src/hosted-retainers.js";
import { COMPANY, embeddedAvailable, SETTINGS, startHarness, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const COMPANY_UPSERTED = "plugin.partnersinbiz.crm.company.upserted";
const FIRST_OF_NOVEMBER = new Date("2026-11-01T00:15:00.000Z");

describe("hosted plan prices", () => {
  it("prices the three plan labels in ZAR cents and rejects anything else", () => {
    expect(HOSTED_PLAN_PRICES_MINOR).toEqual({ starter: 195_000, growth: 450_000, business: 750_000 });
    expect(hostedPlan(" Growth ")).toBe("growth");
    expect(hostedPlan("gold")).toBeNull();
    expect(hostedPlan(null)).toBeNull();
    expect(hostedPlan("toString")).toBeNull();
  });

  it("keys a draft by CRM company and month", () => {
    expect(hostedRetainerKey("co-demo", new Date(Date.UTC(2026, 10, 1)))).toBe("hosted-retainer:co-demo:2026-11");
  });
});

describe.skipIf(!available)("hosted retainers (postgres)", () => {
  let h: Harness;
  let tick = 0;

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
  });

  /** A company.upserted event as the CRM sends it, through the registered handler. */
  async function upsert(id: string, name: string, hosted?: { companyId: string | null; plan: string | null }) {
    tick += 1;
    const payload: Record<string, unknown> = { id, name, domain: null, lifecycle: "customer", updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, tick)).toISOString() };
    if (hosted) payload.hosted = hosted;
    await h.deliver(COMPANY_UPSERTED, COMPANY, payload);
  }

  const invoices = async () =>
    (await h.client.query(`SELECT id, status, currency, customer_kind, customer_ref, sent_at, recurring_key, subtotal_minor FROM ${NAMESPACE}.invoices ORDER BY recurring_key`)).rows as Array<{
      id: string;
      status: string;
      currency: string;
      customer_kind: string;
      customer_ref: string;
      sent_at: unknown;
      recurring_key: string;
      subtotal_minor: string | number;
    }>;
  const lines = async (invoiceId: string) =>
    (await h.client.query(`SELECT description, quantity, unit_amount_minor FROM ${NAMESPACE}.invoice_lines WHERE invoice_id = $1`, [invoiceId])).rows as Array<{ description: string; quantity: number | string; unit_amount_minor: string | number }>;
  const outbox = async () => Number(((await h.client.query(`SELECT count(*) AS n FROM ${NAMESPACE}.outbox`)).rows[0] as { n: string }).n);

  it("stores the hosted link and plan from company.upserted", async () => {
    await upsert("co-demo", "PiB Demo", { companyId: "hosted-1", plan: "growth" });
    const stored = (await h.client.query(`SELECT hosted FROM ${NAMESPACE}.crm_companies WHERE id = 'co-demo'`)).rows[0] as { hosted: unknown };
    expect(stored.hosted).toEqual({ companyId: "hosted-1", plan: "growth" });
  });

  it("makes a draft with the plan line for PiB Demo on the first of the month, and sends nothing", async () => {
    await upsert("co-demo", "PiB Demo", { companyId: "hosted-1", plan: "growth" });
    const result = await runHostedRetainers(h.ctx, COMPANY, FIRST_OF_NOVEMBER);
    expect(result.created).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    const [invoice] = await invoices();
    expect(invoice).toMatchObject({ status: "draft", currency: "ZAR", customer_kind: "company", customer_ref: "co-demo", sent_at: null, recurring_key: "hosted-retainer:co-demo:2026-11" });
    expect(Number(invoice!.subtotal_minor)).toBe(450_000);
    const [line, ...rest] = await lines(invoice!.id);
    expect(rest).toEqual([]);
    expect(Number(line!.unit_amount_minor)).toBe(450_000);
    expect(Number(line!.quantity)).toBe(1);
    expect(line!.description).toBe("Hosted platform retainer, Growth plan (2026-11-01 to 2026-11-30)");
    expect(await outbox()).toBe(0);
  });

  it("prices each plan label from the one table", async () => {
    await upsert("co-s", "Starter Co", { companyId: "h-s", plan: "starter" });
    await upsert("co-b", "Business Co", { companyId: "h-b", plan: "business" });
    await runHostedRetainers(h.ctx, COMPANY, FIRST_OF_NOVEMBER);
    const prices = new Map<string, number>();
    for (const invoice of await invoices()) prices.set(invoice.customer_ref, Number((await lines(invoice.id))[0]!.unit_amount_minor));
    expect(Object.fromEntries(prices)).toEqual({ "co-s": 195_000, "co-b": 750_000 });
  });

  it("makes nothing twice for the same month, and a new draft the next month", async () => {
    await upsert("co-demo", "PiB Demo", { companyId: "hosted-1", plan: "starter" });
    await runHostedRetainers(h.ctx, COMPANY, FIRST_OF_NOVEMBER);
    const again = await runHostedRetainers(h.ctx, COMPANY, new Date("2026-11-01T06:00:00.000Z"));
    expect(again.created).toEqual([]);
    expect(await invoices()).toHaveLength(1);
    await runHostedRetainers(h.ctx, COMPANY, new Date("2026-12-01T00:15:00.000Z"));
    expect((await invoices()).map((row) => row.recurring_key)).toEqual(["hosted-retainer:co-demo:2026-11", "hosted-retainer:co-demo:2026-12"]);
  });

  it("skips a client with no or an unknown plan label and one that is not hosted, never guessing a price", async () => {
    await upsert("co-none", "No Plan", { companyId: "h-1", plan: null });
    await upsert("co-gold", "Gold Co", { companyId: "h-2", plan: "gold" });
    await upsert("co-plain", "Not Hosted", { companyId: null, plan: "growth" });
    await upsert("co-old", "Before Hosted");
    const result = await runHostedRetainers(h.ctx, COMPANY, FIRST_OF_NOVEMBER);
    expect(result.created).toEqual([]);
    expect(result.skipped.map((entry) => entry.crmCompanyId).sort()).toEqual(["co-gold", "co-none"]);
    expect(await invoices()).toEqual([]);
  });

  it("leaves a deleted CRM company alone", async () => {
    await upsert("co-demo", "PiB Demo", { companyId: "hosted-1", plan: "growth" });
    await h.client.query(`UPDATE ${NAMESPACE}.crm_companies SET deleted = true WHERE id = 'co-demo'`);
    await runHostedRetainers(h.ctx, COMPANY, FIRST_OF_NOVEMBER);
    expect(await invoices()).toEqual([]);
  });

  it("runs from the hosted-retainers job as drafts only", async () => {
    await upsert("co-demo", "PiB Demo", { companyId: "hosted-1", plan: "business" });
    await h.runJob("hosted-retainers");
    const rows = await invoices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "draft", customer_ref: "co-demo", sent_at: null });
    expect(Number(rows[0]!.subtotal_minor)).toBe(750_000);
    expect(await outbox()).toBe(0);
  });
});
