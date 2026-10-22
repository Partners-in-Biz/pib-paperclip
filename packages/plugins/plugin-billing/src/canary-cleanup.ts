/**
 * Clean up Billing documents when the CRM deletes a canary company.
 * The CRM's cleanupCanary emits `company.deleted`; Billing reacts by deleting
 * all invoices, quotes and their related records for that customer.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { PIB_PLUGINS, pluginEvent } from "@partnersinbiz/pib-plugin-kit";
import { isCanaryRef } from "./canary.js";
import { table } from "./db.js";
import { deleteInvoiceDependents, deleteQuoteDependents } from "./draft-delete.js";
import { syncDraftsDigest } from "./followups.js";

const CRM_PLUGIN = PIB_PLUGINS.crm;
const COMPANY_DELETED_EVENT = pluginEvent(CRM_PLUGIN, "company.deleted");

interface CompanyDeletedPayload {
  id: string;
  name: string;
  deletedAt: string;
  key?: string;
}

const asJson = (list: string[]) => JSON.stringify(list);
const ids = (n: number) => `(SELECT jsonb_array_elements_text($${n}::jsonb))`;

/**
 * Registers a listener for CRM's `company.deleted` event.
 * When a canary company is deleted, removes all its Billing documents.
 */
export function registerCanaryCleanup(ctx: PluginContext): void {
  ctx.events.on(COMPANY_DELETED_EVENT, async (event) => {
    const payload = event.payload as CompanyDeletedPayload;
    if (!payload?.id) return;
    if (!isCanaryRef(payload.id)) return;

    const companyId = event.companyId;
    const customerId = payload.id;

    // Find all invoices and quotes for this customer
    const invoices = await ctx.db.query<{ id: string }>(
      `SELECT id FROM ${table(ctx, "invoices")} WHERE company_id = $1 AND customer_ref = $2`,
      [companyId, customerId],
    );
    const quotes = await ctx.db.query<{ id: string }>(
      `SELECT id FROM ${table(ctx, "quotes")} WHERE company_id = $1 AND customer_ref = $2`,
      [companyId, customerId],
    );

    const invoiceIds = invoices.map((r) => r.id);
    const quoteIds = quotes.map((r) => r.id);
    const allDocIds = [...invoiceIds, ...quoteIds];

    // Delete invoice-specific records (payment-related are canary-only cleanup, not in draft-delete)
    // Defence in depth: add company_id to WHERE clauses even though we already filtered by company_id above
    if (invoiceIds.length) {
      await ctx.db.execute(`DELETE FROM ${table(ctx, "payment_refunds")} WHERE invoice_id IN ${ids(1)} AND company_id = $2`, [asJson(invoiceIds), companyId]);
      await ctx.db.execute(`DELETE FROM ${table(ctx, "payment_links")} WHERE invoice_id IN ${ids(1)} AND company_id = $2`, [asJson(invoiceIds), companyId]);
      await ctx.db.execute(`DELETE FROM ${table(ctx, "reminders")} WHERE invoice_id IN ${ids(1)} AND company_id = $2`, [asJson(invoiceIds), companyId]);
      await ctx.db.execute(`DELETE FROM ${table(ctx, "pops")} WHERE invoice_id IN ${ids(1)} AND company_id = $2`, [asJson(invoiceIds), companyId]);
      await ctx.db.execute(`DELETE FROM ${table(ctx, "credit_notes")} WHERE invoice_id IN ${ids(1)} AND company_id = $2`, [asJson(invoiceIds), companyId]);
      await ctx.db.execute(`DELETE FROM ${table(ctx, "credit_applications")} WHERE invoice_id IN ${ids(1)} AND company_id = $2`, [asJson(invoiceIds), companyId]);
      await ctx.db.execute(`DELETE FROM ${table(ctx, "payments")} WHERE invoice_id IN ${ids(1)} AND company_id = $2`, [asJson(invoiceIds), companyId]);

      // Use helper for common invoice dependents (including work_issues)
      await deleteInvoiceDependents(ctx, invoiceIds);

      // Delete invoices themselves (with company_id for defence in depth)
      await ctx.db.execute(`DELETE FROM ${table(ctx, "invoices")} WHERE id IN ${ids(1)} AND company_id = $2`, [asJson(invoiceIds), companyId]);
    }

    if (quoteIds.length) {
      // Use helper for quote dependents (including work_issues)
      await deleteQuoteDependents(ctx, quoteIds);

      // Delete quotes themselves (with company_id for defence in depth)
      await ctx.db.execute(`DELETE FROM ${table(ctx, "quotes")} WHERE id IN ${ids(1)} AND company_id = $2`, [asJson(quoteIds), companyId]);
    }

    // Delete delivery records that reference any of the deleted documents
    if (allDocIds.length) {
      await ctx.db.execute(`DELETE FROM ${table(ctx, "deliveries")} WHERE company_id = $1 AND doc_id IN ${ids(2)}`, [companyId, asJson(allDocIds)]);
    }

    // Refresh drafts digest if there are any remaining drafts for this company
    try {
      await syncDraftsDigest(ctx, companyId);
    } catch {
      // Ignore if syncDraftsDigest fails; cleanup must not throw
    }
  });
}
