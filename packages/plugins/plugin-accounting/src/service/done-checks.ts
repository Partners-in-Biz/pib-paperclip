/**
 * Done-checks (kit `registerDoneChecks`): when an agent marks one of
 * Accounting's work issues done, the finished outcome is checked in
 * Accounting's own data. Not finished → the issue opens again with what is
 * missing. Each rule also passes when the work was finished another way
 * (a person did it on the page, or it turned out not to be needed).
 *
 * - "Bank statement received" (`accounting:statement:<messageId>`): the email
 *   is imported, or recorded as a duplicate or not a statement.
 * - "Reconcile N new bank lines" (`accounting:reconcile:<statementId>`): every
 *   line from that statement is matched (reconciled, or sent to Billing) or
 *   excluded with a reason. Lines dated after today wait for a person.
 * - "Month-end close" (`accounting:close:<YYYY-MM>`): each bank account with
 *   lines has a reconciliation for the month and the VAT201 is prepared (or
 *   waiting for approval, or locked), or each is recorded as not needed.
 * - "Accounting: postings were rejected" (`accounting:rejections`): no
 *   rejected posting is still open (re-posted or dismissed).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ASK_OWNER_TOOL, type DoneCheckResult, type DoneCheckRule } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { monthYearLabel, periodLabel } from "../domain/dates.js";
import { dayText, todayIso } from "../domain/util.js";
import { closeNeeds } from "./close.js";
import { readPdfBatch } from "./bank.js";
import { money, readSettings, WORK_ORIGINS } from "./common.js";

const SHOWN = 5;

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Up to SHOWN lines, then "…and N more". */
function listSome<T>(items: T[], line: (item: T) => string, more: (count: number) => string): string[] {
  const out = items.slice(0, SHOWN).map(line);
  if (items.length > SHOWN) out.push(more(items.length - SHOWN));
  return out;
}

/** "Bank statement received": imported, a duplicate, or not a statement. */
export async function checkStatementEmail(ctx: PluginContext, companyId: string, messageId: string): Promise<DoneCheckResult> {
  const row = await db.getStatementEmail(ctx.db, companyId, messageId);
  if (row && row.status !== "received") return { done: true };
  return {
    done: false,
    missing: [
      `Nothing from statement email \`${messageId}\` is imported yet: import each CSV, OFX or MT940 file with \`import-statement\` and \`messageId: "${messageId}"\` (a file you already imported is linked, not added twice).`,
      `A PDF: read it with your pdf skill, then \`import-statement\` with the rows as CSV \`content\`, \`checkRunningBalance: true\` and \`messageId: "${messageId}"\`.`,
      `No statement in it, or already imported another way? Record that with \`mark-statement-email\` (\`outcome\` \`not_statement\` or \`duplicate\`, and the \`reason\`).`,
    ],
  };
}

/** "Read N PDF bank statements": every uploaded PDF has a statement imported from it. */
export async function checkPdfBatch(ctx: PluginContext, companyId: string, batchId: string): Promise<DoneCheckResult> {
  const batch = await readPdfBatch(ctx, companyId, batchId);
  if (!batch) return { done: true };
  const imported = await db.importedObjectKeys(ctx.db, companyId, batch.files.map((f) => f.objectKey));
  const left = batch.files.filter((f) => !imported.has(f.objectKey));
  if (left.length === 0) return { done: true };
  return {
    done: false,
    missing: [
      ...listSome(left, (f) => `Not imported yet: ${f.fileName}`, (n) => `…and ${n} more (\`pdf-statements\` with \`batchId: "${batchId}"\`).`),
      `Read each with your pdf skill and import it with \`import-statement\` (\`content\` = the CSV, \`pdfObjectKey\` = its objectKey, \`checkRunningBalance: true\`). A file that is not a bank statement, or cannot be read: ask once with \`${ASK_OWNER_TOOL}\`; the issue waits with the owner until they answer.`,
    ],
  };
}

/** "Reconcile N new bank lines": the statement's lines are matched or explained. */
export async function checkReconcileLines(ctx: PluginContext, companyId: string, statementId: string, today = todayIso()): Promise<DoneCheckResult> {
  const lines = await db.listBankLines(ctx.db, companyId, { statementId, statuses: ["unreconciled"], limit: 5000 });
  // Agents may not touch a line dated after today: it waits for a person to check the date (flagged in the Cockpit).
  const open = lines.filter((l) => l.date <= today).sort((a, b) => a.date.localeCompare(b.date) || a.amountMinor - b.amountMinor);
  if (open.length === 0) return { done: true };
  const settings = await readSettings(ctx, companyId);
  const missing = [
    ...listSome(open, (l) => `Still open: ${dayText(l.date)}, ${money(l.amountMinor)}, "${l.description.slice(0, 60)}" (\`${l.id}\`)`, (n) => `…and ${n} more still open (\`list-bank-lines\` with \`status: "unreconciled"\`).`),
    settings.agentsMayAcceptCategorisation
      ? `Accept or categorise ${open.length === 1 ? "it" : `these ${plural(open.length, "line")}`} with \`accept-categorisation\`. Put the ones you cannot place in one \`${ASK_OWNER_TOOL}\`; the issue waits with the owner until they answer.`
      : `Accepting is switched off for agents, so a person accepts ${open.length === 1 ? "it" : `these ${plural(open.length, "line")}`} on Accounting → Bank: ask once with \`${ASK_OWNER_TOOL}\`, with your proposed category for each. The issue waits with the owner until they answer.`,
  ];
  return { done: false, missing };
}

/** "Month-end close": the reconciliations and the VAT201 are prepared, or recorded as not needed. */
export async function checkMonthEndClose(ctx: PluginContext, companyId: string, month: string): Promise<DoneCheckResult> {
  const needs = await closeNeeds(ctx, companyId, month);
  const label = monthYearLabel(month) || month;
  const missing: string[] = [];
  for (const r of needs.reconciliations.filter((x) => !x.done)) {
    missing.push(`No reconciliation for ${r.bank.name} for ${label}: \`prepare-reconciliation\` with \`bankAccountId: "${r.bank.id}"\` and \`month: "${month}"\`, or \`mark-not-needed\` (\`step: "reconciliation"\`) with the reason.`);
  }
  if (needs.vat && !needs.vat.done) {
    const p = needs.vat.period;
    missing.push(`No VAT201 for ${periodLabel(p.start, p.end)}: \`prepare-vat201\` with \`periodStart: "${p.start}"\` and \`periodEnd: "${p.end}"\`, or \`mark-not-needed\` (\`step: "vat201"\`) with the reason.`);
  }
  return missing.length ? { done: false, missing } : { done: true };
}

/** "Accounting: postings were rejected": nothing is left to fix. */
export async function checkRejections(ctx: PluginContext, companyId: string): Promise<DoneCheckResult> {
  const open = await db.listRejections(ctx.db, companyId, "open");
  if (open.length === 0) return { done: true };
  return {
    done: false,
    missing: [
      ...listSome(open, (r) => `\`${r.key}\` (${(r.source as { plugin?: string } | null)?.plugin ?? "plugin"}) is still rejected: ${r.error.slice(0, 160)}`, (n) => `…and ${n} more under Accounting → Journals → Rejected.`),
      `Only a person fixes these (map the role or reopen the month, then Retry under Accounting → Journals → Rejected): ask once with \`${ASK_OWNER_TOOL}\` with the exact steps. The issue closes itself when nothing is left.`,
    ],
  };
}

/** The rules registered in setup, one per kind of work Accounting hands to agents. */
export function accountingDoneChecks(): DoneCheckRule[] {
  const rest = (originId: string | null, prefix: string) => (originId ?? "").slice(prefix.length).trim();
  // An origin id this version cannot read is never held against the agent.
  const unreadable: DoneCheckResult = { done: true };
  return [
    {
      originPrefix: WORK_ORIGINS.statement,
      label: "Bank statement received",
      check: async (issue, ctx) => {
        const messageId = rest(issue.originId, WORK_ORIGINS.statement);
        return messageId ? checkStatementEmail(ctx, issue.companyId, messageId) : unreadable;
      },
    },
    {
      originPrefix: WORK_ORIGINS.pdf,
      label: "Read PDF bank statements",
      check: async (issue, ctx) => {
        const batchId = rest(issue.originId, WORK_ORIGINS.pdf);
        return batchId ? checkPdfBatch(ctx, issue.companyId, batchId) : unreadable;
      },
    },
    {
      originPrefix: WORK_ORIGINS.reconcile,
      label: "Reconcile new bank lines",
      check: async (issue, ctx) => {
        const statementId = rest(issue.originId, WORK_ORIGINS.reconcile);
        return statementId ? checkReconcileLines(ctx, issue.companyId, statementId) : unreadable;
      },
    },
    {
      originPrefix: WORK_ORIGINS.close,
      label: "Month-end close",
      check: async (issue, ctx) => {
        const month = rest(issue.originId, WORK_ORIGINS.close);
        return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? checkMonthEndClose(ctx, issue.companyId, month) : unreadable;
      },
    },
    {
      originPrefix: WORK_ORIGINS.rejections,
      label: "Rejected postings",
      check: (issue, ctx) => checkRejections(ctx, issue.companyId),
    },
  ];
}
