import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const INVOICE_DRAFT_SKILL = `# Invoice draft

Use \`partnersinbiz.billing:create-invoice\` and \`partnersinbiz.billing:add-line\` to draft a commercial invoice.

- Amounts are integers in minor units. Quantity is a positive integer.
- The customer is a CRM company id (a PiB client) or a CRM contact id. This plugin does not own the person. The customer name comes from the CRM when you leave \`customerName\` out.
- Sender details, VAT rate, due date and EFT bank details come from the Billing settings. Do not type them into lines.
- You may draft. You may not send, and you may not mark an invoice paid.
- A person approves sending or payment on a Paperclip issue. The plugin writes the status after that issue is done.
- Sender and customer details freeze when the invoice is sent.
- Invoice numbers are assigned automatically (INV-0001, INV-0002, ...). Do not invent a number.

## Quotes and expenses

- \`create-quote\` and \`add-quote-line\` draft a quote (estimate). A quote is not an invoice.
- \`convert-quote\` turns an accepted quote into a draft invoice, copying its lines and customer. Only convert a quote the customer has accepted.
- \`create-expense\` records a business expense. Amounts are integers in minor units. Use a category such as software, travel, or other.
- \`invoice-html\` returns a printable HTML invoice a person can open and save as PDF.
- \`create-recurring-invoice\` schedules a draft invoice to be re-created on a frequency. \`list-recurring-invoices\`, \`pause-recurring-invoice\`, and \`resume-recurring-invoice\` manage the schedules. The plugin creates the new draft automatically when due.
- \`record-payment\` records a payment against an invoice. \`invoice-payments\` returns the recorded payments. Amounts are positive integers in minor units.
- \`set-invoice-tax\` sets the tax rate (percentage) on a draft invoice. The total is recomputed with tax.
- \`quote-html\` returns a printable HTML quote a person can open and save as PDF.
- \`create-credit-note\` issues a credit against an invoice. \`list-credit-notes\` returns the credits. Amounts are positive integers in minor units.
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: "invoice-draft",
    displayName: "Invoice draft",
    slug: "pib-invoice-draft",
    description: "Draft commercial invoices. Do not send them.",
    markdown: withFrontmatter(
      { name: "pib-invoice-draft", description: "Draft commercial invoices, quotes and expenses for PiB clients. Never send or mark paid." },
      INVOICE_DRAFT_SKILL,
    ),
  },
];
