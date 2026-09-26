# Billing

Paperclip plugin `partnersinbiz.billing` (0.3). Customer-facing money for PiB: invoices, quotes, credit notes, EFT proof of payment, suppliers' bills, expenses with receipts, time, retainers and operational reports. Every financial event posts to the Accounting plugin as a journal. Money is integer minor units (cents) everywhere.

Agents draft. A person approves sending, confirms money and voids.

## Pages

- `/billing` is PiB's whole book: Overview (what needs you), Invoices, Quotes, Payments (proof-of-payment queue, credit notes), Bills, Expenses, Time, Retainers, Reports, Reminders.
- `/billing?client=company:<id>` or `?client=contact:<id>` is one client's workspace: their invoices, quotes, payments and credit, statement, reminder opt-out, time and retainers (no bills or expenses).
- `GET /api/plugins/partnersinbiz.billing/api/client-summary?companyId=&kind=&id=` returns `{ headline, stats }` for the CRM client workspace.

## Documents

- **Numbers** per client: the first three letters of the client's name (deduplicated per company), `LUM-001`, quotes `Q-LUM-001`, credit notes `CN-LUM-001`. A counter row per kind and prefix is claimed with compare-and-swap (the host's `execute` has no RETURNING) and every number is also claimed in `number_claims`, so no number is issued twice. Existing numbers never change; `numbering.mode = sequential` keeps `INV-0001`.
- **VAT per line** with the kit `TAX_CODES` (`za_std_15`, `za_zero`, `za_exempt`, `za_out_of_scope`, …), prices excluding or including VAT, totals per line and per code. Invoices without any line code keep the 0.2 rule (one rate on the subtotal, rounded once); `set-invoice-tax` switches an invoice back to that rule.
- **PDF** through the kit's `renderDocumentPdf` for invoices, quotes, credit notes and statements. Sent documents are stored in a **private** R2 bucket (own `r2` settings) under unguessable keys; the page downloads through presigned GETs, the Mailbox gets 7-day links.

## Sending

`request-send` opens an approval issue. When a person marks it done, the invoice's sender/customer details freeze, the PDF is stored and `mail.send.requested` is enqueued in the outbox (key `billing:mail:invoice:<id>:<n>`, labels `PiB/Invoices`, context `{plugin, kind, id, clientKind, clientRef}`) with EFT details and "reply with proof of payment". The invoice becomes `sent` when `plugin.partnersinbiz.mailbox.mail.send.result` says sent; a permanent failure shows on the invoice with **Retry email** (next `<n>`). Email off, or no address: marked sent as before. The `redeliver` job (5 min) re-sends unanswered requests.

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

## Money out, time and retainers

- **Bills**: supplier (CRM company/contact or text), lines with VAT codes and categories, due date, attach the supplier's PDF; approve (a person, or `request-bill-approval` for agents) → journal; pay → `settleBill`.
- **Expenses**: record directly (journal) or upload a receipt; with an Anthropic key Claude (`claude-haiku-4-5-20251001`, JSON schema output) reads vendor, date, total, VAT and currency; Jev picks the category and whether VAT is claimable (minimal fields, amount bucketed). Drafts post when a person saves them.
- **Time**: one running timer per person or agent, or log minutes; billable entries go onto a draft invoice (hours × rate, claimed once).
- **Retainers**: plans and subscriptions draft an invoice each period (idempotent per period), sending themselves only when set by a person. **Recurring** schedules copy every field and line.

## Reports and reminders

- Revenue by month (invoiced excl. VAT and collected), per client, aged debtors and creditors (0-30 / 31-60 / 61-90 / 90+ days past due, on what is still owed), client value, expenses by category, MRR/ARR/churn. Foreign documents convert at their own rate or the latest daily rate (`fx-rates` job: frankfurter.app, fallback exchangerate.host).
- **Reminders** (off until `dunning.enabled`): stages 1/7/14 days after due by default, templated, one per stage per invoice (latest due stage only), per-client opt-out, none while a POP is being checked.

## Settings

Business, EFT, VAT defaults, numbering, email (`from`, cc, sign-off), `r2` (private bucket; secret-ref), `anthropic.apiKey` (secret-ref), `jev` (kit schema), `ledger.enabled`, `dunning`, expense categories, reviewer user id, book currency. Save once per company: jobs only act for companies with saved settings.

## Jobs

`mark-overdue` (hourly), `run-recurring` (daily: schedules + retainers), `redeliver` (5 min), `emit-open-items` (15 min), `emit-open-items-all` (nightly), `dunning` (07:00), `fx-rates` (06:15).
