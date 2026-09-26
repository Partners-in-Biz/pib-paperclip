import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import { customerInvoiceBalances, listCreditNotes, listInvoices, listQuotes, listRecurring } from "../src/db.js";
import { clientBillingSummary, isOverdueInvoice, outstandingMinor, type SummaryInvoice } from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";

function fakeCtx(rows: unknown[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return rows;
      },
      execute: async () => ({ rowCount: 0 }),
    },
  } as unknown as PluginContext;
  return { ctx, calls };
}

const compact = (sql: string) => sql.replace(/\s+/g, " ");
const ada = { kind: "contact" as const, id: "ct-ada" };
const acme = { kind: "company" as const, id: "co-acme" };

describe("billing load filter", () => {
  it("lists the whole book when no client is given", async () => {
    const { ctx, calls } = fakeCtx();
    await listInvoices(ctx, "w");
    await listQuotes(ctx, "w");
    expect(calls.map((call) => call.params)).toEqual([["w"], ["w"]]);
    expect(calls[0]!.sql).not.toContain("customer_kind =");
    expect(calls[1]!.sql).not.toContain("customer_kind =");
  });

  it("filters invoices and quotes to one customer, keeping partner shares inside the OR", async () => {
    const { ctx, calls } = fakeCtx();
    await listInvoices(ctx, "w", ada);
    await listQuotes(ctx, "w", acme);
    expect(compact(calls[0]!.sql)).toContain("WHERE (company_id = $1 OR id IN ( SELECT invoice_id FROM");
    expect(compact(calls[0]!.sql)).toContain(")) AND customer_kind = $2 AND customer_ref = $3");
    expect(calls[0]!.params).toEqual(["w", "contact", "ct-ada"]);
    expect(compact(calls[1]!.sql)).toContain("WHERE company_id = $1 AND customer_kind = $2 AND customer_ref = $3");
    expect(calls[1]!.params).toEqual(["w", "company", "co-acme"]);
  });

  it("filters recurring schedules and credit notes through their invoice's customer", async () => {
    const { ctx, calls } = fakeCtx();
    await listRecurring(ctx, "w", acme);
    await listCreditNotes(ctx, "w", acme);
    expect(compact(calls[0]!.sql)).toContain(`JOIN ${NAMESPACE}.invoices i ON i.id = r.template_invoice_id`);
    expect(compact(calls[0]!.sql)).toContain("WHERE r.company_id = $1 AND i.customer_kind = $2 AND i.customer_ref = $3");
    expect(compact(calls[1]!.sql)).toContain(`JOIN ${NAMESPACE}.invoices i ON i.id = n.invoice_id`);
    expect(calls[1]!.params).toEqual(["w", "company", "co-acme"]);
  });

  it("reads balances for one customer, skipping cancelled invoices", async () => {
    const { ctx, calls } = fakeCtx();
    await customerInvoiceBalances(ctx, "w", ada);
    const sql = compact(calls[0]!.sql);
    expect(sql).toContain(`FROM ${NAMESPACE}.payments p WHERE p.invoice_id = i.id`);
    expect(sql).toContain(`FROM ${NAMESPACE}.credit_notes c WHERE c.invoice_id = i.id`);
    expect(sql).toContain("i.customer_kind = $2 AND i.customer_ref = $3 AND i.status <> 'cancelled'");
    expect(calls[0]!.params).toEqual(["w", "contact", "ct-ada"]);
  });
});

describe("billing client summary", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  const invoice = (patch: Partial<SummaryInvoice>): SummaryInvoice => ({
    status: "sent",
    currency: "ZAR",
    totalMinor: 0,
    paidMinor: 0,
    creditedMinor: 0,
    dueAt: null,
    lastPaidAt: null,
    ...patch,
  });

  it("owes the total less payments and credits, only once sent", () => {
    expect(outstandingMinor(invoice({ totalMinor: 10_000, paidMinor: 2_500, creditedMinor: 500 }))).toBe(7_000);
    expect(outstandingMinor(invoice({ totalMinor: 10_000, paidMinor: 12_000 }))).toBe(0);
    expect(outstandingMinor(invoice({ status: "draft", totalMinor: 10_000 }))).toBe(0);
    expect(outstandingMinor(invoice({ status: "paid", totalMinor: 10_000 }))).toBe(0);
  });

  it("counts an invoice overdue by status or by a passed due date", () => {
    expect(isOverdueInvoice(invoice({ status: "overdue", totalMinor: 100 }), now)).toBe(true);
    expect(isOverdueInvoice(invoice({ totalMinor: 100, dueAt: "2026-09-20T00:00:00Z" }), now)).toBe(true);
    expect(isOverdueInvoice(invoice({ totalMinor: 100, dueAt: "2026-10-20T00:00:00Z" }), now)).toBe(false);
    expect(isOverdueInvoice(invoice({ status: "overdue", totalMinor: 100, paidMinor: 100 }), now)).toBe(false);
  });

  it("headlines what is outstanding and flags overdue invoices", () => {
    const summary = clientBillingSummary({
      now,
      invoices: [
        invoice({ totalMinor: 1_000_000, dueAt: "2026-09-01T00:00:00Z" }),
        invoice({ totalMinor: 300_000, paidMinor: 60_000 }),
        invoice({ status: "paid", totalMinor: 50_000, lastPaidAt: "2026-09-14T09:00:00.000Z" }),
        invoice({ status: "draft", totalMinor: 99_000 }),
      ],
      quotes: [{ status: "draft" }, { status: "sent" }, { status: "accepted" }, { status: "declined" }],
    });
    expect(summary.headline).toMatch(/^ZAR\s12,400\.00 outstanding$/);
    expect(summary.stats[0]).toMatchObject({ label: "Outstanding" });
    expect(String(summary.stats[0]!.value)).toMatch(/^ZAR\s12,400\.00$/);
    expect(summary.stats[1]).toEqual({ label: "Overdue invoices", value: 1, tone: "bad" });
    expect(summary.stats[2]).toEqual({ label: "Open quotes", value: 2 });
    expect(summary.stats[3]).toEqual({ label: "Last paid", value: "2026-09-14" });
  });

  it("adds up each currency on its own", () => {
    const summary = clientBillingSummary({
      now,
      invoices: [invoice({ totalMinor: 10_000 }), invoice({ currency: "USD", totalMinor: 2_500 })],
      quotes: [],
    });
    expect(summary.headline).toMatch(/^ZAR\s100\.00 \+ \$25\.00 outstanding$/);
  });

  it("says when nothing is owed and when there are no invoices", () => {
    const settled = clientBillingSummary({ now, invoices: [invoice({ status: "paid", totalMinor: 100 })], quotes: [] });
    expect(settled.headline).toBe("Nothing outstanding");
    expect(settled.stats[0]).toMatchObject({ tone: "ok" });
    expect(settled.stats[1]).toEqual({ label: "Overdue invoices", value: 0, tone: "ok" });
    const empty = clientBillingSummary({ now, invoices: [], quotes: [], defaultCurrency: "ZAR" });
    expect(empty.headline).toBe("No invoices");
    expect(String(empty.stats[0]!.value)).toMatch(/^ZAR\s0\.00$/);
    expect(empty.stats[3]).toEqual({ label: "Last paid", value: "Never" });
  });
});
