/**
 * PAR-6202 wake-loop guards.
 *
 * Blocked tickets stay quiet unless a human (board user) comments or the
 * blocker is cleared. A ticket may start at most 3 runs per rolling hour;
 * the next one is skipped once and flagged, with no retry. A queued run
 * does not start if the ticket is blocked, paused, cancelled, or no longer
 * assigned to that agent.
 */

export const TICKET_RUNS_PER_HOUR_CAP = 3;
export const TICKET_RUN_CAP_WINDOW_MS = 60 * 60 * 1000;
export const WAKE_LOOP_GUARD_ACTION = "issue.wake_loop_guard";
export const ISSUE_RUN_CAP_SKIP_REASON = "issue_run_cap";
export const BLOCKED_TICKET_NO_WAKE_REASON = "issue_blocked_no_wake";
export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";
export const ISSUE_COMMENT_MENTION_WAKE_REASON = "issue_comment_mentioned";

export const WAKE_LOOP_FLAG_BODY =
  "Wake loop guard: this ticket already had 3 runs in the last hour, so this run was skipped and will not retry on its own. Further runs stay skipped until that hour window moves. A board comment or a cleared blocker can wake it again once there is room under the cap.";

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

export function shouldWakeBlockedTicket(input: {
  issueStatus: string | null | undefined;
  wakeReason?: string | null;
  requestedByActorType?: string | null;
}): {
  wake: boolean;
  reason: "not_blocked" | "blocker_cleared" | "human" | "system_recovery" | "blocked_suppressed";
} {
  if (input.issueStatus !== "blocked") {
    return { wake: true, reason: "not_blocked" };
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
  const maxRuns = input.maxRuns ?? TICKET_RUNS_PER_HOUR_CAP;
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
 * Claim/enqueue exemption from the hourly cap. retryOfRunId is set by
 * recovery code, not by the wakeup HTTP route. Reason-based exemptions
 * require a system actor because that route copies a client-supplied reason.
 */
export function isTicketRunCapExempt(input: {
  retryOfRunId?: string | null;
  wakeReason?: string | null;
  requestedByActorType?: string | null;
}): boolean {
  if (input.retryOfRunId) return true;
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
  humanWake: boolean;
  blockerClearedWake: boolean;
  assigneeMismatchExempt?: boolean;
}): {
  start: boolean;
  reason: "ok" | "paused" | "cancelled" | "blocked" | "reassigning";
} {
  if (input.issueStatus === "cancelled") {
    return { start: false, reason: "cancelled" };
  }
  if (
    input.issueStatus === "blocked" &&
    !input.humanWake &&
    !input.blockerClearedWake &&
    !(
      input.requestedByActorType === "system" &&
      input.wakeReason &&
      SYSTEM_RECOVERY_WAKE_REASONS.has(input.wakeReason)
    )
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
