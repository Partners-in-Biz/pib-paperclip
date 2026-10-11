import { and, desc, eq, inArray, isNull, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { isOpsAlertIssue } from "./ops-alerts.js";

/**
 * Wake loop breaker (PAR-1963, plan PAR-1964 section 3.1).
 *
 * At wake admission, when one agent has already started `maxRuns` non-retry
 * runs on one issue inside the window, the next automation/system wake is
 * refused, the issue is parked for the board, and one ops alert goes out. The
 * refusal is keyed on the active `wake_loop_breaker` recovery action, so it
 * holds until a user wake or a board resolution re-arms the pair.
 */

// Final defaults are Peet's call on PAR-1964. Keep every knob in this block.
export const WAKE_LOOP_BREAKER_DEFAULTS = {
  maxRuns: 10,
  windowMinutes: 60,
} as const;
export const WAKE_LOOP_MAX_RUNS_ENV = "PAPERCLIP_WAKE_LOOP_MAX_RUNS";
export const WAKE_LOOP_WINDOW_MINUTES_ENV = "PAPERCLIP_WAKE_LOOP_WINDOW_MINUTES";

export const WAKE_LOOP_BREAKER_CAUSE = "wake_loop_breaker";
export const WAKE_LOOP_TRIPPED_REASON = "issue_wake_loop_tripped";
export const WAKE_LOOP_TRIPPED_ACTIVITY = "issue.wake_loop_breaker_tripped";
export const WAKE_LOOP_REARMED_ACTIVITY = "issue.wake_loop_breaker_rearmed";
export const WAKE_LOOP_DESCRIPTOR_ACTION =
  "Loop breaker: resolve the recovery action or comment to re-arm";
// The UI renders this kind as "Task Needs Next Step" with board choices.
const WAKE_LOOP_RECOVERY_KIND = "issue_graph_liveness" as const;

const ACTIVE_STATUSES = ["active", "escalated"] as const;
const SETTLED_STATUSES = ["resolved", "cancelled"] as const;
const RESTORABLE_STATUSES = new Set([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
]);

export type WakeLoopBreakerConfig = {
  /** 0 disables the breaker. */
  maxRuns: number;
  windowMinutes: number;
};

function readNonNegativeInt(raw: string | undefined, fallback: number) {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) return fallback;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(value) ? value : fallback;
}

/** Read per evaluation; invalid or negative values fall back to the defaults. */
export function readWakeLoopBreakerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WakeLoopBreakerConfig {
  const maxRuns = readNonNegativeInt(
    env[WAKE_LOOP_MAX_RUNS_ENV],
    WAKE_LOOP_BREAKER_DEFAULTS.maxRuns,
  );
  const windowMinutes = readNonNegativeInt(
    env[WAKE_LOOP_WINDOW_MINUTES_ENV],
    WAKE_LOOP_BREAKER_DEFAULTS.windowMinutes,
  );
  return {
    maxRuns,
    windowMinutes:
      windowMinutes > 0 ? windowMinutes : WAKE_LOOP_BREAKER_DEFAULTS.windowMinutes,
  };
}

/** User wakes never trip (they re-arm instead); the ops-alert inbox never trips. */
export function shouldEvaluateWakeLoopBreaker(input: {
  config: WakeLoopBreakerConfig;
  issueId: string;
  requestedByActorType: string | null | undefined;
  env?: NodeJS.ProcessEnv;
}) {
  if (input.config.maxRuns <= 0) return false;
  if (input.requestedByActorType === "user") return false;
  return !isOpsAlertIssue(input.issueId, input.env);
}

export type WakeLoopBreakerDetails = {
  agentId: string;
  runsInWindow: number;
  maxRuns: number;
  windowMinutes: number;
  runIds: string[];
  firstRunAt: string | null;
  requestedReason: string | null;
  previousStatus: string;
  previousBlockerIds: string[];
  prunedBlockerIds: string[];
  previousUnblockDescriptor: IssueUnblockDescriptor | null;
};

type BreakerPair = { companyId: string; issueId: string; agentId: string };

function pairActionPredicate(pair: BreakerPair) {
  return and(
    eq(issueRecoveryActions.companyId, pair.companyId),
    eq(issueRecoveryActions.sourceIssueId, pair.issueId),
    eq(issueRecoveryActions.cause, WAKE_LOOP_BREAKER_CAUSE),
    eq(issueRecoveryActions.fingerprint, pair.agentId),
  );
}

export type WakeLoopBreakerCheck =
  | { kind: "pass"; runsInWindow: number }
  | { kind: "refuse"; recoveryActionId: string }
  | {
      kind: "trip";
      runs: Array<{ id: string; createdAt: Date }>;
      windowStart: Date;
    };

/**
 * Must run inside the wake admission transaction. Serialises admissions for
 * the (agent, issue) pair, refuses while a breaker action is active, and
 * otherwise counts non-retry runs (minus runs cancelled before they started)
 * since max(now - window, last re-arm).
 */
export async function checkWakeLoopBreaker(
  tx: Db,
  input: BreakerPair & { config: WakeLoopBreakerConfig; now: Date },
): Promise<WakeLoopBreakerCheck> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`${input.agentId}:${input.issueId}`}))`,
  );

  const [state] = await tx
    .select({
      activeId: sql<string | null>`(array_agg(${issueRecoveryActions.id}) filter (where ${inArray(issueRecoveryActions.status, [...ACTIVE_STATUSES])}))[1]`,
      anchor: sql<string | null>`max(${issueRecoveryActions.resolvedAt}) filter (where ${inArray(issueRecoveryActions.status, [...SETTLED_STATUSES])})`,
    })
    .from(issueRecoveryActions)
    .where(pairActionPredicate(input));
  if (state?.activeId) return { kind: "refuse", recoveryActionId: state.activeId };

  const windowFloor = new Date(
    input.now.getTime() - input.config.windowMinutes * 60_000,
  );
  const anchor = state?.anchor ? new Date(state.anchor) : null;
  const windowStart =
    anchor && anchor.getTime() > windowFloor.getTime() ? anchor : windowFloor;

  // Index: heartbeat_runs_company_ctx_issue_created_idx. The limit bounds the
  // scan: reaching maxRuns rows is all the decision needs.
  const runs = await tx
    .select({ id: heartbeatRuns.id, createdAt: heartbeatRuns.createdAt })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
        eq(heartbeatRuns.agentId, input.agentId),
        isNull(heartbeatRuns.retryOfRunId),
        // Runs cancelled before dispatch never reached the adapter and cost
        // nothing; queued and running runs still count.
        sql`not (${heartbeatRuns.status} = 'cancelled' and ${heartbeatRuns.startedAt} is null)`,
        gte(heartbeatRuns.createdAt, windowStart),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(input.config.maxRuns);

  if (runs.length < input.config.maxRuns) {
    return { kind: "pass", runsInWindow: runs.length };
  }
  return { kind: "trip", runs, windowStart };
}

const SAST_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatSastTime(date: Date) {
  return `${SAST_TIME.format(date)} SAST`;
}

function issueLink(issue: { id: string; identifier: string | null }) {
  const identifier = issue.identifier;
  if (!identifier || !/^[A-Z][A-Z0-9]*-\d+$/.test(identifier)) return issue.identifier ?? issue.id;
  const prefix = identifier.split("-")[0];
  return `[${identifier}](/${prefix}/issues/${identifier})`;
}

/** One line: what, since when (SAST), impact, link, what Peet must do. */
export function buildWakeLoopAlertBody(input: {
  agentName: string;
  issue: { id: string; identifier: string | null };
  runsInWindow: number;
  firstRunAt: Date;
  now: Date;
}) {
  const link = issueLink(input.issue);
  const spanMinutes = Math.max(
    1,
    Math.round((input.now.getTime() - input.firstRunAt.getTime()) / 60_000),
  );
  return (
    `Loop breaker: ${input.agentName} ran ${input.runsInWindow} times on ${link} in ${spanMinutes} min ` +
    `(since ${formatSastTime(input.firstRunAt)}). Automation wakes for that pair are refused and the issue ` +
    `is parked (owner: board). ${link}. Need: resolve the recovery action on ${link} or comment there to re-arm.`
  );
}

export type WakeLoopTripResult =
  | {
      kind: "tripped";
      recoveryActionId: string;
      details: WakeLoopBreakerDetails;
      cancelledRuns: Array<typeof heartbeatRuns.$inferSelect>;
      alert: { key: string; body: string };
    }
  | { kind: "already_tripped"; recoveryActionId: string | null };

/**
 * First trip for the pair, inside the admission transaction: record the
 * recovery action (ON CONFLICT DO NOTHING so a concurrent trip never aborts
 * the caller), park the issue for the board, cancel the pair's queued runs,
 * and write the issue comment and activity. The caller stores the skipped
 * wake row and posts the ops alert after commit.
 */
export async function tripWakeLoopBreaker(
  tx: Db,
  input: {
    issue: { id: string; companyId: string; identifier: string | null };
    agent: { id: string; name: string };
    config: WakeLoopBreakerConfig;
    runs: Array<{ id: string; createdAt: Date }>;
    requestedReason: string | null;
    now: Date;
  },
): Promise<WakeLoopTripResult> {
  const { issue, agent, now } = input;
  const [current] = await tx
    .select({ status: issues.status, unblockDescriptor: issues.unblockDescriptor })
    .from(issues)
    .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)));
  const blockers = await tx
    .select({ id: issueRelations.issueId, status: issues.status })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, issue.companyId),
        eq(issueRelations.relatedIssueId, issue.id),
        eq(issueRelations.type, "blocks"),
      ),
    );
  const previousStatus = current?.status ?? "todo";
  const prunedBlockerIds = blockers
    .filter((blocker) => blocker.status === "done")
    .map((blocker) => blocker.id);
  const firstRun = input.runs[input.runs.length - 1];
  const details: WakeLoopBreakerDetails = {
    agentId: agent.id,
    runsInWindow: input.runs.length,
    maxRuns: input.config.maxRuns,
    windowMinutes: input.config.windowMinutes,
    runIds: input.runs.map((run) => run.id),
    firstRunAt: firstRun ? new Date(firstRun.createdAt).toISOString() : null,
    requestedReason: input.requestedReason,
    previousStatus,
    previousBlockerIds: blockers.map((blocker) => blocker.id),
    prunedBlockerIds,
    previousUnblockDescriptor: current?.unblockDescriptor ?? null,
  };

  const [inserted] = await tx
    .insert(issueRecoveryActions)
    .values({
      companyId: issue.companyId,
      sourceIssueId: issue.id,
      kind: WAKE_LOOP_RECOVERY_KIND,
      status: "active",
      ownerType: "board",
      previousOwnerAgentId: agent.id,
      returnOwnerAgentId: agent.id,
      cause: WAKE_LOOP_BREAKER_CAUSE,
      fingerprint: agent.id,
      evidence: { wakeLoopBreaker: details },
      nextAction:
        `${agent.name} ran ${details.runsInWindow} times on this issue within ${details.windowMinutes} minutes. ` +
        "Automation wakes for this agent are refused. Comment on the issue or resolve this action to re-arm.",
      attemptCount: 1,
      lastAttemptAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: issueRecoveryActions.id });

  if (!inserted) {
    // Either a concurrent admission tripped first, or another recovery action
    // already holds the issue's single active slot. Refuse silently; the
    // existing action is what the board sees.
    const [active] = await tx
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, issue.companyId),
          eq(issueRecoveryActions.sourceIssueId, issue.id),
          inArray(issueRecoveryActions.status, [...ACTIVE_STATUSES]),
        ),
      )
      .limit(1);
    return { kind: "already_tripped", recoveryActionId: active?.id ?? null };
  }

  if (prunedBlockerIds.length > 0) {
    await tx
      .delete(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, issue.companyId),
          eq(issueRelations.relatedIssueId, issue.id),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.issueId, prunedBlockerIds),
        ),
      );
  }

  const parked = previousStatus !== "done" && previousStatus !== "cancelled";
  if (parked) {
    await tx
      .update(issues)
      .set({
        status: "blocked",
        unblockDescriptor: { owner: "board", action: WAKE_LOOP_DESCRIPTOR_ACTION },
        // The ops alert is the owner notification.
        blockedOwnerNotifiedAt: now,
        ...(previousStatus === "blocked" ? {} : { blockedTransitionAt: now }),
        updatedAt: now,
      })
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)));
  }

  const cancelReason = "Cancelled by the wake loop breaker";
  const cancelledRuns = await tx
    .update(heartbeatRuns)
    .set({
      status: "cancelled",
      finishedAt: now,
      error: cancelReason,
      errorCode: WAKE_LOOP_TRIPPED_REASON,
      updatedAt: now,
    })
    .where(
      and(
        eq(heartbeatRuns.companyId, issue.companyId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        eq(heartbeatRuns.agentId, agent.id),
        eq(heartbeatRuns.status, "queued"),
      ),
    )
    .returning();
  const cancelledRunIds = cancelledRuns.map((run) => run.id);
  await tx
    .update(agentWakeupRequests)
    .set({ status: "cancelled", finishedAt: now, error: cancelReason, updatedAt: now })
    .where(
      and(
        eq(agentWakeupRequests.companyId, issue.companyId),
        eq(agentWakeupRequests.agentId, agent.id),
        eq(agentWakeupRequests.status, "queued"),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
      ),
    );
  if (cancelledRunIds.length > 0) {
    await tx
      .update(issues)
      .set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(and(eq(issues.id, issue.id), inArray(issues.executionRunId, cancelledRunIds)));
  }

  const commentBody = [
    `Paperclip's wake loop breaker stopped automatic wakes for ${agent.name} on this issue.`,
    "",
    `- Runs: ${details.runsInWindow} in the last ${details.windowMinutes} minutes (cap ${details.maxRuns}; retries not counted)`,
    `- Run ids: ${details.runIds.join(", ")}`,
    parked
      ? `- Issue parked: \`${previousStatus}\` → \`blocked\` (owner: board)` +
        (prunedBlockerIds.length > 0 ? `; removed finished blockers ${prunedBlockerIds.join(", ")}` : "")
      : `- Issue left \`${previousStatus}\``,
    "- Re-arm: comment on this issue as a board user, or resolve the recovery action. The previous status comes back and the run count starts again.",
  ].join("\n");
  await tx.insert(issueComments).values({
    companyId: issue.companyId,
    issueId: issue.id,
    authorType: "system",
    body: commentBody,
    createdAt: now,
    updatedAt: now,
  });

  await logActivity(tx, {
    companyId: issue.companyId,
    actorType: "system",
    actorId: WAKE_LOOP_BREAKER_CAUSE,
    agentId: agent.id,
    runId: null,
    action: WAKE_LOOP_TRIPPED_ACTIVITY,
    entityType: "issue",
    entityId: issue.id,
    details: {
      identifier: issue.identifier,
      recoveryActionId: inserted.id,
      ...details,
      cancelledRunIds,
    },
  });

  return {
    kind: "tripped",
    recoveryActionId: inserted.id,
    details,
    cancelledRuns,
    alert: {
      key: `${WAKE_LOOP_BREAKER_CAUSE}:${inserted.id}`,
      body: buildWakeLoopAlertBody({
        agentName: agent.name,
        issue,
        runsInWindow: details.runsInWindow,
        firstRunAt: firstRun ? new Date(firstRun.createdAt) : now,
        now,
      }),
    },
  };
}

function readBreakerDetails(evidence: Record<string, unknown> | null | undefined) {
  const raw = evidence?.wakeLoopBreaker;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Partial<WakeLoopBreakerDetails>)
    : null;
}

/**
 * Re-arm: settle active breaker actions for the issue (one agent's, or all
 * when `agentId` is null) and, when the issue is still parked by the breaker,
 * restore the status it had before the trip. Finished blockers stay pruned.
 * The settled action's `resolvedAt` anchors the next count.
 */
export async function rearmWakeLoopBreaker(
  tx: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string | null;
    actionId?: string | null;
    actor: { actorType: "user" | "agent" | "system"; actorId: string; agentId?: string | null; runId?: string | null };
    source: "user_wake" | "recovery_action_resolution";
    restoreStatus: boolean;
    resolutionNote: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const resolved = await tx
    .update(issueRecoveryActions)
    .set({
      status: "resolved",
      outcome: "restored",
      resolutionNote: input.resolutionNote,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(issueRecoveryActions.companyId, input.companyId),
        eq(issueRecoveryActions.sourceIssueId, input.issueId),
        eq(issueRecoveryActions.cause, WAKE_LOOP_BREAKER_CAUSE),
        inArray(issueRecoveryActions.status, [...ACTIVE_STATUSES]),
        input.agentId ? eq(issueRecoveryActions.fingerprint, input.agentId) : undefined,
        input.actionId ? eq(issueRecoveryActions.id, input.actionId) : undefined,
      ),
    )
    .returning();
  if (resolved.length === 0) return { resolved, restoredStatus: null as string | null };

  let restoredStatus: string | null = null;
  const details = readBreakerDetails(resolved[0]!.evidence);
  const previousStatus = details?.previousStatus;
  if (input.restoreStatus && previousStatus && RESTORABLE_STATUSES.has(previousStatus)) {
    const [current] = await tx
      .select({ status: issues.status, unblockDescriptor: issues.unblockDescriptor })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
    // Only undo our own park: anyone who changed the issue since then wins.
    const stillParked =
      current?.status === "blocked" &&
      current.unblockDescriptor?.owner === "board" &&
      current.unblockDescriptor.action === WAKE_LOOP_DESCRIPTOR_ACTION;
    if (stillParked) {
      await tx
        .update(issues)
        .set(
          previousStatus === "blocked"
            ? {
                unblockDescriptor: details?.previousUnblockDescriptor ?? null,
                blockedOwnerNotifiedAt: null,
                updatedAt: now,
              }
            : {
                status: previousStatus,
                unblockDescriptor: null,
                blockedTransitionAt: null,
                blockedOwnerNotifiedAt: null,
                updatedAt: now,
              },
        )
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
      restoredStatus = previousStatus;
    }
  }

  await logActivity(tx, {
    companyId: input.companyId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    agentId: input.actor.agentId ?? null,
    runId: input.actor.runId ?? null,
    action: WAKE_LOOP_REARMED_ACTIVITY,
    entityType: "issue",
    entityId: input.issueId,
    details: {
      recoveryActionIds: resolved.map((action) => action.id),
      agentIds: resolved.map((action) => action.fingerprint),
      source: input.source,
      restoredStatus,
    },
  });
  return { resolved, restoredStatus };
}
