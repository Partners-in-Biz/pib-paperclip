/**
 * What the attribution report reads and the little it writes (migration 012): paid invoices Billing told us about, the cost a person
 * recorded for a channel, the lead captures of our own forms, and what a client reported about each lead on its own forms.
 * One statement per call, every query scoped by company, simple statements only (the report does its own joining in code).
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { asRecord, table } from "./db.js";
import type { ClientKind } from "./refs.js";

function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const int = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

// ---------------------------------------------------------------------------
// Revenue: invoices Billing says are paid
// ---------------------------------------------------------------------------

export interface RevenueRow {
  key: string;
  invoiceId: string | null;
  number: string | null;
  dealId: string | null;
  clientKind: ClientKind | null;
  clientRef: string | null;
  totalMinor: number;
  currency: string;
  paidAt: string;
}

interface RevenueDbRow {
  key: string;
  invoice_id: string | null;
  number: string | null;
  deal_id: string | null;
  client_kind: string | null;
  client_ref: string | null;
  total_minor: unknown;
  currency: string;
  paid_at: unknown;
}

/** Records a paid invoice once per key (Billing's event is sent again for a day). True when this call recorded it. */
export async function insertRevenue(ctx: PluginContext, companyId: string, row: RevenueRow): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "revenue_events")} (id, company_id, key, invoice_id, number, deal_id, client_kind, client_ref, total_minor, currency, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
     ON CONFLICT (company_id, key) DO NOTHING`,
    [randomUUID(), companyId, row.key, row.invoiceId, row.number, row.dealId, row.clientKind, row.clientRef, row.totalMinor, row.currency, row.paidAt],
  );
  return (res?.rowCount ?? 0) > 0;
}

/** Deletes the revenue rows that name any of these deals (the canary's deals when its journey is cleaned up). Returns how many went. */
export async function deleteRevenueOfDeals(ctx: PluginContext, companyId: string, dealIds: readonly string[]): Promise<number> {
  if (dealIds.length === 0) return 0;
  const res = await ctx.db.execute(`DELETE FROM ${table(ctx, "revenue_events")} WHERE company_id = $1 AND deal_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))`, [companyId, JSON.stringify(dealIds)]);
  return res?.rowCount ?? 0;
}

export async function revenueBetween(ctx: PluginContext, companyId: string, fromIso: string, toIso: string): Promise<RevenueRow[]> {
  const rows = await ctx.db.query<RevenueDbRow>(
    `SELECT key, invoice_id, number, deal_id, client_kind, client_ref, total_minor, currency, paid_at FROM ${table(ctx, "revenue_events")}
      WHERE company_id = $1 AND paid_at >= $2::timestamptz AND paid_at < $3::timestamptz ORDER BY paid_at LIMIT 5000`,
    [companyId, fromIso, toIso],
  );
  return rows.map((row) => ({
    key: row.key,
    invoiceId: row.invoice_id ?? null,
    number: row.number ?? null,
    dealId: row.deal_id ?? null,
    clientKind: row.client_kind === "company" || row.client_kind === "contact" ? row.client_kind : null,
    clientRef: row.client_ref ?? null,
    totalMinor: int(row.total_minor),
    currency: row.currency,
    paidAt: iso(row.paid_at) ?? fromIso,
  }));
}

// ---------------------------------------------------------------------------
// Costs a person or agent recorded
// ---------------------------------------------------------------------------

export interface CostRow {
  /** `own`, `company:<id>` or `contact:<id>`. */
  scope: string;
  channel: string;
  /** `YYYY-MM`. */
  period: string;
  amountMinor: number;
  currency: string;
  note: string | null;
}

interface CostDbRow {
  scope: string;
  channel: string;
  period: string;
  amount_minor: unknown;
  currency: string;
  note: string | null;
}

export async function costsOf(ctx: PluginContext, companyId: string, scope: string): Promise<CostRow[]> {
  const rows = await ctx.db.query<CostDbRow>(`SELECT scope, channel, period, amount_minor, currency, note FROM ${table(ctx, "channel_costs")} WHERE company_id = $1 AND scope = $2 ORDER BY period LIMIT 2000`, [companyId, scope]);
  return rows.map((row) => ({ scope: row.scope, channel: row.channel, period: row.period, amountMinor: int(row.amount_minor), currency: row.currency, note: row.note ?? null }));
}

/** Records the cost of a channel for a month, replacing the one already recorded for that channel and month (a correction, not a second cost). */
export async function putCost(ctx: PluginContext, companyId: string, row: CostRow, recordedBy: string | null): Promise<"created" | "updated"> {
  const existing = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "channel_costs")} WHERE company_id = $1 AND scope = $2 AND channel = $3 AND period = $4 LIMIT 1`, [companyId, row.scope, row.channel, row.period]);
  if (existing[0]) {
    await ctx.db.execute(`UPDATE ${table(ctx, "channel_costs")} SET amount_minor = $2, currency = $3, note = $4, recorded_by = $5, updated_at = now() WHERE id = $1`, [existing[0].id, row.amountMinor, row.currency, row.note, recordedBy]);
    return "updated";
  }
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "channel_costs")} (id, company_id, scope, channel, period, amount_minor, currency, note, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), companyId, row.scope, row.channel, row.period, row.amountMinor, row.currency, row.note, recordedBy],
  );
  return "created";
}

// ---------------------------------------------------------------------------
// Our own leads (form captures)
// ---------------------------------------------------------------------------

export interface CaptureRow {
  key: string;
  createdAt: string;
  contactId: string | null;
  attribution: Record<string, unknown>;
}

interface CaptureDbRow {
  key: string;
  contact_id: string | null;
  attribution: unknown;
  created_at: unknown;
}

/** Captures from our own forms (no client) up to a time, oldest first: a customer's first touch is its earliest capture. */
export async function ownCaptures(ctx: PluginContext, companyId: string, toIso: string): Promise<CaptureRow[]> {
  const rows = await ctx.db.query<CaptureDbRow>(
    `SELECT key, contact_id, attribution, created_at FROM ${table(ctx, "lead_captures")} WHERE company_id = $1 AND client_kind IS NULL AND created_at < $2::timestamptz ORDER BY created_at LIMIT 20000`,
    [companyId, toIso],
  );
  return rows.map((row) => ({ key: row.key, createdAt: iso(row.created_at) ?? toIso, contactId: row.contact_id ?? null, attribution: asRecord(row.attribution) }));
}

// ---------------------------------------------------------------------------
// A client's leads and what the client reported about them
// ---------------------------------------------------------------------------

export const LEAD_OUTCOMES = ["new", "contacted", "qualified", "won", "lost"] as const;
export type LeadOutcome = (typeof LEAD_OUTCOMES)[number];

export interface ClientLeadAttribution {
  key: string;
  source: string;
  platform: string | null;
  capturedAt: string;
  attribution: Record<string, unknown>;
  outcome: LeadOutcome;
  valueMinor: number | null;
  currency: string | null;
  name: string | null;
}

interface ClientLeadDbRow {
  key: string;
  source: string;
  platform: string | null;
  captured_at: unknown;
  meta: unknown;
  outcome: string | null;
  value_minor: unknown;
  value_currency: string | null;
  name: string | null;
}

function mapClientLead(row: ClientLeadDbRow): ClientLeadAttribution {
  const meta = asRecord(row.meta);
  return {
    key: row.key,
    source: row.source,
    platform: row.platform ?? null,
    capturedAt: iso(row.captured_at) ?? new Date(0).toISOString(),
    attribution: asRecord(meta.attribution),
    outcome: (LEAD_OUTCOMES as readonly string[]).includes(row.outcome ?? "") ? (row.outcome as LeadOutcome) : "new",
    valueMinor: row.value_minor == null ? null : int(row.value_minor),
    currency: row.value_currency ?? null,
    name: row.name ?? null,
  };
}

const LEAD_COLUMNS = "key, source, platform, captured_at, meta, outcome, value_minor, value_currency, name";

export async function clientLeadsBetween(ctx: PluginContext, companyId: string, client: { kind: ClientKind; id: string }, fromIso: string, toIso: string, limit = 5000): Promise<ClientLeadAttribution[]> {
  const rows = await ctx.db.query<ClientLeadDbRow>(
    `SELECT ${LEAD_COLUMNS} FROM ${table(ctx, "client_leads")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 AND captured_at >= $4::timestamptz AND captured_at < $5::timestamptz ORDER BY captured_at LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 5000))}`,
    [companyId, client.kind, client.id, fromIso, toIso],
  );
  return rows.map(mapClientLead);
}

export async function clientLeadByKey(ctx: PluginContext, companyId: string, client: { kind: ClientKind; id: string }, key: string): Promise<ClientLeadAttribution | null> {
  const rows = await ctx.db.query<ClientLeadDbRow>(`SELECT ${LEAD_COLUMNS} FROM ${table(ctx, "client_leads")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 AND key = $4 LIMIT 1`, [companyId, client.kind, client.id, key]);
  return rows[0] ? mapClientLead(rows[0]) : null;
}

export async function setLeadOutcome(ctx: PluginContext, companyId: string, key: string, patch: { outcome: LeadOutcome; valueMinor: number | null; currency: string | null }): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "client_leads")} SET outcome = $3, value_minor = $4, value_currency = $5, outcome_at = now() WHERE company_id = $1 AND key = $2`,
    [companyId, key, patch.outcome, patch.valueMinor, patch.currency],
  );
}
