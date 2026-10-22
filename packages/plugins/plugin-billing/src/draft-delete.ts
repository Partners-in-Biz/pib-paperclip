/**
 * Delete draft invoices and quotes: hard-delete for canary and numberless drafts,
 * void instead for non-canary drafts with a number to keep the sequence gap-free.
 * Refuse when sent, paid, or linked to a recurring/subscription.
 */
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { isCanaryCustomer } from "./canary.js";
import { getInvoice, getQuote, table, type InvoiceRow, type QuoteRow } from "./db.js";
import { BillingError } from "./domain.js";
import { syncDraftsDigest } from "./followups.js";
import { publicInvoice, publicQuote, requireOwnInvoice, requireQuote } from "./invoices.js";
import { requiredCompany, requiredString } from "./util.js";

/**
 * Delete all child records of invoices, including work_issues.
 * Does NOT delete the invoices themselves; caller handles that after cleanup.
 */
export async function deleteInvoiceDependents(ctx: PluginContext, invoiceIds: string[]): Promise<void> {
  if (invoiceIds.length === 0) return;

  const invoiceIdsList = `(${invoiceIds.map((_, i) => `$${i + 1}`).join(",")})`;

  // Delete invoice-specific children
  await ctx.db.execute(`DELETE FROM ${table(ctx, "invoice_lines")} WHERE invoice_id IN ${invoiceIdsList}`, invoiceIds);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "invoice_grants")} WHERE invoice_id IN ${invoiceIdsList}`, invoiceIds);

  // Delete follow-ups and work issues that reference these invoices
  await ctx.db.execute(
    `DELETE FROM ${table(ctx, "follow_ups")} WHERE subject_kind = 'invoice' AND subject_id IN ${invoiceIdsList}`,
    invoiceIds,
  );
  await ctx.db.execute(
    `DELETE FROM ${table(ctx, "work_issues")} WHERE kind = 'invoice' AND subject_id IN ${invoiceIdsList}`,
    invoiceIds,
  );
}

/**
 * Delete all child records of quotes, including work_issues.
 * Does NOT delete the quotes themselves; caller handles that after cleanup.
 */
export async function deleteQuoteDependents(ctx: PluginContext, quoteIds: string[]): Promise<void> {
  if (quoteIds.length === 0) return;

  const quoteIdsList = `(${quoteIds.map((_, i) => `$${i + 1}`).join(",")})`;

  // Delete quote-specific children
  await ctx.db.execute(`DELETE FROM ${table(ctx, "quote_lines")} WHERE quote_id IN ${quoteIdsList}`, quoteIds);

  // Delete follow-ups and work issues that reference these quotes
  await ctx.db.execute(
    `DELETE FROM ${table(ctx, "follow_ups")} WHERE subject_kind = 'quote' AND subject_id IN ${quoteIdsList}`,
    quoteIds,
  );
  await ctx.db.execute(
    `DELETE FROM ${table(ctx, "work_issues")} WHERE kind = 'quote' AND subject_id IN ${quoteIdsList}`,
    quoteIds,
  );
}

/** Delete a draft invoice (hard-delete for canary/numberless, void otherwise). */
export async function deleteDraftInvoice(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));

  // Only drafts may be deleted
  if (invoice.status !== "draft") throw new BillingError("Only draft invoices can be deleted");
  if (invoice.sent_at) throw new BillingError("This invoice was sent; use cancel-invoice instead");

  // Check for linked recurring/subscription
  if (invoice.recurring_id || invoice.subscription_id) {
    throw new BillingError("This draft is part of a recurring series; delete the series instead");
  }

  // Check for payments or related transactions
  const restrictions = await ctx.db.query<{ has_related: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM ${table(ctx, "payments")} WHERE invoice_id = $1) OR
            EXISTS(SELECT 1 FROM ${table(ctx, "pops")} WHERE invoice_id = $1) OR
            EXISTS(SELECT 1 FROM ${table(ctx, "payment_links")} WHERE invoice_id = $1) OR
            EXISTS(SELECT 1 FROM ${table(ctx, "credit_notes")} WHERE invoice_id = $1) OR
            EXISTS(SELECT 1 FROM ${table(ctx, "credit_applications")} WHERE invoice_id = $1) OR
            EXISTS(SELECT 1 FROM ${table(ctx, "reminders")} WHERE invoice_id = $1) OR
            EXISTS(SELECT 1 FROM ${table(ctx, "payment_refunds")} WHERE invoice_id = $1)
      AS has_related`,
    [invoice.id],
  );

  if (restrictions[0]?.has_related) {
    throw new BillingError("This draft has payments or related transactions; cancel it instead");
  }

  // Decide: void or hard-delete
  const isCanary = isCanaryCustomer(invoice);
  const shouldVoid = !isCanary && invoice.number;

  // If this invoice was converted from a quote, reset the quote (before deletion)
  if (invoice.quote_id && !shouldVoid) {
    const quote = await getQuote(ctx, invoice.quote_id);
    if (quote && quote.converted_invoice_id === invoice.id) {
      await ctx.db.execute(
        `UPDATE ${table(ctx, "quotes")} SET converted_invoice_id = NULL, status = 'accepted', updated_at = now() WHERE id = $1`,
        [invoice.quote_id],
      );
    }
  }

  if (shouldVoid) {
    // Void the invoice: set status to cancelled and clear pending action
    await ctx.db.execute(
      `UPDATE ${table(ctx, "invoices")} SET status = 'cancelled', cancelled_at = now(), void_reason = 'deleted draft', pending_action = NULL, updated_at = now() WHERE id = $1`,
      [invoice.id],
    );
  } else {
    // Hard-delete: remove in transaction order (children first)
    await deleteInvoiceDependents(ctx, [invoice.id]);

    // Finally, delete the invoice
    await ctx.db.execute(`DELETE FROM ${table(ctx, "invoices")} WHERE id = $1`, [invoice.id]);
  }

  // Refresh the drafts digest to update standing issues
  await syncDraftsDigest(ctx, companyId).catch(() => {
    // Ignore if sync fails; deletion is done
  });

  // Return result
  if (shouldVoid) {
    const updated = await getInvoice(ctx, invoice.id);
    return { voided: true, id: invoice.id, number: invoice.number, ...(updated ? publicInvoice(updated) : {}) };
  } else {
    return { deleted: true, id: invoice.id, number: invoice.number };
  }
}

/**
 * Delete a draft quote (hard-delete only). Unlike invoices, quotes have no statutory gap-free number sequence,
 * so numbering gaps are acceptable and voiding is not necessary.
 */
export async function deleteDraftQuote(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const quote = await requireQuote(ctx, companyId, requiredString(params, "quoteId"));

  // Only drafts may be deleted
  if (quote.status !== "draft") throw new BillingError("Only draft quotes can be deleted");

  // Check if converted to an invoice (converted quotes have converted_invoice_id set)
  if (quote.converted_invoice_id) {
    throw new BillingError("This quote was converted to an invoice; delete the invoice instead");
  }

  // Hard-delete: remove dependents first
  await deleteQuoteDependents(ctx, [quote.id]);

  // Delete the quote
  await ctx.db.execute(`DELETE FROM ${table(ctx, "quotes")} WHERE id = $1`, [quote.id]);

  // Refresh the drafts digest
  await syncDraftsDigest(ctx, companyId).catch(() => {
    // Ignore if sync fails
  });

  return { deleted: true, id: quote.id, number: quote.number };
}
