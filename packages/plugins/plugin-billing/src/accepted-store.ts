/**
 * Storage for what Billing did with each document a client signed (`signed_acceptances`, migration 013).
 *
 * One row per signed document and company. It is claimed before any work starts, so the two events of one
 * signature (`deal.accepted` and `quote.accepted`), a repeated delivery and a retry after a crash all meet on
 * the same key and one signature drafts at most one invoice. The row also holds the id the invoice will have,
 * chosen when the row is claimed, so a retry finds a half-made draft instead of making another.
 *
 * Only ids, amounts and fingerprints live here, never a name: a person erased from the CRM leaves nothing behind.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { iso } from "./balances.js";
import { table } from "./db.js";

export const ACCEPTANCE_STATUSES = ["processing", "drafted", "already_invoiced", "needs_attention", "skipped"] as const;
export type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];

/** A claim nobody finished (the worker stopped) can be taken over after this long. Redeliveries come hourly, so this only has to outlast one run. */
export const CLAIM_LEASE_MINUTES = 10;

export interface AcceptanceRow {
  company_id: string;
  document_id: string;
  status: AcceptanceStatus;
  first_event: string;
  quote_id: string | null;
  quote_number: string | null;
  deal_id: string | null;
  client_kind: string | null;
  client_ref: string | null;
  amount_minor: number | string | null;
  currency: string | null;
  content_sha256: string | null;
  audit_head: string | null;
  invoice_id: string | null;
  reason: string | null;
  last_error: string | null;
  canary: boolean;
  claimed_at?: unknown;
  finished_at?: unknown;
}

const COLUMNS = `company_id, document_id, status, first_event, quote_id, quote_number, deal_id, client_kind, client_ref, amount_minor, currency,
            content_sha256, audit_head, invoice_id, reason, last_error, canary, claimed_at, finished_at`;

export async function getAcceptance(ctx: PluginContext, companyId: string, documentId: string): Promise<AcceptanceRow | null> {
  const rows = await ctx.db.query<AcceptanceRow>(`SELECT ${COLUMNS} FROM ${table(ctx, "signed_acceptances")} WHERE company_id = $1 AND document_id = $2`, [companyId, documentId]);
  return rows[0] ?? null;
}

export interface NewAcceptance {
  companyId: string;
  documentId: string;
  firstEvent: string;
  quoteId: string | null;
  quoteNumber: string | null;
  dealId: string | null;
  clientKind: string | null;
  clientRef: string | null;
  amountMinor: number | null;
  currency: string | null;
  contentSha256: string | null;
  auditHead: string | null;
  canary: boolean;
}

export interface Claim {
  /** This call owns the work: nobody else is making this document's invoice. */
  claimed: boolean;
  /** The id the invoice has (or will have): chosen once, kept across retries. */
  invoiceId: string;
  row: AcceptanceRow | null;
}

/**
 * Claim a signed document for this call. A document already finished (or being worked on by a live claim) is not claimed again;
 * one whose claim went stale is taken over and keeps the invoice id the first attempt chose.
 */
export async function claimAcceptance(ctx: PluginContext, input: NewAcceptance): Promise<Claim> {
  const seen = await getAcceptance(ctx, input.companyId, input.documentId);
  if (seen && seen.status !== "processing") return { claimed: false, invoiceId: seen.invoice_id ?? "", row: seen };
  const invoiceId = randomUUID();
  const inserted = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "signed_acceptances")}
      (company_id, document_id, status, first_event, quote_id, quote_number, deal_id, client_kind, client_ref, amount_minor, currency, content_sha256, audit_head, invoice_id, canary)
     VALUES ($1, $2, 'processing', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (company_id, document_id) DO NOTHING`,
    [input.companyId, input.documentId, input.firstEvent, input.quoteId, input.quoteNumber, input.dealId, input.clientKind, input.clientRef, input.amountMinor, input.currency, input.contentSha256, input.auditHead, invoiceId, input.canary],
  );
  if ((inserted.rowCount ?? 0) > 0) return { claimed: true, invoiceId, row: null };
  const taken = await ctx.db.execute(
    `UPDATE ${table(ctx, "signed_acceptances")} SET claimed_at = now(), updated_at = now()
      WHERE company_id = $1 AND document_id = $2 AND status = 'processing' AND claimed_at < now() - interval '${CLAIM_LEASE_MINUTES} minutes'`,
    [input.companyId, input.documentId],
  );
  const row = await getAcceptance(ctx, input.companyId, input.documentId);
  return { claimed: (taken.rowCount ?? 0) > 0, invoiceId: row?.invoice_id ?? invoiceId, row };
}

/** The outcome of a claimed document. `invoiceId` is the invoice it made or found, and null when there is none (the id chosen at the claim is dropped). */
export async function finishAcceptance(
  ctx: PluginContext,
  companyId: string,
  documentId: string,
  outcome: { status: Exclude<AcceptanceStatus, "processing">; invoiceId?: string | null; reason?: string | null },
): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "signed_acceptances")}
        SET status = $3, invoice_id = $4, reason = $5, last_error = NULL, finished_at = now(), updated_at = now()
      WHERE company_id = $1 AND document_id = $2`,
    [companyId, documentId, outcome.status, outcome.invoiceId ?? null, outcome.reason ? outcome.reason.slice(0, 1000) : null],
  );
}

/** A failed attempt: the claim stays (so a retry resumes where it stopped) and says why. */
export async function noteAcceptanceError(ctx: PluginContext, companyId: string, documentId: string, error: string): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "signed_acceptances")} SET last_error = $3, updated_at = now() WHERE company_id = $1 AND document_id = $2 AND status = 'processing'`,
    [companyId, documentId, error.slice(0, 500)],
  );
}

/** Signed documents of a deal whose invoice Billing drafted (the won-deal issue then has nothing to draft). */
export async function draftedForDeal(ctx: PluginContext, companyId: string, dealId: string): Promise<AcceptanceRow | null> {
  const rows = await ctx.db.query<AcceptanceRow>(
    `SELECT ${COLUMNS} FROM ${table(ctx, "signed_acceptances")} WHERE company_id = $1 AND deal_id = $2 AND status = 'drafted' ORDER BY finished_at DESC LIMIT 1`,
    [companyId, dealId],
  );
  return rows[0] ?? null;
}

/** Claims nobody finished for this long: a signature whose invoice could not be drafted (health in the Cockpit). */
export async function stuckAcceptances(ctx: PluginContext, companyId: string, hours: number): Promise<Array<{ documentId: string; since: string | null; error: string | null }>> {
  const rows = await ctx.db.query<{ document_id: string; claimed_at: unknown; last_error: string | null }>(
    `SELECT document_id, claimed_at, last_error FROM ${table(ctx, "signed_acceptances")}
      WHERE company_id = $1 AND status = 'processing' AND created_at < now() - ($2 || ' hours')::interval ORDER BY created_at LIMIT 20`,
    [companyId, String(Math.max(1, Math.floor(hours)))],
  );
  return rows.map((row) => ({ documentId: row.document_id, since: iso(row.claimed_at), error: row.last_error }));
}
