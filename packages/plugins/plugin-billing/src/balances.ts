/**
 * What each invoice owes, derived from the stored rows: payments allocated
 * to it, credit applied (credit notes, a customer's overpayment) and
 * write-offs. Status follows from those sums (`deriveInvoiceStatus`), so a
 * repeated or interrupted operation converges on the same answer.
 *
 * Every write is one statement. Credit is applied with a guarded
 * INSERT … SELECT … WHERE so it never exceeds what is owed or available.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { INVOICE_COLUMNS, table, type CreditNoteRow, type InvoiceRow } from "./db.js";
import { balanceOutstanding, deriveInvoiceStatus, OPEN_STATUSES, type BalanceState, type InvoiceStatusValue } from "./domain.js";

export interface InvoiceBalanceRow extends InvoiceRow {
  paid_minor: number | string | null;
  payment_count: number | string | null;
  credited_minor: number | string | null;
  written_off_minor: number | string | null;
  pending_pops: number | string | null;
}

export interface InvoiceBalance {
  invoice: InvoiceRow;
  state: BalanceState;
  outstandingMinor: number;
}

const OPEN_SQL = OPEN_STATUSES.map((s) => `'${s}'`).join(", ");

export function balanceSelect(ctx: PluginContext): string {
  return `SELECT ${INVOICE_COLUMNS.split(",").map((c) => `i.${c.trim()}`).join(", ")},
            COALESCE((SELECT sum(COALESCE(p.allocated_minor, p.amount_minor)) FROM ${table(ctx, "payments")} p WHERE p.invoice_id = i.id), 0) AS paid_minor,
            (SELECT count(*) FROM ${table(ctx, "payments")} p WHERE p.invoice_id = i.id) AS payment_count,
            COALESCE((SELECT sum(a.amount_minor) FROM ${table(ctx, "credit_applications")} a WHERE a.invoice_id = i.id AND a.source_kind <> 'write_off'), 0) AS credited_minor,
            COALESCE((SELECT sum(a.amount_minor) FROM ${table(ctx, "credit_applications")} a WHERE a.invoice_id = i.id AND a.source_kind = 'write_off'), 0) AS written_off_minor,
            (SELECT count(*) FROM ${table(ctx, "pops")} o WHERE o.invoice_id = i.id AND o.status = 'pending') AS pending_pops
       FROM ${table(ctx, "invoices")} i`;
}

export function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

export function toBalance(row: InvoiceBalanceRow): InvoiceBalance {
  const state: BalanceState = {
    status: row.status,
    totalMinor: Number(row.total_minor),
    paidMinor: Number(row.paid_minor ?? 0),
    creditedMinor: Number(row.credited_minor ?? 0),
    writtenOffMinor: Number(row.written_off_minor ?? 0),
    pendingPops: Number(row.pending_pops ?? 0),
    paymentCount: Number(row.payment_count ?? 0),
    dueAt: iso(row.due_at),
  };
  return { invoice: row, state, outstandingMinor: balanceOutstanding(state) };
}

export async function invoiceBalance(ctx: PluginContext, invoiceId: string): Promise<InvoiceBalance | null> {
  const rows = await ctx.db.query<InvoiceBalanceRow>(`${balanceSelect(ctx)} WHERE i.id = $1`, [invoiceId]);
  return rows[0] ? toBalance(rows[0]) : null;
}

/** Balances for a company, optionally one customer and/or only open invoices. */
export async function invoiceBalances(
  ctx: PluginContext,
  companyId: string,
  filter: { customerKind?: string; customerRef?: string; openOnly?: boolean; ids?: string[] } = {},
): Promise<InvoiceBalance[]> {
  const where = ["i.company_id = $1"];
  const params: unknown[] = [companyId];
  if (filter.customerRef) {
    params.push(filter.customerKind ?? "company", filter.customerRef);
    where.push(`i.customer_kind = $${params.length - 1} AND i.customer_ref = $${params.length}`);
  }
  if (filter.openOnly) where.push(`i.status IN (${OPEN_SQL})`);
  if (filter.ids) {
    params.push(JSON.stringify(filter.ids));
    where.push(`i.id IN (SELECT jsonb_array_elements_text($${params.length}::jsonb))`);
  }
  const rows = await ctx.db.query<InvoiceBalanceRow>(`${balanceSelect(ctx)} WHERE ${where.join(" AND ")} ORDER BY i.created_at DESC`, params);
  return rows.map(toBalance);
}

/**
 * Re-derive the invoice status from its sums and store it (one UPDATE).
 * Returns the status and whether it changed.
 */
export async function refreshInvoiceStatus(ctx: PluginContext, invoiceId: string, now = new Date()): Promise<{ status: InvoiceStatusValue; changed: boolean; balance: InvoiceBalance } | null> {
  const balance = await invoiceBalance(ctx, invoiceId);
  if (!balance) return null;
  const next = deriveInvoiceStatus(balance.state, now);
  if (next === balance.invoice.status) return { status: next, changed: false, balance };
  await ctx.db.execute(
    `UPDATE ${table(ctx, "invoices")}
        SET status = $2,
            paid_at = CASE WHEN $2 = 'paid' THEN COALESCE(paid_at, now()) ELSE paid_at END,
            updated_at = now()
      WHERE id = $1 AND status NOT IN ('draft', 'cancelled')`,
    [invoiceId, next],
  );
  balance.invoice.status = next;
  return { status: next, changed: true, balance: { ...balance, state: { ...balance.state, status: next }, outstandingMinor: balanceOutstanding({ ...balance.state, status: next }) } };
}

// ── Credit ─────────────────────────────────────────────────────────────────

export type CreditSourceKind = "credit_note" | "payment" | "write_off";

const OWED_SQL = (ctx: PluginContext, invoiceParam: number) => `(SELECT i.total_minor
          - COALESCE((SELECT sum(COALESCE(p.allocated_minor, p.amount_minor)) FROM ${table(ctx, "payments")} p WHERE p.invoice_id = i.id), 0)
          - COALESCE((SELECT sum(a.amount_minor) FROM ${table(ctx, "credit_applications")} a WHERE a.invoice_id = i.id), 0)
         FROM ${table(ctx, "invoices")} i WHERE i.id = $${invoiceParam}::text AND i.status IN (${OPEN_SQL}))`;

function availableSql(ctx: PluginContext, kind: CreditSourceKind, sourceParam: number): string | null {
  if (kind === "credit_note") {
    return `(SELECT n.amount_minor - COALESCE((SELECT sum(a.amount_minor) FROM ${table(ctx, "credit_applications")} a WHERE a.source_kind = 'credit_note' AND a.source_id = n.id), 0)
         FROM ${table(ctx, "credit_notes")} n WHERE n.id = $${sourceParam}::text)`;
  }
  if (kind === "payment") {
    return `(SELECT p.amount_minor - COALESCE(p.allocated_minor, p.amount_minor) - COALESCE((SELECT sum(a.amount_minor) FROM ${table(ctx, "credit_applications")} a WHERE a.source_kind = 'payment' AND a.source_id = p.id), 0)
         FROM ${table(ctx, "payments")} p WHERE p.id = $${sourceParam}::text)`;
  }
  return null;
}

/**
 * Apply credit to an invoice in one guarded statement: nothing is written
 * when the amount exceeds what the invoice owes or what the source has left.
 * Idempotent by `key`. Returns true when a row was written.
 */
export async function applyCredit(
  ctx: PluginContext,
  input: { companyId: string; invoiceId: string; sourceKind: CreditSourceKind; sourceId: string; amountMinor: number; key: string; createdBy?: string | null },
): Promise<boolean> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) return false;
  const available = availableSql(ctx, input.sourceKind, 6);
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "credit_applications")} (id, company_id, key, invoice_id, source_kind, source_id, amount_minor, created_by)
     SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::bigint, $8::text
      WHERE $7::bigint <= ${OWED_SQL(ctx, 4)}${available ? `
        AND $7::bigint <= ${available}` : ""}
     ON CONFLICT DO NOTHING`,
    [randomUUID(), input.companyId, input.key, input.invoiceId, input.sourceKind, input.sourceId, input.amountMinor, input.createdBy ?? null],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function creditNoteAvailable(ctx: PluginContext, creditNoteId: string): Promise<number> {
  const rows = await ctx.db.query<{ available: string | number | null }>(
    `SELECT n.amount_minor - COALESCE((SELECT sum(a.amount_minor) FROM ${table(ctx, "credit_applications")} a WHERE a.source_kind = 'credit_note' AND a.source_id = n.id), 0) AS available
       FROM ${table(ctx, "credit_notes")} n WHERE n.id = $1`,
    [creditNoteId],
  );
  return Math.max(0, Number(rows[0]?.available ?? 0));
}

/** Mark a credit note applied when nothing is left on it. */
export async function syncCreditNoteStatus(ctx: PluginContext, creditNoteId: string): Promise<void> {
  const left = await creditNoteAvailable(ctx, creditNoteId);
  await ctx.db.execute(`UPDATE ${table(ctx, "credit_notes")} SET status = $2 WHERE id = $1`, [creditNoteId, left > 0 ? "issued" : "applied"]);
}

/** Apply this invoice's own credit notes that still have credit left (up to what is owed). */
export async function applyOwnCreditNotes(ctx: PluginContext, invoiceId: string, createdBy?: string | null): Promise<number> {
  const notes = await ctx.db.query<Pick<CreditNoteRow, "id" | "company_id" | "amount_minor">>(
    `SELECT id, company_id, amount_minor FROM ${table(ctx, "credit_notes")} WHERE invoice_id = $1 ORDER BY created_at`,
    [invoiceId],
  );
  let applied = 0;
  for (const note of notes) {
    const balance = await invoiceBalance(ctx, invoiceId);
    if (!balance || balance.outstandingMinor <= 0) break;
    const left = await creditNoteAvailable(ctx, note.id);
    const amount = Math.min(left, balance.outstandingMinor);
    if (amount <= 0) continue;
    const ok = await applyCredit(ctx, {
      companyId: note.company_id,
      invoiceId,
      sourceKind: "credit_note",
      sourceId: note.id,
      amountMinor: amount,
      key: `credit_note:${note.id}:${invoiceId}`,
      createdBy,
    });
    if (ok) applied += amount;
    await syncCreditNoteStatus(ctx, note.id);
  }
  return applied;
}

export interface CreditSource {
  sourceKind: "credit_note" | "payment";
  sourceId: string;
  availableMinor: number;
  currency: string;
  at: string | null;
  label: string;
}

/** A customer's unused credit: overpayments and credit-note remainders. */
export async function customerCredit(ctx: PluginContext, companyId: string, customerKind: string, customerRef: string): Promise<CreditSource[]> {
  const rows = await ctx.db.query<{ source_kind: "credit_note" | "payment"; source_id: string; available: string | number; currency: string | null; at: unknown; label: string | null }>(
    `SELECT 'payment' AS source_kind, p.id AS source_id,
            p.amount_minor - COALESCE(p.allocated_minor, p.amount_minor)
              - COALESCE((SELECT sum(a.amount_minor) FROM ${table(ctx, "credit_applications")} a WHERE a.source_kind = 'payment' AND a.source_id = p.id), 0) AS available,
            p.currency, p.paid_at AS at, COALESCE(p.reference, p.method) AS label
       FROM ${table(ctx, "payments")} p
      WHERE p.company_id = $1 AND p.customer_kind = $2 AND p.customer_ref = $3
     UNION ALL
     SELECT 'credit_note' AS source_kind, n.id AS source_id,
            n.amount_minor - COALESCE((SELECT sum(a.amount_minor) FROM ${table(ctx, "credit_applications")} a WHERE a.source_kind = 'credit_note' AND a.source_id = n.id), 0) AS available,
            n.currency, n.created_at AS at, COALESCE(n.number, n.reason) AS label
       FROM ${table(ctx, "credit_notes")} n
      WHERE n.company_id = $1 AND n.customer_kind = $2 AND n.customer_ref = $3`,
    [companyId, customerKind, customerRef],
  );
  return rows
    .map((row) => ({
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      availableMinor: Number(row.available ?? 0),
      currency: row.currency ?? "ZAR",
      at: iso(row.at),
      label: row.label ?? (row.source_kind === "payment" ? "Overpayment" : "Credit note"),
    }))
    .filter((row) => row.availableMinor > 0);
}
