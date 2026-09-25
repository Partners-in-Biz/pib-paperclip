export const INVOICE_DRAFT_SKILL = `# Invoice draft

Use \`partnersinbiz.billing:create-invoice\` and \`partnersinbiz.billing:add-line\` to draft a commercial invoice.

- Amounts are integers in minor units. Quantity is a positive integer.
- The customer is a CRM company id or a CRM contact id. This plugin does not own the person.
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
`;
