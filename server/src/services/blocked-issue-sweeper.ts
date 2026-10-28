import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, heartbeatRuns, issues } from "@paperclipai/db";
import { isAgentInvokable } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { issueService } from "./issues.js";

export const BLOCKED_ISSUE_SWEEP_MIN_AGE_MS = 30 * 60 * 1000;
export const BLOCKED_ISSUE_SWEEP_MAX_PER_TICK = 50;
// Candidates are scanned in age order. The scan window is wider than the move
// cap so issues that stay blocked on purpose cannot starve the ones behind them.
const BLOCKED_ISSUE_SWEEP_SCAN_LIMIT = 500;
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
        await logActivity(db, {
          companyId: candidate.companyId,
          actorType: "system",
          actorId: "blocked_issue_sweeper",
          action: "issue.blocked_swept_to_todo",
          entityType: "issue",
          entityId: candidate.id,
          issueId: candidate.id,
          details: {
            identifier: candidate.identifier,
            reason,
            previousStatus: "blocked",
            status: "todo",
            blockedSince: new Date(candidate.blockedSince).toISOString(),
            assigneeAgentId,
          },
        });
        moved += 1;
        await queueIssueAssignmentWakeup({
          heartbeat,
          issue: { id: candidate.id, assigneeAgentId, status: "todo" },
          reason: reason === "blockers_done" ? "issue_blockers_resolved" : "issue_status_changed",
          mutation: "blocked_issue_sweep",
          contextSource: "blocked_issue_sweeper",
          requestedByActorType: "system",
          requestedByActorId: "blocked_issue_sweeper",
        });
      } catch (err) {
        logger.error({ err, issueId: candidate.id }, "blocked issue sweep failed for issue");
        skipped += 1;
      }
    }

    return { checked: candidates.length, moved, skipped };
  }

  return { sweep };
}
