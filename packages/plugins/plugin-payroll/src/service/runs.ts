/**
 * Pay run lifecycle: create → calculate → adjust → request approval (issue
 * to a board member who did not prepare it) → approve → lock → post to
 * Accounting through the outbox → payslips. Reverse or correct with a new
 * run; a locked run is never edited.
 */
import { createWorkIssue, enqueue, isModuleEnabled, LEDGER_EVENTS, outboxStatus, PIB_PLUGINS, retryOutbox, settleOutbox, type LedgerPostResult } from "@partnersinbiz/pib-plugin-kit";
import { mergeComponents } from "../components.js";
import * as db from "../db.js";
import {
  assertApproverAllowed,
  assertCanAdjust,
  assertCanApprove,
  assertCanCalculate,
  assertCanCancel,
  assertCanLock,
  assertCanRequestApproval,
  assertCanReverse,
  assertPeriod,
  defaultPeriod,
  runNumber,
  sdlApplies,
  variances,
  type Actor,
  type RunKind,
} from "../domain.js";
import { calculatePeriod, type PeriodInput, type PeriodResult } from "../engine.js";
import { paidLeaveHoursInPeriod, unpaidLeaveHoursInPeriod } from "../leave.js";
import { addTotals, EMPTY_RUN_TOTALS, ledgerKey, ledgerPostFor, type RunTotals } from "../ledger.js";
import { formatRand, PayrollError, toCentiHours } from "../money.js";
import { PLUGIN_ID } from "../namespace.js";
import { ruleVersionFor, taxYearOf, type PayFrequency, type RuleVersion } from "../rules.js";
import { assignableUser, errorMessage, optDate, optStr, reqStr, requireUser, today, type Env } from "./env.js";

export const APPROVAL_ORIGIN = `plugin:${PLUGIN_ID}:approval`;

function prepared(actor: Actor) {
  return {
    prepared_by_user_id: actor.kind === "user" ? actor.userId : null,
    prepared_by_agent_id: actor.kind === "agent" ? actor.agentId : null,
    prepared_at: new Date().toISOString(),
  };
}

export async function ruleVersionForDate(env: Env, date: string): Promise<RuleVersion> {
  const version = ruleVersionFor(await db.listRuleVersions(env.ctx), date);
  if (!version) throw new PayrollError(`There are no payroll rules for ${date} (tax year ${taxYearOf(date)}). Add the rule version for that tax year first.`);
  return version;
}

export async function requireRun(env: Env, companyId: string, runId: string): Promise<db.PayRun> {
  const run = await db.getRun(env.ctx, companyId, runId);
  if (!run) throw new PayrollError("Pay run not found");
  return run;
}

export async function createRun(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  if (actor.kind === "system") throw new PayrollError("A person or agent must create the pay run");
  const config = await env.config(companyId);
  const frequency = (params.frequency ?? "monthly") as PayFrequency;
  if (!["monthly", "fortnightly", "weekly"].includes(frequency)) throw new PayrollError("Pay frequency must be monthly, fortnightly or weekly");
  const defaults = defaultPeriod(frequency, optDate(params, "month") ?? today(env), config.defaultPayDay);
  const periodStart = optDate(params, "periodStart") ?? defaults.periodStart;
  const periodEnd = optDate(params, "periodEnd") ?? defaults.periodEnd;
  const payDate = optDate(params, "payDate") ?? defaults.payDate;
  assertPeriod(periodStart, periodEnd, payDate);
  const version = await ruleVersionForDate(env, payDate);
  const kind: RunKind = params.kind === "correction" ? "correction" : "regular";
  const sequence = (await db.countRuns(env.ctx, companyId, payDate.slice(0, 7), frequency, kind)) + 1;
  const run: db.PayRun = {
    id: db.newId("run"),
    companyId,
    number: runNumber(payDate, frequency, sequence, kind),
    kind,
    frequency,
    periodStart,
    periodEnd,
    payDate,
    taxYear: version.taxYear,
    ruleVersionId: version.id,
    status: "draft",
    preparedByUserId: actor.kind === "user" ? actor.userId : null,
    preparedByAgentId: actor.kind === "agent" ? actor.agentId : null,
    preparedAt: new Date().toISOString(),
    approverUserId: null,
    approvalIssueId: null,
    approvalRequestedAt: null,
    approvedByUserId: null,
    approvedAt: null,
    lockedByUserId: null,
    lockedAt: null,
    reversesRunId: null,
    correctsRunId: optStr(params, "correctsRunId", 64),
    reversedByRunId: null,
    ledgerStatus: "none",
    journalId: null,
    journalNumber: null,
    ledgerError: null,
    totals: EMPTY_RUN_TOTALS,
    warnings: [],
    notes: optStr(params, "notes", 1000),
    createdAt: null,
  };
  await db.insertRun(env.ctx, run);
  await db.audit(env.ctx, companyId, actorIds(actor), "run.created", "pay_run", run.id, { number: run.number });
  return { run: runSummary(run) };
}

function actorIds(actor: Actor) {
  return { userId: actor.kind === "user" ? actor.userId : null, agentId: actor.kind === "agent" ? actor.agentId : null };
}

/** Rough yearly leviable payroll from everyone's current terms (for SDL "auto"). */
function projectedAnnualPayroll(terms: Map<string, db.Terms>, activeIds: Set<string>, periods: Record<PayFrequency, number>): number {
  let total = 0;
  for (const [employeeId, t] of terms) {
    if (!activeIds.has(employeeId)) continue;
    const perPeriod = t.workerCategory === "salaried" ? t.rateMinor : Math.round((t.rateMinor * t.standardHoursCenti) / 100);
    total += perPeriod * periods[t.frequency] + (t.travel?.amountMinor ?? 0) * periods[t.frequency];
  }
  return total;
}

export interface CalculationContext {
  run: db.PayRun;
  version: RuleVersion;
  employees: db.Employee[];
  terms: Map<string, db.Terms>;
  inputs: Map<string, db.RunInputs>;
  recurring: db.Recurring[];
  leave: db.LeaveRequest[];
  etiMonths: Map<string, number>;
  sdlOn: boolean;
  etiRegistered: boolean;
}

/** Builds the engine input for one employee (pure given the context). */
export function periodInputFor(c: CalculationContext, employee: db.Employee): PeriodInput {
  const t = c.terms.get(employee.id);
  if (!t) throw new PayrollError("No employment terms");
  const extra = c.inputs.get(employee.id) ?? {};
  const approvedLeave = c.leave.filter((l) => l.employeeId === employee.id).map((l) => ({ id: l.id, type: l.type, status: l.status, startDate: l.startDate, endDate: l.endDate, daysCenti: l.daysCenti }));
  const unpaidFromLeave = unpaidLeaveHoursInPeriod(approvedLeave, c.run.periodStart, c.run.periodEnd, t.hoursPerDayCenti, t.daysPerWeek);
  // Salaried pay already covers paid leave; hourly staff are paid for approved paid leave in the period.
  const paidFromLeave = t.workerCategory === "hourly" ? paidLeaveHoursInPeriod(approvedLeave, c.run.periodStart, c.run.periodEnd, t.hoursPerDayCenti, t.daysPerWeek) : 0;
  const recurring = c.recurring.filter((r) => r.employeeId === employee.id && r.active && r.amountMinor > 0).map((r) => ({ code: r.code, amountMinor: r.amountMinor, label: r.label }));
  const oneOff = (extra.components ?? []).filter((x) => x.amountMinor > 0);
  const etiOn = c.etiRegistered && employee.etiEligible;
  return {
    employeeId: employee.id,
    frequency: c.run.frequency,
    periodStart: c.run.periodStart,
    periodEnd: c.run.periodEnd,
    payDate: c.run.payDate,
    workerCategory: t.workerCategory,
    rateMinor: t.rateMinor,
    standardHoursCenti: t.standardHoursCenti,
    // Hourly staff default to their normal hours less leave taken in the period.
    ordinaryHoursCenti: extra.ordinaryHours != null
      ? toCentiHours(extra.ordinaryHours)
      : t.workerCategory === "hourly" ? Math.max(0, t.standardHoursCenti - paidFromLeave - unpaidFromLeave) : undefined,
    overtimeHoursCenti: toCentiHours(extra.overtimeHours ?? 0),
    overtimeMultiplierBp: t.overtimeMultiplierBp,
    doubleTimeHoursCenti: toCentiHours(extra.doubleTimeHours ?? 0),
    unpaidLeaveHoursCenti: unpaidFromLeave + toCentiHours(extra.unpaidHours ?? 0),
    paidLeaveHoursCenti: extra.paidLeaveHours != null ? toCentiHours(extra.paidLeaveHours) : paidFromLeave,
    dateOfBirth: employee.dateOfBirth,
    uifApplicable: t.uifApplicable,
    sdlApplicable: c.sdlOn && t.sdlApplicable,
    medical: t.medical,
    retirement: t.retirement,
    travelAllowance: t.travel,
    components: [...recurring, ...oneOff],
    eti: etiOn ? { eligible: true, qualifyingMonth: (c.etiMonths.get(employee.id) ?? 0) + employee.etiMonthsBefore + 1 } : null,
  };
}

function snapshotFor(employee: db.Employee, t: db.Terms | undefined): db.ItemSnapshot {
  return {
    name: employee.name,
    employeeNumber: employee.employeeNumber,
    jobTitle: employee.jobTitle,
    email: employee.email,
    frequency: t?.frequency ?? "monthly",
    termsVersion: t?.version ?? null,
    accountMask: employee.masks.accountNumber,
    bankName: employee.masks.bankName,
    taxReferenceMask: employee.masks.taxReference,
  };
}

function itemFromResult(runId: string, employee: db.Employee, t: db.Terms | undefined, input: PeriodInput | null, result: PeriodResult | null, error: string | null, existingId?: string): db.RunItem {
  const totals = result?.totals;
  // The stored input keeps amounts and hours only; the date of birth stays on the employee.
  const storedInput = input ? { ...input, dateOfBirth: undefined } : {};
  return {
    id: existingId ?? db.newId("item"),
    runId,
    employeeId: employee.id,
    termsId: t?.id ?? null,
    status: error ? "error" : "ok",
    error,
    snapshot: snapshotFor(employee, t),
    input: storedInput,
    result,
    grossMinor: totals?.grossMinor ?? 0,
    taxableMinor: totals?.taxableIncomeMinor ?? 0,
    payeMinor: totals?.payeMinor ?? 0,
    uifEmployeeMinor: totals?.uifEmployeeMinor ?? 0,
    uifEmployerMinor: totals?.uifEmployerMinor ?? 0,
    sdlMinor: totals?.sdlMinor ?? 0,
    etiMinor: totals?.etiMinor ?? 0,
    deductionsMinor: totals?.deductionsMinor ?? 0,
    employerContributionsMinor: totals?.employerContributionsMinor ?? 0,
    netMinor: totals?.netPayMinor ?? 0,
    employerCostMinor: totals?.employerCostMinor ?? 0,
  };
}

export function runTotalsFrom(items: db.RunItem[]): RunTotals {
  let totals = { ...EMPTY_RUN_TOTALS };
  for (const item of items) {
    if (item.status !== "ok") continue;
    totals = addTotals(totals, {
      employeeCount: 1,
      grossMinor: item.grossMinor,
      fringeBenefitsMinor: item.result?.totals.fringeBenefitsMinor ?? 0,
      payeMinor: item.payeMinor,
      etiMinor: item.etiMinor,
      uifEmployeeMinor: item.uifEmployeeMinor,
      uifEmployerMinor: item.uifEmployerMinor,
      sdlMinor: item.sdlMinor,
      deductionsMinor: item.deductionsMinor,
      employerContributionsMinor: item.employerContributionsMinor,
      netPayMinor: item.netMinor,
      employerCostMinor: item.employerCostMinor,
    });
  }
  return totals;
}

/**
 * SARS Budget 2026 FAQ: one employee paid below the minimum wage loses the
 * whole month's ETI. Clears ETI on every item when that applies.
 */
export function applyMinimumWageRule(results: Array<{ result: PeriodResult }>, version: RuleVersion): string | null {
  if (!version.rules.eti.wholeClaimLostBelowMinimumWage) return null;
  const below = results.filter((r) => r.result.hours.belowMinimumWage).length;
  const anyEti = results.some((r) => r.result.totals.etiMinor > 0);
  if (!below || !anyEti) return null;
  for (const r of results) {
    r.result.totals.etiMinor = 0;
    delete r.result.sarsCodes["4118"];
  }
  return `No ETI this run: ${below} employee(s) are paid below the national minimum wage, which loses the whole month's claim.`;
}

export async function calculateRun(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  if (actor.kind === "system") throw new PayrollError("A person or agent must calculate the pay run");
  const { ctx } = env;
  const run = await requireRun(env, companyId, reqStr(params, "runId", 64));
  assertCanCalculate(run);
  const version = await ruleVersionForDate(env, run.payDate);
  const config = await env.config(companyId);
  const [allEmployees, terms, inputs, recurring, leave, etiMonths, custom] = await Promise.all([
    db.listEmployees(ctx, companyId),
    db.termsOn(ctx, companyId, run.periodEnd),
    db.getInputs(ctx, run.id),
    db.listRecurring(ctx, companyId),
    db.listLeave(ctx, companyId, { status: "approved" }),
    db.etiMonthsClaimed(ctx, companyId, run.periodStart),
    db.listCustomComponents(ctx, companyId),
  ]);
  const catalogue = mergeComponents(custom);
  const inPeriod = allEmployees.filter((e) => e.startDate <= run.periodEnd && (!e.endDate || e.endDate >= run.periodStart));
  const active = new Set(inPeriod.map((e) => e.id));
  const employees = inPeriod.filter((e) => terms.get(e.id)?.frequency === run.frequency && !(inputs.get(e.id)?.excluded));
  const projected = projectedAnnualPayroll(terms, active, version.rules.periods);
  const sdlOn = sdlApplies(config.sdlMode, projected, version.rules.sdl.annualExemptionThresholdMinor);
  const context: CalculationContext = { run, version, employees, terms, inputs, recurring, leave, etiMonths, sdlOn, etiRegistered: config.etiRegistered };

  const warnings: string[] = [];
  if (version.unverified.length) warnings.push(`${version.unverified.length} payroll rule(s) for ${version.taxYear} are not confirmed yet; check them before relying on the figures.`);
  if (!sdlOn && config.sdlMode === "auto") warnings.push(`SDL is not charged: yearly payroll looks like ${formatRand(projected)}, under the ${formatRand(version.rules.sdl.annualExemptionThresholdMinor)} exemption.`);
  if (!employees.length) warnings.push(`No ${run.frequency} employees with employment terms were found for this period.`);
  const noTerms = inPeriod.filter((e) => !terms.has(e.id));
  if (noTerms.length) warnings.push(`Left out, no employment terms yet: ${noTerms.map((e) => e.name).join(", ")}.`);

  const computed: Array<{ employee: db.Employee; input: PeriodInput | null; result: PeriodResult | null; error: string | null }> = [];
  for (const employee of employees) {
    try {
      const input = periodInputFor(context, employee);
      computed.push({ employee, input, result: calculatePeriod(input, version.rules, catalogue), error: null });
    } catch (error) {
      computed.push({ employee, input: null, result: null, error: errorMessage(error) });
    }
  }
  const minWageNote = applyMinimumWageRule(computed.filter((c): c is typeof c & { result: PeriodResult } => c.result !== null), version);
  if (minWageNote) warnings.push(minWageNote);

  const existing = new Map((await db.listItems(ctx, companyId, run.id)).map((i) => [i.employeeId, i.id]));
  const items: db.RunItem[] = [];
  for (const c of computed) {
    const t = terms.get(c.employee.id);
    const item = itemFromResult(run.id, c.employee, t, c.input, c.result, c.error, existing.get(c.employee.id));
    items.push(item);
    await db.upsertItem(ctx, companyId, item);
    if (!c.employee.hasBank) warnings.push(`${c.employee.name} has no bank details; they will be left out of the net pay file.`);
    if (!c.employee.hasTax) warnings.push(`${c.employee.name} has no tax reference number (needed for the IRP5).`);
    if (c.employee.etiEligible && config.etiRegistered && !c.employee.hasIdentity) warnings.push(`${c.employee.name} is marked for ETI but has no ID number on file.`);
  }
  await db.excludeItemsNotIn(ctx, companyId, run.id, employees.map((e) => e.id));

  const totals = runTotalsFrom(items);
  const hadApproval = run.status === "pending_approval" ? run.approvalIssueId : null;
  const changed = await db.updateRun(ctx, companyId, run.id, {
    status: "calculated",
    rule_version_id: version.id,
    ...prepared(actor),
    approver_user_id: null,
    approval_issue_id: null,
    approval_requested_at: null,
    totals,
    warnings,
  }, ["draft", "calculated", "pending_approval"]);
  if (!changed) throw new PayrollError("The pay run changed while it was being calculated; open it again");
  if (hadApproval) await closeApprovalIssue(env, companyId, hadApproval, "cancelled", "The pay run was recalculated, so this approval request no longer applies. A new request will be sent.");
  await db.audit(ctx, companyId, actorIds(actor), "run.calculated", "pay_run", run.id, { employees: totals.employeeCount, errors: items.filter((i) => i.status === "error").length });
  return runDetail(env, companyId, run.id);
}

export async function adjustItem(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const run = await requireRun(env, companyId, reqStr(params, "runId", 64));
  assertCanAdjust(run);
  const employeeId = reqStr(params, "employeeId", 64);
  if (!(await db.getEmployee(env.ctx, companyId, employeeId))) throw new PayrollError("Employee not found");
  const current = (await db.getInputs(env.ctx, run.id)).get(employeeId) ?? {};
  const next = { ...current, ...parseInputs(params.inputs ?? params) };
  await db.upsertInputs(env.ctx, companyId, run.id, employeeId, next, actorIds(actor));
  return calculateRun(env, companyId, actor, { runId: run.id });
}

function hoursOrUndefined(value: unknown, key: string): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 744) throw new PayrollError(`${key} must be between 0 and 744 hours`);
  return n;
}

export function parseInputs(raw: unknown): db.RunInputs {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: db.RunInputs = {};
  if (typeof v.excluded === "boolean") out.excluded = v.excluded;
  for (const key of ["ordinaryHours", "overtimeHours", "doubleTimeHours", "paidLeaveHours", "unpaidHours"] as const) {
    const h = hoursOrUndefined(v[key], key);
    if (h !== undefined) out[key] = h;
  }
  if (Array.isArray(v.components)) {
    out.components = v.components.map((c, i) => {
      const item = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
      const code = String(item.code ?? "").trim().toUpperCase();
      const amount = Number(item.amountMinor);
      if (!code) throw new PayrollError(`Component ${i + 1} needs a code`);
      if (!Number.isSafeInteger(amount) || amount < 0) throw new PayrollError(`Component ${code} needs an amount in whole cents`);
      return { code, amountMinor: amount, label: typeof item.label === "string" ? item.label.slice(0, 80) : null };
    });
  }
  if (typeof v.note === "string") out.note = v.note.slice(0, 500);
  return out;
}

async function closeApprovalIssue(env: Env, companyId: string, issueId: string, status: "done" | "cancelled", comment: string): Promise<void> {
  try {
    await env.ctx.issues.update(issueId, { status }, companyId);
  } catch (error) {
    env.ctx.logger.info("Approval issue update skipped", { issueId, error: errorMessage(error) });
  }
  try {
    await env.ctx.issues.createComment(issueId, comment, companyId);
  } catch (error) {
    env.ctx.logger.info("Approval comment skipped", { issueId, error: errorMessage(error) });
  }
}

export async function requestApproval(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  if (actor.kind === "system") throw new PayrollError("A person or agent must request approval");
  const run = await requireRun(env, companyId, reqStr(params, "runId", 64));
  const items = await db.listItems(env.ctx, companyId, run.id);
  const ok = items.filter((i) => i.status === "ok");
  assertCanRequestApproval(run, ok.length, items.filter((i) => i.status === "error").length);
  const config = await env.config(companyId);
  // Separation of duties: the approver is neither the person who calculated the run nor the person asking.
  const approver = assertApproverAllowed(run, optStr(params, "approverUserId", 64) ?? config.defaultApproverUserId);
  if (actor.kind === "user" && actor.userId === approver) throw new PayrollError("You cannot send a pay run to yourself for approval. Choose someone else.");
  const t = run.totals;
  const description = [
    `Pay run **${run.number}** (${run.frequency}, ${run.periodStart} to ${run.periodEnd}, paid ${run.payDate}) is ready for approval.`,
    "",
    `| | |`,
    `|---|---|`,
    `| Employees | ${t.employeeCount} |`,
    `| Gross pay | ${formatRand(t.grossMinor)} |`,
    `| PAYE | ${formatRand(t.payeMinor)} |`,
    `| UIF (employee + employer) | ${formatRand(t.uifEmployeeMinor + t.uifEmployerMinor)} |`,
    `| SDL | ${formatRand(t.sdlMinor)} |`,
    `| ETI | ${formatRand(t.etiMinor)} |`,
    `| Net pay | ${formatRand(t.netPayMinor)} |`,
    `| Cost to company | ${formatRand(t.employerCostMinor)} |`,
    "",
    ...(run.warnings.length ? ["**Check first:**", ...run.warnings.map((w) => `- ${w}`), ""] : []),
    "Open **Payroll → Pay runs** to review each employee's calculation, then click **Approve** (or mark this issue done).",
    "The person who prepared the run cannot approve it. Approving does not pay anyone; after approval a board member locks the run, which posts it to Accounting and creates payslips.",
  ].join("\n");
  const issue = await createWorkIssue(env.ctx, {
    companyId,
    title: `Approve pay run ${run.number}`,
    description,
    priority: "high",
    ...(assignableUser(approver) ? { assigneeUserId: assignableUser(approver) } : {}),
    originKind: APPROVAL_ORIGIN as Parameters<typeof createWorkIssue>[1]["originKind"],
    originId: run.id,
    wake: false,
  });
  const changed = await db.updateRun(env.ctx, companyId, run.id, {
    status: "pending_approval",
    approver_user_id: approver,
    approval_issue_id: issue.id,
    approval_requested_at: new Date().toISOString(),
  }, ["calculated"]);
  if (!changed) {
    await closeApprovalIssue(env, companyId, issue.id, "cancelled", "The pay run changed before approval was requested.");
    throw new PayrollError("The pay run changed; open it again");
  }
  await db.audit(env.ctx, companyId, actorIds(actor), "run.approval_requested", "pay_run", run.id, { approverUserId: approver, issueId: issue.id });
  return { runId: run.id, status: "pending_approval", approvalIssueId: issue.id };
}

export async function approveRun(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>, fromIssue = false) {
  const run = await requireRun(env, companyId, reqStr(params, "runId", 64));
  const approver = assertCanApprove(run, actor);
  const changed = await db.updateRun(env.ctx, companyId, run.id, { status: "approved", approved_by_user_id: approver, approved_at: new Date().toISOString() }, ["pending_approval"]);
  if (!changed) throw new PayrollError("The pay run is no longer waiting for approval");
  if (run.approvalIssueId && !fromIssue) await closeApprovalIssue(env, companyId, run.approvalIssueId, "done", "Approved in Payroll.");
  else if (run.approvalIssueId) {
    try {
      await env.ctx.issues.createComment(run.approvalIssueId, "Approved. A board member can now lock the pay run in Payroll.", companyId);
    } catch {
      // comment is best effort
    }
  }
  await db.audit(env.ctx, companyId, actorIds(actor), "run.approved", "pay_run", run.id, { fromIssue });
  return { runId: run.id, status: "approved" };
}

export async function rejectRun(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const user = requireUser(actor);
  const run = await requireRun(env, companyId, reqStr(params, "runId", 64));
  if (run.status !== "pending_approval") throw new PayrollError("The pay run is not waiting for approval");
  const reason = optStr(params, "reason", 1000) ?? "No reason given";
  const changed = await db.updateRun(env.ctx, companyId, run.id, { status: "calculated", approver_user_id: null, approval_issue_id: null, approval_requested_at: null }, ["pending_approval"]);
  if (!changed) throw new PayrollError("The pay run changed; open it again");
  if (run.approvalIssueId) await closeApprovalIssue(env, companyId, run.approvalIssueId, "cancelled", `Sent back: ${reason}`);
  await db.audit(env.ctx, companyId, { userId: user.userId, agentId: null }, "run.rejected", "pay_run", run.id, { reason });
  return { runId: run.id, status: "calculated" };
}

/**
 * The approval issue changed. Done by a board member who did not prepare
 * the run approves it; done by anyone else reopens the issue with a note.
 * Cancelled sends the run back.
 */
export async function onApprovalIssueUpdated(env: Env, companyId: string, issueId: string, event: { actorType?: string; actorId?: string; status?: string }) {
  if (event.actorType === "plugin") return;
  const run = await db.getRunByApprovalIssue(env.ctx, companyId, issueId);
  if (!run || run.status !== "pending_approval") return;
  const issue = await env.ctx.issues.get(issueId, companyId);
  const status = issue?.status ?? event.status;
  if (status === "done") {
    const actor: Actor = event.actorType === "user" && event.actorId
      ? { kind: "user", userId: event.actorId, agentId: null }
      : { kind: event.actorType === "agent" ? "agent" : "system", userId: null, agentId: event.actorType === "agent" ? event.actorId ?? null : null };
    try {
      await approveRun(env, companyId, actor, { runId: run.id }, true);
    } catch (error) {
      try {
        await env.ctx.issues.update(issueId, { status: "todo" }, companyId);
        await env.ctx.issues.createComment(issueId, `Not approved: ${errorMessage(error)} The issue was reopened.`, companyId);
      } catch (inner) {
        env.ctx.logger.info("Could not reopen the approval issue", { issueId, error: errorMessage(inner) });
      }
    }
  } else if (status === "cancelled") {
    await db.updateRun(env.ctx, companyId, run.id, { status: "calculated", approver_user_id: null, approval_issue_id: null, approval_requested_at: null }, ["pending_approval"]);
  }
}

export async function lockRun(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const user = requireUser(actor);
  const run = await requireRun(env, companyId, reqStr(params, "runId", 64));
  assertCanLock(run, actor);
  const changed = await db.updateRun(env.ctx, companyId, run.id, { status: "locked", locked_by_user_id: user.userId, locked_at: new Date().toISOString(), ledger_status: "pending", ledger_error: null }, ["approved"]);
  if (!changed) throw new PayrollError("The pay run is no longer approved");
  if (run.kind === "reversal" && run.reversesRunId) {
    await db.updateRun(env.ctx, companyId, run.reversesRunId, { status: "reversed" }, ["locked"]);
  }
  await postToLedger(env, companyId, { ...run, status: "locked" });
  await db.audit(env.ctx, companyId, { userId: user.userId, agentId: null }, "run.locked", "pay_run", run.id, {});
  return { runId: run.id, status: "locked" };
}

export const ACCOUNTING_OFF = "Accounting is switched off for this company, so this run was not posted. Turn Accounting on in Setup, then post it again.";

/** True when Accounting is on for the company (no choice saved counts as on). */
export function accountingEnabled(env: Env, companyId: string): Promise<boolean> {
  return isModuleEnabled(env.ctx, companyId, PIB_PLUGINS.accounting);
}

/** Queues the run's journal for Accounting. False when nothing was queued. */
export async function postToLedger(env: Env, companyId: string, run: db.PayRun): Promise<boolean> {
  if (!(await accountingEnabled(env, companyId))) {
    // The run still locks; it is simply not posted until Accounting is on.
    await db.updateRun(env.ctx, companyId, run.id, { ledger_status: "none", ledger_error: ACCOUNTING_OFF });
    return false;
  }
  try {
    const payload = ledgerPostFor({
      id: run.id,
      number: run.number,
      kind: run.kind,
      payDate: run.payDate,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      totals: run.totals,
      reversesRunId: run.reversesRunId,
    });
    await enqueue(env.ctx, companyId, LEDGER_EVENTS.postRequested, payload as unknown as { key: string } & Record<string, unknown>);
    return true;
  } catch (error) {
    await db.updateRun(env.ctx, companyId, run.id, { ledger_status: "failed", ledger_error: errorMessage(error) });
    env.ctx.logger.error("Pay run ledger post failed", { runId: run.id, error: errorMessage(error) });
    return false;
  }
}

/** `plugin.partnersinbiz.accounting.ledger.post.result` for one of our runs. */
export async function onLedgerResult(env: Env, companyId: string, payload: unknown): Promise<void> {
  const result = payload as Partial<LedgerPostResult> | null;
  if (!result || typeof result.key !== "string" || !result.key.startsWith("payroll:run:")) return;
  if (result.source && result.source.plugin && result.source.plugin !== PLUGIN_ID) return;
  const runId = result.source?.id ?? result.key.slice("payroll:run:".length);
  const posted = result.status === "posted";
  await settleOutbox(env.ctx, result.key, result as Record<string, unknown>, posted ? "done" : "failed");
  await db.updateRun(env.ctx, companyId, runId, posted
    ? { ledger_status: "posted", journal_id: result.journalId ?? null, journal_number: result.journalNumber ?? null, ledger_error: null }
    : { ledger_status: "rejected", ledger_error: rejectionText(result.error) });
}

/** Accounting's reason, with the next step when it was switched off after the run was queued. */
export function rejectionText(error: string | null | undefined): string {
  const text = typeof error === "string" && error.trim() ? error.trim() : "Accounting refused the journal";
  return /switched off/i.test(text) ? `${text.replace(/\.$/, "")}. Turn Accounting on in Setup, then post it again.` : text;
}

/** Posts again after Accounting refused the journal (e.g. once the chart is set up). */
export async function repostLedger(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  requireUser(actor);
  const run = await requireRun(env, companyId, reqStr(params, "runId", 64));
  if (run.status !== "locked" && run.status !== "reversed") throw new PayrollError("Only a locked pay run is posted to Accounting");
  if (run.ledgerStatus === "posted") throw new PayrollError("The pay run is already posted");
  if (!(await accountingEnabled(env, companyId))) throw new PayrollError("Accounting is switched off for this company. Turn it on in Setup first.");
  const row = await outboxStatus(env.ctx, ledgerKey(run.id));
  if (row?.status === "failed") await retryOutbox(env.ctx, ledgerKey(run.id));
  else if (!row && !(await postToLedger(env, companyId, run))) {
    const failed = await requireRun(env, companyId, run.id);
    return { runId: run.id, ledgerStatus: failed.ledgerStatus };
  }
  await db.updateRun(env.ctx, companyId, run.id, { ledger_status: "pending", ledger_error: null });
  return { runId: run.id, ledgerStatus: "pending" };
}

function negate(result: PeriodResult | null): PeriodResult | null {
  if (!result) return null;
  const totals = { ...result.totals };
  for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] = -totals[key];
  const sarsCodes: Record<string, number> = {};
  for (const [code, amount] of Object.entries(result.sarsCodes)) sarsCodes[code] = -amount;
  return { ...result, totals, sarsCodes, lines: result.lines.map((l) => ({ ...l, amountMinor: -l.amountMinor })), trace: [], warnings: ["Reversal of the original calculation"] };
}

export async function reverseRun(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  if (actor.kind === "system") throw new PayrollError("A person or agent must reverse the pay run");
  const original = await requireRun(env, companyId, reqStr(params, "runId", 64));
  assertCanReverse(original);
  const payDate = optDate(params, "payDate") ?? today(env);
  if (taxYearOf(payDate) !== original.taxYear) throw new PayrollError(`Reverse within the same tax year (${original.taxYear}); pick a pay date in it`);
  const sequence = (await db.countRuns(env.ctx, companyId, payDate.slice(0, 7), original.frequency, "reversal")) + 1;
  const items = (await db.listItems(env.ctx, companyId, original.id)).filter((i) => i.status === "ok");
  const reversal: db.PayRun = {
    ...original,
    id: db.newId("run"),
    number: runNumber(payDate, original.frequency, sequence, "reversal"),
    kind: "reversal",
    payDate,
    status: "calculated",
    preparedByUserId: actor.kind === "user" ? actor.userId : null,
    preparedByAgentId: actor.kind === "agent" ? actor.agentId : null,
    preparedAt: new Date().toISOString(),
    approverUserId: null,
    approvalIssueId: null,
    approvalRequestedAt: null,
    approvedByUserId: null,
    approvedAt: null,
    lockedByUserId: null,
    lockedAt: null,
    reversesRunId: original.id,
    correctsRunId: null,
    reversedByRunId: null,
    ledgerStatus: "none",
    journalId: null,
    journalNumber: null,
    ledgerError: null,
    totals: negateTotals(original.totals),
    warnings: [`Reverses pay run ${original.number}. Locking it posts the reversing journal and marks ${original.number} reversed.`],
    notes: optStr(params, "reason", 1000),
  };
  const claimed = await db.updateRun(env.ctx, companyId, original.id, { reversed_by_run_id: reversal.id }, ["locked"]);
  if (!claimed) throw new PayrollError("The pay run changed; open it again");
  await db.insertRun(env.ctx, reversal);
  for (const item of items) {
    const result = negate(item.result);
    await db.upsertItem(env.ctx, companyId, {
      ...item,
      id: db.newId("item"),
      runId: reversal.id,
      result,
      grossMinor: -item.grossMinor,
      taxableMinor: -item.taxableMinor,
      payeMinor: -item.payeMinor,
      uifEmployeeMinor: -item.uifEmployeeMinor,
      uifEmployerMinor: -item.uifEmployerMinor,
      sdlMinor: -item.sdlMinor,
      etiMinor: -item.etiMinor,
      deductionsMinor: -item.deductionsMinor,
      employerContributionsMinor: -item.employerContributionsMinor,
      netMinor: -item.netMinor,
      employerCostMinor: -item.employerCostMinor,
    });
  }
  await db.audit(env.ctx, companyId, actorIds(actor), "run.reversal_created", "pay_run", reversal.id, { reverses: original.id });
  return { run: runSummary(reversal) };
}

function negateTotals(t: RunTotals): RunTotals {
  const out = { ...t };
  for (const key of Object.keys(out) as Array<keyof RunTotals>) out[key] = key === "employeeCount" ? t.employeeCount : -t[key];
  return out;
}

/** Reverse the run and start a correction run for the same period with the same inputs. */
export async function correctRun(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const original = await requireRun(env, companyId, reqStr(params, "runId", 64));
  const { run: reversal } = await reverseRun(env, companyId, actor, params);
  const { run: correction } = await createRun(env, companyId, actor, {
    frequency: original.frequency,
    periodStart: original.periodStart,
    periodEnd: original.periodEnd,
    payDate: optDate(params, "payDate") ?? today(env),
    kind: "correction",
    correctsRunId: original.id,
    notes: `Corrects ${original.number}`,
  });
  const inputs = await db.getInputs(env.ctx, original.id);
  for (const [employeeId, value] of inputs) await db.upsertInputs(env.ctx, companyId, correction.id, employeeId, value, actorIds(actor));
  return { reversal, correction };
}

export async function cancelRun(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  if (actor.kind === "system") throw new PayrollError("A person or agent must cancel the pay run");
  const run = await requireRun(env, companyId, reqStr(params, "runId", 64));
  assertCanCancel(run);
  const changed = await db.updateRun(env.ctx, companyId, run.id, { status: "cancelled" }, ["draft", "calculated", "pending_approval"]);
  if (!changed) throw new PayrollError("The pay run changed; open it again");
  if (run.approvalIssueId) await closeApprovalIssue(env, companyId, run.approvalIssueId, "cancelled", "The pay run was cancelled.");
  if (run.kind === "reversal" && run.reversesRunId) await db.updateRun(env.ctx, companyId, run.reversesRunId, { reversed_by_run_id: null }, ["locked"]);
  await db.audit(env.ctx, companyId, actorIds(actor), "run.cancelled", "pay_run", run.id, {});
  return { runId: run.id, status: "cancelled" };
}

export function runSummary(run: db.PayRun) {
  return {
    id: run.id,
    number: run.number,
    kind: run.kind,
    frequency: run.frequency,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    payDate: run.payDate,
    taxYear: run.taxYear,
    status: run.status,
    preparedBy: run.preparedByUserId ? { kind: "user", id: run.preparedByUserId } : run.preparedByAgentId ? { kind: "agent", id: run.preparedByAgentId } : null,
    approverUserId: run.approverUserId,
    approvalIssueId: run.approvalIssueId,
    approvedByUserId: run.approvedByUserId,
    approvedAt: run.approvedAt,
    lockedAt: run.lockedAt,
    reversesRunId: run.reversesRunId,
    correctsRunId: run.correctsRunId,
    reversedByRunId: run.reversedByRunId,
    ledger: { status: run.ledgerStatus, journalNumber: run.journalNumber, error: run.ledgerError },
    totals: run.totals,
    warnings: run.warnings,
  };
}

/** Item view: names, masks, amounts and the calculation trace. No sealed values. */
export function itemView(item: db.RunItem) {
  return {
    id: item.id,
    employeeId: item.employeeId,
    name: item.snapshot.name,
    employeeNumber: item.snapshot.employeeNumber,
    status: item.status,
    error: item.error,
    grossMinor: item.grossMinor,
    taxableMinor: item.taxableMinor,
    payeMinor: item.payeMinor,
    uifEmployeeMinor: item.uifEmployeeMinor,
    uifEmployerMinor: item.uifEmployerMinor,
    sdlMinor: item.sdlMinor,
    etiMinor: item.etiMinor,
    deductionsMinor: item.deductionsMinor,
    netMinor: item.netMinor,
    employerCostMinor: item.employerCostMinor,
    lines: item.result?.lines ?? [],
    trace: item.result?.trace ?? [],
    warnings: item.result?.warnings ?? [],
    sarsCodes: item.result?.sarsCodes ?? {},
    bank: item.snapshot.accountMask ? `${item.snapshot.bankName ?? "Bank"} ${item.snapshot.accountMask}` : null,
  };
}

export async function runDetail(env: Env, companyId: string, runId: string) {
  const run = await requireRun(env, companyId, runId);
  const [items, inputs, payslips] = await Promise.all([db.listItems(env.ctx, companyId, run.id), db.getInputs(env.ctx, run.id), db.listPayslips(env.ctx, companyId, run.id)]);
  let approvalStatus: string | null = null;
  if (run.approvalIssueId) {
    try {
      approvalStatus = (await env.ctx.issues.get(run.approvalIssueId, companyId))?.status ?? null;
    } catch {
      approvalStatus = null;
    }
  }
  return {
    run: runSummary(run),
    approvalStatus,
    items: items.filter((i) => i.status !== "excluded").map((i) => ({ ...itemView(i), inputs: inputs.get(i.employeeId) ?? {} })),
    excluded: items.filter((i) => i.status === "excluded").map((i) => ({ employeeId: i.employeeId, name: i.snapshot.name })),
    payslips: payslips.map((p) => ({ id: p.id, employeeId: p.employeeId, number: p.number, status: p.status, emailedTo: p.emailedTo ? maskEmail(p.emailedTo) : null, emailedAt: p.emailedAt, error: p.error })),
  };
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  return `${local!.slice(0, 1)}•••@${domain}`;
}

/** Compare a run with the previous locked run of the same frequency. */
export async function runVariances(env: Env, companyId: string, params: Record<string, unknown>) {
  const run = await requireRun(env, companyId, reqStr(params, "runId", 64));
  const runs = await db.listRuns(env.ctx, companyId, 100);
  const compareId = optStr(params, "compareRunId", 64);
  const previous = compareId
    ? runs.find((r) => r.id === compareId)
    : runs.find((r) => r.id !== run.id && r.frequency === run.frequency && r.kind !== "reversal" && (r.status === "locked") && r.payDate <= run.payDate);
  const current = (await db.listItems(env.ctx, companyId, run.id)).filter((i) => i.status === "ok");
  const before = previous ? (await db.listItems(env.ctx, companyId, previous.id)).filter((i) => i.status === "ok") : [];
  const row = (i: db.RunItem) => ({ employeeId: i.employeeId, name: i.snapshot.name, grossMinor: i.grossMinor, netMinor: i.netMinor, payeMinor: i.payeMinor });
  const thresholdPercent = typeof params.thresholdPercent === "number" ? params.thresholdPercent : 10;
  return {
    runId: run.id,
    comparedWith: previous ? { id: previous.id, number: previous.number } : null,
    ...variances(current.map(row), before.map(row), Math.round(thresholdPercent * 100)),
  };
}
