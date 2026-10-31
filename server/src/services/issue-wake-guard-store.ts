import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issueComments } from "@paperclipai/db";
import {
  TICKET_RUN_CAP_WINDOW_MS,
  WAKE_LOOP_FLAG_BODY,
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
  latestRunStatus: string | null;
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
  const [latestRun] = await db
    .select({ status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(runWhere)
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1);
  return {
    runsStartedInWindow: Number(runRow?.n ?? 0),
    alreadyFlaggedInWindow: Boolean(flagRow),
    latestRunStatus: latestRun?.status ?? null,
  };
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
      maxRuns: 3,
      windowMs: TICKET_RUN_CAP_WINDOW_MS,
    },
    createdAt: now,
  });
  await db.insert(issueComments).values({
    companyId: input.companyId,
    issueId: input.issueId,
    authorType: "system",
    body: WAKE_LOOP_FLAG_BODY,
    createdAt: now,
    updatedAt: now,
  });
}
