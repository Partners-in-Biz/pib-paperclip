/**
 * VAT periods from the settings (category A–E), VAT201 preparation from the
 * journals, approval, lock (postings dated inside a locked period are then
 * refused) and CSV export. No SARS e-filing.
 *
 * Periods that ended before these books start (service/books `booksStartFor`)
 * belong to the previous books: the page does not list them and the
 * prepare-vat201 tool does not prepare them, unless a return was already
 * saved here for one.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import * as db from "../db.js";
import { periodLabel } from "../domain/dates.js";
import { toCsv } from "../domain/files.js";
import { endsBeforeBooks, vatPeriodFor, vatPeriodsBetween, vatPeriodsInBooks, type BooksStart } from "../domain/periods.js";
import { vatDueDate } from "../domain/trends.js";
import { AccountingError, addDays, addMonths, decimal, firstDayOfMonth, monthOf, requireDate, todayIso } from "../domain/util.js";
import { computeVatReturn, MANUAL_VAT_FIELDS, VAT_FIELD_LABELS, VAT_FIELDS, type ManualVatField, type VatSourceLine } from "../domain/vat.js";
import { booksStartFor, loadChart, roleAccount } from "./books.js";
import { actorRecord, closeIssue, commentOn, money, newId, readSettings, reopenForPerson, requireUser, type Actor } from "./common.js";
import { openLedgerApproval, retireOldApprovalIssue, reviewGate } from "./review.js";

export interface VatPeriodRow {
  start: string;
  end: string;
  /** Today falls inside the period. */
  current: boolean;
  /** VAT201 due date on eFiling (last business day of the next month). */
  dueDate: string;
  returnId: string | null;
  status: string;
  payableMinor: number | null;
}

/**
 * The recent VAT periods, newest first, without the ones that ended before
 * the books start. `hidden` says how many were left out for that reason.
 */
export async function vatPeriods(ctx: PluginContext, companyId: string, count = 8): Promise<{ category: string; booksStart: BooksStart | null; hidden: number; periods: VatPeriodRow[] }> {
  const settings = await readSettings(ctx, companyId);
  const start = await booksStartFor(ctx, companyId);
  if (settings.vatCategory === "none") return { category: "none", booksStart: start, hidden: 0, periods: [] };
  const today = todayIso();
  const from = firstDayOfMonth(addMonths(monthOf(today), -24));
  const recent = vatPeriodsBetween(from, today, settings.vatCategory, settings.yearEndMonth).slice(-count);
  const returns = await db.listVatReturns(ctx.db, companyId);
  const saved = (p: { start: string; end: string }) => returns.find((x) => x.periodStart === p.start && x.periodEnd === p.end) ?? null;
  const shown = vatPeriodsInBooks(recent, start?.date, (p) => Boolean(saved(p)));
  return {
    category: settings.vatCategory,
    booksStart: start,
    hidden: recent.length - shown.length,
    periods: shown.reverse().map((p) => {
      const r = saved(p);
      return { start: p.start, end: p.end, current: p.start <= today && today <= p.end, dueDate: vatDueDate(p.end), returnId: r?.id ?? null, status: r?.status ?? "not_prepared", payableMinor: r ? Number(r.boxes.f20 ?? 0) : null };
    }),
  };
}

export async function computeForPeriod(ctx: PluginContext, companyId: string, start: string, end: string, adjustments: Partial<Record<ManualVatField, number>>) {
  const chart = await loadChart(ctx, companyId);
  const vatAccountIds = chart.accounts.filter((a) => a.subtype === "vat_output" || a.subtype === "vat_input").map((a) => a.id);
  const badDebt = roleAccount(chart, "bad_debts");
  const raw = await db.vatLines(ctx.db, companyId, start, end, vatAccountIds);
  const rates = await db.listTaxRates(ctx.db, companyId);
  const lines: VatSourceLine[] = [];
  for (const r of raw) {
    const account = chart.byId.get(r.accountId);
    if (!account) continue;
    lines.push({
      journalId: r.journalId,
      journalNumber: r.journalNumber,
      sourceKind: r.sourceKind,
      accountType: account.type,
      accountSubtype: account.subtype,
      isBadDebtAccount: Boolean(badDebt && badDebt.id === account.id),
      debitMinor: r.debitMinor,
      creditMinor: r.creditMinor,
      taxCode: r.taxCode,
      taxBaseMinor: r.taxBaseMinor,
    });
  }
  const rateFor = (code: string) => rates.filter((x) => x.code === code && x.effectiveFrom <= end).sort((a, b) => b.version - a.version)[0]?.rateBps ?? 0;
  return computeVatReturn(lines, adjustments, rateFor);
}

function readAdjustments(input: unknown): Partial<Record<ManualVatField, number>> {
  const out: Partial<Record<ManualVatField, number>> = {};
  if (!input || typeof input !== "object") return out;
  for (const field of MANUAL_VAT_FIELDS) {
    const v = (input as Record<string, unknown>)[field];
    if (v == null || v === "") continue;
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new AccountingError(`Adjustment ${field} must be whole cents`);
    if (n !== 0) out[field] = n;
  }
  return out;
}

export async function prepareVatReturn(ctx: PluginContext, companyId: string, actor: Actor, input: { periodStart?: unknown; periodEnd?: unknown; date?: unknown; adjustments?: unknown }) {
  const settings = await readSettings(ctx, companyId);
  let start: string;
  let end: string;
  if (input.periodStart || input.periodEnd) {
    start = requireDate(input.periodStart, "periodStart");
    end = requireDate(input.periodEnd, "periodEnd");
  } else {
    const period = vatPeriodFor(typeof input.date === "string" ? input.date : todayIso(), settings.vatCategory, settings.yearEndMonth);
    if (!period) throw new AccountingError("Set the VAT category in the Accounting settings first");
    start = period.start;
    end = period.end;
  }
  if (end < start) throw new AccountingError("The period ends before it starts");
  const existing = await db.vatReturnByPeriod(ctx.db, companyId, start, end);
  if (existing && existing.status !== "draft") throw new AccountingError(`This VAT return is ${existing.status === "locked" ? "locked" : "waiting for approval"}`, "conflict");
  const adjustments = input.adjustments === undefined && existing ? readAdjustments(existing.adjustments) : readAdjustments(input.adjustments);
  const result = await computeForPeriod(ctx, companyId, start, end, adjustments);
  await db.upsertVatReturn(ctx.db, companyId, { id: existing?.id ?? newId(), periodStart: start, periodEnd: end, boxes: result.boxes, detail: result.detail, adjustments }, actorRecord(actor));
  const saved = (await db.vatReturnByPeriod(ctx.db, companyId, start, end))!;
  return { vatReturn: saved, warnings: result.warnings };
}

export async function requestVatApproval(ctx: PluginContext, companyId: string, actor: Actor, id: string) {
  const ret = await db.getVatReturn(ctx.db, companyId, id);
  if (!ret) throw new AccountingError("VAT return not found", "not_found");
  if (ret.status !== "draft") throw new AccountingError("Approval was already requested", "conflict");
  // Recompute so the approver sees current numbers.
  const { vatReturn, warnings } = await prepareVatReturn(ctx, companyId, actor, { periodStart: ret.periodStart, periodEnd: ret.periodEnd, adjustments: ret.adjustments });
  const b = vatReturn.boxes;
  const settings = await readSettings(ctx, companyId);
  const issue = await openLedgerApproval(ctx, {
    companyId,
    kind: "vat",
    subjectId: ret.id,
    actor,
    title: `Approve VAT201 for ${periodLabel(ret.periodStart, ret.periodEnd)} (${Number(b.f20) >= 0 ? "pay" : "refund"} ${money(Math.abs(Number(b.f20 ?? 0)))})`,
    description: [
      `VAT return (VAT201) for ${settings.legalName || "the company"}${settings.vatNumber ? ` (VAT ${settings.vatNumber})` : ""}, ${periodLabel(ret.periodStart, ret.periodEnd)}. Prepared by ${actor.kind === "agent" ? "the Bookkeeper" : "a board user"}.`,
      "",
      "| Field | Amount |",
      "|---|---:|",
      ...["f1", "f1A", "f2", "f2A", "f3", "f4", "f4A", "f12", "f13", "f14", "f15", "f16", "f17", "f18", "f19", "f20"].map((f) => `| ${VAT_FIELD_LABELS[f as keyof typeof VAT_FIELD_LABELS]} | ${money(Number(b[f] ?? 0))} |`),
      "",
      warnings.length ? `Check first:\n${warnings.map((w) => `- ${w}`).join("\n")}\n` : "",
      "Approving locks the period: nothing dated inside it can post afterwards. To approve, mark this issue done yourself, or approve it under **Accounting → Reports & VAT → VAT**. Only a person can approve: if an agent closes it, it opens again for you. Filing on SARS eFiling and paying stay with you. The Reviewer checks it first when there is one.",
    ].join("\n"),
    priority: "high",
    originId: `vat:${ret.id}`,
  });
  await db.setVatStatus(ctx.db, companyId, ret.id, "draft", { status: "pending_approval", approvalIssueId: issue.id });
  // After a Reviewer send-back the old approval issue is retired, once the row points at the new one (see requestReconciliationApproval).
  await retireOldApprovalIssue(ctx, companyId, ret.approvalIssueId, issue.id);
  return (await db.getVatReturn(ctx.db, companyId, ret.id))!;
}

export async function approveVatReturn(ctx: PluginContext, companyId: string, actor: Actor, id: string, via: "page" | "issue" = "page", options: { overrideReview?: boolean } = {}) {
  const userId = requireUser(actor, "approve a VAT return");
  const ret = await db.getVatReturn(ctx.db, companyId, id);
  if (!ret) throw new AccountingError("VAT return not found", "not_found");
  if (ret.status === "locked") return ret;
  if (ret.status !== "pending_approval") throw new AccountingError("Request approval first", "conflict");
  const gate = await reviewGate(ctx, companyId, "vat", ret.id, { via, userId, override: options.overrideReview });
  // The numbers must not have moved since approval was requested.
  const current = await computeForPeriod(ctx, companyId, ret.periodStart, ret.periodEnd, readAdjustments(ret.adjustments));
  const changed = VAT_FIELDS.filter((f) => Number(ret.boxes[f] ?? 0) !== current.boxes[f]);
  if (changed.length) {
    await db.setVatStatus(ctx.db, companyId, ret.id, "pending_approval", { status: "draft" });
    if (ret.approvalIssueId) await commentOn(ctx, companyId, ret.approvalIssueId, `Not locked: postings changed fields ${changed.map((f) => f.slice(1)).join(", ")} since approval was requested. Prepare it again.`);
    throw new AccountingError(`Postings changed the return since approval was requested (fields ${changed.map((f) => f.slice(1)).join(", ")}). Prepare it again.`, "conflict");
  }
  await db.setVatStatus(ctx.db, companyId, ret.id, "pending_approval", { status: "locked", approvedBy: userId, lock: true });
  await gate.confirm();
  if (via === "page") await closeIssue(ctx, companyId, ret.approvalIssueId, "done", "Approved and locked.");
  else if (ret.approvalIssueId) await commentOn(ctx, companyId, ret.approvalIssueId, "Approved and locked.");
  return (await db.getVatReturn(ctx.db, companyId, ret.id))!;
}

/**
 * The `prepare-vat201` tool: save the VAT201 for a period from the journals
 * and, once the period has ended, open its approval issue for a person.
 * Manual adjustments (fields 10, 12, 14A, 15A, 16 to 18) stay with people on
 * the page; a saved draft keeps the ones they entered.
 */
export async function prepareVat201Tool(ctx: PluginContext, companyId: string, actor: Actor, input: { periodStart?: unknown; periodEnd?: unknown; date?: unknown; requestApproval?: unknown }) {
  let start: string;
  let end: string;
  if (input.periodStart || input.periodEnd) {
    start = requireDate(input.periodStart, "periodStart");
    end = requireDate(input.periodEnd, "periodEnd");
  } else {
    const settings = await readSettings(ctx, companyId);
    const today = todayIso();
    const current = vatPeriodFor(input.date ? requireDate(input.date, "date") : today, settings.vatCategory, settings.yearEndMonth);
    if (!current) throw new AccountingError("The company is not VAT-registered in the Accounting settings, so there is no VAT201.");
    // Without a date: the last VAT period that has ended (the one due next).
    const period = input.date || current.end < today ? current : vatPeriodFor(addDays(current.start, -1), settings.vatCategory, settings.yearEndMonth)!;
    start = period.start;
    end = period.end;
  }
  const saved = await db.vatReturnByPeriod(ctx.db, companyId, start, end);
  if (saved && saved.status !== "draft") {
    return {
      returnId: saved.id,
      periodStart: saved.periodStart,
      periodEnd: saved.periodEnd,
      status: saved.status,
      approvalIssueId: saved.approvalIssueId,
      next: saved.status === "locked" ? "Already approved and locked. Filing on eFiling and paying are a person's job." : "Already waiting for a person's approval on its issue. Nothing to do.",
    };
  }
  // A period that ended before these books start was filed from the previous books.
  const books = await booksStartFor(ctx, companyId);
  if (!saved && endsBeforeBooks({ start, end }, books?.date)) {
    const settings = await readSettings(ctx, companyId);
    const first = vatPeriodFor(books!.date, settings.vatCategory, settings.yearEndMonth);
    return {
      returnId: null,
      periodStart: start,
      periodEnd: end,
      status: "before_books_start",
      booksStart: books!.date,
      approvalIssueId: null,
      next: `This VAT period ended before these books start (${books!.date}), so its VAT201 comes from the previous books. Nothing to prepare or approve here.${first ? ` The first VAT201 from these books is for ${first.start} to ${first.end}; prepare it after ${first.end}.` : ""}`,
    };
  }
  const { vatReturn, warnings } = await prepareVatReturn(ctx, companyId, actor, { periodStart: start, periodEnd: end });
  let ret = vatReturn;
  const ended = ret.periodEnd < todayIso();
  if (input.requestApproval !== false && ended) ret = await requestVatApproval(ctx, companyId, actor, ret.id);
  const payable = Number(ret.boxes.f20 ?? 0);
  return {
    returnId: ret.id,
    periodStart: ret.periodStart,
    periodEnd: ret.periodEnd,
    status: ret.status,
    payableMinor: payable,
    result: payable >= 0 ? `Pay SARS ${money(payable)}` : `Refund from SARS ${money(-payable)}`,
    boxes: ret.boxes,
    warnings,
    approvalIssueId: ret.approvalIssueId,
    next: ret.status === "pending_approval"
      ? "Approval issue opened for a person (it lists the warnings). Nothing more to do here."
      : !ended
        ? `The period ends on ${ret.periodEnd}. Saved as a draft; prepare it again after that to ask for approval.`
        : "Saved as a draft. Run again without requestApproval: false to open the approval issue.",
  };
}

export async function onVatIssue(ctx: PluginContext, companyId: string, ret: db.VatReturnRow, status: string, actor: { type?: string; id?: string }) {
  if (ret.status !== "pending_approval") return;
  if (actor.type === "agent" && (status === "done" || status === "cancelled")) {
    await reopenForPerson(ctx, companyId, ret.approvalIssueId, `VAT201 for ${periodLabel(ret.periodStart, ret.periodEnd)}`);
    return;
  }
  if (status === "cancelled") {
    await db.setVatStatus(ctx.db, companyId, ret.id, "pending_approval", { status: "draft" });
    return;
  }
  if (status !== "done") return;
  if (actor.type === "user" && actor.id) {
    await approveVatReturn(ctx, companyId, { kind: "user", userId: actor.id }, ret.id, "issue").catch(() => undefined);
    return;
  }
  if (ret.approvalIssueId) await commentOn(ctx, companyId, ret.approvalIssueId, "Closed without a person's approval, so the VAT period was not locked. A board user can approve it in Accounting → Reports & VAT → VAT.");
}

export async function vatCsv(ctx: PluginContext, companyId: string, id: string): Promise<{ fileName: string; csv: string }> {
  const ret = await db.getVatReturn(ctx.db, companyId, id);
  if (!ret) throw new AccountingError("VAT return not found", "not_found");
  const settings = await readSettings(ctx, companyId);
  const rows: unknown[][] = VAT_FIELDS.map((f) => [f.slice(1), VAT_FIELD_LABELS[f], decimal(Number(ret.boxes[f] ?? 0))]);
  rows.push([], ["Detail"], ["direction", "tax code", "field", "base", "tax", "journals"]);
  for (const d of ret.detail as Array<Record<string, unknown>>) rows.push([d.direction, d.taxCode, d.field, decimal(Number(d.baseMinor ?? 0)), decimal(Number(d.taxMinor ?? 0)), d.journals]);
  const header = [`VAT201 ${settings.legalName || ""} ${settings.vatNumber || ""} ${ret.periodStart} to ${ret.periodEnd} (${ret.status})`.trim(), "", ""];
  return { fileName: `vat201-${ret.periodStart}-${ret.periodEnd}.csv`, csv: toCsv(header, rows) };
}
