import type { IssueUnblockDescriptor } from "@paperclipai/shared";

export const ROUTABLE_BLOCKED_ROLLOUT_AT = new Date("2026-07-23T18:13:03.000Z");
/** Fixed system actor id; isSystemUnblockOwnerWake (issue-wake-guards.ts) admits it. */
export const ROUTABLE_BLOCKED_WAKE_ACTOR_ID = "routable_blocked";

type RoutableBlockedIssue = {
  id: string;
  status: string;
  unblockDescriptor?: IssueUnblockDescriptor | null;
  blockedTransitionAt?: Date | null;
  blockedOwnerNotifiedAt?: Date | null;
};

type ProspectiveBlockedIssue = RoutableBlockedIssue & {
  status: "blocked";
  blockedTransitionAt: Date;
};

export type UnblockOwnerWakeOptions = {
  source: "automation";
  triggerDetail: "system";
  reason: "issue_unblock_requested";
  idempotencyKey: string;
  requestedByActorType: "system";
  requestedByActorId: typeof ROUTABLE_BLOCKED_WAKE_ACTOR_ID;
  payload: { issueId: string; action: string };
  contextSnapshot: { wakeReason: "issue_unblock_requested"; issueId: string; taskId: string };
};

export function isProspectiveBlockedTransition(issue: RoutableBlockedIssue): issue is ProspectiveBlockedIssue {
  return issue.status === "blocked" &&
    Boolean(issue.blockedTransitionAt && issue.blockedTransitionAt >= ROUTABLE_BLOCKED_ROLLOUT_AT);
}

/**
 * PAR-10086: true only when a run exists for the wake: the wakeup returned a
 * run, or the receipt found by idempotency key has a runId. A deferred receipt
 * with no run, a skipped receipt or no receipt reached nobody yet.
 */
export function isRunBackedWakeResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const value = result as { id?: unknown; runId?: unknown };
  if ("runId" in value) return typeof value.runId === "string" && value.runId.length > 0;
  return typeof value.id === "string" && value.id.length > 0;
}

export async function deliverAgentUnblockNotification(input: {
  issue: RoutableBlockedIssue;
  wakeup: (agentId: string, options: UnblockOwnerWakeOptions) => Promise<unknown>;
  markNotified: (notifiedAt: Date) => Promise<unknown>;
  now?: () => Date;
}) {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || !issue.unblockDescriptor || issue.blockedOwnerNotifiedAt) {
    return false;
  }

  const owner = issue.unblockDescriptor.owner;
  if (owner === "board" || !("agentId" in owner)) return false;

  const result = await input.wakeup(owner.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_unblock_requested",
    idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt.toISOString()}`,
    requestedByActorType: "system",
    requestedByActorId: ROUTABLE_BLOCKED_WAKE_ACTOR_ID,
    payload: { issueId: issue.id, action: issue.unblockDescriptor.action },
    contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: issue.id, taskId: issue.id },
  });
  // PAR-9390 / PAR-10086: the owner counts as notified only once a run exists.
  if (!isRunBackedWakeResult(result)) return false;
  await input.markNotified((input.now ?? (() => new Date()))());
  return true;
}
