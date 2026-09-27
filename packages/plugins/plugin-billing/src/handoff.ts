/**
 * Hand-offs Billing sends to other modules (kit `HANDOFF_EVENTS`):
 * - `quote.accepted` when a quote becomes accepted (any path), with its deal;
 * - `invoice.paid` when an invoice becomes paid in full (any path).
 *
 * Events are delivered at most once and have no answer, so each one is stored
 * under its key, sent once, and sent again hourly for a few hours (same key;
 * receivers dedupe by key). A key is sent for one transition only.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { HANDOFF_EVENTS, type InvoicePaid, type QuoteAccepted } from "@partnersinbiz/pib-plugin-kit";
import { asObject, table, type InvoiceRow, type QuoteRow } from "./db.js";

/** How many times a hand-off is sent in total, and for how long it is repeated. */
export const HANDOFF_MAX_EMITS = 6;
export const HANDOFF_WINDOW_HOURS = 24;

function isoOf(value: unknown): string | null {
  if (value == null || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function clientOf(kind: string | null | undefined, ref: string | null | undefined): { clientKind: "company" | "contact" | null; clientRef: string | null } {
  if (!ref) return { clientKind: null, clientRef: null };
  return { clientKind: kind === "contact" ? "contact" : "company", clientRef: ref };
}

/** Store and send a hand-off once per key. True when this call sent it. */
export async function emitHandoff(ctx: PluginContext, companyId: string, event: string, payload: { key: string } & Record<string, unknown>): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "handoffs")} (key, company_id, event, payload) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (key) DO NOTHING`,
    [payload.key, companyId, event, JSON.stringify(payload)],
  );
  if ((res.rowCount ?? 0) === 0) return false;
  try {
    await ctx.events.emit(event, companyId, payload);
  } catch (error) {
    ctx.logger.info("Hand-off emit failed; the hourly job sends it again", { key: payload.key, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}

export function quoteAcceptedPayload(quote: Pick<QuoteRow, "id" | "number" | "customer_kind" | "customer_ref" | "total_minor" | "currency" | "deal_id">, acceptedAt: string): QuoteAccepted {
  return {
    key: `billing:quote:${quote.id}:accepted`,
    quoteId: quote.id,
    number: quote.number,
    dealId: quote.deal_id ?? null,
    ...clientOf(quote.customer_kind, quote.customer_ref),
    totalMinor: Number(quote.total_minor),
    currency: quote.currency,
    acceptedAt,
  };
}

export function invoicePaidPayload(invoice: Pick<InvoiceRow, "id" | "number" | "customer_kind" | "customer_ref" | "total_minor" | "currency" | "deal_id">, paidAt: string): InvoicePaid {
  return {
    key: `billing:invoice:${invoice.id}:paid`,
    invoiceId: invoice.id,
    number: invoice.number,
    dealId: invoice.deal_id ?? null,
    ...clientOf(invoice.customer_kind, invoice.customer_ref),
    totalMinor: Number(invoice.total_minor),
    currency: invoice.currency,
    paidAt,
  };
}

/** A quote became accepted: tell the CRM (it moves the deal to won). */
export async function emitQuoteAccepted(ctx: PluginContext, quote: Parameters<typeof quoteAcceptedPayload>[0] & { company_id: string }, acceptedAt: string): Promise<boolean> {
  const payload = quoteAcceptedPayload(quote, acceptedAt);
  return emitHandoff(ctx, quote.company_id, HANDOFF_EVENTS.quoteAccepted, payload as unknown as { key: string } & Record<string, unknown>);
}

/** An invoice became paid in full: tell the CRM and the Cockpit. */
export async function emitInvoicePaid(ctx: PluginContext, invoice: Parameters<typeof invoicePaidPayload>[0] & { company_id: string; paid_at?: unknown }): Promise<boolean> {
  const payload = invoicePaidPayload(invoice, isoOf(invoice.paid_at) ?? new Date().toISOString());
  return emitHandoff(ctx, invoice.company_id, HANDOFF_EVENTS.invoicePaid, payload as unknown as { key: string } & Record<string, unknown>);
}

/** Hourly: send recent hand-offs again (same key) until they have gone out `HANDOFF_MAX_EMITS` times. */
export async function reemitHandoffs(ctx: PluginContext): Promise<number> {
  const rows = await ctx.db.query<{ key: string; company_id: string; event: string; payload: unknown }>(
    `SELECT key, company_id, event, payload FROM ${table(ctx, "handoffs")}
      WHERE emits < $1 AND created_at > now() - interval '${HANDOFF_WINDOW_HOURS} hours' AND last_emitted_at < now() - interval '50 minutes'
      ORDER BY created_at LIMIT 200`,
    [HANDOFF_MAX_EMITS],
  );
  let sent = 0;
  for (const row of rows) {
    await ctx.db.execute(`UPDATE ${table(ctx, "handoffs")} SET emits = emits + 1, last_emitted_at = now() WHERE key = $1`, [row.key]);
    try {
      await ctx.events.emit(row.event, row.company_id, asObject(row.payload));
      sent += 1;
    } catch (error) {
      ctx.logger.info("Hand-off re-send failed", { key: row.key, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return sent;
}
