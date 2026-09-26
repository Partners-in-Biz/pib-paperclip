/**
 * Leave requests (approved through an issue or on the Payroll page),
 * balances and opening balances. Approved unpaid leave flows into the next
 * pay run for the period it falls in.
 */
import { createWorkIssue } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import type { Actor } from "../domain.js";
import { assertLeaveType, checkLeaveRequest, LEAVE_LABELS, leaveBalances, workingDaysBetween, type LeaveBalance } from "../leave.js";
import { PayrollError } from "../money.js";
import { PLUGIN_ID } from "../namespace.js";
import { assignableUser, errorMessage, optNumber, optStr, reqDate, reqStr, requireUser, today, type Env } from "./env.js";

export const LEAVE_ORIGIN = `plugin:${PLUGIN_ID}:leave`;

export interface LeaveData {
  requests: db.LeaveRequest[];
  openings: db.LeaveOpeningRow[];
  terms: Map<string, db.Terms>;
}

export async function loadLeaveData(env: Env, companyId: string, asOf: string, employeeId?: string): Promise<LeaveData> {
  const [requests, openings, terms] = await Promise.all([
    db.listLeave(env.ctx, companyId, employeeId ? { employeeId } : {}),
    db.listLeaveOpenings(env.ctx, companyId),
    db.termsOn(env.ctx, companyId, asOf),
  ]);
  return { requests, openings, terms };
}

export async function balancesFor(env: Env, companyId: string, employee: db.Employee, asOf: string, preloaded?: LeaveData): Promise<LeaveBalance[]> {
  const { requests: all, openings, terms } = preloaded ?? (await loadLeaveData(env, companyId, asOf, employee.id));
  const requests = all.filter((r) => r.employeeId === employee.id);
  const t = terms.get(employee.id);
  return leaveBalances({
    employmentStart: employee.startDate,
    asOf,
    daysPerWeek: t?.daysPerWeek ?? 5,
    annualDaysPerYear: t?.annualLeaveDays ?? null,
    requests: requests.map((r) => ({ id: r.id, type: r.type, status: r.status, startDate: r.startDate, endDate: r.endDate, daysCenti: r.daysCenti })),
    openings: openings.filter((o) => o.employeeId === employee.id),
  });
}

export async function requestLeave(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  if (actor.kind === "system") throw new PayrollError("A person or agent must request leave");
  const employee = await db.getEmployee(env.ctx, companyId, reqStr(params, "employeeId", 64));
  if (!employee) throw new PayrollError("Employee not found");
  const type = assertLeaveType(params.type);
  const startDate = reqDate(params, "startDate");
  const endDate = reqDate(params, "endDate");
  if (endDate < startDate) throw new PayrollError("Leave ends before it starts");
  const terms = (await db.termsOn(env.ctx, companyId, startDate)).get(employee.id);
  const days = optNumber(params, "days", 0.5, 400) ?? workingDaysBetween(startDate, endDate, terms?.daysPerWeek ?? 5);
  const daysCenti = Math.round(days * 100);
  const balances = await balancesFor(env, companyId, employee, startDate);
  const problem = checkLeaveRequest(balances.find((b) => b.type === type), type, daysCenti);
  if (problem) throw new PayrollError(problem);
  const request: db.LeaveRequest = {
    id: db.newId("leave"),
    employeeId: employee.id,
    type,
    startDate,
    endDate,
    daysCenti,
    status: "pending",
    reason: optStr(params, "reason", 500),
    approvalIssueId: null,
    requestedByUserId: actor.kind === "user" ? actor.userId : null,
    requestedByAgentId: actor.kind === "agent" ? actor.agentId : null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: null,
  };
  await db.insertLeave(env.ctx, companyId, request);
  const config = await env.config(companyId);
  const approver = assignableUser(config.leaveApproverUserId);
  try {
    const issue = await createWorkIssue(env.ctx, {
      companyId,
      title: `Approve leave: ${employee.name}, ${LEAVE_LABELS[type].toLowerCase()} ${startDate}${endDate !== startDate ? ` to ${endDate}` : ""}`,
      description: [
        `${employee.name} asked for **${days} day(s)** of ${LEAVE_LABELS[type].toLowerCase()} from ${startDate} to ${endDate}.`,
        request.reason ? `Reason: ${request.reason}` : "",
        type === "unpaid" ? "Unpaid leave is deducted from pay in the pay run for that period." : "",
        "Mark this issue done to approve, or cancel it to decline. You can also decide on the Payroll page (Leave tab).",
      ].filter(Boolean).join("\n\n"),
      ...(approver && approver !== request.requestedByUserId ? { assigneeUserId: approver } : {}),
      originKind: LEAVE_ORIGIN as Parameters<typeof createWorkIssue>[1]["originKind"],
      originId: request.id,
      wake: false,
    });
    await db.updateLeave(env.ctx, companyId, request.id, { approval_issue_id: issue.id });
    request.approvalIssueId = issue.id;
  } catch (error) {
    env.ctx.logger.info("Leave approval issue skipped", { requestId: request.id, error: errorMessage(error) });
  }
  return { request: leaveView(request, employee) };
}

/** Board members decide; the person who asked cannot approve their own request. */
export async function decideLeave(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>, fromIssue = false) {
  const user = requireUser(actor);
  const request = await db.getLeave(env.ctx, companyId, reqStr(params, "requestId", 64));
  if (!request) throw new PayrollError("Leave request not found");
  if (request.status !== "pending") throw new PayrollError(`The request is already ${request.status}`);
  const decision = params.decision === "reject" ? "rejected" : params.decision === "approve" ? "approved" : null;
  if (!decision) throw new PayrollError("decision must be approve or reject");
  if (decision === "approved" && request.requestedByUserId && request.requestedByUserId === user.userId) {
    throw new PayrollError("You asked for this leave, so someone else must approve it");
  }
  const changed = await db.updateLeave(env.ctx, companyId, request.id, { status: decision, decided_by_user_id: user.userId, decided_at: new Date().toISOString() }, "pending");
  if (!changed) throw new PayrollError("The request changed; open it again");
  if (request.approvalIssueId && !fromIssue) {
    try {
      await env.ctx.issues.update(request.approvalIssueId, { status: decision === "approved" ? "done" : "cancelled" }, companyId);
    } catch (error) {
      env.ctx.logger.info("Leave issue update skipped", { error: errorMessage(error) });
    }
  }
  await db.audit(env.ctx, companyId, { userId: user.userId, agentId: null }, `leave.${decision}`, "leave_request", request.id, {});
  return { requestId: request.id, status: decision };
}

export async function onLeaveIssueUpdated(env: Env, companyId: string, issueId: string, event: { actorType?: string; actorId?: string }) {
  if (event.actorType === "plugin") return;
  const request = await db.getLeaveByIssue(env.ctx, companyId, issueId);
  if (!request || request.status !== "pending") return;
  const issue = await env.ctx.issues.get(issueId, companyId);
  if (!issue) return;
  if (issue.status !== "done" && issue.status !== "cancelled") return;
  const decision = issue.status === "done" ? "approve" : "reject";
  if (event.actorType !== "user" || !event.actorId) {
    if (decision === "approve") {
      await env.ctx.issues.update(issueId, { status: "todo" }, companyId).catch(() => undefined);
      await env.ctx.issues.createComment(issueId, "Leave is approved by a board member, not an agent. The issue was reopened.", companyId).catch(() => undefined);
    }
    return;
  }
  try {
    await decideLeave(env, companyId, { kind: "user", userId: event.actorId, agentId: null }, { requestId: request.id, decision }, true);
  } catch (error) {
    await env.ctx.issues.update(issueId, { status: "todo" }, companyId).catch(() => undefined);
    await env.ctx.issues.createComment(issueId, `Not decided: ${errorMessage(error)} The issue was reopened.`, companyId).catch(() => undefined);
  }
}

export async function cancelLeave(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const user = requireUser(actor);
  const request = await db.getLeave(env.ctx, companyId, reqStr(params, "requestId", 64));
  if (!request) throw new PayrollError("Leave request not found");
  if (request.status !== "pending" && request.status !== "approved") throw new PayrollError(`A ${request.status} request cannot be cancelled`);
  const changed = await db.updateLeave(env.ctx, companyId, request.id, { status: "cancelled", decided_by_user_id: user.userId, decided_at: new Date().toISOString() }, request.status);
  if (!changed) throw new PayrollError("The request changed; open it again");
  await db.audit(env.ctx, companyId, { userId: user.userId, agentId: null }, "leave.cancelled", "leave_request", request.id, {});
  return { requestId: request.id, status: "cancelled", note: request.status === "approved" && request.type === "unpaid" ? "If a locked pay run already deducted it, correct that run." : null };
}

export async function setLeaveOpening(env: Env, companyId: string, actor: Actor, params: Record<string, unknown>) {
  const user = requireUser(actor);
  const employee = await db.getEmployee(env.ctx, companyId, reqStr(params, "employeeId", 64));
  if (!employee) throw new PayrollError("Employee not found");
  const type = assertLeaveType(params.type);
  if (type === "unpaid" || type === "family") throw new PayrollError("Opening balances are for annual and sick leave");
  const days = optNumber(params, "days", -100, 400);
  if (days == null) throw new PayrollError("Enter the number of days available");
  const asOf = reqDate(params, "asOf");
  await db.upsertLeaveOpening(env.ctx, companyId, { employeeId: employee.id, type, daysCenti: Math.round(days * 100), asOf });
  await db.audit(env.ctx, companyId, { userId: user.userId, agentId: null }, "leave.opening", "employee", employee.id, { type, days, asOf });
  return { employeeId: employee.id, type, days, asOf };
}

export function leaveView(r: db.LeaveRequest, employee?: db.Employee | null) {
  return {
    id: r.id,
    employeeId: r.employeeId,
    employee: employee?.name ?? null,
    type: r.type,
    label: LEAVE_LABELS[r.type],
    startDate: r.startDate,
    endDate: r.endDate,
    days: r.daysCenti / 100,
    status: r.status,
    reason: r.reason,
    approvalIssueId: r.approvalIssueId,
    requestedBy: r.requestedByUserId ? "user" : r.requestedByAgentId ? "agent" : null,
    decidedAt: r.decidedAt,
  };
}

export async function leaveOverview(env: Env, companyId: string, params: Record<string, unknown>) {
  const asOf = optStr(params, "asOf", 10) ?? today(env);
  const [employees, data] = await Promise.all([db.listEmployees(env.ctx, companyId), loadLeaveData(env, companyId, asOf)]);
  const byId = new Map(employees.map((e) => [e.id, e]));
  const balances = [];
  for (const e of employees.filter((x) => x.status === "active")) balances.push({ employeeId: e.id, name: e.name, balances: await balancesFor(env, companyId, e, asOf, data) });
  return {
    asOf,
    requests: data.requests.slice(0, 200).map((r) => leaveView(r, byId.get(r.employeeId) ?? null)),
    balances,
  };
}
