/**
 * Small tool results (audit Q8-11): lists are compact and windowed by default, full detail stays reachable by id,
 * and the page's own actions are untouched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import plugin from "../src/worker.js";
import { BILLING_TOOLS } from "../src/tools.js";
import { DETAIL_SECTIONS, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, LIST_TOOLS, listWindow, shapeInvoiceDetail, shapeList, shapeToolResult } from "../src/tool-results.js";
import { agentContext, COMPANY, embeddedAvailable, seedClient, SETTINGS, startHarness, userContext, type Harness } from "./helpers/harness.js";

const available = await embeddedAvailable();
const RUN = { agentId: "agent-am", runId: "run-1", companyId: COMPANY, projectId: "p" };

const invoices = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `inv-${i}`, number: `LUM-${String(i + 1).padStart(3, "0")}`, customerKind: "company", customerRef: "c-1", customerName: "Lumen", status: "sent", currency: "ZAR", totalMinor: 115_000, outstandingMinor: 115_000, dueAt: "2026-10-30", notes: "x".repeat(400), sendTo: [{ email: "ap@lumen.test" }], approvalIssueId: null, createdAt: "2026-10-01" }));

describe("windowing", () => {
  it("defaults to 50 rows, never above 200, and treats nonsense as the default", () => {
    expect(listWindow({})).toEqual({ limit: LIST_DEFAULT_LIMIT, offset: 0, compact: true });
    expect(listWindow({ limit: 5000 }).limit).toBe(LIST_MAX_LIMIT);
    expect(listWindow({ limit: 0 }).limit).toBe(1);
    expect(listWindow({ limit: "abc", offset: -4 })).toEqual({ limit: LIST_DEFAULT_LIMIT, offset: 0, compact: true });
    expect(listWindow({ compact: false }).compact).toBe(false);
  });

  it("returns a page with the total, says when there is more and how to ask for it", () => {
    const page = shapeList("list-open-invoices", invoices(7), { limit: 3 });
    expect(page).toMatchObject({ mode: "compact", total: 7, count: 3, offset: 0, more: true });
    expect(page.next).toBe("4 more. Ask again with offset 3, or narrow the request (client, status).");
    const last = shapeList("list-open-invoices", invoices(7), { limit: 3, offset: 6 });
    expect(last).toMatchObject({ count: 1, offset: 6 });
    expect(last).not.toHaveProperty("more");
    expect(shapeList("list-open-invoices", [], {})).toEqual({ mode: "compact", total: 0, count: 0, offset: 0, items: [] });
  });

  it("keeps only the fields a decision needs and folds the client into one text", () => {
    const [row] = shapeList("list-open-invoices", invoices(1), {}).items;
    expect(row).toEqual({ id: "inv-0", number: "LUM-001", client: "company:c-1", customerName: "Lumen", status: "sent", currency: "ZAR", totalMinor: 115_000, outstandingMinor: 115_000, dueAt: "2026-10-30" });
    expect(JSON.stringify(row).length).toBeLessThan(JSON.stringify(invoices(1)[0]).length / 2);
  });

  it("gives the full rows with compact false, still windowed", () => {
    const full = shapeList("list-open-invoices", invoices(60), { compact: false });
    expect(full).toMatchObject({ mode: "full", count: 50, total: 60, more: true });
    expect(full.items[0]).toHaveProperty("notes");
  });

  it("shapes retainers as two lists and leaves other tools alone", () => {
    const shaped = shapeToolResult("list-retainers", { plans: [{ id: "p", name: "Growth", priceMinor: 100, currency: "ZAR", period: "monthly", active: true, description: "long text" }], subscriptions: [{ id: "s", customerKind: "company", customerRef: "c-1", status: "active", description: "x" }] }, {}) as { plans: { items: Array<Record<string, unknown>> }; subscriptions: { items: Array<Record<string, unknown>> } };
    expect(shaped.plans.items[0]).toEqual({ id: "p", name: "Growth", priceMinor: 100, currency: "ZAR", period: "monthly", active: true });
    expect(shaped.subscriptions.items[0]).toEqual({ id: "s", client: "company:c-1", description: "x", status: "active" });
    expect(shapeToolResult("create-invoice", { id: "x", big: "y" }, {})).toEqual({ id: "x", big: "y" });
  });

  it("every list tool declares the window parameters and has a projection", () => {
    for (const name of LIST_TOOLS) {
      const tool = BILLING_TOOLS.find((t) => t.name === name)!;
      const props = (tool.parametersSchema as { properties: Record<string, unknown> }).properties;
      expect(Object.keys(props), name).toEqual(expect.arrayContaining(["limit", "offset", "compact"]));
    }
    expect(DETAIL_SECTIONS).toContain("refunds");
  });
});

describe("invoice detail", () => {
  const detail = {
    invoice: { id: "i1", number: "LUM-001", status: "sent", currency: "ZAR", customerKind: "contact", customerRef: "ct", customerName: "Lumen", totalMinor: 115_000, outstandingMinor: 115_000, createdAt: "2026-10-01", notes: "long", sendTo: [{ email: "a@b.c" }] },
    lines: [{ id: "l1", description: "Work", quantity: 1, unitAmountMinor: 100_000, taxCode: "za_std_15", netMinor: 100_000, vatMinor: 15_000, grossMinor: 115_000, fromTime: false }],
    payments: [{ id: "p1", amountMinor: 5_000, allocatedMinor: 5_000, method: "eft", reference: "r", source: "manual", paidAt: "2026-10-02", bankTxId: null, ledgerStatus: "posted", journalNumber: "JNL-1" }],
    paymentLinks: [{ id: "k1", provider: "stripe", label: "Card (Stripe)", status: "active", amountMinor: 110_000, url: "https://buy.stripe.com/x", lastError: null }],
    recipients: [{ email: "ap@lumen.test", name: "Lumen" }],
    groups: [{ taxCode: "za_std_15" }], credits: [], creditNotes: [{ id: "c" }], pops: [], deliveries: [{ key: "d1" }, { key: "d2" }], reminders: [], followUps: [{ id: "f" }], refunds: [], customerCredit: [],
  };

  it("is compact by default: the invoice, lines, payments, links, recipients and counts of the rest", () => {
    const out = shapeInvoiceDetail(detail, {});
    expect(out.invoice).toEqual({ id: "i1", number: "LUM-001", status: "sent", currency: "ZAR", client: "contact:ct", customerName: "Lumen", totalMinor: 115_000, outstandingMinor: 115_000 });
    expect(out.lines).toEqual([{ id: "l1", description: "Work", quantity: 1, unitAmountMinor: 100_000, taxCode: "za_std_15", grossMinor: 115_000 }]);
    expect(out.payments).toEqual([{ id: "p1", amountMinor: 5_000, allocatedMinor: 5_000, method: "eft", reference: "r", source: "manual", paidAt: "2026-10-02" }]);
    expect(out.paymentLinks).toEqual([{ id: "k1", provider: "stripe", label: "Card (Stripe)", status: "active", amountMinor: 110_000, url: "https://buy.stripe.com/x" }]);
    expect(out.recipients).toEqual(["ap@lumen.test"]);
    expect(out.counts).toEqual({ credits: 0, creditNotes: 1, pops: 0, deliveries: 2, reminders: 0, followUps: 1, refunds: 0 });
    expect(out).not.toHaveProperty("deliveries");
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(detail).length);
  });

  it("adds the sections asked for, and gives everything with compact false", () => {
    expect(shapeInvoiceDetail(detail, { sections: ["deliveries", "followUps", "nonsense"] })).toMatchObject({ deliveries: [{ key: "d1" }, { key: "d2" }], followUps: [{ id: "f" }] });
    expect(shapeInvoiceDetail(detail, { sections: ["deliveries"] })).not.toHaveProperty("creditNotes");
    expect(shapeInvoiceDetail(detail, { compact: false })).toBe(detail);
  });
});

describe.skipIf(!available)("through the agent tools (postgres)", () => {
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

  const tool = async (name: string, params: Record<string, unknown>) => (await h.tools.get(name)!(params, RUN)) as { data: Record<string, any>; error?: string };

  it("pages a long list of open invoices and keeps the page's own action unshaped", async () => {
    for (let i = 0; i < 5; i += 1) {
      const invoice = (await tool("create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen", notes: "n".repeat(300) })).data as { id: string };
      await tool("add-line", { invoiceId: invoice.id, description: "Work", quantity: 1, unitAmountMinor: 10_000 });
      await h.call("billing.mark-sent", { invoiceId: invoice.id });
    }
    const first = (await tool("list-open-invoices", { limit: 2 })).data;
    expect(first).toMatchObject({ mode: "compact", total: 5, count: 2, more: true });
    expect(first.items[0]).toMatchObject({ number: expect.stringMatching(/^LUM-/), client: "contact:ct-lumen", outstandingMinor: 11_500 });
    expect(first.items[0]).not.toHaveProperty("notes");
    const rest = (await tool("list-open-invoices", { limit: 2, offset: 2 })).data;
    expect(rest.items.map((i: { id: string }) => i.id)).not.toEqual(expect.arrayContaining(first.items.map((i: { id: string }) => i.id)));
    expect((await tool("list-open-invoices", { limit: 2, offset: 4 })).data).toMatchObject({ count: 1 });
    // Full rows on request, by the same call.
    expect((await tool("list-open-invoices", { limit: 1, compact: false })).data.items[0]).toHaveProperty("notes");
    // The page's action still returns the plain list.
    const page = await h.call<unknown[]>("billing.open-invoices", {}, userContext());
    expect(Array.isArray(page)).toBe(true);
    expect(page).toHaveLength(5);
    void agentContext;
  });

  it("detail by id: compact first, a section on request, everything with compact false", async () => {
    const invoice = (await tool("create-invoice", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" })).data as { id: string };
    await tool("add-line", { invoiceId: invoice.id, description: "Work", quantity: 1, unitAmountMinor: 10_000 });
    await h.call("billing.mark-sent", { invoiceId: invoice.id });
    const compact = (await tool("invoice-detail", { invoiceId: invoice.id })).data;
    expect(compact).toMatchObject({ mode: "compact", invoice: { number: "LUM-001", status: "sent" }, paymentLinks: [], counts: { deliveries: 0 } });
    expect(compact).not.toHaveProperty("groups");
    expect((await tool("invoice-detail", { invoiceId: invoice.id, sections: ["groups"] })).data.groups).toHaveLength(1);
    expect((await tool("invoice-detail", { invoiceId: invoice.id, compact: false })).data).toHaveProperty("followUps");
  });

  it("shapes the other list tools too (quotes, bills, credit notes, proofs, time, recurring, retainers)", async () => {
    const quote = (await tool("create-quote", { currency: "ZAR", customerKind: "contact", customerRef: "ct-lumen" })).data as { id: string };
    await tool("add-quote-line", { quoteId: quote.id, description: "Audit", quantity: 1, unitAmountMinor: 20_000 });
    const quotes = (await tool("list-quotes", {})).data;
    expect(quotes).toMatchObject({ mode: "compact", total: 1 });
    expect(quotes.items[0]).toEqual({ id: quote.id, number: "Q-LUM-001", client: "contact:ct-lumen", customerName: "Lumen Digital", status: "draft", currency: "ZAR", totalMinor: 23_000 });
    for (const name of ["list-bills", "list-credit-notes", "list-proofs-of-payment", "list-time-entries", "list-recurring-invoices"]) {
      expect((await tool(name, {})).data, name).toMatchObject({ mode: "compact", total: 0, items: [] });
    }
    expect((await tool("list-retainers", {})).data).toMatchObject({ plans: { mode: "compact", total: 0 }, subscriptions: { mode: "compact", total: 0 } });
  });
});
