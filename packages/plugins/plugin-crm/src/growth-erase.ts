/**
 * What the e-sign, site events and attribution features keep for a client or a person goes with them (audit Q10-13: POPIA).
 * It imports only storage modules, so the deletion paths (a deleted client, the canary cleanup, an erasure) can call it without a cycle.
 *
 * What stays, and why: a SIGNED document is the agreement and its evidence (the signature, the SHA-256 of what was signed, the audit
 * trail), so it is kept for a real client, and the erasure says so. The canary's are deleted with it. Revenue rows are a copy of what
 * Billing says was paid (Billing keeps the invoice for tax law): a real client's CRM copy is unlinked from the person, not deleted.
 * The canary's test payment is never revenue (`handoffs.ts` does not record it), and any row that exists anyway is deleted, so the
 * attribution report and the goal numbers never carry a test payment.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isCanaryId } from "./canary-flag.js";
import { table } from "./db.js";
import { deleteDocsOfClient, deleteEsignClient, listDocs, revokeTokens } from "./esign-store.js";
import type { ClientKind } from "./refs.js";
import { deleteEventDataOfClient } from "./site-events-store.js";

export interface GrowthErased {
  /** Rows removed. */
  removed: number;
  /** Signed documents kept as the agreement's evidence. */
  keptSigned: number;
}

/** Removes a client's documents (signed ones stay unless it is the canary), e-sign switch, event keys and counts, and cost records; unlinks its revenue rows (deletes them for the canary). Idempotent. */
export async function deleteGrowthDataOfClient(ctx: PluginContext, companyId: string, client: { kind: ClientKind; id: string }): Promise<GrowthErased> {
  const canary = isCanaryId(client.id);
  for (const doc of await listDocs(ctx, companyId, client, 500)) if (doc.status !== "signed" || canary) await revokeTokens(ctx, companyId, doc.id);
  const docs = await deleteDocsOfClient(ctx, companyId, client, canary);
  let removed = docs.removed;
  if (await deleteEsignClient(ctx, companyId, client)) removed += 1;
  removed += (await deleteEventDataOfClient(ctx, companyId, client.kind, client.id)).keys;
  removed += (await ctx.db.execute(`DELETE FROM ${table(ctx, "channel_costs")} WHERE company_id = $1 AND scope = $2`, [companyId, `${client.kind}:${client.id}`]))?.rowCount ?? 0;
  if (canary) removed += (await ctx.db.execute(`DELETE FROM ${table(ctx, "revenue_events")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3`, [companyId, client.kind, client.id]))?.rowCount ?? 0;
  else await ctx.db.execute(`UPDATE ${table(ctx, "revenue_events")} SET client_kind = NULL, client_ref = NULL WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3`, [companyId, client.kind, client.id]);
  return { removed, keptSigned: docs.keptSigned };
}

/** What a person's erasure does to documents sent to their address: unsigned ones go, signed ones are kept as evidence. */
export async function eraseSignDocsOfPerson(ctx: PluginContext, companyId: string, emails: readonly string[]): Promise<GrowthErased> {
  const result: GrowthErased = { removed: 0, keptSigned: 0 };
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    const rows = await ctx.db.query<{ id: string; status: string }>(`SELECT id, status FROM ${table(ctx, "sign_documents")} WHERE company_id = $1 AND recipient_email = $2 LIMIT 200`, [companyId, email]);
    for (const row of rows) {
      if (row.status === "signed") {
        result.keptSigned += 1;
        continue;
      }
      await ctx.db.execute(`DELETE FROM ${table(ctx, "sign_events")} WHERE company_id = $1 AND doc_id = $2`, [companyId, row.id]);
      await ctx.db.execute(`DELETE FROM ${table(ctx, "sign_tokens")} WHERE company_id = $1 AND doc_id = $2`, [companyId, row.id]);
      result.removed += (await ctx.db.execute(`DELETE FROM ${table(ctx, "sign_documents")} WHERE company_id = $1 AND id = $2`, [companyId, row.id]))?.rowCount ?? 0;
    }
  }
  return result;
}

/** How many documents are addressed to these emails and how many are signed (for the approval a person reads). Read only. */
export async function signDocsOfEmails(ctx: PluginContext, companyId: string, emails: readonly string[]): Promise<{ total: number; signed: number }> {
  let total = 0;
  let signed = 0;
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    const rows = await ctx.db.query<{ status: string }>(`SELECT status FROM ${table(ctx, "sign_documents")} WHERE company_id = $1 AND recipient_email = $2 LIMIT 200`, [companyId, email]);
    total += rows.length;
    signed += rows.filter((row) => row.status === "signed").length;
  }
  return { total, signed };
}
