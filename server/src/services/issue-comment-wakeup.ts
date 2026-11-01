import { shouldWakeBlockedTicket } from "./issue-wake-guards.js";

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
