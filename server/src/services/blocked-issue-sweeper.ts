import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, companies, heartbeatRuns, issues } from "@paperclipai/db";
import { isAgentInvokable } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { buildIssueBlockersResolvedWakeStateKey } from "./issue-dependency-wakeups.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { issueService } from "./issues.js";
import { readDispositionRepairDurableWaitingState } from "./recovery/disposition-repair.js";

export const BLOCKED_ISSUE_SWEEP_MIN_AGE_MS = 30 * 60 * 1000;
export const BLOCKED_ISSUE_SWEEP_MAX_PER_TICK = 50;
// How soon an overdue blocked issue the sweep left alone is looked at again.
export const BLOCKED_ISSUE_SWEEP_RETRY_MS = 5 * 60 * 1000;
// Candidates are scanned in age order. The scan window is wider than the move
// cap so issues that stay blocked on purpose cannot starve the ones behind them.
const BLOCKED_ISSUE_SWEEP_SCAN_LIMIT = 500;
// An issue swept once is not swept again inside this window. Without it, an agent
// that re-blocks the issue would be woken about every 30 minutes.
export const BLOCKED_ISSUE_SWEEP_REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const BLOCKED_ISSUE_SWEPT_ACTION = "issue.blocked_swept_to_todo";
// PAR-9398: one row per re-notice sent to another agent named as unblock owner.
export const BLOCKED_OWNER_RENOTIFIED_ACTION = "issue.blocked_owner_renotified";
// Re-notices before the sweeper falls back to moving the issue to todo.
export const BLOCKED_OWNER_MAX_RENOTICES = 2;
const UNBLOCK_OWNER_SWEEPER_ACTOR_ID = "blocked_issue_sweeper";
const HEALTHY_AGENT_STATUSES = new Set(["idle", "active"]);

export type BlockedIssueSweepReason = "blockers_done" | "owner_agent_idle" | "owner_did_not_act";

/**
 * Moves long-blocked issues back to `todo` and wakes the assignee when nothing
 * is actually holding them:
 *  - `blockers_done`: every blocker issue is done (and finalized), or
 *  - `owner_agent_idle`: no blocker issue is open and the agent named as the
 *    unblock owner (the assignee when no descriptor is set) is idle and
 *    invokable, so a wake will be picked up.
 * When the owner is another agent than the assignee (PAR-9398), the sweeper first
 * re-notices that owner twice, 24 h apart (24 h and 48 h after the block), and only
 * 24 h after the second re-notice moves the issue with reason `owner_did_not_act`.
 * Issues owned by the board or a user, with open blockers, or with a run in
 * flight are left alone.
 */
export function blockedIssueSweeper(db: Db, heartbeat: IssueAssignmentWakeupDeps) {
  const issuesSvc = issueService(db);

  async function hasActiveRun(issueId: string, executionRunId: string | null) {
    if (executionRunId) return true;
    const [row] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async function sweep(now = new Date()) {
    const cutoff = new Date(now.getTime() - BLOCKED_ISSUE_SWEEP_MIN_AGE_MS);
    const candidates = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        executionRunId: issues.executionRunId,
        unblockDescriptor: issues.unblockDescriptor,
        blockedTransitionAt: issues.blockedTransitionAt,
        blockedSince: sql<string>`coalesce(${issues.blockedTransitionAt}, ${issues.updatedAt})`,
      })
      .from(issues)
      .innerJoin(companies, eq(companies.id, issues.companyId))
      .where(
        and(
          eq(companies.status, "active"),
          eq(issues.status, "blocked"),
          isNull(issues.assigneeUserId),
          sql`${issues.assigneeAgentId} is not null`,
          isNull(issues.executionRunId),
          sql`coalesce(${issues.blockedTransitionAt}, ${issues.updatedAt}) <= ${cutoff.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(sql`coalesce(${issues.blockedTransitionAt}, ${issues.updatedAt})`))
      .limit(BLOCKED_ISSUE_SWEEP_SCAN_LIMIT);

    if (candidates.length === 0) return { checked: 0, moved: 0, renotified: 0, skipped: 0 };

    const recentlySwept = new Set(
      (
        await db
          .select({ entityId: activityLog.entityId })
          .from(activityLog)
          .where(
            and(
              inArray(activityLog.companyId, [...new Set(candidates.map((c) => c.companyId))]),
              eq(activityLog.entityType, "issue"),
              eq(activityLog.action, BLOCKED_ISSUE_SWEPT_ACTION),
              inArray(activityLog.entityId, candidates.map((c) => c.id)),
              gte(activityLog.createdAt, new Date(now.getTime() - BLOCKED_ISSUE_SWEEP_REPEAT_WINDOW_MS)),
            ),
          )
      ).map((row) => row.entityId),
    );

    const companyIds = [...new Set(candidates.map((c) => c.companyId))];
    // Re-notices per issue, counted only for the issue's current block.
    const renotices = new Map<string, { count: number; lastAt: number }>();
    const renoticeRows = await db
      .select({ entityId: activityLog.entityId, details: activityLog.details, createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          inArray(activityLog.companyId, companyIds),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.action, BLOCKED_OWNER_RENOTIFIED_ACTION),
          inArray(activityLog.entityId, candidates.map((c) => c.id)),
        ),
      );
    const blockedSinceById = new Map(candidates.map((c) => [c.id, new Date(c.blockedSince).toISOString()]));
    for (const row of renoticeRows) {
      const details = (row.details ?? {}) as { blockedTransitionAt?: unknown; renotifiedAt?: unknown };
      if (details.blockedTransitionAt !== blockedSinceById.get(row.entityId)) continue;
      const at = typeof details.renotifiedAt === "string" ? Date.parse(details.renotifiedAt) : row.createdAt.getTime();
      const prev = renotices.get(row.entityId) ?? { count: 0, lastAt: 0 };
      renotices.set(row.entityId, { count: prev.count + 1, lastAt: Math.max(prev.lastAt, at) });
    }

    const agentRows = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        status: agents.status,
        reportsTo: agents.reportsTo,
      })
      .from(agents)
      .where(inArray(agents.companyId, companyIds));
    const agentsById = new Map(agentRows.map((a) => [a.id, a]));
    const isHealthy = (agentId: string) => {
      const agent = agentsById.get(agentId);
      if (!agent || !HEALTHY_AGENT_STATUSES.has(agent.status)) return false;
      return isAgentInvokable({
        agent,
        agents: agentRows.filter((a) => a.companyId === agent.companyId),
      });
    };

    const readinessByCompany = new Map<string, Awaited<ReturnType<typeof issuesSvc.listDependencyReadiness>>>();
    for (const companyId of companyIds) {
      readinessByCompany.set(
        companyId,
        await issuesSvc.listDependencyReadiness(
          companyId,
          candidates.filter((c) => c.companyId === companyId).map((c) => c.id),
        ),
      );
    }

    let moved = 0;
    let renotified = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      if (moved + renotified >= BLOCKED_ISSUE_SWEEP_MAX_PER_TICK) break;
      const assigneeAgentId = candidate.assigneeAgentId!;
      if (recentlySwept.has(candidate.id)) {
        logger.info({ issueId: candidate.id }, "blocked issue sweeper skipped an issue it already swept in the last 24h");
        skipped += 1;
        continue;
      }
      const readiness = readinessByCompany.get(candidate.companyId)?.get(candidate.id);
      // Open or still-finalizing blockers: the issue is blocked for a real reason.
      if (!readiness || readiness.unresolvedBlockerCount > 0) {
        skipped += 1;
        continue;
      }

      let reason: BlockedIssueSweepReason;
      // Set when the next step is a re-notice to another agent owner, not a move.
      let renotice: { ownerAgentId: string; action: string; count: number } | null = null;
      if (readiness.blockerIssueIds.length > 0 && readiness.allBlockersDone) {
        reason = "blockers_done";
      } else {
        const owner = candidate.unblockDescriptor?.owner;
        // A board or user owner means a person must act; PR 3 flags those.
        if (owner === "board" || (owner && "userId" in owner)) {
          skipped += 1;
          continue;
        }
        const ownerAgentId = owner && "agentId" in owner ? owner.agentId : assigneeAgentId;
        if (!isHealthy(ownerAgentId) || !isHealthy(assigneeAgentId)) {
          skipped += 1;
          continue;
        }
        // A pending question or approval, a future monitor, or a pending review
        // stage already holds the issue and will wake the owner. Sweeping it
        // anyway wakes the agent to say "still waiting"; its re-check then ends
        // without a disposition and buys a second, repair wake (PAR-8900).
        const wait = await readDispositionRepairDurableWaitingState(db, { issue: candidate });
        if (wait.hasDurableWaitingPath) {
          skipped += 1;
          continue;
        }
        reason = "owner_agent_idle";
        if (ownerAgentId !== assigneeAgentId) {
          // PAR-9398: another agent must act. Re-notice it twice before moving the issue.
          const sent = renotices.get(candidate.id) ?? { count: 0, lastAt: 0 };
          const since = sent.count === 0 ? new Date(candidate.blockedSince).getTime() : sent.lastAt;
          if (now.getTime() - since < BLOCKED_ISSUE_SWEEP_REPEAT_WINDOW_MS) {
            skipped += 1;
            continue;
          }
          if (sent.count < BLOCKED_OWNER_MAX_RENOTICES) {
            renotice = { ownerAgentId, action: candidate.unblockDescriptor?.action ?? "", count: sent.count + 1 };
          } else {
            reason = "owner_did_not_act";
          }
        }
      }

      try {
        if (await hasActiveRun(candidate.id, candidate.executionRunId)) {
          skipped += 1;
          continue;
        }
        // Re-read so an issue unblocked, re-blocked or reassigned since the scan is left alone.
        // This is a check, not a lock: a change between this read and the update below is
        // possible but rare, and the worst case is one early move to todo.
        const [fresh] = await db
          .select({
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
            blockedTransitionAt: issues.blockedTransitionAt,
          })
          .from(issues)
          .where(and(eq(issues.id, candidate.id), eq(issues.companyId, candidate.companyId)))
          .limit(1);
        if (
          !fresh ||
          fresh.status !== "blocked" ||
          fresh.assigneeAgentId !== assigneeAgentId ||
          fresh.blockedTransitionAt?.getTime() !== candidate.blockedTransitionAt?.getTime()
        ) {
          skipped += 1;
          continue;
        }

        if (renotice) {
          const blockedTransitionAt = new Date(candidate.blockedSince).toISOString();
          // Same shape as the notice at block time (routable-blocked.ts), with a numbered
          // key so the wake queue does not merge it into that first notice.
          let wakeFailed = false;
          try {
            await heartbeat.wakeup(renotice.ownerAgentId, {
              source: "automation",
              triggerDetail: "system",
              reason: "issue_unblock_requested",
              idempotencyKey: `issue-unblock:${candidate.id}:${blockedTransitionAt}:n${renotice.count}`,
              requestedByActorType: "system",
              requestedByActorId: UNBLOCK_OWNER_SWEEPER_ACTOR_ID,
              payload: { issueId: candidate.id, action: renotice.action },
              contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: candidate.id, taskId: candidate.id },
            });
          } catch (err) {
            wakeFailed = true;
            logger.warn({ err, issueId: candidate.id }, "failed to re-notice the unblock owner");
          }
          // Recorded even when the wake failed or was skipped, so the fallback move
          // still comes and the issue is never left blocked with nobody due to be woken.
          await logActivity(db, {
            companyId: candidate.companyId,
            actorType: "system",
            actorId: UNBLOCK_OWNER_SWEEPER_ACTOR_ID,
            action: BLOCKED_OWNER_RENOTIFIED_ACTION,
            entityType: "issue",
            entityId: candidate.id,
            issueId: candidate.id,
            details: {
              identifier: candidate.identifier,
              blockedTransitionAt,
              count: renotice.count,
              ownerAgentId: renotice.ownerAgentId,
              renotifiedAt: now.toISOString(),
              ...(wakeFailed ? { wakeFailed: true } : {}),
            },
          });
          renotified += 1;
          continue;
        }

        const updated = await issuesSvc.update(candidate.id, {
          status: "todo",
          companyGuard: candidate.companyId,
        });
        if (!updated) {
          skipped += 1;
          continue;
        }
        // Wake first: the move is already committed, so a failing log write must not
        // leave the issue in todo with nobody woken.
        let wakeFailed = false;
        if (reason === "blockers_done") {
          // Same source and state key as the route and the recovery backstop, so the
          // wake queue treats this as the same wake and does not start a second run.
          await heartbeat
            .wakeup(assigneeAgentId, {
              source: "automation",
              triggerDetail: "system",
              reason: "issue_blockers_resolved",
              payload: {
                issueId: candidate.id,
                blockerIssueIds: readiness.blockerIssueIds,
                mutation: "blocked_issue_sweep",
              },
              idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
                dependentIssueId: candidate.id,
                blockerIssueIds: readiness.blockerIssueIds,
                blockedTransitionAt: candidate.blockedTransitionAt,
              }),
              requestedByActorType: "system",
              requestedByActorId: "blocked_issue_sweeper",
              contextSnapshot: {
                issueId: candidate.id,
                taskId: candidate.id,
                wakeReason: "issue_blockers_resolved",
                source: "blocked_issue_sweeper",
                blockerIssueIds: readiness.blockerIssueIds,
              },
            })
            .catch((err) => {
              wakeFailed = true;
              logger.warn({ err, issueId: candidate.id }, "failed to wake assignee after blocked issue sweep");
            });
        } else {
          await queueIssueAssignmentWakeup({
            heartbeat,
            issue: { id: candidate.id, assigneeAgentId, status: "todo" },
            reason: "issue_status_changed",
            mutation: "blocked_issue_sweep",
            contextSource: "blocked_issue_sweeper",
            requestedByActorType: "system",
            requestedByActorId: "blocked_issue_sweeper",
          });
        }
        const details = {
          identifier: candidate.identifier,
          reason,
          previousStatus: "blocked",
          status: "todo",
          blockedSince: new Date(candidate.blockedSince).toISOString(),
          assigneeAgentId,
          // The issue is already in todo, so a failed wake does not leave it blocked and the
          // guard has nothing to hold back; the assignee's next timer heartbeat finds it.
          ...(wakeFailed ? { wakeFailed: true } : {}),
        };
        // The sweeper entry is the loop guard; `issue.updated` is the event plugins
        // subscribe to, which the route writes for a status change and the service does not.
        await logActivity(db, {
          companyId: candidate.companyId,
          actorType: "system",
          actorId: "blocked_issue_sweeper",
          action: BLOCKED_ISSUE_SWEPT_ACTION,
          entityType: "issue",
          entityId: candidate.id,
          issueId: candidate.id,
          details,
        });
        await logActivity(db, {
          companyId: candidate.companyId,
          actorType: "system",
          actorId: "blocked_issue_sweeper",
          action: "issue.updated",
          entityType: "issue",
          entityId: candidate.id,
          issueId: candidate.id,
          details: {
            status: "todo",
            identifier: candidate.identifier,
            source: "blocked_issue_sweeper",
            changes: { status: { from: "blocked", to: "todo" } },
          },
        });
        moved += 1;
      } catch (err) {
        logger.error({ err, issueId: candidate.id }, "blocked issue sweep failed for issue");
        skipped += 1;
      }
    }

    return { checked: candidates.length, moved, renotified, skipped };
  }

  /**
   * When the sweep next has something to look at: the moment the oldest blocked,
   * agent-assigned issue reaches the minimum age, `retryAt` when such an issue is
   * already past it (it was skipped for a reason that may clear), or null when no
   * issue is blocked. Null keeps the server quiet; an issue moving to blocked
   * notifies the sweep queue again (issues.ts).
   */
  async function nextDueAt(now = new Date(), retryAt = now.getTime() + BLOCKED_ISSUE_SWEEP_RETRY_MS) {
    const [row] = await db
      .select({ oldest: sql<string | null>`min(coalesce(${issues.blockedTransitionAt}, ${issues.updatedAt}))` })
      .from(issues)
      .innerJoin(companies, eq(companies.id, issues.companyId))
      .where(
        and(
          eq(companies.status, "active"),
          eq(issues.status, "blocked"),
          isNull(issues.assigneeUserId),
          sql`${issues.assigneeAgentId} is not null`,
          isNull(issues.executionRunId),
        ),
      );
    if (!row?.oldest) return null;
    const dueAt = new Date(row.oldest).getTime() + BLOCKED_ISSUE_SWEEP_MIN_AGE_MS;
    return dueAt > now.getTime() ? dueAt : retryAt;
  }

  return { sweep, nextDueAt };
}
