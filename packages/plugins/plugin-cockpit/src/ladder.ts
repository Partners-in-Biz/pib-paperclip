/**
 * Ladder: escalating blocked issues through levels 1–4 via the pib-plugin-kit.
 * Orchestrates marker reconciliation, ladder tick execution, and storm handling.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { escalate } from "@partnersinbiz/pib-plugin-kit";
import { nextAction, BLOCKED_ESCALATE_HOURS, classifyUnblock, type Level, type UnblockInput } from "./ladder-model.js";
import { recordRepair, listRepairs } from "./repairs.js";
import { readMarkerIssues, readLadderIssues, readStorms, type MarkerIssueRow, type LadderIssue } from "./watch.js";
import { message, type Env } from "./env.js";

export interface LadderTickCounts {
  created: number;
  advanced: number;
  cancelled: number;
  resolved: number;
  skipped: number;
  stormed: number;
  reconciled: number;
}

type SkipReason = "disabled" | "dedupe" | "cooldown" | "cap" | "no-target" | "no-owner" | "no-issue";
type NoneReason = "not_stuck_yet" | "level_open" | "owner_level" | "ladder_end" | "nothing_to_do";

/**
 * Ensures every marker issue has a corresponding repairs row. Idempotent:
 * existing rows (by targetKind='issue' + targetId + action match) are skipped.
 * Returns the number of rows inserted (not existing ones).
 */
export async function reconcileMarkers(
  ctx: PluginContext,
  companyId: string,
  markers: MarkerIssueRow[],
  now: Date,
): Promise<number> {
  if (markers.length === 0) return 0;

  // Fetch existing repairs for this company with kind='escalation'
  const existing = await listRepairs(ctx, companyId, {
    kind: "escalation",
    limit: 500,
  });

  // Build a set of existing (targetId, action) pairs
  const existingSet = new Set(
    existing
      .filter((r) => r.targetKind === "issue")
      .map((r) => `${r.targetId}:${r.action}`),
  );

  let inserted = 0;
  for (const marker of markers) {
    const action = `create_L${marker.level}`;
    const key = `${marker.id}:${action}`;

    if (!existingSet.has(key)) {
      await recordRepair(ctx, companyId, {
        kind: "escalation",
        targetKind: "issue",
        targetId: marker.id,
        action,
        outcome: "created",
        detail: `Escalated issue ${marker.stuckIssueId} to level ${marker.level}`,
        actor: "cockpit-ladder",
      });
      inserted += 1;
    }
  }

  return inserted;
}

/** Check if a repair row exists (fetched once per tick, checked many times). */
async function hasRepair(
  ctx: PluginContext,
  companyId: string,
  existingList: Awaited<ReturnType<typeof listRepairs>>,
  opts: { targetId: string; action: string; since?: string },
): Promise<boolean> {
  return existingList.some(
    (r) =>
      r.targetKind === "issue" &&
      r.targetId === opts.targetId &&
      r.action === opts.action &&
      (!opts.since || r.createdAt >= opts.since),
  );
}

/** Internal state key for the hourly guard. */
function ladderStateKey(companyId: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId,
    namespace: "cockpit",
    stateKey: `ladder-last-run:${companyId}`,
  };
}

/** Record a skip reason (called by create, advance, and storm paths). */
async function recordSkip(
  ctx: PluginContext,
  companyId: string,
  stuckIssueId: string,
  skipReason: SkipReason,
  existingList: Awaited<ReturnType<typeof listRepairs>>,
  now: Date,
): Promise<void> {
  const today = now.toISOString().split("T")[0];
  const action = `skip_${skipReason}`;
  if (!(await hasRepair(ctx, companyId, existingList, { targetId: stuckIssueId, action, since: today }))) {
    await recordRepair(ctx, companyId, {
      kind: "escalation",
      targetKind: "issue",
      targetId: stuckIssueId,
      action,
      outcome: `skipped_${skipReason}`,
      actor: "cockpit-ladder",
    });
  }
}

/** Determine the highest open Unblock level from the list. */
function highestOpenLevel(unblocks: UnblockInput[]): Level | null {
  const openStatuses = new Set(["todo", "in_progress", "in_review"]);
  let highest: Level | null = null;
  for (const u of unblocks) {
    if (openStatuses.has(u.status)) {
      const c = classifyUnblock(u);
      if (c.kind === "unblock" && (highest === null || c.level > highest)) {
        highest = c.level;
      }
    }
  }
  return highest;
}

/**
 * Hourly job: reconcile markers, optionally escalate stuck issues and handle storms.
 * Wraps failures per issue so one does not stop the others.
 */
export async function ladderTick(env: Env, companyId: string): Promise<LadderTickCounts> {
  const counts: LadderTickCounts = {
    created: 0,
    advanced: 0,
    cancelled: 0,
    resolved: 0,
    skipped: 0,
    stormed: 0,
    reconciled: 0,
  };

  const skipReasons = new Map<SkipReason, number>();
  const noneReasons = new Map<NoneReason, number>();

  const now = env.now();

  // Step (a): Always reconcile markers
  const markers = await readMarkerIssues(env.ctx, companyId);
  const reconciled = await reconcileMarkers(env.ctx, companyId, markers, now);
  counts.reconciled = reconciled;

  // Step (b): Hourly guard (55 minutes)
  const stateKey = ladderStateKey(companyId);
  const lastRunIso = (await env.ctx.state.get(stateKey)) as string | null;
  const lastRun = lastRunIso ? new Date(lastRunIso) : null;
  const timeSinceLastRun = lastRun ? now.getTime() - lastRun.getTime() : Infinity;
  const fiftyFiveMinutesMs = 55 * 60 * 1000;

  if (timeSinceLastRun < fiftyFiveMinutesMs) {
    // Guard active, skip escalation actions
    return counts;
  }

  // Guard passed; record the run time and proceed with actions
  await env.ctx.state.set(stateKey, now.toISOString());

  // Fetch repairs once for the entire tick (used by hasRepair)
  const existingRepairs = await listRepairs(env.ctx, companyId, {
    kind: "escalation",
    limit: 500,
  });

  // Step (c): Process each ladder issue
  const markerIds = new Set(markers.map((m) => m.id));
  const ladderIssues = await readLadderIssues(env.ctx, companyId, now);
  const blockedTotal = ladderIssues.length;

  for (const issue of ladderIssues) {
    try {
      const action = nextAction(issue.stuck, issue.unblocks, now);

      if (action.type === "none") {
        // Track the reason for skipping
        noneReasons.set(action.reason, (noneReasons.get(action.reason) ?? 0) + 1);
      } else if (action.type === "resolved") {
        // Only if stuck has marker children
        const hasMarkers = issue.unblocks.some((u) => markerIds.has(u.id));
        if (hasMarkers) {
          const today = now.toISOString().split("T")[0];
          if (!(await hasRepair(env.ctx, companyId, existingRepairs, { targetId: issue.stuck.id, action: "resolved", since: today }))) {
            await recordRepair(env.ctx, companyId, {
              kind: "escalation",
              targetKind: "issue",
              targetId: issue.stuck.id,
              action: "resolved",
              outcome: "resolved",
              actor: "cockpit-ladder",
            });
            counts.resolved += 1;
          }
        }
      } else if (action.type === "create") {
        const reason = `Blocked over ${BLOCKED_ESCALATE_HOURS} hours with no open blocker.`;
        const startLevel = action.level === 4 ? "owner" : action.level;

        const result = await escalate(env.ctx, issue.stuck.id, reason, {
          companyId,
          startLevel,
          now,
        });

        if ("id" in result && result.created) {
          // Record using the new Unblock issue id as target (for dedup with reconciler)
          if (!(await hasRepair(env.ctx, companyId, existingRepairs, { targetId: result.id, action: `create_L${action.level}` }))) {
            await recordRepair(env.ctx, companyId, {
              kind: "escalation",
              targetKind: "issue",
              targetId: result.id,
              action: `create_L${action.level}`,
              outcome: "created",
              actor: "cockpit-ladder",
            });
          }
          counts.created += 1;
        } else if ("skipped" in result) {
          const skipReason = result.skipped as SkipReason;
          skipReasons.set(skipReason, (skipReasons.get(skipReason) ?? 0) + 1);
          await recordSkip(env.ctx, companyId, issue.stuck.id, skipReason, existingRepairs, now);
          counts.skipped += 1;
        }
      } else if (action.type === "advance") {
        const startLevel = action.level === 4 ? "owner" : action.level;

        // Escalate to the new level
        const result = await escalate(env.ctx, issue.stuck.id, `Escalation advance to level ${action.level}.`, {
          companyId,
          startLevel,
          now,
        });

        // Determine the comment level (for both created and dedupe cases)
        const highest = highestOpenLevel(issue.unblocks);
        const nextLevelNum = action.level === 4 ? 4 : Math.min(4, action.level + 1);

        // Handle created or dedupe (dedupe returns {id, level, created: false}): cancel lower unblocks and update blocker edges
        const isSuccess = "id" in result && (result.created || result.created === false);

        if (isSuccess) {
          if ("id" in result && result.created) {
            counts.advanced += 1;
          }

          // Cancel lower unblocks
          for (const cancelId of action.cancelIds) {
            try {
              await env.ctx.issues.update(
                cancelId,
                { status: "cancelled" },
                companyId,
              );
              await env.ctx.issues.createComment(
                cancelId,
                `Superseded by level ${nextLevelNum}.`,
                companyId,
              );
              counts.cancelled += 1;
            } catch (error) {
              env.ctx.logger.info("Failed to cancel unblock", {
                companyId,
                issueId: cancelId,
                error: message(error),
              });
            }
          }

          // Update blocker edges if any cleanup needed
          if (action.swapBlockerFrom || action.replaceClosedBlockerIds?.length || action.cancelIds.length) {
            try {
              const relations = await env.ctx.issues.relations.get(issue.stuck.id, companyId);
              const blockedByIds = new Set(relations.blockedBy?.map((b) => b.id) ?? []);

              // Remove all superseded/closed/cancelled ids (new Unblock already added by escalate)
              if (action.swapBlockerFrom) blockedByIds.delete(action.swapBlockerFrom);
              for (const id of action.replaceClosedBlockerIds ?? []) {
                blockedByIds.delete(id);
              }
              for (const id of action.cancelIds) {
                blockedByIds.delete(id);
              }

              await env.ctx.issues.update(
                issue.stuck.id,
                {
                  blockedByIssueIds: Array.from(blockedByIds),
                },
                companyId,
              );
            } catch (error) {
              env.ctx.logger.warn("Failed to update blocker edges", {
                companyId,
                issueId: issue.stuck.id,
                error: message(error),
              });
            }
          }
        } else if ("skipped" in result) {
          // Record the skip for advance attempts
          const skipReason = result.skipped as SkipReason;
          skipReasons.set(skipReason, (skipReasons.get(skipReason) ?? 0) + 1);
          await recordSkip(env.ctx, companyId, issue.stuck.id, skipReason, existingRepairs, now);
          counts.skipped += 1;
        }
      } else if (action.type === "cancel_lower") {
        // Determine highest remaining level for comment
        const highest = highestOpenLevel(issue.unblocks);

        // Cancel lower unblocks
        for (const cancelId of action.cancelIds) {
          try {
            await env.ctx.issues.update(
              cancelId,
              { status: "cancelled" },
              companyId,
            );
            const msg = highest ? `Superseded by level ${highest}.` : "Superseded by higher level.";
            await env.ctx.issues.createComment(cancelId, msg, companyId);
            counts.cancelled += 1;
          } catch (error) {
            env.ctx.logger.info("Failed to cancel unblock", {
              companyId,
              issueId: cancelId,
              error: message(error),
            });
          }
        }
      }
    } catch (error) {
      env.ctx.logger.warn("Ladder tick failed for issue", {
        companyId,
        issueId: issue.stuck.id,
        error: message(error),
      });
    }
  }

  // Step (d): Handle storms
  const storms = await readStorms(env.ctx, companyId, now);
  for (const storm of storms) {
    // Skip if this is a marker issue (storms on Unblock are handled by the ladder)
    if (markerIds.has(storm.issueId)) continue;

    try {
      const reason = `Retry storm: ${storm.failed} failed runs.`;
      const result = await escalate(env.ctx, storm.issueId, reason, {
        companyId,
        errorCode: storm.errorCode ?? undefined,
        startLevel: 1,
        now,
      });

      if ("id" in result && result.created) {
        counts.stormed += 1;
      } else if ("skipped" in result) {
        const skipReason = result.skipped as SkipReason;
        skipReasons.set(skipReason, (skipReasons.get(skipReason) ?? 0) + 1);
      }
    } catch (error) {
      env.ctx.logger.warn("Storm escalation failed", {
        companyId,
        issueId: storm.issueId,
        error: message(error),
      });
    }
  }

  // Log tick summary
  const skipReasonsLog = Array.from(skipReasons.entries()).reduce((acc, [reason, count]) => ({ ...acc, [reason]: count }), {} as Record<string, number>);
  const noneReasonsLog = Array.from(noneReasons.entries()).reduce((acc, [reason, count]) => ({ ...acc, [reason]: count }), {} as Record<string, number>);
  env.ctx.logger.info("Ladder tick", {
    companyId,
    candidates: blockedTotal,
    ...counts,
    skipReasons: skipReasonsLog,
    noneReasons: noneReasonsLog,
  });

  return counts;
}
