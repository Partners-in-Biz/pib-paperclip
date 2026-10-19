/**
 * Escalate a stuck issue to the next manager in the chain or to the owner.
 *
 * When an issue is blocked and has no way out after 24 hours, escalate it
 * to the assignee's manager. If the manager is unavailable, go to the next
 * manager. If there is no manager chain, escalate to the company owner.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  ESCALATION_DAILY_CAP,
  buildUnblockIssue,
  escalationDecide,
  escalationOriginId,
  pickLevels,
  type AgentHealthInput,
  type StartLevel,
} from "./escalate-model.js";
import { createWorkIssue } from "./issues.js";
import { ownerUserFor } from "./cockpit.js";
import { redactSecrets } from "./redact.js";

export type EscalateOptions = {
  /** Company ID for the stuck issue. */
  companyId: string;
  /** Optional error code to include in the unblock issue description. */
  errorCode?: string | null;
  /** Optional run ID to include in the unblock issue description. */
  runId?: string | null;
  /** Start escalation at this level (number or "owner"). */
  startLevel?: StartLevel;
  /** Current time for testing; defaults to now. */
  now?: Date;
};

export type EscalateResult =
  | { id: string; level: number; created: boolean }
  | {
      skipped:
        | "disabled"
        | "dedupe"
        | "cooldown"
        | "cap"
        | "below-start"
        | "no-target"
        | "no-owner"
        | "no-issue";
    };

/**
 * Escalate a stuck issue to the next manager or owner.
 *
 * Returns a result with either `id` (the unblock issue created or found) and `level`,
 * or `skipped` with a reason.
 *
 * Behavior:
 * - If escalation is disabled in config, returns `{skipped: "disabled"}` without writing.
 * - Reads the stuck issue; if not found, returns `{skipped: "no-issue"}`.
 * - Walks the assignee's `reportsTo` chain (nearest first) with a cycle guard and depth cap 10.
 * - Computes health per agent (paused/terminated agents are skipped).
 * - Calls `pickLevels` to get the chain and `escalationDecide` to check dedup/cooldown/cap.
 * - On "create": builds the unblock issue and creates it.
 *   - For agent targets: assigned to the agent, woke by default.
 *   - For owner targets: assigned to the owner user, no wakeup.
 *   - If `ownerUserFor` returns no user, returns `{skipped: "no-owner"}`.
 * - Updates the stuck issue to mark it blocked and add the new unblock as a blocker.
 * - Records state in `ctx.state` namespace `pib-escalations`.
 * - On "skip": returns the skip reason; if a dedupe, includes the existing unblock id.
 */
export async function escalate(
  ctx: PluginContext,
  issueId: string,
  reason: string,
  opts: EscalateOptions,
): Promise<EscalateResult> {
  const now = opts.now ?? new Date();

  // Check if escalation is enabled
  const configKey = { scopeKind: "company" as const, scopeId: opts.companyId, namespace: "default", stateKey: "config" };
  try {
    const config = await ctx.state.get(configKey);
    const escalationEnabled = config && typeof config === "object" ? (config as any).escalation?.enabled : true;
    if (escalationEnabled === false) {
      return { skipped: "disabled" };
    }
  } catch {
    // If we can't read config, assume enabled (safe default)
  }

  // Read the stuck issue
  const stuckIssue = await ctx.issues.get(issueId, opts.companyId);
  if (!stuckIssue) {
    return { skipped: "no-issue" };
  }

  // Build the reportsTo chain (nearest first, head last)
  const chain: string[] = [];
  const visited = new Set<string>();
  let current = stuckIssue.assigneeAgentId;
  const maxDepth = 10;
  let depth = 0;

  while (current && depth < maxDepth) {
    if (visited.has(current)) break; // Cycle guard
    visited.add(current);
    const agent = await ctx.agents.get(current, opts.companyId);
    if (!agent) break;
    if ((agent as any).reportsTo) {
      chain.push((agent as any).reportsTo);
      current = (agent as any).reportsTo;
    } else {
      break;
    }
    depth += 1;
  }

  // Compute health per agent
  const healthByAgent: Record<string, AgentHealthInput | undefined> = {};
  for (const agentId of chain) {
    const agent = await ctx.agents.get(agentId, opts.companyId);
    if (agent) {
      healthByAgent[agentId] = {
        agentStatus: (agent as any).status ?? null,
        hireOpen: false,
      };
    }
  }

  // Pick levels
  const levels = pickLevels(chain, healthByAgent, opts.startLevel);

  // Read existing escalations for this issue
  const stateKey = {
    scopeKind: "company" as const,
    scopeId: opts.companyId,
    namespace: "pib-escalations",
    stateKey: `escalations:${issueId}`,
  };

  let existing = (await ctx.state.get(stateKey)) as
    | Array<{ originId: string; createdAt: string | Date; open: boolean; issueId?: string }>
    | null;
  existing = existing ?? [];

  // Get today's count
  const today = now.toISOString().split("T")[0];
  const countKey = {
    scopeKind: "company" as const,
    scopeId: opts.companyId,
    namespace: "pib-escalations",
    stateKey: `count:${today}`,
  };
  const todayCount = ((await ctx.state.get(countKey)) as number | null) ?? 0;

  // Try to escalate at each level
  for (const level of levels) {
    const decision = escalationDecide({
      issueId,
      existing,
      now,
      todayCount,
      level,
      startLevel: opts.startLevel,
    });

    if (decision.action === "skip") {
      if (decision.reason === "dedupe") {
        // Return the existing unblock id
        const existingEscalation = existing.find((e) => e.originId === decision.originId && e.open);
        if (existingEscalation && existingEscalation.issueId) {
          return { id: existingEscalation.issueId, level: level.level, created: false };
        }
      }
      if (decision.reason === "cap") {
        // Hard stop - can't escalate more today
        return { skipped: "cap" };
      }
      continue;
    }

    // Create the unblock issue
    const comments =
      stuckIssue.assigneeAgentId && stuckIssue.assigneeAgentId.length > 0
        ? [
            // Would fetch comments from the issue in a real implementation
          ]
        : [];

    const unblockInput = buildUnblockIssue({
      issue: { id: stuckIssue.id, identifier: stuckIssue.identifier ?? "", title: stuckIssue.title },
      level,
      reason,
      errorCode: opts.errorCode,
      lastFailedRunId: opts.runId,
      assigneeComments: comments,
      redact: redactSecrets,
      now,
    });

    let unblockIssue;
    if (level.target.kind === "agent") {
      // Assign to the agent
      unblockIssue = await createWorkIssue(ctx, {
        companyId: opts.companyId,
        title: unblockInput.title,
        description: unblockInput.description,
        assigneeAgentId: level.target.agentId,
        originKind: "plugin:pib-escalation",
        originId: unblockInput.originId,
        wake: true,
        wakeReason: "Escalation: issue is blocked",
      });
    } else {
      // Assign to the owner
      const owner = await ownerUserFor(ctx, opts.companyId);
      if (!owner.userId) {
        return { skipped: "no-owner" };
      }
      unblockIssue = await createWorkIssue(ctx, {
        companyId: opts.companyId,
        title: unblockInput.title,
        description: unblockInput.description,
        assigneeUserId: owner.userId,
        originKind: "plugin:pib-escalation",
        originId: unblockInput.originId,
        wake: false,
        wakeReason: undefined,
      });
    }

    // Update the stuck issue to mark it blocked
    const relations = await ctx.issues.relations.get(stuckIssue.id, opts.companyId);
    const blockedByIds = new Set(relations.blockedBy?.map((b) => b.id) ?? []);
    blockedByIds.add(unblockIssue.id);

    await ctx.issues.update(
      stuckIssue.id,
      {
        status: "blocked",
        blockedByIssueIds: Array.from(blockedByIds),
      },
      opts.companyId,
    );

    // Record in state
    const escalationRecord = {
      originId: unblockInput.originId,
      createdAt: now.toISOString(),
      open: true,
      issueId: unblockIssue.id,
      level: level.level,
      target: unblockInput.target,
    };

    existing.push(escalationRecord);
    await ctx.state.set(stateKey, existing);

    // Increment today's count
    await ctx.state.set(countKey, todayCount + 1);

    return { id: unblockIssue.id, level: level.level, created: true };
  }

  // All levels skipped
  return { skipped: "no-target" };
}
