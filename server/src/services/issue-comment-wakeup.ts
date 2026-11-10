import {
  ISSUE_REVIEW_VERDICT_WAKE_REASON,
  isReviewVerdictComment,
  REVIEW_VERDICT_WAKE_ACTOR_ID,
  shouldWakeBlockedTicket,
} from "./issue-wake-guards.js";

/**
 * PAR-8960: a `qa` agent (not the assignee) posts a verdict comment on a
 * blocked issue. The caller still checks that the normal comment wake did not
 * fire, and the assignee/goal-steer guards it applies to that wake.
 */
export function shouldRelayReviewVerdictWake(input: {
  issueStatus: string | null | undefined;
  actorType: string | null | undefined;
  actorAgentId: string | null | undefined;
  actorAgentRole: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  commentBody: string | null | undefined;
}): boolean {
  return (
    input.issueStatus === "blocked" &&
    input.actorType === "agent" &&
    input.actorAgentRole === "qa" &&
    Boolean(input.assigneeAgentId) &&
    Boolean(input.actorAgentId) &&
    input.actorAgentId !== input.assigneeAgentId &&
    isReviewVerdictComment(input.commentBody)
  );
}

export function buildReviewVerdictWakeup(input: { issueId: string; commentId: string }) {
  return {
    source: "automation" as const,
    triggerDetail: "system" as const,
    reason: ISSUE_REVIEW_VERDICT_WAKE_REASON,
    requestedByActorType: "system" as const,
    requestedByActorId: REVIEW_VERDICT_WAKE_ACTOR_ID,
    // Audit label only: no index dedupes on it (plan Q&A 8).
    idempotencyKey: `review-verdict:${input.issueId}:${input.commentId}`,
    payload: {
      issueId: input.issueId,
      commentId: input.commentId,
      mutation: "comment",
      reviewVerdict: true,
    },
    contextSnapshot: {
      issueId: input.issueId,
      taskId: input.issueId,
      commentId: input.commentId,
      wakeCommentId: input.commentId,
      source: "issue.comment.review_verdict",
      wakeReason: ISSUE_REVIEW_VERDICT_WAKE_REASON,
    },
  };
}

export function shouldWakeAssigneeForIssueComment(input: {
  selfComment: boolean;
  resumeRequested: boolean;
  commentCreatedByRunId?: string | null;
  issueAtCommentStart: {
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  };
  reopened: boolean;
  currentStatus: string | null | undefined;
  commentAuthorType?: string | null;
}) {
  const sourceRunId = input.commentCreatedByRunId;
  const commentIsFromCurrentIssueRun = Boolean(
    sourceRunId &&
    (sourceRunId === input.issueAtCommentStart.checkoutRunId ||
      sourceRunId === input.issueAtCommentStart.executionRunId),
  );
  if (
    input.selfComment &&
    (!input.resumeRequested || commentIsFromCurrentIssueRun)
  ) {
    return false;
  }
  const blockedWake = shouldWakeBlockedTicket({
    issueStatus: input.currentStatus,
    wakeReason: input.reopened
      ? "issue_reopened_via_comment"
      : "issue_commented",
    requestedByActorType: input.commentAuthorType ?? null,
  });
  if (!blockedWake.wake) return false;
  return (
    input.reopened ||
    (input.currentStatus !== "done" && input.currentStatus !== "cancelled")
  );
}
