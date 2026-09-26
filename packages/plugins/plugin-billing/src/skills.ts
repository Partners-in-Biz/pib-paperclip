import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const INVOICE_DRAFT_SKILL = `# Invoice draft

Use \`partnersinbiz.billing:create-invoice\` and \`partnersinbiz.billing:add-line\` to draft a commercial invoice.

- Amounts are integers in minor units (cents). Quantity is a positive integer.
- The customer is a CRM company id (a PiB client) or a CRM contact id. This plugin does not own the person. The customer name comes from the CRM when you leave \`customerName\` out.
- Sender details, VAT, due date and EFT bank details come from the Billing settings. Do not type them into lines.
- Each line has a VAT code (\`taxCode\`): \`za_std_15\` (15%), \`za_zero\`, \`za_exempt\`, \`za_out_of_scope\`, \`za_export_zero\`, \`za_capital_15\`. Leave it out to use the invoice's code. Prices exclude VAT unless the invoice has \`pricesIncludeVat\`.
- You may draft, change and remove lines on drafts (\`update-line\`, \`remove-line\`). You may not send, and you may not mark an invoice paid.
- A person approves sending on a Paperclip issue. The invoice is then emailed with its PDF from the Mailbox (Gmail) and becomes "sent" when the email goes out. Sender and customer details freeze at that point.
- Invoice numbers are assigned automatically per client (LUM-001, LUM-002 …; quotes Q-LUM-001; credit notes CN-LUM-001). Do not invent a number.

## Money in (EFT only)

- Customers pay by EFT with the invoice number as reference and reply with proof of payment. Billing matches the proof to the invoice and opens a verification issue; the invoice shows "payment pending verification".
- A person confirms the money is in (or Accounting's bank match confirms it). Never tell a customer an invoice is paid until its status is \`paid\`.
- \`record-payment\` records money received (partial payments leave the invoice \`partially_paid\`; an overpayment becomes the customer's credit). Pass \`paymentKey\` so a retry does not record it twice.
- \`create-credit-note\` credits a sent invoice; what the invoice no longer owes stays with the customer as credit (\`customer-credit\`).

## Quotes, expenses, bills and time

- \`create-quote\` and \`add-quote-line\` draft a quote. \`set-quote-status\` records accepted/declined. \`convert-quote\` turns an accepted quote into a draft invoice with the same lines.
- \`create-expense\` records a paid expense (amount = total paid, \`vatMinor\` = VAT on the receipt). Receipts are uploaded by people on the Billing page.
- \`create-bill\` + \`add-bill-line\` draft a supplier's bill; \`request-bill-approval\` asks a person to approve it. You may not pay bills.
- \`start-timer\`/\`stop-timer\`/\`log-time\` record time; \`bill-time\` puts unbilled entries on a draft invoice.
- \`create-subscription\` puts a client on a retainer; each period a draft invoice is created for a person to send.
- \`billing-report\` returns revenue, aged debtors/creditors, expenses and MRR.
- \`invoice-html\` / \`quote-html\` return printable HTML. The Billing page has the real PDF.
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: "invoice-draft",
    displayName: "Invoice draft",
    slug: "pib-invoice-draft",
    description: "Draft commercial invoices. Do not send them.",
    markdown: withFrontmatter(
      { name: "pib-invoice-draft", description: "Draft invoices, quotes, bills, expenses and time for PiB clients with VAT codes. Never send, confirm payments or mark paid." },
      INVOICE_DRAFT_SKILL,
    ),
  },
];
