# Accounting (`partnersinbiz.accounting`)

Partners in Biz's own books, and the ledger every other PiB plugin posts to.
Namespace `plugin_accounting_03d0185a67`, page `/accounting`, sidebar entry "Accounting". No client workspace mode.

## What it does

- **Book setup**: on the first settings save (or first use) it seeds a South African chart of accounts (IFRS for SMEs style, 68 accounts), a role map covering every kit `ACCOUNT_ROLES` role plus `expense:<category>` / `revenue:<category>` roles, and the VAT codes (15% from 2018-04-01, versioned). Chart and roles are editable (Books setup → Chart & roles). A newer template only adds accounts/roles; it never overwrites edits.
- **Journals**: one row per journal with `lines jsonb`; `source_key` unique (idempotent); numbered `JNL-000123` (seq read inside a per-company lock, unique `(company_id, seq)` index, retry on clash); sha256 hash chain over canonical content + previous hash (Journals → Check audit chain). Posted journals are never edited; reversals swap the lines. Periods are open / soft-closed (only approved manual journals and reversals) / closed; a locked VAT period refuses postings dated inside it.
- **Manual journals**: draft → approval issue → a board user approves (page button, or marks the issue done — an agent closing it does not count) → posts.
- **Postings from other plugins**: `ledger.post.requested` from Billing and Payroll, handled once per key (`receiveOnce`), result re-sent on repeats. Rejections (unbalanced, closed period, unknown role…) return `status: "rejected"` with a plain error and go to **one** open issue; Journals → Rejected → Retry posts after the cause is fixed. A redelivered rejected key is tried again.
- **Open items**: projection of Billing's receivables/payables (`open-item.upserted`, last `updatedAt` wins) for aged AR/AP, matching, FX and the forecast.
- **Bank**: bank accounts linked to chart accounts; CSV (header auto-detect, SA bank formats, balance column), OFX and MT940 import, deduped by fingerprint; files over 1 MB go to the private R2 bucket by presigned PUT and are parsed by the worker. Bank rules; Jev suggests an account (choice), `vat_applies` and `is_transfer` (noul) from minimal fields only — suggestions, never postings.
- **Matching & reconciliation**: invoice/bill matches (`exact` = amount + number/reference, `amount`, `reference` = part payment), journals already on the bank, categories. Accepting an invoice/bill match sends `bank.matched` (outbox) to Billing; Billing settles and posts the payment journal with `dimensions.bankTxId`, which reconciles the line. Category accepts post a bank journal (VAT split by tax code). Reconciliation per bank account and period: opening + lines = closing (difference 0), every line reconciled or excluded, approval issue, lock.
- **VAT201**: built from journal lines' `taxCode` + `taxBaseMinor`, mapped to SARS fields 1–20 (see `src/domain/vat.ts` for the field list and source), manual fields 10/12/14A/15A/16/17/18, prepare → approval → lock, CSV export. No eFiling.
- **When the books start** (`domain/periods.ts` `booksStart`, `service/books.ts` `booksStartFor`, one place for the page and the tools): the day after the cut-over date when opening balances are posted, else the date of the earliest journal, else the day the book was set up (`books.seeded_at`, its UTC day). VAT periods that ended before it are not listed on the VAT page (it says "Your books start on …, so earlier VAT periods are not shown"; a period that already has a return here stays), `prepare-vat201` answers `status: "before_books_start"` instead of preparing one, `vat-summary` returns `booksStart`, the close checklist leaves that VAT item out, and Journals → Periods lists months from the books start.
- **Reports** (all from journals via `jsonb_array_elements`): trial balance, P&L, balance sheet (prior years' profit shown with retained earnings), cash flow (indirect, reconciles to cash by construction), GL with running balance, period comparison, budget vs actual, cash-flow forecast (open AR/AP + 3-month cost average + manual lines), aged AR/AP.
- **Fixed assets**: register, straight-line monthly depreciation (`depreciation:<assetId>:<YYYY-MM>`), disposal with profit/loss.
- **FX**: daily rates from frankfurter.app; month-end revaluation of open foreign items (`fx-reval:<YYYY-MM>`), reversed on the 1st of the next month.
- **Cut-over**: opening trial balance CSV → one opening journal; must balance (or the person chooses to post the difference to opening balance equity); compares TB AR/AP with Billing's open items. A business with no earlier books says so once: **We started on these books** (board users only; page actions `accounting.skip-cutover` and `accounting.undo-skip-cutover`, stored as `books.cutover_skipped_at` / `cutover_skipped_by`, migration `002`). That counts as done for the Setup item and the Cockpit's opening-balances check; posting opening balances later clears it. `accounting.load` returns it as `book.cutoverSkippedAt`.
- **Accountant pack**: ZIP (TB, GL, journals, chart, open items, VAT returns, audit hash check) in the private bucket with a 24-hour download link (small packs download directly without R2).
- **Bookkeeper agent** (required, like the kit `TEAM_ROLES` entry): hired or picked in **Setup → Team** (a normal hire task, kit `agent-hire`; actions `accounting.hire-options`, `accounting.start-hire`, `accounting.link-agent`, `accounting.unlink-agent`, `accounting.resync-agent`), linked automatically or by hand, granted `tools:use`; skills `pib-bookkeeping` then `pib-company-os`. Gets "Bank statement received" for each statement email, "Reconcile N new bank lines" after imports, "Month-end close: YYYY-MM" early each month and "Accounting: postings were rejected". Every one of these goes to the linked Bookkeeper while it runs, else kit `routeWork(["bookkeeper"])` (the Operator, then the owner), so none is left unassigned. Approval issues (manual journals, reconciliations, VAT201) go to a person: the owner, else whoever asked; an agent closing one gets kit `reopenApprovalForPerson`. The Cockpit snapshot reports the Bookkeeper in `team`. The Accounting page shows a Bookkeeper box only when something is wrong (none and no open hire, a hire open, paused, in error, waiting for approval, or a skill missing), with **Fix in Setup**.

## The page

Five tabs, each with sections (`src/ui/views.ts`): **Overview** · **Bank** · **Journals** (Journals, Drafts, Rejected, Periods) · **Reports & VAT** (Reports, VAT, Budgets & forecast) · **Books setup** (Chart & roles, Cut-over, Assets & exchange rates). `?tab=` takes a tab or a section, and every value the page had before (`overview`, `bank`, `journals`, `chart`, `vat`, `reports`, `assets`, `budgets`, `cutover`) still opens the same content, so Cockpit, Setup and issue links keep working. New section values: `drafts`, `rejected`, `periods`, `setup`. Tab badges mean "needs you": Bank (open lines), Journals (rejected postings, manual journals waiting), Books setup (roles without an account). Settings not saved and roles without an account show as one line each above the tabs on every tab. Journal memos are shown without database ids (`domain/memo.ts` `cleanMemo`; the stored, hash-chained memo is unchanged).

## Agent tools (`partnersinbiz.accounting:*`)

`list-accounts`, `list-bank-accounts`, `import-statement` (CSV/OFX/MT940 as `content`, or the Mailbox `get-attachment` link as `url`), `list-bank-lines`, `suggest-categorisation`, `accept-categorisation`, `prepare-reconciliation` (a month or statement period; opens the approval issue when ready), `vat-summary`, `prepare-vat201` (the last ended period by default; opens the approval issue), `period-close-checklist`, `create-manual-journal`, `trial-balance`, `pnl`, `balance-sheet`, `gl`. None posts, locks or approves on a person's behalf.

## Install (lead)

1. `pnpm install` (already run for this package; the lockfile has the importer).
2. `node ./esbuild.config.mjs` in this folder.
3. Install from the local path (or `/home/paperclip/pib-plugins/plugin-accounting` on the VPS) and approve the capabilities: `events.emit`, `events.subscribe`, `secrets.read-ref`, `http.outbound`, `issues.update`, `authorization.grants.write`, … (see `src/manifest.ts`).
4. Settings → Plugins → Accounting: legal name, VAT number, VAT category (A/B/C/D/E/none), financial year-end month, Jev key (same Paperclip secret as the other plugins), and **Save once** (jobs skip companies without saved settings).
5. Private storage (optional, needed for statements over 1 MB and large packs): a **private** R2 bucket (no public URL), an API token with object read/write, and CORS on the bucket allowing `PUT` from the Paperclip origin, e.g.
   ```json
   [{ "AllowedOrigins": ["https://paperclip.partnersinbiz.online"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600 }]
   ```
6. Import the opening trial balance under Books setup → Cut-over before relying on the balance sheet, or click **We started on these books** there when there are no earlier books. Have the accountant review the chart, role map and VAT mapping.

## Contracts (kit `contracts.ts`)

| Direction | Event | Notes |
|---|---|---|
| in | `plugin.partnersinbiz.billing.ledger.post.requested`, `plugin.partnersinbiz.payroll.ledger.post.requested` | `LedgerPostRequested`; `reverseKey` reverses the journal posted under that key |
| out | `ledger.post.result` | `LedgerPostResult` for every delivery (repeats re-send the stored result) |
| in | `plugin.partnersinbiz.billing.open-item.upserted` | `OpenItemUpserted` projection |
| out | `bank.matched` (outbox, redelivered every 5 min) | `BankMatched`, key `bank:<bankTxId>:<openItemKey>`, then `…:2`, `…:3` when the same line and item are matched again (Billing answers each key once) |
| in | `plugin.partnersinbiz.billing.bank.match.result` | `BankMatchResult` → `settleOutbox`. A later answer for the same key (`needs_review`, then a person's `settled` or `rejected`) is recorded on the row and still applied: `rejected` returns the line to unreconciled with a note, and that item is no longer suggested for it |
| in | `plugin.partnersinbiz.mailbox.mail.received` | category `bank_statement` opens one "Bank statement received" issue with the `get-attachment` → `import-statement` → reconcile steps |

What senders should do so the books and VAT201 come out right:

- Post VAT on a `vat_output` / `vat_input` role line carrying `taxCode` and `taxBaseMinor` (the net). Revenue/expense lines may also carry the `taxCode`; zero-rated, export and exempt lines must (they have no VAT line).
- Use `source.kind: "credit_note"` for credit notes (their VAT goes to field 18 / 12), and a bad-debt journal on the `bad_debts` role for write-offs (field 17).
- The payment journal for a bank match should post the bank side to `accountCode: <BankMatched.bankAccountCode>` and put `dimensions.bankTxId` on a line; that reconciles the bank line.
- A `rejected` result can later be followed by `posted` for the same key (after a person fixes the cause and clicks Retry). Record the journal id even if the outbox entry was already settled as failed.
- When the company switched Accounting off in Setup, every new request gets `rejected` with `error: "Accounting is switched off for this company"` and nothing is stored. After it is switched back on, `retryOutbox` with the same key posts it.

## Setup

- `GET /setup-status?companyId=` (kit `SETUP_STATUS_ROUTE`) returns the checklist: settings, company details, chart, roles, bank account, opening balances, Bookkeeper (required); first statement, private R2, accountant review (optional). The overview's "Finish setting up" card (pib-plugin-ui `GetStarted`) reads it.
- The `redeliver` job pushes the same status as `setup.status` at most once an hour per company.
- Module switch (kit `registerModuleWatch`): when Accounting is off for a company, jobs skip new work for it (Bookkeeper link, depreciation, FX revaluation, month-end issue, status push) and statement emails are ignored. Outbox redelivery, approval issues, bank-match results and the open-item projection keep running. The page and sidebar hide.

## Jobs

- `redeliver` (every 5 min): outbox redelivery, approval issues closed while an event was missed, Bookkeeper hire link.
- `month-end` (daily 03:20 UTC): depreciation through last month; on days 1–7 FX revaluation of last month and the month-end close issue (once per month; Bookkeeper, else the Operator or the owner).
- `fx-rates` (daily 16:30 UTC): frankfurter.app rates to ZAR.

## Tests

`npx vitest run --config ./vitest.config.ts` — domain tests (parsers with fixtures, matching, VAT201, reports, depreciation, FX, cut-over, hash chain, ZIP), SQL guard checks for every statement, and an end-to-end suite on an embedded Postgres (skipped when `packages/db/node_modules/embedded-postgres` is missing) that also boots the worker in the SDK test harness to check every action, tool, event and job against the manifest's capabilities.
