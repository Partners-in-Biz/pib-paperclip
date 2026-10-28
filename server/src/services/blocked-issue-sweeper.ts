import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, companies, heartbeatRuns, issues } from "@paperclipai/db";
import { isAgentInvokable } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { buildIssueBlockersResolvedWakeStateKey } from "./issue-dependency-wakeups.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { issueService } from "./issues.js";

export const BLOCKED_ISSUE_SWEEP_MIN_AGE_MS = 30 * 60 * 1000;
export const BLOCKED_ISSUE_SWEEP_MAX_PER_TICK = 50;
// Candidates are scanned in age order. The scan window is wider than the move
// cap so issues that stay blocked on purpose cannot starve the ones behind them.
const BLOCKED_ISSUE_SWEEP_SCAN_LIMIT = 500;
// An issue swept once is not swept again inside this window. Without it, an agent
// that re-blocks the issue would be woken about every 30 minutes.
export const BLOCKED_ISSUE_SWEEP_REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const BLOCKED_ISSUE_SWEPT_ACTION = "issue.blocked_swept_to_todo";
const HEALTHY_AGENT_STATUSES = new Set(["idle", "active"]);

export type BlockedIssueSweepReason = "blockers_done" | "owner_agent_idle";

/**
 * Moves long-blocked issues back to `todo` and wakes the assignee when nothing
 * is actually holding them:
 *  - `blockers_done`: every blocker issue is done (and finalized), or
 *  - `owner_agent_idle`: no blocker issue is open and the agent named as the
 *    unblock owner (the assignee when no descriptor is set) is idle and
 *    invokable, so a wake will be picked up.
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
        assigneeAgentId: issues.assigneeAgentId,
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

    if (candidates.length === 0) return { checked: 0, moved: 0, skipped: 0 };

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
    let skipped = 0;
    for (const candidate of candidates) {
      if (moved >= BLOCKED_ISSUE_SWEEP_MAX_PER_TICK) break;
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
        reason = "owner_agent_idle";
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

    return { checked: candidates.length, moved, skipped };
  }

  return { sweep };
}
