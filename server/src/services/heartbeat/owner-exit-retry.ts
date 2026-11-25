import { and, eq, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { issueService } from "../issues.js";
import { keyValueRow, runLinkRow, systemNoticePresentation } from "../recovery/notice-format.js";

/**
 * PAR-14473: bounded retry for a wake skipped because the previous run still
 * held its process or environment lease (`execution_owner_active`).
 *
 * The receipt is replayed at once when the lease release or run exit hints it
 * (notifyDeferredWakesForIssue). Without a hint the deferred-receipt worker
 * re-checks it on a short backoff. A lease that stays held past the cap is
 * escalated once on the issue and leaves timed retries; a later release hint
 * still replays it.
 */
export const OWNER_EXIT_RETRY_FAST_MS = 15_000;
export const OWNER_EXIT_RETRY_SLOW_MS = 30_000;
/** Receipts younger than this retry on the fast backoff. */
const OWNER_EXIT_FAST_PHASE_MS = 60_000;
/** Lease cleanup normally settles within seconds of the run ending. */
export const OWNER_EXIT_ESCALATE_AFTER_MS = 10 * 60_000;
export const OWNER_EXIT_ESCALATION_ACTION = "issue.execution_owner_exit_escalated";

export const ownerExitEscalatedSql = sql`${agentWakeupRequests.payload} #> '{executionWait,escalatedAt}' is not null`;

/** Delay before the next timed re-check of a still-blocked receipt. */
export function ownerExitRetryDelayMs(createdAt: Date, now = Date.now()) {
  return now - createdAt.getTime() < OWNER_EXIT_FAST_PHASE_MS ? OWNER_EXIT_RETRY_FAST_MS : OWNER_EXIT_RETRY_SLOW_MS;
}

export function ownerExitRetryExhausted(createdAt: Date, now = Date.now()) {
  return now - createdAt.getTime() >= OWNER_EXIT_ESCALATE_AFTER_MS;
}

/** A skipped owner-exit receipt that still waits for redelivery. */
export function isPendingOwnerExitWait(row: { status: string; payload: Record<string, unknown> | null }) {
  const wait = row.payload?.executionWait as Record<string, unknown> | undefined;
  return row.status === "skipped" && Boolean(wait?.ownerExit) && !wait?.redeliveredAt;
}

export function isEscalatedOwnerExitWait(payload: Record<string, unknown> | null) {
  return Boolean((payload?.executionWait as Record<string, unknown> | undefined)?.escalatedAt);
}

/**
 * Stop timed retries for one receipt and tell the issue once per blocking run.
 * The issue row lock serializes concurrent escalations, so two workers cannot
 * both post the notice.
 */
export async function escalateStuckOwnerExitWait(db: Db, input: {
  wakeId: string; companyId: string; issueId: string; agentId: string;
  blockingRunId: string | null; nextAction: string;
}) {
  const publications: ActivityPublication[] = [];
  const escalatedAt = new Date().toISOString();
  const outcome = await db.transaction(async tx => {
    const [issue] = await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const [marked] = await tx.update(agentWakeupRequests).set({
      payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{executionWait}',
        (${agentWakeupRequests.payload}->'executionWait') || ${JSON.stringify({ escalatedAt, escalatedForRunId: input.blockingRunId })}::jsonb)`,
      updatedAt: new Date(),
    }).where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, input.wakeId),
      eq(agentWakeupRequests.status, "skipped"),
      sql`${agentWakeupRequests.payload} #> '{executionWait,redeliveredAt}' is null`,
      sql`${agentWakeupRequests.payload} #> '{executionWait,escalatedAt}' is null`))
      .returning({ id: agentWakeupRequests.id });
    if (!marked || !issue) return "not_marked" as const;
    const [prior] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, input.companyId), eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.issueId), eq(activityLog.action, OWNER_EXIT_ESCALATION_ACTION),
      input.blockingRunId
        ? sql`${activityLog.details}->>'blockingRunId' = ${input.blockingRunId}`
        : sql`${activityLog.details}->>'blockingRunId' is null`,
    )).limit(1);
    if (prior) return "already_escalated" as const;
    const [blockingRun] = input.blockingRunId ? await tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
      agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.id, input.blockingRunId))).limit(1) : [];
    const comment = await issueService(tx as unknown as Db).addComment(input.issueId,
      "The previous run on this task still holds its environment lease, so Paperclip could not start the next "
      + "wake. Automatic retries stopped after 10 minutes. The wake runs on its own once the lease is released.",
      {}, {
        authorType: "system",
        presentation: systemNoticePresentation({ tone: "warning", title: "Previous run has not released its environment" }),
        metadata: {
          version: 1,
          recoveryResponsibility: "system",
          sourceRunId: input.blockingRunId,
          sections: [{ title: "Recovery", rows: [
            keyValueRow("Next action", input.nextAction),
            runLinkRow("Blocking run", blockingRun ?? null),
          ] }],
        },
      }, tx);
    await logActivity(tx as unknown as Db, {
      companyId: input.companyId, actorType: "system", actorId: "heartbeat", agentId: input.agentId,
      runId: input.blockingRunId, action: OWNER_EXIT_ESCALATION_ACTION, entityType: "issue", entityId: input.issueId,
      details: { wakeId: input.wakeId, blockingRunId: input.blockingRunId, commentId: comment.id },
    }, publications);
    return "escalated" as const;
  });
  for (const publication of publications) publishActivity(publication);
  return outcome;
}
