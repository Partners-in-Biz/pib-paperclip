/** SQL for payment links, provider events and refunds. Every statement is one call, qualified by the plugin namespace. */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { table } from "../db.js";
import type { ProviderKey } from "./types.js";

export type LinkStatus = "active" | "paid" | "cancelled" | "needs_attention" | "failed";

export interface PaymentLinkRow {
  id: string;
  company_id: string;
  invoice_id: string;
  provider: ProviderKey;
  status: LinkStatus;
  amount_minor: number | string;
  currency: string;
  url: string | null;
  provider_ref: string | null;
  provider_payment_id: string | null;
  payment_id: string | null;
  fee_minor: number | string | null;
  refunded_minor: number | string;
  last_error: string | null;
  created_by: string | null;
  created_at: unknown;
  paid_at: unknown;
  remote_off_at?: unknown;
}

const COLUMNS = "id, company_id, invoice_id, provider, status, amount_minor, currency, url, provider_ref, provider_payment_id, payment_id, fee_minor, refunded_minor, last_error, created_by, created_at, paid_at, remote_off_at";

export async function insertLink(ctx: PluginContext, row: { id: string; companyId: string; invoiceId: string; provider: ProviderKey; amountMinor: number; currency: string; createdBy: string | null }): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "payment_links")} (id, company_id, invoice_id, provider, amount_minor, currency, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [row.id, row.companyId, row.invoiceId, row.provider, row.amountMinor, row.currency, row.createdBy],
  );
}

export async function getLink(ctx: PluginContext, id: string): Promise<PaymentLinkRow | null> {
  const rows = await ctx.db.query<PaymentLinkRow>(`SELECT ${COLUMNS} FROM ${table(ctx, "payment_links")} WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function linkByProviderPayment(ctx: PluginContext, provider: ProviderKey, providerPaymentId: string): Promise<PaymentLinkRow | null> {
  const rows = await ctx.db.query<PaymentLinkRow>(`SELECT ${COLUMNS} FROM ${table(ctx, "payment_links")} WHERE provider = $1 AND provider_payment_id = $2`, [provider, providerPaymentId]);
  return rows[0] ?? null;
}

export async function linksForInvoice(ctx: PluginContext, invoiceId: string, statuses?: LinkStatus[]): Promise<PaymentLinkRow[]> {
  const rows = await ctx.db.query<PaymentLinkRow>(`SELECT ${COLUMNS} FROM ${table(ctx, "payment_links")} WHERE invoice_id = $1 ORDER BY created_at DESC`, [invoiceId]);
  return statuses ? rows.filter((row) => statuses.includes(row.status)) : rows;
}

export async function linksForCompany(ctx: PluginContext, companyId: string, statuses: LinkStatus[], limit = 100): Promise<PaymentLinkRow[]> {
  return ctx.db.query<PaymentLinkRow>(
    `SELECT ${COLUMNS} FROM ${table(ctx, "payment_links")} WHERE company_id = $1 AND status IN (SELECT jsonb_array_elements_text($2::jsonb)) ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(limit, 500))}`,
    [companyId, JSON.stringify(statuses)],
  );
}

/** The link was made: store the provider's address and id. */
export async function setLinkCreated(ctx: PluginContext, id: string, created: { url: string; providerRef: string | null }): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "payment_links")} SET url = $2, provider_ref = $3, last_error = NULL, updated_at = now() WHERE id = $1`, [id, created.url, created.providerRef]);
}

export async function setLinkStatus(ctx: PluginContext, id: string, from: LinkStatus[], status: LinkStatus, error: string | null = null): Promise<boolean> {
  const res = await ctx.db.execute(
    `UPDATE ${table(ctx, "payment_links")}
        SET status = $3, last_error = COALESCE($4, last_error), updated_at = now(), deactivated_at = CASE WHEN $3 IN ('cancelled', 'failed') THEN now() ELSE deactivated_at END
      WHERE id = $1 AND status IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [id, JSON.stringify(from), status, error],
  );
  return (res.rowCount ?? 0) > 0;
}

/** The provider confirmed the money: the link is paid, and remembers its provider payment id, payment row and fee. */
export async function markLinkPaid(ctx: PluginContext, id: string, input: { providerPaymentId: string | null; paymentId: string; feeMinor: number | null; paidAt: string }): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "payment_links")}
        SET status = 'paid', provider_payment_id = COALESCE($2, provider_payment_id), payment_id = $3, fee_minor = $4, paid_at = $5::timestamptz, last_error = NULL, updated_at = now()
      WHERE id = $1`,
    [id, input.providerPaymentId, input.paymentId, input.feeMinor, input.paidAt],
  );
}

/** The provider was told to stop taking payments on this link. */
export async function markLinkRemoteOff(ctx: PluginContext, id: string): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "payment_links")} SET remote_off_at = now() WHERE id = $1 AND remote_off_at IS NULL`, [id]);
}

export async function setLinkRefunded(ctx: PluginContext, id: string, refundedMinor: number): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "payment_links")} SET refunded_minor = $2, updated_at = now() WHERE id = $1`, [id, refundedMinor]);
}

// ── provider deliveries ──────────────────────────────────────────────────────

/** First sight of a delivery. False when it was seen before (the caller then checks whether it was applied). */
export async function recordEvent(ctx: PluginContext, input: { key: string; companyId: string; provider: ProviderKey; kind: string; linkId: string | null }): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "payment_events")} (key, company_id, provider, kind, link_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING`,
    [input.key, input.companyId, input.provider, input.kind, input.linkId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function eventResult(ctx: PluginContext, key: string): Promise<string | null> {
  const rows = await ctx.db.query<{ result: string }>(`SELECT result FROM ${table(ctx, "payment_events")} WHERE key = $1`, [key]);
  return rows[0]?.result ?? null;
}

export async function finishEvent(ctx: PluginContext, key: string, result: "applied" | "ignored" | "needs_attention" | "failed", detail: string | null): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "payment_events")} SET result = $2, detail = $3, applied_at = CASE WHEN $2 = 'failed' THEN NULL ELSE now() END WHERE key = $1`,
    [key, result, detail ? detail.slice(0, 500) : null],
  );
}

export interface EventRow {
  key: string;
  provider: string;
  kind: string;
  link_id: string | null;
  result: string;
  detail: string | null;
  received_at: unknown;
}

export async function recentEvents(ctx: PluginContext, companyId: string, limit = 20): Promise<EventRow[]> {
  return ctx.db.query<EventRow>(
    `SELECT key, provider, kind, link_id, result, detail, received_at FROM ${table(ctx, "payment_events")} WHERE company_id = $1 ORDER BY received_at DESC LIMIT ${Math.max(1, Math.min(limit, 100))}`,
    [companyId],
  );
}

// ── refunds ──────────────────────────────────────────────────────────────────

export async function insertRefund(ctx: PluginContext, row: { id: string; companyId: string; invoiceId: string; linkId: string | null; paymentId: string | null; provider: ProviderKey; sourceKey: string; amountMinor: number; reason: string | null; source: "webhook" | "person"; recordedBy: string | null }): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "payment_refunds")} (id, company_id, invoice_id, link_id, payment_id, provider, source_key, amount_minor, reason, source, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (company_id, source_key) DO NOTHING`,
    [row.id, row.companyId, row.invoiceId, row.linkId, row.paymentId, row.provider, row.sourceKey, row.amountMinor, row.reason, row.source, row.recordedBy],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function refundsForInvoice(ctx: PluginContext, invoiceId: string): Promise<Array<{ id: string; provider: string; amount_minor: number | string; reason: string | null; source: string; created_at: unknown }>> {
  return ctx.db.query(`SELECT id, provider, amount_minor, reason, source, created_at FROM ${table(ctx, "payment_refunds")} WHERE invoice_id = $1 ORDER BY created_at`, [invoiceId]);
}

export async function refundedTotalForLink(ctx: PluginContext, linkId: string): Promise<number> {
  const rows = await ctx.db.query<{ total: string | number | null }>(`SELECT COALESCE(sum(amount_minor), 0) AS total FROM ${table(ctx, "payment_refunds")} WHERE link_id = $1`, [linkId]);
  return Number(rows[0]?.total ?? 0);
}

/** After a payment or credit changed what an invoice owes: links for another amount stop showing (SQL only). Returns how many. */
export async function retireStaleLinks(ctx: PluginContext, invoiceId: string, outstandingMinor: number): Promise<number> {
  const res = await ctx.db.execute(
    `UPDATE ${table(ctx, "payment_links")} SET status = 'cancelled', deactivated_at = now(), updated_at = now() WHERE invoice_id = $1 AND status = 'active' AND amount_minor <> $2`,
    [invoiceId, outstandingMinor],
  );
  return res.rowCount ?? 0;
}
