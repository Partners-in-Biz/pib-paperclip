/**
 * Time entries: a running timer per person or agent (start/stop), or time
 * logged by hand. Billable entries become invoice lines (hours × rate in
 * minor units, rounded to the cent).
 */
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { formatMoneyMinor } from "@partnersinbiz/pib-plugin-kit";
import { iso } from "./balances.js";
import { loadBilling } from "./config.js";
import { insertLine, table } from "./db.js";
import { BillingError } from "./domain.js";
import { assertEditableInvoice, recomputeInvoice, requireOwnInvoice, publicInvoice } from "./invoices.js";
import { roundDiv } from "./money.js";
import { actorLabel, currencyCode, integer, optionalBoolean, optionalDate, optionalInteger, optionalString, readClientScope, requiredCompany, requiredString } from "./util.js";

export interface TimeEntryRow {
  id: string;
  company_id: string;
  owner: string;
  description: string;
  customer_kind: string | null;
  customer_ref: string | null;
  customer_name: string | null;
  started_at: unknown;
  ended_at: unknown;
  minutes: number | string;
  rate_minor: number | string;
  currency: string;
  billable: boolean;
  invoice_id: string | null;
}

const COLUMNS = "id, company_id, owner, description, customer_kind, customer_ref, customer_name, started_at, ended_at, minutes, rate_minor, currency, billable, invoice_id";

/** Whole minutes between two times (at least 1 once a timer has run). */
export function minutesBetween(start: string, end: string): number {
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(1, Math.round(ms / 60_000));
}

/** minutes × hourly rate, in minor units. */
export function timeAmountMinor(minutes: number, rateMinor: number): number {
  if (minutes <= 0 || rateMinor <= 0) return 0;
  return roundDiv(minutes * rateMinor, 60);
}

export function hoursLabel(minutes: number): string {
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(2).replace(/0$/, "")} h`;
}

export function timeLineDescription(entry: { description: string; minutes: number; rateMinor: number; currency: string; startedAt: string | null }): string {
  const day = entry.startedAt ? ` (${entry.startedAt.slice(0, 10)})` : "";
  return `${entry.description}${day}: ${hoursLabel(entry.minutes)} @ ${formatMoneyMinor(entry.rateMinor, entry.currency)}/h`;
}

function ownerOf(context: PluginPerformActionContext, params: Record<string, unknown>): string {
  const explicit = optionalString(params, "owner");
  if (explicit) return explicit.slice(0, 120);
  return actorLabel(context) ?? "unknown";
}

export function publicEntry(row: TimeEntryRow) {
  const running = row.ended_at == null;
  const minutes = running ? minutesBetween(String(iso(row.started_at)), new Date().toISOString()) : Number(row.minutes);
  return {
    id: row.id,
    owner: row.owner,
    description: row.description,
    customerKind: row.customer_kind,
    customerRef: row.customer_ref,
    customerName: row.customer_name,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    running,
    minutes,
    rateMinor: Number(row.rate_minor),
    currency: row.currency,
    amountMinor: row.billable ? timeAmountMinor(minutes, Number(row.rate_minor)) : 0,
    billable: row.billable,
    invoiceId: row.invoice_id,
  };
}

async function clientName(ctx: PluginContext, companyId: string, kind: string, ref: string): Promise<string | null> {
  const tableName = kind === "contact" ? "crm_contacts" : "crm_companies";
  const rows = await ctx.db.query<{ name: string }>(`SELECT name FROM ${table(ctx, tableName)} WHERE company_id = $1 AND id = $2`, [companyId, ref]);
  return rows[0]?.name ?? null;
}

async function insertEntry(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>, timing: { startedAt: string; endedAt: string | null; minutes: number }) {
  const companyId = requiredCompany(context);
  const { settings } = await loadBilling(ctx, companyId);
  const client = readClientScope(params) ?? null;
  const id = randomUUID();
  const rate = optionalInteger(params, "rateMinor") ?? Math.max(0, Math.floor(Number(settings.defaultHourlyRateMinor ?? 0)));
  if (rate < 0) throw new BillingError("rateMinor must not be negative");
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "time_entries")}
      (id, company_id, owner, description, customer_kind, customer_ref, customer_name, started_at, ended_at, minutes, rate_minor, currency, billable, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT DO NOTHING`,
    [
      id,
      companyId,
      ownerOf(context, params),
      requiredString(params, "description"),
      client?.kind ?? null,
      client?.id ?? null,
      client ? await clientName(ctx, companyId, client.kind, client.id) : null,
      timing.startedAt,
      timing.endedAt,
      timing.minutes,
      rate,
      currencyCode(params.currency ?? settings.defaultCurrency ?? "ZAR"),
      optionalBoolean(params, "billable") ?? true,
      actorLabel(context),
    ],
  );
  if ((res.rowCount ?? 0) === 0) throw new BillingError("A timer is already running. Stop it before starting a new one.");
  const rows = await ctx.db.query<TimeEntryRow>(`SELECT ${COLUMNS} FROM ${table(ctx, "time_entries")} WHERE id = $1`, [id]);
  return publicEntry(rows[0]!);
}

export async function startTimer(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return insertEntry(ctx, context, params, { startedAt: new Date().toISOString(), endedAt: null, minutes: 0 });
}

export async function stopTimer(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const entryId = optionalString(params, "entryId");
  const rows = entryId
    ? await ctx.db.query<TimeEntryRow>(`SELECT ${COLUMNS} FROM ${table(ctx, "time_entries")} WHERE id = $1 AND company_id = $2`, [entryId, companyId])
    : await ctx.db.query<TimeEntryRow>(`SELECT ${COLUMNS} FROM ${table(ctx, "time_entries")} WHERE company_id = $1 AND owner = $2 AND ended_at IS NULL`, [companyId, ownerOf(context, params)]);
  const entry = rows[0];
  if (!entry) throw new BillingError("No running timer");
  if (entry.ended_at != null) return publicEntry(entry);
  const end = new Date().toISOString();
  const minutes = minutesBetween(String(iso(entry.started_at)), end);
  await ctx.db.execute(
    `UPDATE ${table(ctx, "time_entries")} SET ended_at = $2, minutes = $3, updated_at = now() WHERE id = $1 AND ended_at IS NULL`,
    [entry.id, end, minutes],
  );
  const fresh = await ctx.db.query<TimeEntryRow>(`SELECT ${COLUMNS} FROM ${table(ctx, "time_entries")} WHERE id = $1`, [entry.id]);
  return publicEntry(fresh[0]!);
}

export async function logTime(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const minutes = integer(params.minutes, "minutes");
  if (minutes <= 0 || minutes > 24 * 60) throw new BillingError("minutes must be between 1 and 1440");
  const day = optionalDate(params, "date") ?? new Date().toISOString();
  const start = new Date(day.length === 10 ? `${day}T09:00:00Z` : day);
  return insertEntry(ctx, context, params, { startedAt: start.toISOString(), endedAt: new Date(start.getTime() + minutes * 60_000).toISOString(), minutes });
}

export async function listTime(ctx: PluginContext, companyId: string, filter: { customerKind?: string; customerRef?: string; unbilled?: boolean } = {}) {
  const where = ["company_id = $1"];
  const params: unknown[] = [companyId];
  if (filter.customerRef) {
    params.push(filter.customerKind ?? "company", filter.customerRef);
    where.push(`customer_kind = $${params.length - 1} AND customer_ref = $${params.length}`);
  }
  if (filter.unbilled) where.push("invoice_id IS NULL AND billable = true AND ended_at IS NOT NULL");
  const rows = await ctx.db.query<TimeEntryRow>(`SELECT ${COLUMNS} FROM ${table(ctx, "time_entries")} WHERE ${where.join(" AND ")} ORDER BY started_at DESC LIMIT 500`, params);
  return rows.map(publicEntry);
}

export async function deleteTimeEntry(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const res = await ctx.db.execute(
    `DELETE FROM ${table(ctx, "time_entries")} WHERE id = $1 AND company_id = $2 AND invoice_id IS NULL`,
    [requiredString(params, "entryId"), companyId],
  );
  if ((res.rowCount ?? 0) === 0) throw new BillingError("Only unbilled time can be deleted");
  return { ok: true };
}

/**
 * Put time entries on a draft invoice, one line per entry. Entries are
 * claimed with a token first (one UPDATE), so an entry is never billed twice.
 */
export async function billTime(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  assertEditableInvoice(invoice);
  const ids = Array.isArray(params.entryIds) ? [...new Set(params.entryIds.map((id) => String(id).trim()).filter(Boolean))] : [];
  if (ids.length === 0) throw new BillingError("entryIds must list at least one time entry");
  if (ids.length > 400) throw new BillingError("Bill at most 400 entries at once");
  const token = randomUUID();
  await ctx.db.execute(
    `UPDATE ${table(ctx, "time_entries")} SET invoice_id = $2, bill_token = $3, updated_at = now()
      WHERE company_id = $1 AND invoice_id IS NULL AND ended_at IS NOT NULL AND billable = true
        AND id IN (SELECT jsonb_array_elements_text($4::jsonb))
        AND (customer_ref IS NULL OR (customer_kind = $5 AND customer_ref = $6))`,
    [companyId, invoice.id, token, JSON.stringify(ids), invoice.customer_kind, invoice.customer_ref],
  );
  const claimed = await ctx.db.query<TimeEntryRow>(`SELECT ${COLUMNS} FROM ${table(ctx, "time_entries")} WHERE bill_token = $1 ORDER BY started_at`, [token]);
  for (const entry of claimed) {
    const minutes = Number(entry.minutes);
    const rate = Number(entry.rate_minor);
    await insertLine(ctx, {
      companyId,
      invoiceId: invoice.id,
      description: timeLineDescription({ description: entry.description, minutes, rateMinor: rate, currency: entry.currency, startedAt: iso(entry.started_at) }),
      quantity: 1,
      unitAmountMinor: timeAmountMinor(minutes, rate),
      taxCode: invoice.default_tax_code ?? null,
      timeEntryId: entry.id,
    });
  }
  await recomputeInvoice(ctx, invoice);
  return { billed: claimed.length, skipped: ids.length - claimed.length, invoice: publicInvoice(invoice) };
}
