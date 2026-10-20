/**
 * Drive filing for paid invoices: when an invoice becomes paid in full, open one filing issue for the
 * Account Manager to save the printable invoice to the client's Contracts & Quotes folder. The rendered
 * invoice rides on the issue as the `invoice` document (printable HTML as-is); no link is in the body.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createWorkIssue, formatMoneyMinor, PIB_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import { iso } from "./dates.js";
import { isCanaryRef } from "./canary.js";
import type { InvoiceRow } from "./db.js";
import { invoiceHtmlFrom, invoiceView } from "./invoices.js";
import { loadBilling } from "./config.js";
import { WORK_ORIGINS } from "./origins.js";
import { assigneeOf, workRoute } from "./routing.js";

export const INVOICE_TO_FILE_KEY = "invoice";

/** Path separators and control characters out of a Drive name part. */
const safe = (text: string) => text.replace(/[/\\\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();

/** Open the filing issue once per paid invoice (deduped by origin). Skips canary clients. */
export async function openInvoiceFilingIssue(ctx: PluginContext, invoice: InvoiceRow, paidAt: unknown): Promise<string | null> {
  if (invoice.status !== "paid" || isCanaryRef(invoice.customer_ref)) return null;
  const originId = `${WORK_ORIGINS.driveFileInvoice}${invoice.id}`;
  const originKind = `plugin:${PIB_PLUGINS.billing}` as const;
  const existing = await ctx.issues.list({ companyId: invoice.company_id, originKind, originId, limit: 1 }).catch(() => []);

  const { settings } = await loadBilling(ctx, invoice.company_id);
  const view = await invoiceView(ctx, invoice, settings);
  const client = safe(String(view.customer.name ?? "")) || "Client";
  const topic = safe(view.lines[0]?.description ?? "").slice(0, 40);
  const label = [invoice.number, topic].filter(Boolean).join(" ");
  const fileName = `${(iso(paidAt) ?? new Date().toISOString()).slice(0, 10)} ${client} invoice ${label} v01.html`;
  const total = formatMoneyMinor(view.totalMinor, invoice.currency);

  // On a replay the issue exists; the upsert below re-attaches the document if an earlier attempt failed after creating it.
  const issue = existing[0] ?? await createWorkIssue(ctx, {
    companyId: invoice.company_id,
    title: `File paid invoice ${invoice.number} (${client})`.slice(0, 200),
    description: [
      `Invoice ${invoice.number} for ${client} (${total}) is paid. Save the invoice to Drive.`,
      "",
      "**Where to save it:**",
      "- Folder: `Clients/<Company> (<Contact>)/Contracts & Quotes/`",
      `- File name: \`${fileName}\``,
      "",
      "**What to do:**",
      `Use the \`pib-drive-saving\` skill to save the printable invoice (document key \`${INVOICE_TO_FILE_KEY}\` on this issue) to the folder above. Post the Drive file name in your closing comment.`,
      "",
      "See the skill for Drive naming and folder rules.",
    ].join("\n"),
    originKind,
    originId,
    ...assigneeOf(await workRoute(ctx, invoice.company_id)),
    wakeReason: "A paid invoice needs to be saved to Drive",
  });
  await ctx.issues.documents.upsert({
    issueId: issue.id,
    companyId: invoice.company_id,
    key: INVOICE_TO_FILE_KEY,
    title: `Invoice ${invoice.number} for ${client}`,
    // The host stores markdown only; the printable HTML goes in as-is.
    format: "markdown",
    body: invoiceHtmlFrom(invoice, view),
    changeSummary: "Paid invoice for filing",
  });
  return issue.id;
}
