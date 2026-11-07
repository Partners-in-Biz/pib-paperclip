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
const DRIVE_ID = "0ADMOMlq1HzGgUk9PVA";
const CLIENTS_ID = "1FDrIxsipXHGSOCJzRls0kXAQqeCPFtnU";

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
  const fileName = `${(iso(paidAt) ?? new Date().toISOString()).slice(0, 10)} ${client} invoice ${label} (paid) v01.pdf`;
  const total = formatMoneyMinor(view.totalMinor, invoice.currency);

  // On a replay the issue exists; the upsert below re-attaches the document if an earlier attempt failed after creating it.
  const issue = existing[0] ?? await createWorkIssue(ctx, {
    companyId: invoice.company_id,
    title: `File paid invoice ${invoice.number} (${client})`.slice(0, 200),
    description: [
      `Invoice ${invoice.number} for ${client} (${total}) is paid. Save the invoice PDF to Drive.`,
      "",
      "**Where to save it:**",
      `- Shared Drive \`${DRIVE_ID}\`, path \`02 Partners in Biz/Clients/<Company> (<Contact>)/Contracts & Quotes/\``,
      `- File name: \`${fileName}\``,
      "",
      "**What to do** (use the `pib-drive-saving` skill and the connection \"Google Drive (filing)\"):",
      `1. Build the PDF: \`bash <pib-drive-saving skill dir>/scripts/drive-file.sh invoice-pdf ${invoice.id} <outFile>\``,
      `2. Upload it: \`bash <pib-drive-saving skill dir>/scripts/drive-file.sh upload <parentId> <outFile> "${fileName}"\``,
      `3. Post the Drive file name and id in your closing comment (never a link). The printable HTML is also on this issue as document \`${INVOICE_TO_FILE_KEY}\`.`,
      "",
      "**Filing rules:**",
      `1. Resolve the folder by id chain, never by a bare title search: \`Clients\` (\`${CLIENTS_ID}\`, Shared Drive \`${DRIVE_ID}\`) > \`search-files\` \`parentId = '<Clients>' and title = '<Company> (<Contact>)'\` > \`search-files\` \`parentId = '<client>' and title = 'Contracts & Quotes'\`.`,
      "2. Client folder missing: stop, comment \"client folder missing\", hand the issue to the Delivery Lead. Never create a client folder, never file under another name.",
      "3. `Contracts & Quotes` missing under an existing client folder: create only that subfolder, then continue.",
      "4. Before upload, `search-files` `parentId = '<Contracts & Quotes>' and title = '<file name>'`; if it exists, skip the upload and report its id (no deletes ever).",
      "5. Upload with `contentMimeType: application/pdf`, `disableConversionToGoogleType: true`. Never call any permission or sharing tool. Report file name and id, never a link.",
      "6. 409 `agent_authorization_required` means the agent grant is gone: comment the error, set the issue blocked on Peet re-consenting. Do not retry.",
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
