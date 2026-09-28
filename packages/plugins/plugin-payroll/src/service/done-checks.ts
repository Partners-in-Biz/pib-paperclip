/**
 * Done-checks (kit `registerDoneChecks`): when an agent marks one of
 * Payroll's work issues done, the outcome is checked in Payroll's own data;
 * unfinished work opens again with what is missing.
 *
 * - "Prepare pay run for <month>" (`payroll:prepare:<YYYY-MM>`): the month's
 *   regular monthly run is with the approver or further (pending approval,
 *   approved, locked, reversed). Also done when nobody is on monthly pay any
 *   more (nothing to prepare).
 * - "EMP201 for <month> due by <date>" (`payroll:emp201:<YYYY-MM>`): the
 *   EMP201 is marked filed; or its figures were downloaded (the EMP201 export
 *   for the month) and the owner was asked to file and pay on this issue
 *   (`ask-owner`) or a person replied here.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ASK_OWNER_TOOL, isAskOwnerComment, type DoneCheckResult, type DoneCheckRule } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { emp201Filing } from "./emp201-filing.js";
import { today, type Env } from "./env.js";
import { monthName, WORK_ORIGINS } from "./triggers.js";

/** A run the approver has (or had): the preparing work is finished. */
const SUBMITTED = new Set(["pending_approval", "approved", "locked", "reversed"]);

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "Prepare pay run for <month>": the month's monthly run is with the approver or further. */
export async function checkPrepareRun(e: Env, companyId: string, month: string): Promise<DoneCheckResult> {
  const { ctx } = e;
  const runs = (await db.listRuns(ctx, companyId, 60)).filter((r) => r.kind === "regular" && r.frequency === "monthly" && r.payDate.slice(0, 7) === month);
  const live = runs.filter((r) => r.status !== "cancelled");
  if (live.some((r) => SUBMITTED.has(r.status))) return { done: true };
  // Nobody is on monthly pay any more: there is nothing to prepare.
  const [employees, terms] = await Promise.all([db.listEmployees(ctx, companyId, { status: "active" }), db.termsOn(ctx, companyId, today(e))]);
  if (!employees.some((x) => terms.get(x.id)?.frequency === "monthly")) return { done: true };
  const label = monthName(month);
  const open = live.find((r) => r.status === "draft" || r.status === "calculated") ?? null;
  if (!open) {
    const cancelled = runs.find((r) => r.status === "cancelled");
    return {
      done: false,
      missing: [
        cancelled
          ? `The ${label} run ${cancelled.number} was cancelled and no run replaces it: \`create-pay-run\` with \`frequency: "monthly"\`, \`calculate-pay-run\`, then \`request-pay-run-approval\`.`
          : `No monthly pay run for ${label} yet: \`create-pay-run\` with \`frequency: "monthly"\`, \`calculate-pay-run\`, then \`request-pay-run-approval\`.`,
      ],
    };
  }
  if (open.status === "draft") {
    return { done: false, missing: [`${open.number} is still a draft: \`calculate-pay-run\` with \`runId: "${open.id}"\`, fix any errors, then \`request-pay-run-approval\`.`] };
  }
  const errors = (await db.listItems(ctx, companyId, open.id)).filter((i) => i.status === "error").length;
  return {
    done: false,
    missing: [
      errors
        ? `${open.number} has ${plural(errors, "employee")} with errors (\`get-pay-run\`): fix them, then \`request-pay-run-approval\`. Missing terms or details are added by a person: ask once with \`${ASK_OWNER_TOOL}\`.`
        : `${open.number} is calculated but not sent for approval: \`request-pay-run-approval\` with \`runId: "${open.id}"\`.`,
    ],
  };
}

/**
 * Whether this issue carries an `ask-owner` question and whether a person
 * replied on it. When the comments cannot be read, neither is held against
 * the agent.
 */
export async function askedOrAnswered(ctx: PluginContext, companyId: string, issueId: string): Promise<{ asked: boolean; answered: boolean }> {
  let comments: Awaited<ReturnType<PluginContext["issues"]["listComments"]>>;
  try {
    comments = await ctx.issues.listComments(issueId, companyId);
  } catch (error) {
    ctx.logger.info("EMP201 done-check could not read the issue's comments", { issueId, error: error instanceof Error ? error.message : String(error) });
    return { asked: true, answered: true };
  }
  const live = comments.filter((c) => !c.deletedAt && typeof c.body === "string" && c.body.trim());
  return {
    asked: live.some((c) => Boolean(c.authorAgentId) && isAskOwnerComment(c.body)),
    answered: live.some((c) => Boolean(c.authorUserId)),
  };
}

/** "EMP201 for <month> due by <date>": filed, or downloaded and handed to the owner. */
export async function checkEmp201(e: Env, companyId: string, month: string, issueId: string): Promise<DoneCheckResult> {
  if (await emp201Filing(e, companyId, month)) return { done: true };
  const exported = (await db.listExports(e.ctx, companyId)).some((x) => x.kind === "emp201" && x.ref === month);
  const { asked, answered } = await askedOrAnswered(e.ctx, companyId, issueId);
  if (exported && (asked || answered)) return { done: true };
  const label = monthName(month);
  const missing: string[] = [`The EMP201 for ${label} is not marked filed.`];
  if (!exported) missing.push(`Its figures were not downloaded yet (Payroll → Statutory → EMP201 → Download CSV): the owner does this when they file.`);
  if (!asked && !answered) missing.push(`Nobody was asked to file and pay it: ask the owner once with \`${ASK_OWNER_TOOL}\` on this issue, with the totals from \`emp201-summary\`, the due date and the steps. The issue waits with them.`);
  missing.push(`When the owner confirms it is filed and paid, record it with \`mark-emp201-filed\` (\`month: "${month}"\` and their payment reference), then close this issue.`);
  return { done: false, missing };
}

/** The rules registered in setup, one per kind of work Payroll hands to agents. */
export function payrollDoneChecks(e: Env): DoneCheckRule[] {
  const monthOf = (originId: string | null, prefix: string) => {
    const month = (originId ?? "").slice(prefix.length).trim();
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
  };
  // An origin id this version cannot read is never held against the agent.
  const unreadable: DoneCheckResult = { done: true };
  return [
    {
      originPrefix: WORK_ORIGINS.prepare,
      label: "Prepare pay run",
      check: async (issue) => {
        const month = monthOf(issue.originId, WORK_ORIGINS.prepare);
        return month ? checkPrepareRun(e, issue.companyId, month) : unreadable;
      },
    },
    {
      originPrefix: WORK_ORIGINS.emp201,
      label: "EMP201 due",
      check: async (issue) => {
        const month = monthOf(issue.originId, WORK_ORIGINS.emp201);
        return month ? checkEmp201(e, issue.companyId, month, issue.id) : unreadable;
      },
    },
  ];
}
