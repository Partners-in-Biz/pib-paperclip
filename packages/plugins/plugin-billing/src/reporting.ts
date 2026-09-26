/** Loads the rows for the Reports tab and runs the pure report functions. */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { invoiceBalances, iso } from "./balances.js";
import { reportingCurrency, type BillingSettings } from "./config.js";
import { asObject, listRecurring, table } from "./db.js";
import { storedRates, rateFrom } from "./fx.js";
import { billBalanceSelect, billOutstanding, type BillBalanceRow } from "./openitems.js";
import { ageing, converterFor, expenseSummary, mrrMetrics, revenueByClient, revenueByMonth, type ExpenseItem, type RecurringRevenue, type RevenuePayment } from "./reports.js";
import { allSubscriptions } from "./retainers.js";

export async function latestRates(ctx: PluginContext, book: string, currencies: string[]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  const fx = await storedRates(ctx, book, new Date().toISOString().slice(0, 10)).catch(() => null);
  for (const currency of new Set(currencies)) out[currency] = currency === book ? 1 : fx ? rateFrom(fx, currency) : null;
  return out;
}

function clientKey(kind: string | null, ref: string | null): string {
  return ref ? `${kind ?? "company"}:${ref}` : "none";
}

export async function buildReports(ctx: PluginContext, companyId: string, settings: BillingSettings, range: { from: string; to: string }, now = new Date()) {
  const book = reportingCurrency(settings);
  const balances = await invoiceBalances(ctx, companyId);
  const payments = await ctx.db.query<{ invoice_id: string; allocated_minor: string | number | null; amount_minor: string | number; paid_at: unknown; currency: string | null; fx_rate: string | number | null; customer_kind: string | null; customer_ref: string | null }>(
    `SELECT invoice_id, allocated_minor, amount_minor, paid_at, currency, fx_rate, customer_kind, customer_ref FROM ${table(ctx, "payments")} WHERE company_id = $1`,
    [companyId],
  );
  const bills = await ctx.db.query<BillBalanceRow>(`${billBalanceSelect(ctx)} WHERE b.company_id = $1`, [companyId]);
  const expenses = await ctx.db.query<{ category: string; currency: string; amount_minor: string | number; vat_minor: string | number | null; vat_claimable: boolean | null; incurred_on: unknown; fx_rate: string | number | null; status: string | null }>(
    `SELECT category, currency, amount_minor, vat_minor, vat_claimable, incurred_on, fx_rate, status FROM ${table(ctx, "expenses")} WHERE company_id = $1`,
    [companyId],
  );
  const subs = await allSubscriptions(ctx, companyId);
  const recurring = await listRecurring(ctx, companyId);
  const currencies = [
    ...balances.map((b) => b.invoice.currency),
    ...bills.map((b) => b.currency),
    ...expenses.map((e) => e.currency),
    ...subs.map((s) => s.currency),
  ];
  const convert = converterFor(book, await latestRates(ctx, book, currencies));
  const byInvoice = new Map(balances.map((b) => [b.invoice.id, b]));
  const nameOf = (id: string) => {
    const b = byInvoice.get(id);
    return b ? String(asObject(b.invoice.customer_snapshot ?? b.invoice.customer).name ?? b.invoice.customer_ref) : "";
  };
  const revenuePayments: RevenuePayment[] = payments
    .filter((p) => byInvoice.has(p.invoice_id))
    .map((p) => ({
      invoiceId: p.invoice_id,
      currency: p.currency ?? byInvoice.get(p.invoice_id)!.invoice.currency,
      paidAt: iso(p.paid_at) ?? new Date().toISOString(),
      allocatedMinor: Number(p.allocated_minor ?? p.amount_minor),
      fxRate: p.fx_rate == null ? null : Number(p.fx_rate),
      clientKey: clientKey(p.customer_kind, p.customer_ref),
      clientName: nameOf(p.invoice_id),
    }));
  const revenueInvoices = balances.map((b) => ({
    id: b.invoice.id,
    status: b.invoice.status,
    currency: b.invoice.currency,
    sentAt: iso(b.invoice.sent_at),
    subtotalMinor: Number(b.invoice.subtotal_minor ?? b.invoice.total_minor),
    vatMinor: Number(b.invoice.vat_minor ?? 0),
    totalMinor: Number(b.invoice.total_minor),
    fxRate: b.invoice.fx_rate == null ? null : Number(b.invoice.fx_rate),
    clientKey: clientKey(b.invoice.customer_kind, b.invoice.customer_ref),
    clientName: String(asObject(b.invoice.customer_snapshot ?? b.invoice.customer).name ?? b.invoice.customer_ref),
  }));
  const debtors = ageing(
    balances.map((b) => ({
      id: b.invoice.id,
      number: b.invoice.number,
      party: String(asObject(b.invoice.customer_snapshot ?? b.invoice.customer).name ?? b.invoice.customer_ref),
      partyKey: clientKey(b.invoice.customer_kind, b.invoice.customer_ref),
      currency: b.invoice.currency,
      outstandingMinor: b.outstandingMinor,
      dueAt: iso(b.invoice.due_at),
      fxRate: b.invoice.fx_rate == null ? null : Number(b.invoice.fx_rate),
    })),
    now,
    book,
    convert,
  );
  const creditors = ageing(
    bills.map((b) => ({
      id: b.id,
      number: b.supplier_reference ?? b.id.slice(0, 8),
      party: b.supplier_name,
      partyKey: b.supplier_ref ? `${b.supplier_kind}:${b.supplier_ref}` : `text:${b.supplier_name.toLowerCase()}`,
      currency: b.currency,
      outstandingMinor: billOutstanding(b),
      dueAt: iso(b.due_date),
      fxRate: b.fx_rate == null ? null : Number(b.fx_rate),
    })),
    now,
    book,
    convert,
  );
  const expenseItems: ExpenseItem[] = [
    ...expenses
      .filter((e) => e.status !== "void" && e.status !== "draft")
      .map((e) => ({ category: e.category, currency: e.currency, amountMinor: Number(e.amount_minor), vatMinor: Number(e.vat_minor ?? 0), vatClaimable: Boolean(e.vat_claimable), date: iso(e.incurred_on), fxRate: e.fx_rate == null ? null : Number(e.fx_rate), source: "expense" as const })),
    ...bills
      .filter((b) => b.status !== "draft" && b.status !== "cancelled")
      .map((b) => ({ category: b.category ?? "other", currency: b.currency, amountMinor: Number(b.total_minor), vatMinor: Number(b.vat_minor ?? 0), vatClaimable: Number(b.vat_minor ?? 0) > 0, date: iso(b.issue_date ?? b.created_at), fxRate: b.fx_rate == null ? null : Number(b.fx_rate), source: "bill" as const })),
  ];
  const recurringItems: RecurringRevenue[] = [
    ...subs.map((s) => ({ status: s.status as RecurringRevenue["status"], priceMinor: Number(s.price_minor), currency: s.currency, period: s.period, startedAt: iso(s.started_at) ?? now.toISOString(), cancelledAt: iso(s.cancelled_at) })),
    ...recurring
      .map((r) => ({ r, template: byInvoice.get(r.template_invoice_id) }))
      .filter((x) => x.template)
      .map(({ r, template }) => ({
        status: (r.is_active ? "active" : "paused") as RecurringRevenue["status"],
        priceMinor: Number(template!.invoice.subtotal_minor ?? template!.invoice.total_minor),
        currency: template!.invoice.currency,
        period: r.frequency,
        startedAt: iso(template!.invoice.created_at) ?? now.toISOString(),
        cancelledAt: null,
      })),
  ];
  return {
    currency: book,
    range,
    revenue: revenueByMonth({ invoices: revenueInvoices, payments: revenuePayments, from: range.from, to: range.to, book, convert }),
    clients: revenueByClient({
      invoices: balances.map((b) => ({
        clientKey: clientKey(b.invoice.customer_kind, b.invoice.customer_ref),
        clientName: String(asObject(b.invoice.customer_snapshot ?? b.invoice.customer).name ?? b.invoice.customer_ref),
        currency: b.invoice.currency,
        status: b.invoice.status,
        sentAt: iso(b.invoice.sent_at),
        subtotalMinor: Number(b.invoice.subtotal_minor ?? b.invoice.total_minor),
        outstandingMinor: b.outstandingMinor,
        fxRate: b.invoice.fx_rate == null ? null : Number(b.invoice.fx_rate),
      })),
      payments: revenuePayments,
      from: range.from,
      to: range.to,
      book,
      convert,
    }),
    agedDebtors: debtors,
    agedCreditors: creditors,
    expenses: expenseSummary({ items: expenseItems, from: range.from, to: range.to, book, convert }),
    mrr: mrrMetrics({ items: recurringItems, now, book, convert }),
  };
}
