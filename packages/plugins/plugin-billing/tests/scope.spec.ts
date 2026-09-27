import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import { AS_AT_CUTOFF_SQL, customerLastPaidAt, listCreditNotes, listInvoices, listQuotes, listRecurring } from "../src/db.js";
import { clientBillingSummary, dayText, formatMoney, isOverdueInvoice, outstandingMinor, shortDayText, type SummaryInvoice } from "../src/domain.js";
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

  it("reads one customer's last payment as at today, ignoring payments dated later", async () => {
    const { ctx, calls } = fakeCtx([{ at: "2026-09-26T11:51:52.903Z" }]);
    expect(await customerLastPaidAt(ctx, "w", ada)).toBe("2026-09-26T11:51:52.903Z");
    const sql = compact(calls[0]!.sql);
    expect(sql).toContain(`FROM ${NAMESPACE}.payments p WHERE p.company_id = $1 AND p.customer_kind = $2 AND p.customer_ref = $3 AND p.paid_at < ${AS_AT_CUTOFF_SQL}`);
    expect(sql).toContain("i.status = 'paid'");
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
    expect(summary.headline).toBe("R 12,400.00 outstanding");
    expect(summary.stats[0]).toEqual({ label: "Outstanding", value: "R 12,400.00" });
    expect(summary.stats[1]).toEqual({ label: "Overdue invoices", value: 1, tone: "bad" });
    expect(summary.stats[2]).toEqual({ label: "Open quotes", value: 2 });
    expect(summary.stats[3]).toEqual({ label: "Last paid", value: "14 Sep" });
    const lastYear = clientBillingSummary({ now, invoices: [invoice({ status: "paid", totalMinor: 1, lastPaidAt: "2025-12-01T09:00:00.000Z" })], quotes: [] });
    expect(lastYear.stats[3]).toEqual({ label: "Last paid", value: "1 Dec 2025" });
  });

  it("says which day the figures are for", () => {
    const summary = clientBillingSummary({ now, asOf: "2026-09-26", invoices: [invoice({ totalMinor: 750_000 })], quotes: [] });
    expect(summary.headline).toBe("R 7,500.00 outstanding as at 26 Sep");
    const settled = clientBillingSummary({ now, asOf: "2026-09-26", invoices: [invoice({ status: "paid", totalMinor: 100 })], quotes: [] });
    expect(settled.headline).toBe("Nothing outstanding as at 26 Sep");
  });

  it("adds up each currency on its own", () => {
    const summary = clientBillingSummary({
      now,
      invoices: [invoice({ totalMinor: 10_000 }), invoice({ currency: "USD", totalMinor: 2_500 })],
      quotes: [],
    });
    expect(summary.headline).toBe("R 100.00 + $25.00 outstanding");
  });

  it("says when nothing is owed and when there are no invoices", () => {
    const settled = clientBillingSummary({ now, invoices: [invoice({ status: "paid", totalMinor: 100 })], quotes: [] });
    expect(settled.headline).toBe("Nothing outstanding");
    expect(settled.stats[0]).toMatchObject({ tone: "ok" });
    expect(settled.stats[1]).toEqual({ label: "Overdue invoices", value: 0, tone: "ok" });
    const empty = clientBillingSummary({ now, invoices: [], quotes: [], defaultCurrency: "ZAR" });
    expect(empty.headline).toBe("No invoices");
    expect(empty.stats[0]!.value).toBe("R 0.00");
    expect(empty.stats[3]).toEqual({ label: "Last paid", value: "Never" });
  });
});

describe("worker-side money and dates", () => {
  it("shows rand as R with the amount (never ZAR), other currencies by symbol or code", () => {
    expect(formatMoney(750_000, "ZAR")).toBe("R 7,500.00");
    expect(formatMoney(-12_345, "zar")).toBe("-R 123.45");
    expect(formatMoney(120_000, "USD")).toBe("$1,200.00");
    expect(formatMoney(120_000, "CHF")).toBe("CHF 1,200.00");
  });

  it("writes days as 14 Sep 2026, and the short form without this year", () => {
    expect(dayText("2026-09-14")).toBe("14 Sep 2026");
    expect(dayText("2026-09-28T00:00:00.000Z")).toBe("28 Sep 2026");
    expect(dayText(null)).toBe("–");
    expect(shortDayText("2026-09-28", new Date("2026-09-27T10:00:00Z"))).toBe("28 Sep");
    expect(shortDayText("2025-12-01", new Date("2026-09-27T10:00:00Z"))).toBe("1 Dec 2025");
  });
});
