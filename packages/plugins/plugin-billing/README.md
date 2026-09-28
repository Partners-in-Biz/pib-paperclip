# Billing

Paperclip plugin `partnersinbiz.billing` (0.5). Customer-facing money for PiB: invoices, quotes, credit notes, EFT proof of payment, suppliers' bills, expenses with receipts, time, retainers and operational reports. Every financial event posts to the Accounting plugin as a journal. Money is integer minor units (cents) everywhere.

Agents draft and ask. A person approves every send, every money change and voids. Billing has no agent role of its own: the Account Manager (CRM plugin) carries the `pib-invoice-draft` skill, and Billing's work goes to it (else the Bookkeeper, the Operator, the owner).

## Pages

- `/billing` is PiB's whole book, in six tabs with sections: **Overview** (money owed and overdue, drafts to send, what waits on you; Reports), **Invoices** (Invoices, Payments, Credit notes, Reminders), **Quotes**, **Recurring** (Retainers, Repeating invoices), **Costs** (Bills, Expenses) and **Time**. `?tab=` takes a tab or a section, and every pre-0.4 value (`payments`, `bills`, `retainers`, `reports`, `reminders`, …) still opens the same place.
- `/billing?client=company:<id>` or `?client=contact:<id>` is one client's workspace: their invoices, quotes, payments and credit, statement, reminder opt-out, time and retainers (no Costs, Reports or Reminders).
- `GET /api/plugins/partnersinbiz.billing/api/client-summary?companyId=&kind=&id=` returns `{ headline, stats }` for the CRM client workspace.

## Documents

- **Numbers** per client: the first three letters of the client's name (deduplicated per company), `LUM-001`, quotes `Q-LUM-001`, credit notes `CN-LUM-001`. A counter row per kind and prefix is claimed with compare-and-swap (the host's `execute` has no RETURNING) and every number is also claimed in `number_claims`, so no number is issued twice. Existing numbers never change; `numbering.mode = sequential` keeps `INV-0001`.
- **VAT per line** with the kit `TAX_CODES` (`za_std_15`, `za_zero`, `za_exempt`, `za_out_of_scope`, …), prices excluding or including VAT, totals per line and per code. Invoices without any line code keep the 0.2 rule (one rate on the subtotal, rounded once); `set-invoice-tax` switches an invoice back to that rule.
- **PDF** through the kit's `renderDocumentPdf` for invoices, quotes, credit notes and statements. Sent documents are stored in a **private** R2 bucket (own `r2` settings) under unguessable keys; the page downloads through presigned GETs, the Mailbox gets 7-day links.

## Agents ask, a person decides

| Agent tool | Opens | A person's "done" |
|---|---|---|
| `request-invoice-send`, `request-quote-send` | an approval issue (the Reviewer first when one is running, else the Billing approver `reviewerUserId`, else the owner) | emails the document |
| `request-reminder-send` | an approval issue with the stage's subject and message (only when automatic reminders are off, the stage is due and the client is not opted out) | sends that reminder stage |
| `record-payment` | "Record payment of R… on LUM-001?" for a person | records it through `settle()` |
| `create-credit-note` | "Issue credit note of R… on LUM-001?" for a person | issues, applies and posts it |
| `request-payment-check` | the proof-of-payment check (source `agent`) | records the payment on the day the customer paid |

Asking twice returns the open issue; two requests at the same moment leave one approval (the other is withdrawn). An agent marking any of these done or cancelled is undone with the kit's `reopenApprovalForPerson` (reopened, given to the approver, a comment says why). A decision that fails is reopened with the reason. Money is never counted twice: a payment decision is not applied when the invoice was paid or credited since the request or its bank line is already recorded, a credit-note decision is not applied when another credit note was issued meanwhile (and a re-approved one never makes a second note), and open payment and reminder decisions are withdrawn when the invoice becomes paid. The issue says what happened. The person who closes the issue is recorded as the approver. People on the page still act directly.

## Nothing sits silently

- **Drafts to send** (daily 06:30 SAST): one issue per company listing invoices and quotes drafted over a day ago with no send approval (recurring and retainer drafts too) and accepted quotes not invoiced yet. Updated in place, reopened when drafts return, closed when none.
- **Overdue invoices** (Mondays 06:45 SAST, kept current daily): one issue with the next step for each overdue invoice (reminder, payment check, ask the owner).
- **Quote replies**: a reply to a quote email (the Mailbox's reply context, or a sent quote's number in the subject) opens one issue per quote with the reply and next steps.
- **Deal won** (`plugin.partnersinbiz.crm.deal.won`): one drafting issue per deal ("Deal won: … draft the quote, invoice or retainer"), idempotent by the event key; skipped when the deal is already invoiced.

## Flows and done checks (0.5)

- **Stages.** The Cockpit snapshot (`GET /cockpit`, hourly `cockpit.snapshot`) carries `flows` for Billing's lead-to-cash stages, each from the same query as its KPI: `quote.draft` and `invoice.draft` (drafts nobody asked to send; stuck = over a day old), `quote.approval` and `invoice.approval` (a send approval is open), `quote.sent` (sent, still valid, not being re-sent; stuck = no answer after 14 days), `invoice.open` (owed as at today; stuck = overdue, with `oldestDays`). Money is given when a stage is in one currency.
- **Origin ids.** Every issue Billing opens has `billing:<kind>:<id>`: work for agents `billing:drafts-to-send:<company>`, `billing:overdue-invoices:<company>`, `billing:quote-reply:<quote>`, `billing:deal-won:<deal>`, `billing:bill-from-email:<bill>`; person-only decisions `billing:invoice-send:`, `quote-send:`, `invoice-pay:`, `record-payment:`, `credit-note:`, `reminder:`, `payment-check:`, `bank-match:`, `bill-approval:`. Standing issues opened before 0.5 get the new id from the daily job (migration `011` renames their keys).
- **Done checks** (kit `registerDoneChecks`): when an agent closes one of the five kinds of work, Billing checks the outcome and reopens it with what is missing (after three early closes it goes to the Operator). Drafts: no draft over a day old without a send request. Overdue: every listed invoice that needs a step has a reminder request, a payment check, a note or is paid. Quote reply: the status changed, a new quote for the deal, or a logged answer. Deal won: a quote, invoice or retainer for the deal or its client since the issue opened. Complete the bill: lines and an approval request. Approvals are never checked.
- **`log-follow-up`** (`invoiceId` | `quoteId` | `billId` | `dealId`, `note`, `mailDraftId`): an internal note for what leaves no other trace (a reply drafted in the Mailbox, what the owner decided). The checks count it; `invoice-detail` and `quote-detail` show it as `followUps`. Migration `011_billing.sql` adds `follow_ups` and `work_issues.opened_at` / `detail`.

## Hand-offs

- `quote.accepted` (kit `QuoteAccepted`, key `billing:quote:<id>:accepted`, with `dealId`) when a quote becomes accepted by any path.
- `invoice.paid` (kit `InvoicePaid`, key `billing:invoice:<id>:paid`, with `dealId`) when an invoice becomes paid in full by any path.
- Each is sent once and again hourly (same key) up to six times within a day; receivers dedupe by key. Quotes and invoices carry `deal_id` (`dealId` on create-quote, create-invoice, update-quote, update-invoice; copied by convert-quote).

## Sending

`request-send` (tool `request-invoice-send`) opens an approval issue. When a person marks it done, the invoice's sender/customer details freeze, the PDF is stored and `mail.send.requested` is enqueued in the outbox (key `billing:mail:invoice:<id>:<n>`, labels `PiB/Invoices`, context `{plugin, kind, id, clientKind, clientRef}`) with EFT details and "reply with proof of payment". The invoice becomes `sent` when `plugin.partnersinbiz.mailbox.mail.send.result` says sent; a permanent failure shows on the invoice with **Retry email** (next `<n>`). Email off, or no address: marked sent as before. The `redeliver` job (5 min) re-sends unanswered requests.

## Money in (EFT only)

Statuses: `draft → sent → payment_pending_verification → partially_paid → paid`, plus `overdue`, `cancelled`, `written_off`.

- **One `settle()`** for every payment path (record-payment, POP confirmation, payment approval, bank match). Idempotent by `source_key` (`manual:<key>`, `pop:<id>`, `approval:<issue>`, `bank:<tx>`). The allocation is computed inside the INSERT: partial payments, top-ups, overpayments (the rest becomes customer credit). The invoice's own credit notes are applied. A bank line equal to a payment a person already recorded reconciles that payment (its journal is reversed and re-posted on the matched bank account) instead of counting the money twice.
- **Proof of payment** from `plugin.partnersinbiz.mailbox.mail.received` (category `proof_of_payment`, an open invoice number in the subject/snippet/file names, or a reply with attachments on our invoice thread) or an upload. Matched deterministically (thread → invoice number → the sender's only open invoice), stored with the Gmail message, the invoice moves to "payment pending verification" and a **verification issue** opens. Done = confirm (settle), cancelled = reject. Never settled from an email alone.
- **Bank matches** from `plugin.partnersinbiz.accounting.bank.matched` (`receiveOnce`): `exact` and not more than owed → settled; otherwise a review issue and `needs_review`. `bank.match.result` is emitted on every delivery (and again as `settled`/`rejected` when a person decides).
- Supplier invoices by email (`invoice_or_bill`) from a known CRM supplier become draft bills.
- **Credit notes** are applied to what the invoice owes; the rest is the customer's credit, usable on their other invoices. **Write-off** books bad debt (net + the VAT share on output VAT).

## Books (Accounting)

Every event enqueues `ledger.post.requested` (kit `LedgerPostRequested`, account roles only, checked with `isBalanced`), answered by `plugin.partnersinbiz.accounting.ledger.post.result` (journal number stored on the document; a later `posted` wins over an earlier rejection):

| Event | Key | Lines |
|---|---|---|
| Invoice sent | `billing:invoice:<id>:issue` | Dr ar / Cr revenue + vat_output per VAT code (taxCode, taxBaseMinor) |
| Invoice voided | `billing:invoice:<id>:void` | mirror, `reverseKey` = issue |
| Payment | `billing:payment:<id>` (`…:bank:<tx>` when re-posted on a bank line) | Dr bank (bank account code + `bankTxId` from a bank match) / Cr ar |
| Realised FX | `billing:payment:<id>:fx` | ar vs fx_gain / fx_loss, book currency |
| Credit note | `billing:credit_note:<id>:issue` | Dr revenue + vat_output (proportional) / Cr ar |
| Write-off | `billing:invoice:<id>:write_off` | Dr bad_debts + vat_output / Cr ar |
| Bill approved | `billing:bill:<id>:approve` | Dr expense:<category> + vat_input / Cr ap |
| Bill paid | `billing:bill_payment:<id>` | Dr ap / Cr bank |
| Expense | `billing:expense:<id>:v<n>` (`…:reverse` on change) | Dr expense:<category> + vat_input / Cr bank, cash or owner_equity |

Open invoices and bills are shared as `open-item.upserted` after each change, every 15 minutes for recent changes and nightly in full.

Journals skipped while Accounting was switched off (or `ledger.enabled` was off) are posted later under the same keys: when Setup says Accounting is on (`modules.updated`) and from the nightly `post-missing-journals` job. A repeat changes nothing.

## Money out, time and retainers

- **Bills**: supplier (CRM company/contact or text), lines with VAT codes and categories, due date, attach the supplier's PDF; approve (a person, or `request-bill-approval` for agents) → journal; pay → `settleBill`.
- **Expenses**: record directly (journal) or upload a receipt; with an Anthropic key Claude (`claude-haiku-4-5-20251001`, JSON schema output) reads vendor, date, total, VAT and currency; Jev picks the category and whether VAT is claimable (minimal fields, amount bucketed). Drafts post when a person saves them.
- **Time**: one running timer per person or agent, or log minutes; billable entries go onto a draft invoice (hours × rate, claimed once).
- **Retainers**: plans and subscriptions draft an invoice each period (idempotent per period), sending themselves only when set by a person. **Recurring** schedules copy every field and line.

## Reports and reminders

- Revenue by month (invoiced excl. VAT and collected), per client, aged debtors and creditors (0-30 / 31-60 / 61-90 / 90+ days past due, on what is still owed), client value, expenses by category, MRR/ARR/churn. Foreign documents convert at their own rate or the latest daily rate (`fx-rates` job: frankfurter.app, fallback exchangerate.host).
- **Reminders**: stages 1/7/14 days after due by default, templated, one per stage per invoice (latest due stage only), per-client opt-out, none while a POP is being checked. With `dunning.enabled` they go out by themselves each morning (07:00 UTC); otherwise the Account Manager asks for each with `request-reminder-send` and a person approves it.

## Settings

Business, EFT, VAT defaults, numbering, email (`from`, cc, sign-off), `r2` (private bucket; secret-ref), `anthropic.apiKey` (secret-ref), `jev` (kit schema), `ledger.enabled`, `dunning`, expense categories, reviewer user id, book currency. Save once per company: jobs only act for companies with saved settings.

## Jobs

All times UTC. `mark-overdue` (hourly; also re-sends recent hand-offs), `run-recurring` (00:00: schedules + retainers), `redeliver` (5 min), `emit-open-items` (15 min), `emit-open-items-all` (01:40), `post-missing-journals` (01:55), `drafts-to-send` (04:30), `overdue-invoices` (Mondays 04:45), `fx-rates` (06:15), `dunning` (07:00).
