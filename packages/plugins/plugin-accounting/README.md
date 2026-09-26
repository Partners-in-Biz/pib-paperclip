# Accounting (`partnersinbiz.accounting`)

Partners in Biz's own books, and the ledger every other PiB plugin posts to.
Namespace `plugin_accounting_03d0185a67`, page `/accounting`, sidebar entry "Accounting". No client workspace mode.

## What it does

- **Book setup**: on the first settings save (or first use) it seeds a South African chart of accounts (IFRS for SMEs style, 68 accounts), a role map covering every kit `ACCOUNT_ROLES` role plus `expense:<category>` / `revenue:<category>` roles, and the VAT codes (15% from 2018-04-01, versioned). Chart and roles are editable (Chart & roles tab). A newer template only adds accounts/roles; it never overwrites edits.
- **Journals**: one row per journal with `lines jsonb`; `source_key` unique (idempotent); numbered `JNL-000123` (seq read inside a per-company lock, unique `(company_id, seq)` index, retry on clash); sha256 hash chain over canonical content + previous hash (Journals → Check audit chain). Posted journals are never edited; reversals swap the lines. Periods are open / soft-closed (only approved manual journals and reversals) / closed; a locked VAT period refuses postings dated inside it.
- **Manual journals**: draft → approval issue → a board user approves (page button, or marks the issue done — an agent closing it does not count) → posts.
- **Postings from other plugins**: `ledger.post.requested` from Billing and Payroll, handled once per key (`receiveOnce`), result re-sent on repeats. Rejections (unbalanced, closed period, unknown role…) return `status: "rejected"` with a plain error and go to **one** open issue; Journals → Rejected → Retry posts after the cause is fixed. A redelivered rejected key is tried again.
- **Open items**: projection of Billing's receivables/payables (`open-item.upserted`, last `updatedAt` wins) for aged AR/AP, matching, FX and the forecast.
- **Bank**: bank accounts linked to chart accounts; CSV (header auto-detect, SA bank formats, balance column), OFX and MT940 import, deduped by fingerprint; files over 1 MB go to the private R2 bucket by presigned PUT and are parsed by the worker. Bank rules; Jev suggests an account (choice), `vat_applies` and `is_transfer` (noul) from minimal fields only — suggestions, never postings.
- **Matching & reconciliation**: invoice/bill matches (`exact` = amount + number/reference, `amount`, `reference` = part payment), journals already on the bank, categories. Accepting an invoice/bill match sends `bank.matched` (outbox) to Billing; Billing settles and posts the payment journal with `dimensions.bankTxId`, which reconciles the line. Category accepts post a bank journal (VAT split by tax code). Reconciliation per bank account and period: opening + lines = closing (difference 0), every line reconciled or excluded, approval issue, lock.
- **VAT201**: built from journal lines' `taxCode` + `taxBaseMinor`, mapped to SARS fields 1–20 (see `src/domain/vat.ts` for the field list and source), manual fields 10/12/14A/15A/16/17/18, prepare → approval → lock, CSV export. No eFiling.
- **Reports** (all from journals via `jsonb_array_elements`): trial balance, P&L, balance sheet (prior years' profit shown with retained earnings), cash flow (indirect, reconciles to cash by construction), GL with running balance, period comparison, budget vs actual, cash-flow forecast (open AR/AP + 3-month cost average + manual lines), aged AR/AP.
- **Fixed assets**: register, straight-line monthly depreciation (`depreciation:<assetId>:<YYYY-MM>`), disposal with profit/loss.
- **FX**: daily rates from frankfurter.app; month-end revaluation of open foreign items (`fx-reval:<YYYY-MM>`), reversed on the 1st of the next month.
- **Cut-over**: opening trial balance CSV → one opening journal; must balance (or the person chooses to post the difference to opening balance equity); compares TB AR/AP with Billing's open items.
- **Accountant pack**: ZIP (TB, GL, journals, chart, open items, VAT returns, audit hash check) in the private bucket with a 24-hour download link (small packs download directly without R2).
- **Bookkeeper agent**: hired through a normal task (kit `agent-hire`), linked automatically or by hand, granted `tools:use`; skill `pib-bookkeeping`. Gets "Reconcile N new bank lines" after imports and "Month-end close: YYYY-MM" early each month.

## Install (lead)

1. `pnpm install` (already run for this package; the lockfile has the importer).
2. `node ./esbuild.config.mjs` in this folder.
3. Install from the local path (or `/home/paperclip/pib-plugins/plugin-accounting` on the VPS) and approve the capabilities: `events.emit`, `events.subscribe`, `secrets.read-ref`, `http.outbound`, `issues.update`, `authorization.grants.write`, … (see `src/manifest.ts`).
4. Settings → Plugins → Accounting: legal name, VAT number, VAT category (A/B/C/D/E/none), financial year-end month, Jev key (same Paperclip secret as the other plugins), and **Save once** (jobs skip companies without saved settings).
5. Private storage (optional, needed for statements over 1 MB and large packs): a **private** R2 bucket (no public URL), an API token with object read/write, and CORS on the bucket allowing `PUT` from the Paperclip origin, e.g.
   ```json
   [{ "AllowedOrigins": ["https://paperclip.partnersinbiz.online"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600 }]
   ```
6. Import the opening trial balance under Cut-over before relying on the balance sheet. Have the accountant review the chart, role map and VAT mapping.

## Contracts (kit `contracts.ts`)

| Direction | Event | Notes |
|---|---|---|
| in | `plugin.partnersinbiz.billing.ledger.post.requested`, `plugin.partnersinbiz.payroll.ledger.post.requested` | `LedgerPostRequested`; `reverseKey` reverses the journal posted under that key |
| out | `ledger.post.result` | `LedgerPostResult` for every delivery (repeats re-send the stored result) |
| in | `plugin.partnersinbiz.billing.open-item.upserted` | `OpenItemUpserted` projection |
| out | `bank.matched` (outbox, redelivered every 5 min) | `BankMatched`, key `bank:<bankTxId>:<openItemKey>` |
| in | `plugin.partnersinbiz.billing.bank.match.result` | `BankMatchResult` → `settleOutbox` |
| in | `plugin.partnersinbiz.mailbox.mail.received` | category `bank_statement` opens one "Bank statement received" issue |

What senders should do so the books and VAT201 come out right:

- Post VAT on a `vat_output` / `vat_input` role line carrying `taxCode` and `taxBaseMinor` (the net). Revenue/expense lines may also carry the `taxCode`; zero-rated, export and exempt lines must (they have no VAT line).
- Use `source.kind: "credit_note"` for credit notes (their VAT goes to field 18 / 12), and a bad-debt journal on the `bad_debts` role for write-offs (field 17).
- The payment journal for a bank match should post the bank side to `accountCode: <BankMatched.bankAccountCode>` and put `dimensions.bankTxId` on a line; that reconciles the bank line.
- A `rejected` result can later be followed by `posted` for the same key (after a person fixes the cause and clicks Retry). Record the journal id even if the outbox entry was already settled as failed.

## Jobs

- `redeliver` (every 5 min): outbox redelivery, approval issues closed while an event was missed, Bookkeeper hire link.
- `month-end` (daily 03:20 UTC): depreciation through last month; on days 1–7 FX revaluation of last month and the Bookkeeper's month-end close issue.
- `fx-rates` (daily 16:30 UTC): frankfurter.app rates to ZAR.

## Tests

`npx vitest run --config ./vitest.config.ts` — domain tests (parsers with fixtures, matching, VAT201, reports, depreciation, FX, cut-over, hash chain, ZIP), SQL guard checks for every statement, and an end-to-end suite on an embedded Postgres (skipped when `packages/db/node_modules/embedded-postgres` is missing) that also boots the worker in the SDK test harness to check every action, tool, event and job against the manifest's capabilities.
