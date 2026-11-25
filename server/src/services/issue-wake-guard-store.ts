import { and, eq, gt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentWakeupRequests, heartbeatRuns, issueComments } from "@paperclipai/db";
import {
  readTicketRunsPerHourCap,
  REVIEW_VERDICT_WAKE_ACTOR_ID,
  TICKET_RUN_CAP_WINDOW_MS,
  wakeLoopFlagBody,
  WAKE_LOOP_GUARD_ACTION,
} from "./issue-wake-guards.js";

export async function loadTicketRunCapState(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    now: Date;
    excludeRunId?: string | null;
  },
): Promise<{
  runsStartedInWindow: number;
  alreadyFlaggedInWindow: boolean;
}> {
  const since = new Date(input.now.getTime() - TICKET_RUN_CAP_WINDOW_MS);
  const runWhere = and(
    eq(heartbeatRuns.companyId, input.companyId),
    gt(heartbeatRuns.createdAt, since),
    sql`(
      ${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}
      or ${heartbeatRuns.contextSnapshot}->>'taskId' = ${input.issueId}
    )`,
    // Disposition-repair and other retry handoffs are not a new wake loop.
    sql`${heartbeatRuns.contextSnapshot}->>'retryOfRunId' is null`,
    input.excludeRunId ? ne(heartbeatRuns.id, input.excludeRunId) : undefined,
  );
  const [runRow] = await db
    .select({
      n: sql<number>`count(*)::int`,
    })
    .from(heartbeatRuns)
    .where(runWhere);
  const [flagRow] = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.action, WAKE_LOOP_GUARD_ACTION),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        gt(activityLog.createdAt, since),
      ),
    )
    .limit(1);
  return {
    runsStartedInWindow: Number(runRow?.n ?? 0),
    alreadyFlaggedInWindow: Boolean(flagRow),
  };
}

/**
 * PAR-8960: has this issue had a non-skipped review-verdict wake in the rolling
 * cap window? Matched on the fixed system actor id, not the reason, because
 * deferred promotion rewrites the request reason to issue_execution_promoted.
 */
export async function hasReviewVerdictWakeInWindow(
  db: Db,
  input: { companyId: string; issueId: string; now: Date },
): Promise<boolean> {
  const since = new Date(input.now.getTime() - TICKET_RUN_CAP_WINDOW_MS);
  const [row] = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
        eq(agentWakeupRequests.requestedByActorType, "system"),
        eq(agentWakeupRequests.requestedByActorId, REVIEW_VERDICT_WAKE_ACTOR_ID),
        ne(agentWakeupRequests.status, "skipped"),
        gt(agentWakeupRequests.requestedAt, since),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * One activity event and one system comment per window. Direct insert so the
 * flag cannot itself enqueue a wake. Does not change the ticket status.
 */
export async function recordWakeLoopFlag(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId?: string | null;
    runsStartedInWindow: number;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - TICKET_RUN_CAP_WINDOW_MS);
  const [existing] = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.action, WAKE_LOOP_GUARD_ACTION),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        gt(activityLog.createdAt, since),
      ),
    )
    .limit(1);
  if (existing) return;

  const maxRuns = readTicketRunsPerHourCap();
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "system",
    actorId: "system",
    action: WAKE_LOOP_GUARD_ACTION,
    entityType: "issue",
    entityId: input.issueId,
    agentId: input.agentId ?? null,
    details: {
      runsStartedInWindow: input.runsStartedInWindow,
      maxRuns,
      windowMs: TICKET_RUN_CAP_WINDOW_MS,
    },
    createdAt: now,
  });
  await db.insert(issueComments).values({
    companyId: input.companyId,
    issueId: input.issueId,
    authorType: "system",
    body: wakeLoopFlagBody(maxRuns),
    createdAt: now,
    updatedAt: now,
  });
}
