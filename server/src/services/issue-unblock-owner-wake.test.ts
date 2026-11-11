// PAR-9390 AC 2: one helper decides the system unblock-owner wake at all three
// guards (admission, start blocked check, assignee-mismatch exemption).
import { describe, expect, it } from "vitest";
import {
  isSystemUnblockOwnerWake,
  shouldStartQueuedIssueRun,
  shouldWakeBlockedTicket,
} from "./issue-wake-guards.js";
import { decideRunLivenessContinuation } from "./recovery/run-liveness-continuations.js";

const owner = "agent-owner-m";
const assignee = "agent-assignee-a";
const reason = "issue_unblock_requested";

type Row = {
  actorType: string;
  actorId: string;
  wokenAgentId: string;
  assigneeAgentId: string;
  descriptorAtEnqueue: unknown;
  descriptorAtStart: unknown;
};

const descriptor = (agentId: string) => ({ owner: { agentId }, action: "Grant the deploy key" });

const base: Row = {
  actorType: "system",
  actorId: "routable_blocked",
  wokenAgentId: owner,
  assigneeAgentId: assignee,
  descriptorAtEnqueue: descriptor(owner),
  descriptorAtStart: descriptor(owner),
};

// Mirrors queue.ts: admission at enqueueWakeup, then the start guard with the
// helper evaluated again against the live issue and used for the exemption.
function decide(row: Row) {
  const wake = { reason, requestedByActorType: row.actorType, requestedByActorId: row.actorId };
  const context = { wakeReason: reason };
  const admission = shouldWakeBlockedTicket({
    issueStatus: "blocked",
    wakeReason: reason,
    requestedByActorType: row.actorType,
    requestedByActorId: row.actorId,
    systemUnblockOwnerWake: isSystemUnblockOwnerWake(wake, context,
      { assigneeAgentId: row.assigneeAgentId, unblockDescriptor: row.descriptorAtEnqueue }, row.wokenAgentId),
  });
  const atStart = isSystemUnblockOwnerWake(wake, context,
    { assigneeAgentId: row.assigneeAgentId, unblockDescriptor: row.descriptorAtStart }, row.wokenAgentId);
  const start = shouldStartQueuedIssueRun({
    issueStatus: "blocked",
    paused: false,
    assigneeAgentId: row.assigneeAgentId,
    runAgentId: row.wokenAgentId,
    wakeReason: reason,
    requestedByActorType: row.actorType,
    requestedByActorId: row.actorId,
    humanWake: row.actorType === "user",
    blockerClearedWake: false,
    systemUnblockOwnerWake: atStart,
    assigneeMismatchExempt: atStart,
  });
  return { admission, start };
}

describe("isSystemUnblockOwnerWake through the three guards (PAR-9390 AC 2)", () => {
  it.each<[string, Partial<Row>, { admitted: boolean; admissionReason: string; start: boolean; startReason: string }]>([
    ["system routable_blocked, owner is not the assignee", {},
      { admitted: true, admissionReason: "unblock_owner", start: true, startReason: "ok" }],
    ["system blocked_issue_sweeper, owner is not the assignee", { actorId: "blocked_issue_sweeper" },
      { admitted: true, admissionReason: "unblock_owner", start: true, startReason: "ok" }],
    ["system, owner is the assignee", { wokenAgentId: assignee, descriptorAtEnqueue: descriptor(assignee), descriptorAtStart: descriptor(assignee) },
      { admitted: false, admissionReason: "blocked_suppressed", start: false, startReason: "blocked" }],
    ["system with another actor id", { actorId: "some_plugin_uuid" },
      { admitted: false, admissionReason: "blocked_suppressed", start: false, startReason: "blocked" }],
    ["agent actor with the same reason", { actorType: "agent", actorId: owner },
      { admitted: false, admissionReason: "blocked_suppressed", start: false, startReason: "blocked" }],
    // Today's human rule: admitted and past the blocked check, then the
    // assignee-mismatch check cancels it because no exemption applies.
    ["user actor", { actorType: "user", actorId: "board-user" },
      { admitted: true, admissionReason: "human", start: false, startReason: "reassigning" }],
    ["system, woken agent is not the owner", { wokenAgentId: "agent-other" },
      { admitted: false, admissionReason: "blocked_suppressed", start: false, startReason: "blocked" }],
    ["descriptor cleared between enqueue and start", { descriptorAtStart: null },
      { admitted: true, admissionReason: "unblock_owner", start: false, startReason: "blocked" }],
    ["descriptor owner changed between enqueue and start", { descriptorAtStart: descriptor("agent-other") },
      { admitted: true, admissionReason: "unblock_owner", start: false, startReason: "blocked" }],
  ])("%s", (_name, overrides, expected) => {
    const { admission, start } = decide({ ...base, ...overrides });
    expect(admission).toEqual({ wake: expected.admitted, reason: expected.admissionReason });
    expect(start).toEqual({ start: expected.start, reason: expected.startReason });
  });

  // AC 5: a plan-only end of M's run produces no liveness continuation (absent,
  // not created-and-suppressed): the continuation needs the run agent to be the assignee.
  it("creates no liveness continuation for the owner's plan-only run", () => {
    const companyId = "company-1";
    const decision = decideRunLivenessContinuation({
      run: { id: "run-m", companyId, agentId: owner, continuationAttempt: 0 } as never,
      issue: { id: "issue-x", companyId, status: "blocked", assigneeAgentId: assignee } as never,
      agent: { id: owner, companyId, status: "idle" } as never,
      livenessState: "plan_only",
      livenessReason: "Run ended with a plan only",
      nextAction: null,
      budgetBlocked: false,
      idempotentWakeExists: false,
    });
    expect(decision).toEqual({ kind: "skip", reason: "issue is no longer assigned to the source run agent" });
  });

  it("refuses a wake whose request reason and context reason disagree", () => {
    const issue = { assigneeAgentId: assignee, unblockDescriptor: descriptor(owner) };
    const actor = { requestedByActorType: "system", requestedByActorId: "routable_blocked" };
    expect(isSystemUnblockOwnerWake({ ...actor, reason }, { wakeReason: reason }, issue, owner)).toBe(true);
    expect(isSystemUnblockOwnerWake({ ...actor, reason: "issue_commented" }, { wakeReason: reason }, issue, owner)).toBe(false);
    expect(isSystemUnblockOwnerWake({ ...actor, reason }, { wakeReason: "issue_commented" }, issue, owner)).toBe(false);
    expect(isSystemUnblockOwnerWake({ ...actor, reason: null }, {}, issue, owner)).toBe(false);
    expect(isSystemUnblockOwnerWake(actor, { wakeReason: reason }, { ...issue, unblockDescriptor: { owner: "board", action: "x" } }, owner)).toBe(false);
  });
});
