/**
 * What starts payroll work each month (run by the follow-up job, once per
 * company and month, so repeats are safe):
 *
 * - "Prepare pay run for <month>": `prepareDaysBefore` days (default 5)
 *   before the monthly pay day, for the Payroll Clerk (else the Operator,
 *   else the owner), unless the month's run is already with the approver.
 * - "EMP201 for <month> due by <date>": from the 1st of the next month until
 *   the due date (the 7th, earlier on a weekend or public holiday), for the
 *   Bookkeeper (else the Payroll Clerk, the Operator, the owner). Payroll
 *   never files or pays SARS: the issue ends in one ask to the owner.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ASK_OWNER_TOOL, createWorkIssue, linkedAgentId, roleAgentUsable, routeWork, teamAgentId, type TeamRoleKey, type WorkRoute } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { defaultPeriod } from "../domain.js";
import { CLERK_ROLE } from "../hire.js";
import { PLUGIN_ID } from "../namespace.js";
import { emp201DueDate } from "../statutory.js";
import { assignableUser, errorMessage, today, type Env } from "./env.js";

export const TRIGGER_ORIGIN = `plugin:${PLUGIN_ID}` as const;

/**
 * Origin ids of the work Payroll hands to agents, one prefix per kind (the
 * done-checks match on them): `payroll:prepare:<YYYY-MM>` ("Prepare pay run
 * for <month>") and `payroll:emp201:<YYYY-MM>` ("EMP201 for <month> due by
 * <date>", the month the staff were paid). Approval issues for people keep
 * their own origin kinds (pay run and leave approvals).
 */
export const WORK_ORIGINS = {
  prepare: "payroll:prepare:",
  emp201: "payroll:emp201:",
} as const;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-09" → "September 2026". */
export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${MONTHS[m - 1]} ${y}`;
}

/** "2026-10-07" → "7 October 2026". */
export function dayName(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function addMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The linked Payroll Clerk when it is running, else null. */
async function ownClerk(ctx: PluginContext, companyId: string): Promise<string | null> {
  try {
    const id = await linkedAgentId(ctx, companyId, CLERK_ROLE);
    if (!id) return null;
    const agent = await ctx.agents.get(id, companyId);
    return agent && roleAgentUsable(String(agent.status ?? "")) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Who gets a payroll issue: the first running agent in `roles` (Payroll's
 * own linked Clerk counts for "payroll-clerk", before the Cockpit hears of
 * it), else the kit `routeWork` fallback: the Operator, then the owner.
 */
export async function routePayroll(ctx: PluginContext, companyId: string, roles: TeamRoleKey[]): Promise<WorkRoute> {
  for (const role of roles) {
    const agentId = role === "payroll-clerk" ? (await ownClerk(ctx, companyId)) ?? (await teamAgentId(ctx, companyId, role)) : await teamAgentId(ctx, companyId, role);
    if (agentId) return { assigneeAgentId: agentId, assigneeUserId: null, via: role };
  }
  const fallback = await routeWork(ctx, companyId, []);
  return { ...fallback, assigneeUserId: assignableUser(fallback.assigneeUserId) };
}

// ---------------------------------------------------------------------------
// Once per company and month (plugin state)
// ---------------------------------------------------------------------------

const MARK = (companyId: string, key: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "payroll-triggers", stateKey: key });

async function claim(ctx: PluginContext, companyId: string, key: string): Promise<boolean> {
  if (await ctx.state.get(MARK(companyId, key))) return false;
  await ctx.state.set(MARK(companyId, key), { at: new Date().toISOString() });
  return true;
}

async function release(ctx: PluginContext, companyId: string, key: string): Promise<void> {
  await ctx.state.set(MARK(companyId, key), null).catch(() => undefined);
}

/** `key` is the once-a-month mark (`prepare:<month>`, kept as it was so a month already opened never opens twice); `originId` is the issue's. */
async function openOnce(env: Env, companyId: string, key: string, originId: string, route: WorkRoute, input: { title: string; description: string; wakeReason: string }): Promise<string | null> {
  if (!(await claim(env.ctx, companyId, key))) return null;
  try {
    const issue = await createWorkIssue(env.ctx, {
      companyId,
      title: input.title,
      description: input.description,
      priority: "high",
      ...(route.assigneeAgentId ? { assigneeAgentId: route.assigneeAgentId } : route.assigneeUserId ? { assigneeUserId: route.assigneeUserId } : {}),
      originKind: TRIGGER_ORIGIN,
      originId,
      wakeReason: input.wakeReason,
    });
    return issue.id;
  } catch (error) {
    await release(env.ctx, companyId, key);
    env.ctx.logger.warn("Payroll issue could not be opened", { companyId, key, error: errorMessage(error) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// "Prepare pay run for <month>"
// ---------------------------------------------------------------------------

export function prepareRunText(input: { month: string; payDate: string; draft: string | null; lockOnApproval: boolean; sendOnLock: boolean }): string {
  return [
    `Pay day is **${dayName(input.payDate)}**. Prepare the ${monthName(input.month)} monthly pay run so a person can approve it before then. Follow the \`pib-payroll\` skill.`,
    "",
    "1. `payroll-overview`: the settings are saved, this tax year's rules are loaded (mention any unconfirmed rule on the approval), and no leave is waiting.",
    input.draft
      ? `2. Use the open run **${input.draft}** (\`list-pay-runs\`), or \`create-pay-run\` with \`frequency: "monthly"\` if it was cancelled.`
      : "2. `create-pay-run` with `frequency: \"monthly\"` (this month and the company's pay day are the defaults).",
    "3. Enter this month's changes with `adjust-pay-run-item`, one employee at a time: overtime, Sunday and public holiday hours, bonuses, commission, unpaid hours, staff leaving.",
    "4. `calculate-pay-run`, then `get-pay-run`: fix every employee with an error. Missing terms or details are added by a person on the Payroll page: ask once with `" + ASK_OWNER_TOOL + "`.",
    "5. `pay-run-variances`: explain every change of 10% or more against last month.",
    "6. `request-pay-run-approval` (the default approver; never whoever calculated it), with your variance notes.",
    "7. Mark this issue done with the run number and its approval issue. Closing it checks that the month's run is with the approver (or further); if not, it opens again with what is missing.",
    "",
    input.lockOnApproval
      ? `A person approves; approving also locks the run: it posts to Accounting and the payslips are made${input.sendOnLock ? " and emailed" : ""}. Nobody is paid by Payroll: a person uploads the net pay file to the bank.`
      : "A person approves, then a board member locks the run (it posts to Accounting and makes the payslips). Nobody is paid by Payroll.",
    "",
    "Doing it yourself: Payroll → Pay runs → New pay run, then Calculate and Send for approval.",
  ].join("\n");
}

/** The next monthly pay date on or after `date` (the pay day, moved back to a weekday, as new runs use). */
export function nextMonthlyPayDate(date: string, payDay: number): string {
  const thisMonth = defaultPeriod("monthly", date, payDay).payDate;
  return thisMonth >= date ? thisMonth : defaultPeriod("monthly", `${addMonth(date.slice(0, 7), 1)}-01`, payDay).payDate;
}

/** Opens "Prepare pay run for <month>" in the days before the monthly pay day. Returns the issue id, or null. */
export async function prepareRunTrigger(env: Env, companyId: string): Promise<string | null> {
  const { ctx } = env;
  const config = await env.config(companyId);
  const date = today(env);
  const payDate = nextMonthlyPayDate(date, config.defaultPayDay);
  const month = payDate.slice(0, 7);
  const days = daysBetween(date, payDate);
  if (days < 0 || days > config.prepareDaysBefore) return null;
  const [employees, terms, runs] = await Promise.all([db.listEmployees(ctx, companyId, { status: "active" }), db.termsOn(ctx, companyId, date), db.listRuns(ctx, companyId, 24)]);
  if (!employees.some((x) => terms.get(x.id)?.frequency === "monthly")) return null;
  const monthRuns = runs.filter((r) => r.kind === "regular" && r.frequency === "monthly" && r.payDate.slice(0, 7) === month && r.status !== "cancelled");
  // Already with the approver or done: nothing to prepare.
  if (monthRuns.some((r) => ["pending_approval", "approved", "locked", "reversed"].includes(r.status))) return null;
  const draft = monthRuns.find((r) => r.status === "draft" || r.status === "calculated")?.number ?? null;
  const route = await routePayroll(ctx, companyId, ["payroll-clerk"]);
  return openOnce(env, companyId, `prepare:${month}`, `${WORK_ORIGINS.prepare}${month}`, route, {
    title: `Prepare pay run for ${monthName(month)}`,
    description: prepareRunText({ month, payDate, draft, lockOnApproval: config.lockOnApproval, sendOnLock: config.payslipEmail.sendOnLock }),
    wakeReason: "Prepare this month's pay run",
  });
}

// ---------------------------------------------------------------------------
// "EMP201 for <month> due by <date>"
// ---------------------------------------------------------------------------

export function emp201Text(input: { month: string; due: string; runs: string[]; open: string[] }): string {
  return [
    `The EMP201 for **${monthName(input.month)}** (PAYE, UIF and SDL from the locked pay runs, less ETI) must be filed and paid on SARS eFiling by **${dayName(input.due)}**. Payroll never files or pays: a person does both.`,
    "",
    input.runs.length ? `Locked runs in it: ${input.runs.join(", ")}.` : "No locked pay run in the month yet: if staff were paid, the run must be locked first (the EMP201 may also be a nil return).",
    ...(input.open.length ? [`Still open for the month: ${input.open.join(", ")}. Say so in your ask: they are not in the EMP201 until they are locked.`] : []),
    "",
    `1. \`partnersinbiz.payroll:emp201-summary\` with \`month: "${input.month}"\`: check the runs included and the totals (PAYE, SDL, UIF, ETI used, total payable).`,
    "2. Bookkeeper: compare them with the books. `partnersinbiz.accounting:list-accounts` shows the PAYE, UIF and SDL payable accounts; `gl` on each to the month end should hold the same amounts from the pay run journals.",
    `3. Ask the owner once with \`${ASK_OWNER_TOOL}\` to file and pay: open **Payroll → Statutory → EMP201 (monthly)**, pick ${monthName(input.month)}, click **Download CSV** for the figures, submit the EMP201 on eFiling and pay the total by ${dayName(input.due)}. Put the totals and anything that looks wrong in the ask.`,
    `4. When the owner confirms it is filed and paid, record it with \`partnersinbiz.payroll:mark-emp201-filed\` (\`month: "${input.month}"\` and their payment reference), then mark this issue done.`,
    "",
    "Closing this issue checks that the EMP201 is marked filed, or that the figures were downloaded and the owner was asked (or answered) here; if not, it opens again with what is missing.",
  ].join("\n");
}

/** Opens "EMP201 for <month> due by <date>" from the 1st of the next month until it is due. Returns the issue id, or null. */
export async function emp201Trigger(env: Env, companyId: string): Promise<string | null> {
  const { ctx } = env;
  const date = today(env);
  const month = addMonth(date.slice(0, 7), -1);
  const due = emp201DueDate(month);
  if (date > due) return null;
  const [runs, employees] = await Promise.all([db.listRuns(ctx, companyId, 60), db.listEmployees(ctx, companyId, { status: "active" })]);
  const inMonth = runs.filter((r) => r.payDate.slice(0, 7) === month && r.kind !== "reversal");
  const locked = inMonth.filter((r) => r.status === "locked" || r.status === "reversed").map((r) => r.number);
  const unlocked = inMonth.filter((r) => ["draft", "calculated", "pending_approval", "approved"].includes(r.status)).map((r) => r.number);
  if (!locked.length && !employees.length) return null;
  const route = await routePayroll(ctx, companyId, ["bookkeeper", "payroll-clerk"]);
  return openOnce(env, companyId, `emp201:${month}`, `${WORK_ORIGINS.emp201}${month}`, route, {
    title: `EMP201 for ${monthName(month)} due by ${dayName(due)}`,
    description: emp201Text({ month, due, runs: locked, open: unlocked }),
    wakeReason: "EMP201 due",
  });
}

/** Both monthly triggers for one company (the follow-up job). */
export async function payrollTriggers(env: Env, companyId: string): Promise<{ prepare: string | null; emp201: string | null }> {
  const prepare = await prepareRunTrigger(env, companyId).catch((error) => {
    env.ctx.logger.warn("Prepare pay run check did not finish", { companyId, error: errorMessage(error) });
    return null;
  });
  const emp201 = await emp201Trigger(env, companyId).catch((error) => {
    env.ctx.logger.warn("EMP201 check did not finish", { companyId, error: errorMessage(error) });
    return null;
  });
  return { prepare, emp201 };
}
