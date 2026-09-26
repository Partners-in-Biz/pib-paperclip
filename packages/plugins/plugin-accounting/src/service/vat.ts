/**
 * VAT periods from the settings (category A–E), VAT201 preparation from the
 * journals, approval, lock (postings dated inside a locked period are then
 * refused) and CSV export. No SARS e-filing.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createWorkIssue } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { toCsv } from "../domain/files.js";
import { vatPeriodFor, vatPeriodsBetween } from "../domain/periods.js";
import { AccountingError, addMonths, decimal, firstDayOfMonth, formatRand, monthOf, requireDate, todayIso } from "../domain/util.js";
import { computeVatReturn, MANUAL_VAT_FIELDS, VAT_FIELD_LABELS, VAT_FIELDS, type ManualVatField, type VatSourceLine } from "../domain/vat.js";
import { loadChart, roleAccount } from "./books.js";
import { actorRecord, closeIssue, commentOn, newId, ORIGIN, readSettings, requireUser, type Actor } from "./common.js";

export async function vatPeriods(ctx: PluginContext, companyId: string, count = 8) {
  const settings = await readSettings(ctx, companyId);
  if (settings.vatCategory === "none") return { category: "none", periods: [] as Array<Record<string, unknown>> };
  const today = todayIso();
  const from = firstDayOfMonth(addMonths(monthOf(today), -24));
  const all = vatPeriodsBetween(from, today, settings.vatCategory, settings.yearEndMonth).slice(-count);
  const returns = await db.listVatReturns(ctx.db, companyId);
  return {
    category: settings.vatCategory,
    periods: all.reverse().map((p) => {
      const r = returns.find((x) => x.periodStart === p.start && x.periodEnd === p.end);
      return { start: p.start, end: p.end, current: p.start <= today && today <= p.end, returnId: r?.id ?? null, status: r?.status ?? "not_prepared", payableMinor: r ? Number(r.boxes.f20 ?? 0) : null };
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
  const issue = await createWorkIssue(ctx, {
    companyId,
    title: `Approve VAT201: ${ret.periodStart} to ${ret.periodEnd} (${Number(b.f20) >= 0 ? "pay" : "refund"} ${formatRand(Math.abs(Number(b.f20 ?? 0)))})`,
    description: [
      `VAT return for ${settings.legalName || "the company"}${settings.vatNumber ? ` (VAT ${settings.vatNumber})` : ""}, ${ret.periodStart} to ${ret.periodEnd}.`,
      "",
      "| Field | Amount |",
      "|---|---:|",
      ...["f1", "f1A", "f2", "f2A", "f3", "f4", "f4A", "f12", "f13", "f14", "f15", "f16", "f17", "f18", "f19", "f20"].map((f) => `| ${VAT_FIELD_LABELS[f as keyof typeof VAT_FIELD_LABELS]} | ${formatRand(Number(b[f] ?? 0))} |`),
      "",
      warnings.length ? `Check first:\n${warnings.map((w) => `- ${w}`).join("\n")}\n` : "",
      "Approving locks the period: nothing dated inside it can post afterwards. Approve under **Accounting → VAT**, or mark this issue done yourself (a person must do it). Filing on SARS eFiling stays with you.",
    ].join("\n"),
    originKind: ORIGIN,
    originId: `vat:${ret.id}`,
    wake: false,
  });
  await db.setVatStatus(ctx.db, companyId, ret.id, "draft", { status: "pending_approval", approvalIssueId: issue.id });
  return (await db.getVatReturn(ctx.db, companyId, ret.id))!;
}

export async function approveVatReturn(ctx: PluginContext, companyId: string, actor: Actor, id: string, via: "page" | "issue" = "page") {
  const userId = requireUser(actor, "approve a VAT return");
  const ret = await db.getVatReturn(ctx.db, companyId, id);
  if (!ret) throw new AccountingError("VAT return not found", "not_found");
  if (ret.status === "locked") return ret;
  if (ret.status !== "pending_approval") throw new AccountingError("Request approval first", "conflict");
  // The numbers must not have moved since approval was requested.
  const current = await computeForPeriod(ctx, companyId, ret.periodStart, ret.periodEnd, readAdjustments(ret.adjustments));
  const changed = VAT_FIELDS.filter((f) => Number(ret.boxes[f] ?? 0) !== current.boxes[f]);
  if (changed.length) {
    await db.setVatStatus(ctx.db, companyId, ret.id, "pending_approval", { status: "draft" });
    if (ret.approvalIssueId) await commentOn(ctx, companyId, ret.approvalIssueId, `Not locked: postings changed fields ${changed.join(", ")} since approval was requested. Prepare it again.`);
    throw new AccountingError(`Postings changed the return since approval was requested (${changed.join(", ")}). Prepare it again.`, "conflict");
  }
  await db.setVatStatus(ctx.db, companyId, ret.id, "pending_approval", { status: "locked", approvedBy: userId, lock: true });
  if (via === "page") await closeIssue(ctx, companyId, ret.approvalIssueId, "done", "Approved and locked.");
  else if (ret.approvalIssueId) await commentOn(ctx, companyId, ret.approvalIssueId, "Approved and locked.");
  return (await db.getVatReturn(ctx.db, companyId, ret.id))!;
}

export async function onVatIssue(ctx: PluginContext, companyId: string, ret: db.VatReturnRow, status: string, actor: { type?: string; id?: string }) {
  if (ret.status !== "pending_approval") return;
  if (status === "cancelled") {
    await db.setVatStatus(ctx.db, companyId, ret.id, "pending_approval", { status: "draft" });
    return;
  }
  if (status !== "done") return;
  if (actor.type === "user" && actor.id) {
    await approveVatReturn(ctx, companyId, { kind: "user", userId: actor.id }, ret.id, "issue").catch(() => undefined);
    return;
  }
  if (ret.approvalIssueId) await commentOn(ctx, companyId, ret.approvalIssueId, "Closed without a person's approval, so the VAT period was not locked. A board user can approve it in Accounting → VAT.");
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
