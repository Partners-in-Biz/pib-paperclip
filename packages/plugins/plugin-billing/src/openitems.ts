/**
 * Receivables and payables for Accounting's bank matching
 * (`open-item.upserted`). Emitted after every invoice or bill change, again
 * every 15 minutes for recent changes and nightly for everything still open
 * (plus what closed in the last few days), like the CRM projection.
 * Accounting upserts by key and keeps the newest `updatedAt`.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { OPEN_ITEM_EVENTS, type OpenItemUpserted } from "@partnersinbiz/pib-plugin-kit";
import { invoiceBalance, invoiceBalances, iso, type InvoiceBalance } from "./balances.js";
import { asObject, table } from "./db.js";

export interface BillBalanceRow {
  id: string;
  company_id: string;
  supplier_kind: string;
  supplier_ref: string | null;
  supplier_name: string;
  supplier_reference: string | null;
  status: string;
  currency: string;
  total_minor: number | string;
  paid_minor: number | string | null;
  issue_date: unknown;
  due_date: unknown;
  created_at: unknown;
  updated_at: unknown;
  fx_rate?: number | string | null;
  category?: string;
  vat_minor?: number | string | null;
}

function day(value: unknown): string | null {
  const stamp = iso(value);
  return stamp ? stamp.slice(0, 10) : null;
}

export function receivableItem(balance: InvoiceBalance): OpenItemUpserted {
  const invoice = balance.invoice;
  const customer = asObject(invoice.customer_snapshot ?? invoice.customer);
  const references = [invoice.number, invoice.number.replace(/-/g, "")];
  if (typeof customer.name === "string" && customer.name) references.push(customer.name);
  return {
    key: `invoice:${invoice.id}`,
    kind: "receivable",
    id: invoice.id,
    number: invoice.number,
    counterpartyName: typeof customer.name === "string" ? customer.name : invoice.customer_ref,
    clientKind: invoice.customer_kind === "contact" ? "contact" : "company",
    clientRef: invoice.customer_ref,
    currency: invoice.currency,
    totalMinor: Number(invoice.total_minor),
    outstandingMinor: balance.outstandingMinor,
    issueDate: day(invoice.sent_at ?? invoice.created_at) ?? new Date().toISOString().slice(0, 10),
    dueDate: day(invoice.due_at),
    references: [...new Set(references)],
    status: invoice.status,
    updatedAt: iso(invoice.updated_at) ?? new Date().toISOString(),
  };
}

export function billOutstanding(row: Pick<BillBalanceRow, "status" | "total_minor" | "paid_minor">): number {
  if (row.status !== "approved" && row.status !== "partially_paid") return 0;
  return Math.max(0, Number(row.total_minor) - Number(row.paid_minor ?? 0));
}

export function payableItem(row: BillBalanceRow): OpenItemUpserted {
  const references = [row.supplier_reference ?? "", row.supplier_name].filter(Boolean);
  return {
    key: `bill:${row.id}`,
    kind: "payable",
    id: row.id,
    number: row.supplier_reference ?? row.id.slice(0, 8),
    counterpartyName: row.supplier_name,
    clientKind: row.supplier_kind === "company" || row.supplier_kind === "contact" ? row.supplier_kind : null,
    clientRef: row.supplier_ref,
    currency: row.currency,
    totalMinor: Number(row.total_minor),
    outstandingMinor: billOutstanding(row),
    issueDate: day(row.issue_date ?? row.created_at) ?? new Date().toISOString().slice(0, 10),
    dueDate: day(row.due_date),
    references,
    status: row.status,
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
  };
}

export function billBalanceSelect(ctx: PluginContext): string {
  return `SELECT b.id, b.company_id, b.supplier_kind, b.supplier_ref, b.supplier_name, b.supplier_reference, b.status, b.currency,
                 b.total_minor, b.issue_date::text AS issue_date, b.due_date::text AS due_date, b.created_at, b.updated_at, b.fx_rate, b.category, b.vat_minor,
                 COALESCE((SELECT sum(p.allocated_minor) FROM ${table(ctx, "bill_payments")} p WHERE p.bill_id = b.id), 0) AS paid_minor
            FROM ${table(ctx, "bills")} b`;
}

async function emitItem(ctx: PluginContext, companyId: string, item: OpenItemUpserted): Promise<void> {
  try {
    await ctx.events.emit(OPEN_ITEM_EVENTS.upserted, companyId, item);
  } catch (error) {
    ctx.logger.info("Open item emit skipped", { key: item.key, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Emit one invoice (drafts are not receivables yet). */
export async function emitInvoiceItem(ctx: PluginContext, invoiceId: string): Promise<void> {
  const balance = await invoiceBalance(ctx, invoiceId);
  if (!balance || balance.invoice.status === "draft") return;
  await emitItem(ctx, balance.invoice.company_id, receivableItem(balance));
}

export async function emitBillItem(ctx: PluginContext, billId: string): Promise<void> {
  const rows = await ctx.db.query<BillBalanceRow>(`${billBalanceSelect(ctx)} WHERE b.id = $1`, [billId]);
  const row = rows[0];
  if (!row || row.status === "draft") return;
  await emitItem(ctx, row.company_id, payableItem(row));
}

/**
 * Re-emit for one company: items changed in the last `sinceSeconds`, or
 * (nightly, `null`) everything open plus what changed in the last 3 days.
 */
export async function emitOpenItems(ctx: PluginContext, companyId: string, sinceSeconds: number | null): Promise<number> {
  const window = sinceSeconds == null ? 3 * 86_400 : Math.max(60, Math.floor(sinceSeconds));
  const recent = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${table(ctx, "invoices")}
      WHERE company_id = $1 AND status <> 'draft'
        AND (updated_at > now() - make_interval(secs => $2::int)
             OR ($3::boolean AND status IN ('sent', 'viewed', 'overdue', 'partially_paid', 'payment_pending_verification')))`,
    [companyId, window, sinceSeconds == null],
  );
  let count = 0;
  const ids = recent.map((row) => row.id);
  for (let i = 0; i < ids.length; i += 200) {
    for (const balance of await invoiceBalances(ctx, companyId, { ids: ids.slice(i, i + 200) })) {
      await emitItem(ctx, companyId, receivableItem(balance));
      count += 1;
    }
  }
  const bills = await ctx.db.query<BillBalanceRow>(
    `${billBalanceSelect(ctx)}
      WHERE b.company_id = $1 AND b.status <> 'draft'
        AND (b.updated_at > now() - make_interval(secs => $2::int)
             OR ($3::boolean AND b.status IN ('approved', 'partially_paid')))`,
    [companyId, window, sinceSeconds == null],
  );
  for (const bill of bills) {
    await emitItem(ctx, companyId, payableItem(bill));
    count += 1;
  }
  return count;
}
