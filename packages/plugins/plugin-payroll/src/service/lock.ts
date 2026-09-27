/**
 * Locking a pay run and everything that follows it, in one place for the
 * Lock button, "Approve" on the page and the approval issue:
 *
 *   lock (person only) → journal to Accounting (outbox) → payslips made
 *   → payslips emailed when "Email payslips when a run is locked" is on.
 *
 * "Lock on approval" (default on): a person's approval locks the run at
 * once, as that same person, so nothing waits between approval and payslips.
 */
import type { Actor } from "../domain.js";
import { errorMessage, type Env } from "./env.js";
import { generatePayslips, queuePayslipEmails } from "./payslips.js";
import { approveRun, lockRun, onApprovalIssueUpdated, requireRun } from "./runs.js";

export interface LockResult {
  runId: string;
  status: "locked";
  payslips: { created: number; skipped: string | null; emailed: number };
}

/** "3 payslip(s) made and 2 emailed." / the reason none were made. */
export function payslipText(p: LockResult["payslips"]): string {
  if (p.skipped) return `No payslips yet: ${p.skipped}`;
  return `${p.created} payslip(s) made${p.emailed ? ` and ${p.emailed} emailed` : ""}.`;
}

/** Lock as a person, post to Accounting, make the payslips and (when set) email them. */
export async function lockAndIssuePayslips(env: Env, companyId: string, actor: Actor, runId: string): Promise<LockResult> {
  await lockRun(env, companyId, actor, { runId });
  const run = await requireRun(env, companyId, runId);
  const payslips: LockResult["payslips"] = { created: 0, skipped: null, emailed: 0 };
  try {
    const made = await generatePayslips(env, companyId, run.id);
    payslips.created = made.created;
    payslips.skipped = made.skipped;
    const config = await env.config(companyId);
    if (config.payslipEmail.sendOnLock && !made.skipped) payslips.emailed = (await queuePayslipEmails(env, companyId, run, null)).queued;
  } catch (error) {
    payslips.skipped = errorMessage(error);
  }
  return { runId: run.id, status: "locked", payslips };
}

/** "Approve" on the page: approve as the person, then lock as them when "Lock on approval" is on. */
export async function approveFromPage(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const approved = await approveRun(env, companyId, actor, params);
  if (!(await env.config(companyId)).lockOnApproval) return { ...approved, locked: null };
  const run = await requireRun(env, companyId, approved.runId);
  try {
    const locked = await lockAndIssuePayslips(env, companyId, actor, run.id);
    await comment(env, companyId, run.approvalIssueId, `Locked as the approver: posted to Accounting. ${payslipText(locked.payslips)}`);
    return { runId: run.id, status: "locked" as const, locked };
  } catch (error) {
    await comment(env, companyId, run.approvalIssueId, `Approved, but the lock failed: ${errorMessage(error)} Lock it under Payroll → Pay runs.`);
    return { ...approved, locked: null, lockError: errorMessage(error) };
  }
}

/**
 * The approval issue changed (`issue.updated`): a person's "done" approves;
 * with "Lock on approval" on it also locks, as that same person.
 */
export async function onApprovalIssue(env: Env, companyId: string, issueId: string, event: { actorType?: string; actorId?: string; status?: string }): Promise<LockResult | null> {
  const approved = await onApprovalIssueUpdated(env, companyId, issueId, event);
  if (!approved || !(await env.config(companyId)).lockOnApproval) return null;
  try {
    const locked = await lockAndIssuePayslips(env, companyId, { kind: "user", userId: approved.userId, agentId: null }, approved.runId);
    await comment(env, companyId, issueId, `Locked as the approver: posted to Accounting. ${payslipText(locked.payslips)}`);
    return locked;
  } catch (error) {
    await comment(env, companyId, issueId, `Approved, but the lock failed: ${errorMessage(error)} Lock it under Payroll → Pay runs.`);
    return null;
  }
}

async function comment(env: Env, companyId: string, issueId: string | null, body: string): Promise<void> {
  if (!issueId) return;
  try {
    await env.ctx.issues.createComment(issueId, body, companyId);
  } catch (error) {
    env.ctx.logger.info("Pay run comment skipped", { issueId, error: errorMessage(error) });
  }
}
