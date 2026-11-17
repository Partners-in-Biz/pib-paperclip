/**
 * Accounting's access table (access stage A, spec PAR-12578 section 4.4). Every
 * page action, agent tool and API route the worker registers has one row here;
 * `tests/access.spec.ts` fails on a missing or stale row.
 *
 * Catalog resources: `accounting.ledger` (view, create, edit, delete, approve),
 * `accounting.reports` (view, export), `accounting.settings` (view, edit),
 * `accounting.bank` (view, edit, approve) and `accounting.assets` (view, create,
 * edit, delete). None is scopable, so no row is `scoped`: Accounting is not in
 * the Client manager preset and stays closed to an own-companies person.
 *
 * Rules used below:
 * - Each area's own postings come with its own permission: a bank line's journal
 *   with `accounting.bank`, depreciation and disposal with `accounting.assets`.
 * - A journal posted straight to the ledger with no approval step (a reversal, a
 *   period close, FX revaluation, the cut-over opening balances) takes ledger approve.
 * - One action that both creates and changes a record takes edit.
 * - A tool has the permission of the matching page action. Hiring, linking,
 *   unlinking and re-wiring the Bookkeeper changes the company's agents: owner or admin only.
 */
import { ADMIN_ONLY, type AccessTable, type PermissionAction } from "@partnersinbiz/pib-plugin-kit";

const ledger = (action: PermissionAction) => ({ resource: "accounting.ledger", action });
const reports = (action: PermissionAction) => ({ resource: "accounting.reports", action });
const settings = (action: PermissionAction) => ({ resource: "accounting.settings", action });
const bank = (action: PermissionAction) => ({ resource: "accounting.bank", action });
const assets = (action: PermissionAction) => ({ resource: "accounting.assets", action });

export const ACCOUNTING_ACCESS_TABLE: AccessTable = Object.freeze({
  // The page's first read returns the book, the overview figures, the chart and
  // the bank accounts, so it takes ledger view, like the trial-balance tool.
  "accounting.load": ledger("view"),

  // Chart of accounts and where each role posts.
  "accounting.chart": ledger("view"),
  "accounting.save-account": settings("edit"),
  "accounting.map-role": settings("edit"),

  // Journals, periods and the audit chain.
  "accounting.journals": ledger("view"),
  "accounting.journal": ledger("view"),
  "accounting.reverse-journal": ledger("approve"),
  "accounting.verify-chain": ledger("view"),
  "accounting.periods": ledger("view"),
  "accounting.set-period": ledger("approve"),
  "accounting.close-checklist": ledger("view"),

  // Manual journal drafts and their approval.
  "accounting.drafts": ledger("view"),
  "accounting.save-draft": ledger("edit"),
  "accounting.request-draft-approval": ledger("edit"),
  "accounting.approve-draft": ledger("approve"),
  "accounting.cancel-draft": ledger("delete"),

  // Postings another plugin sent that the ledger rejected.
  "accounting.rejections": ledger("view"),
  "accounting.retry-rejection": ledger("edit"),
  "accounting.dismiss-rejection": ledger("edit"),

  // Bank accounts, statements, categorisation and reconciliation.
  "accounting.bank": bank("view"),
  "accounting.save-bank-account": bank("edit"),
  "accounting.statement-upload-url": bank("edit"),
  "accounting.import-statement": bank("edit"),
  "accounting.queue-pdf-statements": bank("edit"),
  "accounting.bank-lines": bank("view"),
  "accounting.refresh-suggestions": bank("edit"),
  "accounting.accept-suggestion": bank("edit"),
  "accounting.categorise": bank("edit"),
  "accounting.match-open-item": bank("edit"),
  "accounting.match-journal": bank("edit"),
  "accounting.exclude-line": bank("edit"),
  "accounting.undo-line": bank("edit"),
  "accounting.save-rule": bank("edit"),
  "accounting.delete-rule": bank("edit"),
  "accounting.prepare-reconciliation": bank("edit"),
  "accounting.request-reconciliation-approval": bank("edit"),
  "accounting.approve-reconciliation": bank("approve"),
  "accounting.open-reconciliation": bank("view"),
  "accounting.discard-reconciliation": bank("edit"),

  // VAT201: reading and the SARS file are reports; preparing and approving a return are ledger work.
  "accounting.vat": reports("view"),
  "accounting.prepare-vat": ledger("edit"),
  "accounting.request-vat-approval": ledger("edit"),
  "accounting.approve-vat": ledger("approve"),
  "accounting.vat-csv": reports("export"),

  "accounting.report": reports("view"),
  "accounting.trends": reports("view"),

  // Fixed assets.
  "accounting.assets": assets("view"),
  "accounting.save-asset": assets("edit"),
  "accounting.dispose-asset": assets("edit"),
  "accounting.run-depreciation": assets("edit"),

  // Foreign exchange. The rate fetch stores rates for every company: a settings change.
  "accounting.fx": ledger("view"),
  "accounting.fetch-fx": settings("edit"),
  "accounting.revalue-fx": ledger("approve"),

  // Budgets and forecast lines are planning numbers set in the settings; reading them is a report.
  "accounting.budgets": reports("view"),
  "accounting.save-budgets": settings("edit"),
  "accounting.forecast": reports("view"),
  "accounting.save-forecast-line": settings("edit"),
  "accounting.delete-forecast-line": settings("edit"),

  // Cut-over from the previous books.
  "accounting.cutover-preview": settings("edit"),
  "accounting.cutover-post": ledger("approve"),
  "accounting.skip-cutover": settings("edit"),
  "accounting.undo-skip-cutover": settings("edit"),

  // The accountant pack is an export of the books.
  "accounting.pack": reports("export"),
  // How often agents' categorisation suggestions were accepted.
  "accounting.decisions": reports("view"),

  // The Bookkeeper agent.
  "accounting.hire-options": settings("view"),
  "accounting.start-hire": ADMIN_ONLY,
  "accounting.link-agent": ADMIN_ONLY,
  "accounting.unlink-agent": ADMIN_ONLY,
  "accounting.resync-agent": ADMIN_ONLY,
  "accounting.sync-skills": settings("edit"),

  "tool:list-accounts": ledger("view"),
  "tool:list-bank-accounts": bank("view"),
  "tool:import-statement": bank("edit"),
  "tool:pdf-statements": bank("view"),
  "tool:mark-statement-email": bank("edit"),
  "tool:list-bank-lines": bank("view"),
  "tool:suggest-categorisation": bank("edit"),
  "tool:accept-categorisation": bank("edit"),
  "tool:accept-categorisations": bank("edit"),
  "tool:record-review": ledger("edit"),
  "tool:trial-balance": reports("view"),
  "tool:pnl": reports("view"),
  "tool:balance-sheet": reports("view"),
  "tool:gl": reports("view"),
  "tool:vat-summary": reports("view"),
  "tool:create-manual-journal": ledger("edit"),
  "tool:period-close-checklist": ledger("view"),
  "tool:prepare-reconciliation": bank("edit"),
  "tool:mark-not-needed": ledger("edit"),
  "tool:prepare-vat201": ledger("edit"),

  // Setup's checklist for Accounting (the Setup page and the "Get started" card).
  "api:setup-status": settings("view"),
  // The Cockpit's Accounting numbers.
  "api:cockpit": reports("view"),
});
