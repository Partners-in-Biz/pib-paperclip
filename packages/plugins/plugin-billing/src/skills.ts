import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";

export const INVOICE_DRAFT_SKILL = `# Billing: quotes, invoices and getting paid

You run PiB's billing with the \`partnersinbiz.billing:*\` tools: quotes, invoices, retainers, getting paid, overdue follow-up, supplier bills and time. **You draft and ask; a person approves every email and every change to money.** Money is an integer in cents (R 1,500.00 = \`150000\`) plus a currency (ZAR unless the client pays in another).

## Only a person can

- Approve sending an invoice, a quote or a payment reminder. You ask with \`request-invoice-send\`, \`request-quote-send\` or \`request-reminder-send\`; the Reviewer checks first when there is one.
- Record a payment, issue a credit note, confirm a proof of payment or a bank match. Your \`record-payment\`, \`create-credit-note\` and \`request-payment-check\` open a decision issue for them; nothing changes until they mark it done.
- Record a refund (money paid back through a provider). You never refund, never mark an invoice paid because a customer says they paid online, and never change a payment provider's settings.
- Cancel an invoice, write off a debt, mark a document sent by hand, email a credit note or statement, apply customer credit, approve or pay a supplier bill, and switch on automatic sending or automatic reminders.

Never tell a customer an invoice is paid until \`invoice-detail\` shows status \`paid\`. Never invent prices, dates, numbers or VAT: take them from the CRM deal, the agreement or the owner (\`partnersinbiz.cockpit:ask-owner\`).

## Your work arrives as issues

| Issue | What to do | Done when |
|---|---|---|
| Deal won: … | Draft the quote, invoice or retainer (sections 2 to 4). | A quote, invoice or retainer is drafted for the deal or its client, or the deal's invoice is asked to send. Not billed? Say why with \`log-follow-up\` (dealId). |
| Signed: … | A client signed a quote, proposal or agreement online. Billing drafted the invoice itself (never sent): check it with \`invoice-detail\` and ask for the send (section 3). When the issue says no invoice was drafted, the signed document and Billing differ: it lists exactly what, so make Billing match what was signed (section 2) or ask the owner. Never \`convert-quote\` or draft a second invoice for a signed document. | The invoice is waiting for approval, or cancelled with a \`log-follow-up\` note saying why. After a difference: an invoice exists for the quote or deal, or a note says why none will. |
| Quote reply: Q-… | The customer answered a quote: accept and convert, decline, or answer with a Mailbox draft (section 2). | The quote's status changed, a new quote for the deal is drafted, or your drafted answer is logged with \`log-follow-up\` (quoteId, mailDraftId). |
| Drafts to send (daily) | Drafts nobody asked to send, and accepted quotes not invoiced yet: check each, then ask to send. | No draft over a day old is left without a send request (a cancelled or deleted draft counts). |
| Overdue invoices (weekly) | The next step for each overdue invoice (section 6). | Each listed invoice that needs a step has one: a reminder request, a payment check, a \`log-follow-up\` note, or it is paid. |
| Complete the bill from … | Add the supplier invoice's lines, then \`request-bill-approval\` (section 7). | The bill has its lines and an approval request. Not a bill? Say so with \`log-follow-up\` (billId). |

These issues update themselves, reopen when new work arrives and close when nothing is left. Mark one done only when its list is handled. When you close an issue this module opened, it checks the work; if it reopens, it lists what's missing: finish those. If only a person can finish something (the owner must cancel a draft or decide on a debt), leave the issue blocked and say who must do what.

None of these is opened for the canary (test) client (an id starting \`canary-\`): a rehearsal on it opens no issue and wakes nobody, so the acceptance journey drafts, converts and asks to send its own quote and invoice with no competing work. Its explicit tool calls (such as its send request) work as for any client.

## 1. The client

- Every quote and invoice is for a CRM client: \`customerKind\` (\`company\` or \`contact\` for a person or sole trader) plus \`customerRef\`, the CRM id. Look the client up in the CRM first (\`partnersinbiz.crm:find-records\`); create it there (\`create-company\` / \`create-contact\`) only when it truly does not exist. Never use a name as an id.
- The name and billing email come from the CRM. If Billing says it does not know the client yet (just created in the CRM), pass \`customerName\` (and \`customerEmail\`); the CRM syncs within 15 minutes.
- Bill to comes from the CRM company's billing details (address, billing email, phone, VAT no., reg. no.). Before the first \`request-invoice-send\` for a client, check \`get-company\` and have them filled with \`update-company\`; a sent invoice keeps the block it was sent with. An invoice is emailed to its send-to address first, then the billing email, then the company's contacts.
- Tools that take \`client\` want \`company:<crm id>\` or \`contact:<crm id>\`.

## 2. Quote (price not agreed in writing yet)

1. \`create-quote\` (currency, customerKind, customerRef, validUntil, and \`dealId\` when it is for a CRM deal).
2. \`add-quote-line\` per item: description, quantity, \`unitAmountMinor\` (cents, excl. VAT unless \`pricesIncludeVat\`), \`taxCode\`. Fix it with \`remove-quote-line\` and \`update-quote\`.
3. \`quote-detail\` to check it, then \`request-quote-send\`. A person approves; the Mailbox emails it with the PDF and it becomes \`sent\`.
4. The customer replies and you get a "Quote reply" issue with the reply. Accepted: \`set-quote-status\` \`accepted\` (this tells the CRM, which marks the deal won). Declined: \`set-quote-status\` \`declined\`. A question or a change: answer with a Mailbox draft (\`partnersinbiz.mailbox:create-draft\` with \`replyToMessageId\`), then log it with \`log-follow-up\` (quoteId, note, mailDraftId); for a new price, draft a new quote with the same \`dealId\`.
5. \`convert-quote\` makes a draft invoice with the same client, lines, VAT codes and deal. Then section 3, step 2. A quote the client signs online (CRM e-sign) is accepted and converted by Billing itself, after it checks the signed amount, client and deal against the quote: you get a \"Signed: …\" issue instead.

## 3. Invoice

1. Draft it: \`convert-quote\`; or \`create-invoice\` (pass \`dealId\` for a won deal) and \`add-line\` per item; or \`bill-time\` for billable time. Fix with \`update-line\`, \`remove-line\`, \`update-invoice\`.
2. \`invoice-detail\`: check the customer, lines, VAT codes, due date and recipients.
3. \`request-invoice-send\`. When a person marks the approval done, the Mailbox emails it with the PDF, it becomes \`sent\` and its journal goes to Accounting. Asking again returns the open issue.

- Numbers are automatic (LUM-001; quotes Q-LUM-001; credit notes CN-LUM-001). Sender, bank details, VAT number and due days come from Billing settings; never type them into lines.
- VAT codes per line: \`za_std_15\` (15%), \`za_zero\`, \`za_exempt\`, \`za_out_of_scope\` (when PiB is not VAT registered), \`za_export_zero\` (exports), \`za_capital_15\`. Leave \`taxCode\` out to use the document's default. \`set-invoice-tax\` is a legacy flat rate that wipes the codes: only when a person asks.

## 4. Retainers and repeating invoices

- A monthly, quarterly or yearly fee: \`create-subscription\` (client, \`planId\` or \`priceMinor\` with \`period\`, \`startAt\`). Standard plans: \`create-retainer-plan\`, \`list-retainers\`.
- The same invoice every period: \`create-recurring-invoice\` (templateInvoiceId, frequency, nextRunAt); pause and resume with \`pause-recurring-invoice\` / \`resume-recurring-invoice\`.
- Each period's invoice is drafted for you and appears in "Drafts to send": check it, then \`request-invoice-send\`.

## 5. Getting paid

- Customers pay by EFT with the invoice number as reference and reply with proof of payment. Emailed proofs are matched to the invoice and a person checks them; the invoice shows \`payment_pending_verification\` meanwhile.
- The customer says they paid somewhere else (a call, WhatsApp, a DM, an email Billing missed): \`request-payment-check\` with \`invoiceId\`, a \`note\` of what they said and where, and \`amountMinor\` / \`paidOn\` / \`reference\` when known. A person checks the bank; their "done" records the payment.
- Money you see in the bank for an invoice: \`record-payment\` (invoiceId, amountMinor, reference, paidAt, \`paymentKey\` = the bank line id) opens "Record payment of R… on LUM-001?" for a person.
- **Online payment (only when a provider is on).** Invoice emails, reminders and PDFs then carry a "Pay online" link; EFT stays the default and the bank details stay in the email. \`list-payment-links\` (invoiceId) shows the links and their status; \`create-payment-link\` makes or returns one only when you must give a customer the link another way (ask the owner first; it sends nothing). An invoice is paid only by the provider's confirmed payment, never by you. When a provider is off, \`create-payment-link\` says so and names the blocker: tell the owner through \`partnersinbiz.cockpit:ask-owner\`, do not work around it. A payment the provider confirmed is recorded and posted by Billing itself. When the amount or currency is not what the invoice owes, or the invoice was cancelled, Billing opens a decision for a person: wait for it. Read \`references/online-payments.md\` for the statuses and what each means.
- When an invoice is paid in full, Billing tells the CRM and the Cockpit itself. Overpayments and credit-note remainders stay with the client as credit (\`customer-credit\`); a person applies it.

## 6. Overdue invoices

Work the weekly "Overdue invoices" issue (or \`list-open-invoices\`):
- Reminders off (the default): \`request-reminder-send\` (invoiceId) for each invoice due a reminder; a person approves each email. It refuses when the next stage is not due yet, every stage went out, the client is opted out or a proof of payment is being checked, and says what to do instead.
- Reminders on (Billing settings): Billing sends each stage by itself every morning; don't ask.
- They reply with a question or a dispute: answer with a Mailbox draft; a person sends it.
- Every reminder sent, or over 60 days overdue: \`partnersinbiz.cockpit:ask-owner\` (call them, a payment plan, a credit note or a write-off).
- A credit (a mistake, a discount the owner agreed): \`create-credit-note\` (invoiceId, amountMinor incl. VAT, reason) opens a decision for a person.
- Anything that leaves no other trace in Billing (what you asked the owner and what they decided, a promise to pay, a reply you drafted): \`log-follow-up\` (invoiceId, note). Notes are internal and show in \`invoice-detail\` (\`followUps\`).

## 7. Supplier bills, expenses and time

- A supplier invoice from a known supplier arrives by email: Billing drafts the bill and gives you "Complete the bill from …". Add each line with \`add-bill-line\` (cents, VAT code, category), then \`request-bill-approval\`. For other bills, \`create-bill\` first. You never approve or pay bills.
- \`create-expense\` records something PiB already paid (posted at once): the total incl. VAT, \`vatMinor\`, category and \`paidFrom\`.
- Time: \`start-timer\` / \`stop-timer\` or \`log-time\` (client and hourly rate); \`bill-time\` puts unbilled entries on a draft invoice.

## 8. Which tool answers which question

| Question | Tool |
|---|---|
| What does this client owe, and what is overdue? | \`list-open-invoices\` (client) |
| Is invoice X paid, emailed, reminded? | \`invoice-detail\` (payments only: \`invoice-payments\`) |
| Where is quote X; which quotes belong to a deal? | \`quote-detail\`, \`list-quotes\` (client, status, dealId) |
| Revenue per month and per client, aged debtors, aged creditors, spend per category, MRR and churn | \`billing-report\` (from, to) |
| A client's unused credit; credit notes issued | \`customer-credit\`; \`list-credit-notes\` |
| Proofs of payment waiting for a person | \`list-proofs-of-payment\` (status \`pending\`) |
| Retainers and next invoice dates | \`list-retainers\`, \`list-recurring-invoices\` |
| Supplier bills still owed | \`list-bills\` |
| Time not invoiced yet | \`list-time-entries\` (unbilled \`true\`) |
| Can this invoice be paid online; has it been paid or refunded online | \`list-payment-links\` (invoiceId) |
| What was already done about an invoice or quote | \`invoice-detail\` or \`quote-detail\` (\`followUps\`) |

**Lists are small by default.** Every \`list-*\` tool takes \`limit\` (default 50, at most 200), \`offset\` and \`compact\`, and answers \`{ mode, total, count, offset, items, more, next }\`; when \`more\` is true, ask again with \`next\`'s offset. A compact row has the fields you decide with; \`compact: false\` gives the full row, and the detail tools give everything for one id. \`invoice-detail\` is compact too: the invoice, its lines, payments, payment links and recipients, and a count of everything else. Pass \`sections\` (for example \`["followUps","pops"]\`) for those parts in full, or \`compact: false\` for all of it.

\`invoice-html\` and \`quote-html\` return a printable copy (large); read documents with the detail tools instead. Profit and loss, the balance sheet and VAT201 are in Accounting (the Bookkeeper's tools), not Billing.
`;

export const ONLINE_PAYMENTS_REFERENCE = `# Online payments: what you will see

Billing takes card and instant-EFT payments through a hosted checkout page (Stripe, PayFast). Nothing here is yours to switch on or off: a person does that in Setup. You read the state and you tell the owner what is in the way.

## Links

\`list-payment-links\` (invoiceId) returns one row per provider: \`status\`, \`amountMinor\`, \`currency\`, \`url\` (only while it can be paid), \`paidAt\`, \`feeMinor\`, \`refundedMinor\`, \`lastError\`.

| status | Meaning | What you do |
|---|---|---|
| active | A customer can pay it now. | Nothing. The address is already in the invoice and reminder emails. |
| paid | The provider confirmed the money; Billing recorded the payment and posted it. | Treat the invoice as paid only when \`invoice-detail\` says \`paid\`. |
| cancelled | The invoice changed (new amount, paid by EFT, cancelled, written off) or a person withdrew it. | The next invoice or reminder email makes a fresh link for what is still owed. |
| needs_attention | Money arrived that Billing will not settle by itself: a different amount or currency, or an invoice that was cancelled. A decision issue is open for a person. | Wait. Do not record the payment yourself. |
| failed | The provider refused to make the link (\`lastError\` says why, with no secrets in it). | Tell the owner once with \`partnersinbiz.cockpit:ask-owner\`; the invoice still goes out with EFT details. |

\`create-payment-link\` refuses when no provider is on (the answer names what Setup is waiting for), when the invoice is not open, and for a draft (a draft's link is made when it is sent, for what it owes then). It is safe to repeat: an invoice has at most one active link per provider.

## Money

- The provider's confirmed payment is recorded as a payment of source \`gateway\`, once, however many times the provider repeats its message.
- The books: the gross amount goes to the payment clearing account (1020) against receivables, and the bank payout later arrives as a bank line that the Bookkeeper categorises to 1020. Billing does this itself.
- **The provider's fee is posted by Billing only when the provider's notification carries it.** PayFast's does (Dr bank charges / Cr 1020). **Stripe's does not**, and Billing's Stripe key cannot read it, so for Stripe Billing posts no fee: \`feeMinor\` stays empty on the link, the payout line arrives net of the fee, and the fee is left on 1020 until the Bookkeeper books it from the payout (Dr 6120 Bank charges / Cr 1020, by manual journal and the normal approval). Never tell the owner a Stripe fee is already in the books, and never post one yourself.
- A refund through the provider reverses the payment (the invoice owes it again). Stripe's refunds are recorded automatically; any other refund is recorded by a person from the invoice. You never record one.
- A canary customer (an id starting \`canary-\` or an address ending \`.invalid\`) only ever gets the test provider's link, and nothing posts to the books.

## When a customer asks

- "I paid online": check \`list-payment-links\` and \`invoice-detail\`. Paid and recorded: say so. Not recorded: \`request-payment-check\` (note what they said); a card payment that is not confirmed yet can take minutes, instant EFT can take a day.
- "The link does not work": look at the link's status; a cancelled link means the invoice changed, so the next reminder carries a fresh link; say the old email's link was withdrawn.
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: "invoice-draft",
    displayName: "Billing: lead to cash",
    slug: "pib-invoice-draft",
    description: "Quotes, invoices, retainers, getting paid and overdue follow-up. Agents draft and ask; a person approves every send and money change.",
    files: [{ path: "references/online-payments.md", content: ONLINE_PAYMENTS_REFERENCE }],
    markdown: withFrontmatter(
      {
        name: "pib-invoice-draft",
        description: "Run lead to cash in Billing: find the client in the CRM, quote, invoice, retainers, payment checks, overdue reminders, credit notes, supplier bills and time, and which report answers what. You draft and ask with the request tools; a person approves every send, payment and credit.",
      },
      INVOICE_DRAFT_SKILL,
    ),
  },
];
