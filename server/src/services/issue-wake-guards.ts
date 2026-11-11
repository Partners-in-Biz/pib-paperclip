/**
 * PAR-6202 wake-loop guards.
 *
 * Blocked tickets stay quiet unless a human (board user) comments or the
 * blocker is cleared. A ticket may start at most 3 runs per rolling hour
 * (PIB_TICKET_RUNS_PER_HOUR_CAP overrides the 3);
 * the next one is skipped once and flagged, with no retry. A queued run
 * does not start if the ticket is blocked, paused, cancelled, or no longer
 * assigned to that agent.
 */

/** Default per-ticket cap; PIB_TICKET_RUNS_PER_HOUR_CAP overrides it. */
export const TICKET_RUNS_PER_HOUR_CAP = 3;
export const TICKET_RUN_CAP_WINDOW_MS = 60 * 60 * 1000;
export const TICKET_RUNS_PER_HOUR_CAP_ENV = "PIB_TICKET_RUNS_PER_HOUR_CAP";

/**
 * The live cap: env PIB_TICKET_RUNS_PER_HOUR_CAP, an integer 1..100 (host
 * patch 14 raised it to 6 on 2026-11-03). Anything else falls back to 3.
 */
export function readTicketRunsPerHourCap(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[TICKET_RUNS_PER_HOUR_CAP_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return TICKET_RUNS_PER_HOUR_CAP;
  const value = Number(raw);
  return value >= 1 && value <= 100 ? value : TICKET_RUNS_PER_HOUR_CAP;
}

export function wakeLoopFlagBody(maxRuns: number = readTicketRunsPerHourCap()): string {
  return `Wake loop guard: this ticket already had ${maxRuns} runs in the last hour, so this run was skipped and will not retry on its own. Further runs stay skipped until that hour window moves. A board comment or a cleared blocker can wake it again once there is room under the cap.`;
}
export const WAKE_LOOP_GUARD_ACTION = "issue.wake_loop_guard";
export const ISSUE_RUN_CAP_SKIP_REASON = "issue_run_cap";
export const BLOCKED_TICKET_NO_WAKE_REASON = "issue_blocked_no_wake";
export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";
export const ISSUE_COMMENT_MENTION_WAKE_REASON = "issue_comment_mentioned";

/** Flag text at the default cap; the store writes wakeLoopFlagBody() with the live cap. */
export const WAKE_LOOP_FLAG_BODY = wakeLoopFlagBody(TICKET_RUNS_PER_HOUR_CAP);

const MENTION_WAKE_REASONS = new Set<string>([ISSUE_COMMENT_MENTION_WAKE_REASON]);

export function isHumanBoardActor(actorType: string | null | undefined): boolean {
  return actorType === "user" || actorType === "board";
}

// System recovery still has to land on a blocked ticket. The hourly cap and
// the execution-hold coalescer bound those wakes; suppressing them here
// drops continuation, child-completion, and safe-replacement recovery.
const SYSTEM_RECOVERY_WAKE_REASONS = new Set<string>([
  "issue_recovery_action_restored",
  "issue_continuation_needed",
  "issue_children_completed",
]);

export function isSystemRecoveryWakeReason(wakeReason: string | null | undefined): boolean {
  return Boolean(wakeReason && SYSTEM_RECOVERY_WAKE_REASONS.has(wakeReason));
}

/**
 * PAR-8960: a `qa` agent's verdict comment on a blocked issue wakes its
 * assignee. Only the issue comment routes write this fixed actor id. The agent
 * wakeup route cannot send a `system` actor, and plugin paths always set the
 * plugin UUID, so the triple below cannot be forged. Do not use
 * contextSnapshot.source as the marker: plugin paths copy a caller-supplied one.
 */
export const ISSUE_REVIEW_VERDICT_WAKE_REASON = "issue_review_verdict";
export const REVIEW_VERDICT_WAKE_ACTOR_ID = "issue_review_verdict_relay";
const REVIEW_VERDICT_LINE = /^(?:\*\*)?(PASS|FAIL|CHANGES NEEDED|DOGFOOD:\s*(?:PASS|FAIL))\b/;

export function isReviewVerdictWake(input: {
  wakeReason?: string | null;
  requestedByActorType?: string | null;
  requestedByActorId?: string | null;
}): boolean {
  return (
    input.wakeReason === ISSUE_REVIEW_VERDICT_WAKE_REASON &&
    input.requestedByActorType === "system" &&
    input.requestedByActorId === REVIEW_VERDICT_WAKE_ACTOR_ID
  );
}

/**
 * PAR-9390: the named unblock owner of a blocked issue is woken by the server
 * (routes/issues.ts via deliverAgentUnblockNotification, or the blocked-issue
 * sweeper) with a fixed system actor. The agent wakeup route cannot send a
 * `system` actor, so the actor pair cannot be forged. The owner is checked
 * against the live descriptor each time, so a cleared or changed descriptor
 * stops the run at the start guard. An owner who is also the assignee gets
 * no exemption: the normal blocked rules apply to the assignee.
 */
export const ISSUE_UNBLOCK_REQUESTED_WAKE_REASON = "issue_unblock_requested";
export const UNBLOCK_OWNER_WAKE_ACTOR_IDS: ReadonlySet<string> = new Set([
  "routable_blocked",
  "blocked_issue_sweeper",
]);

export function isSystemUnblockOwnerWake(
  wakeRequest: {
    reason?: string | null;
    requestedByActorType?: string | null;
    requestedByActorId?: string | null;
  } | null | undefined,
  context: { wakeReason?: unknown } | null | undefined,
  issue: {
    assigneeAgentId?: string | null;
    unblockDescriptor?: unknown;
  } | null | undefined,
  agentId: string | null | undefined,
): boolean {
  if (!wakeRequest || !issue || !agentId) return false;
  const reasons = [wakeRequest.reason, context?.wakeReason].filter(
    (value) => value !== null && value !== undefined,
  );
  if (
    reasons.length === 0 ||
    !reasons.every((value) => value === ISSUE_UNBLOCK_REQUESTED_WAKE_REASON)
  ) {
    return false;
  }
  if (
    wakeRequest.requestedByActorType !== "system" ||
    !wakeRequest.requestedByActorId ||
    !UNBLOCK_OWNER_WAKE_ACTOR_IDS.has(wakeRequest.requestedByActorId)
  ) {
    return false;
  }
  const descriptor = issue.unblockDescriptor;
  if (!descriptor || typeof descriptor !== "object") return false;
  const owner = (descriptor as { owner?: unknown }).owner;
  if (!owner || typeof owner !== "object") return false;
  const ownerAgentId = (owner as { agentId?: unknown }).agentId;
  if (typeof ownerAgentId !== "string" || ownerAgentId !== agentId) return false;
  return issue.assigneeAgentId !== agentId;
}

/** The first non-empty line, trimmed, starts with a verdict token (case-sensitive). */
export function isReviewVerdictComment(body: string | null | undefined): boolean {
  const firstLine = (body ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return Boolean(firstLine && REVIEW_VERDICT_LINE.test(firstLine));
}

export function shouldWakeBlockedTicket(input: {
  issueStatus: string | null | undefined;
  wakeReason?: string | null;
  requestedByActorType?: string | null;
  requestedByActorId?: string | null;
  /** The issue is a chat conversation (its own conversationAgentId column). */
  chatConversation?: boolean | null;
  /** isSystemUnblockOwnerWake() for this wake, the woken agent and the live issue. */
  systemUnblockOwnerWake?: boolean | null;
}): {
  wake: boolean;
  reason:
    | "not_blocked"
    | "blocker_cleared"
    | "human"
    | "system_recovery"
    | "review_verdict"
    | "unblock_owner"
    | "chat_conversation"
    | "blocked_suppressed";
} {
  if (input.issueStatus !== "blocked") {
    return { wake: true, reason: "not_blocked" };
  }
  // A chat conversation waits in `blocked` on the tasks it delegated, and the
  // chat completion outbox wakes it when they finish (upstream's dependency gate
  // still holds the wake while a blocker is open). Like the hourly cap (PAR-6862),
  // the blocked-ticket guard does not apply to chat: it is user-driven, not a loop.
  if (input.chatConversation) {
    return { wake: true, reason: "chat_conversation" };
  }
  if (input.wakeReason === ISSUE_BLOCKERS_RESOLVED_WAKE_REASON) {
    return { wake: true, reason: "blocker_cleared" };
  }
  // The wakeup HTTP route copies a client-supplied reason. Only a system
  // actor may use these reasons to land on a blocked ticket.
  if (
    input.requestedByActorType === "system" &&
    input.wakeReason &&
    SYSTEM_RECOVERY_WAKE_REASONS.has(input.wakeReason)
  ) {
    return { wake: true, reason: "system_recovery" };
  }
  if (isReviewVerdictWake(input)) {
    return { wake: true, reason: "review_verdict" };
  }
  if (input.systemUnblockOwnerWake) {
    return { wake: true, reason: "unblock_owner" };
  }
  if (isHumanBoardActor(input.requestedByActorType)) {
    return { wake: true, reason: "human" };
  }
  return { wake: false, reason: "blocked_suppressed" };
}

export function evaluateTicketHourlyRunCap(input: {
  runsStartedInWindow: number;
  alreadyFlaggedInWindow: boolean;
  maxRuns?: number;
}): { allow: boolean; flag: boolean; reason: "under_cap" | "capped" } {
  // Failed runs count. A ticket whose runs keep failing is the loop this cap
  // exists to stop. Retry handoffs are excluded from the count in the store.
  const maxRuns = input.maxRuns ?? readTicketRunsPerHourCap();
  if (input.runsStartedInWindow < maxRuns) {
    return { allow: true, flag: false, reason: "under_cap" };
  }
  return {
    allow: false,
    flag: !input.alreadyFlaggedInWindow,
    reason: "capped",
  };
}

const DISPOSITION_REPAIR_WAKE_REASON = "issue_disposition_repair";

/**
 * Claim/enqueue exemption from the hourly cap.
 *
 * retryOfRunId is written by server recovery, not by a client. The wakeup
 * route (routes/agents.ts) builds contextSnapshot itself and does not copy
 * a client retryOfRunId. Writers: wake-queue postgres adapter
 * (queueReviewParticipantRecoveryRun, queueImmediateRecoveryRun),
 * recovery/service.ts, native-safe-replacement, and heartbeat retry
 * scheduling. The run column is set from those same server ids
 * (finishingRun.id / opts.failedRunId), never from req.body.retryOfRunId.
 * Reason-based exemptions still require a system actor because that route
 * does copy a client-supplied reason.
 * A chat conversation issue is user-driven (one run per user message), not an
 * automated wake loop, so chat wakes are exempt. Identify chat only by the
 * issue's own conversationAgentId column, not by contextSnapshot flags which
 * can be forged by clients.
 * Execution-stage handoffs (review/approval requested) are issued by the server
 * in routes/issues.ts only when the policy stage actually changes, so they are
 * bounded by the number of stages and cannot loop. They are identified by the
 * server-built contextSnapshot.source "issue.execution_stage" (the wakeup route
 * never copies a client source) plus the reason. changes_requested is not
 * exempt, because a review bounce can repeat.
 */
export const EXECUTION_STAGE_WAKE_SOURCE = "issue.execution_stage";
const EXECUTION_STAGE_HANDOFF_WAKE_REASONS = new Set([
  "execution_review_requested",
  "execution_approval_requested",
]);

export function isExecutionStageHandoffWake(input: {
  contextSource?: unknown;
  wakeReason?: string | null;
}): boolean {
  return (
    input.contextSource === EXECUTION_STAGE_WAKE_SOURCE &&
    typeof input.wakeReason === "string" &&
    EXECUTION_STAGE_HANDOFF_WAKE_REASONS.has(input.wakeReason)
  );
}

export function isTicketRunCapExempt(input: {
  retryOfRunId?: string | null;
  chatConversation?: boolean | null;
  executionStageHandoff?: boolean | null;
  wakeReason?: string | null;
  requestedByActorType?: string | null;
}): boolean {
  if (input.retryOfRunId) return true;
  if (input.chatConversation) return true;
  if (input.executionStageHandoff) return true;
  if (input.requestedByActorType !== "system") return false;
  return (
    input.wakeReason === DISPOSITION_REPAIR_WAKE_REASON ||
    isSystemRecoveryWakeReason(input.wakeReason)
  );
}

export function shouldStartQueuedIssueRun(input: {
  issueStatus: string | null | undefined;
  paused: boolean;
  assigneeAgentId: string | null;
  runAgentId: string;
  wakeReason?: string | null;
  requestedByActorType?: string | null;
  requestedByActorId?: string | null;
  humanWake: boolean;
  blockerClearedWake: boolean;
  assigneeMismatchExempt?: boolean;
  /** Chat conversation issue: exempt from the blocked check (see shouldWakeBlockedTicket). */
  chatConversation?: boolean;
  /** isSystemUnblockOwnerWake(), evaluated again at start against the live issue. */
  systemUnblockOwnerWake?: boolean;
}): {
  start: boolean;
  reason: "ok" | "paused" | "cancelled" | "blocked" | "reassigning";
} {
  if (input.issueStatus === "cancelled") {
    return { start: false, reason: "cancelled" };
  }
  if (
    input.issueStatus === "blocked" &&
    !input.chatConversation &&
    !input.humanWake &&
    !input.blockerClearedWake &&
    !(
      input.requestedByActorType === "system" &&
      input.wakeReason &&
      SYSTEM_RECOVERY_WAKE_REASONS.has(input.wakeReason)
    ) &&
    !isReviewVerdictWake(input) &&
    !input.systemUnblockOwnerWake
  ) {
    return { start: false, reason: "blocked" };
  }
  if (input.paused && !input.humanWake) {
    return { start: false, reason: "paused" };
  }
  const mention =
    input.wakeReason != null && MENTION_WAKE_REASONS.has(input.wakeReason);
  if (
    !mention &&
    !input.assigneeMismatchExempt &&
    input.assigneeAgentId !== input.runAgentId
  ) {
    return { start: false, reason: "reassigning" };
  }
  return { start: true, reason: "ok" };
}
