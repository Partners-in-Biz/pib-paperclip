/**
 * Escalate a stuck issue to the next manager in the chain, last of all to the
 * COO agent (PiB).
 *
 * When an issue is blocked and has no way out after 24 hours, escalate it
 * to the assignee's manager. If the manager is unavailable, go to the next
 * manager. The last level is the COO agent. No Unblock issue is ever assigned
 * to a user.
 */

import type { PluginContext, Agent } from "@paperclipai/plugin-sdk";
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
import { teamRoleHealth } from "./team.js";
import { readConfig } from "./config.js";
import { redactSecrets } from "./redact.js";

export type EscalateOptions = {
  /** Company ID for the stuck issue. */
  companyId: string;
  /** Optional error code to include in the unblock issue description. */
  errorCode?: string | null;
  /** Optional run ID to include in the unblock issue description. */
  runId?: string | null;
  /** Start escalation at this level (number or "coo"). */
  startLevel?: StartLevel;
  /** COO agent for the last level; defaults to `config.escalation.cooAgentId`, else the company's agent with role "coo". */
  cooAgentId?: string | null;
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
        | "no-target"
        | "no-owner"
        | "no-issue";
    };

/**
 * Escalate a stuck issue to the next manager or the COO agent.
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
 *   - The COO level is an agent target too (config `escalation.cooAgentId`, else the
 *     company's active agent with role "coo"). No COO agent: that level is absent.
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

  // Derive the plugin's own origin kind from manifest id
  if (!ctx.manifest?.id) {
    throw new Error("escalate: ctx.manifest.id missing");
  }
  const pluginOriginKind = `plugin:${ctx.manifest.id}` as const;

  // Check if escalation is enabled
  let escalationEnabled = true;
  let configuredCoo: string | null = null;
  try {
    const config = await readConfig<{ escalation?: { enabled?: boolean; cooAgentId?: string } }>(ctx, opts.companyId);
    if (config.escalation?.enabled === false) {
      escalationEnabled = false;
    }
    if (typeof config.escalation?.cooAgentId === "string" && config.escalation.cooAgentId.trim()) {
      configuredCoo = config.escalation.cooAgentId.trim();
    }
  } catch {
    // If we can't read config, fail open (treat as enabled)
  }

  if (!escalationEnabled) {
    return { skipped: "disabled" };
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
    if (agent.reportsTo) {
      chain.push(agent.reportsTo);
      current = agent.reportsTo;
    } else {
      break;
    }
    depth += 1;
  }

  // Compute health per agent
  const healthByAgent: Record<string, AgentHealthInput | undefined> = {};
  const agentCache = new Map<string, Agent | null>();

  for (const agentId of chain) {
    let agent = agentCache.get(agentId);
    if (agent === undefined) {
      agent = await ctx.agents.get(agentId, opts.companyId);
      agentCache.set(agentId, agent);
    }
    if (agent) {
      healthByAgent[agentId] = {
        agentStatus: agent.status ?? null,
        hireOpen: false,
      };
    }
  }

  // The last level: the COO agent (never a user)
  let cooAgentId: string | null = opts.cooAgentId ?? configuredCoo;
  if (!cooAgentId) {
    try {
      const agents = (await ctx.agents.list({ companyId: opts.companyId, limit: 200 })) as unknown as Array<Record<string, unknown>>;
      const coo = agents.find((a) => String(a.role ?? "").toLowerCase() === "coo" && teamRoleHealth({ agentStatus: (a.status as string | null) ?? null, hireOpen: false }) === "ok");
      if (coo) cooAgentId = String(coo.id);
    } catch {
      // No agents.read: no COO level; the manager levels still apply
    }
  }
  if (cooAgentId && !healthByAgent[cooAgentId]) {
    const coo = await ctx.agents.get(cooAgentId, opts.companyId);
    healthByAgent[cooAgentId] = coo ? { agentStatus: coo.status ?? null, hireOpen: false } : undefined;
  }
  if (cooAgentId && (healthByAgent[cooAgentId] === undefined || teamRoleHealth(healthByAgent[cooAgentId]!) !== "ok")) cooAgentId = null;

  // Pick levels
  const levels = pickLevels(chain, healthByAgent, opts.startLevel, cooAgentId);

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
    let comments: string[] = [];
    if (stuckIssue.assigneeAgentId && stuckIssue.assigneeAgentId.length > 0) {
      try {
        const allComments = await ctx.issues.listComments(stuckIssue.id, opts.companyId);
        // Filter to comments by the assignee agent
        const assigneeComments = allComments
          .filter((c) => c.authorAgentId === stuckIssue.assigneeAgentId)
          .map((c) => c.body);
        comments = assigneeComments;
      } catch {
        // If we can't fetch comments (missing capability), proceed with empty list
      }
    }

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

    // Every level is an agent (manager or COO); never a user
    const unblockIssue = await createWorkIssue(ctx, {
      companyId: opts.companyId,
      title: unblockInput.title,
      description: unblockInput.description,
      assigneeAgentId: level.target.agentId,
      originKind: pluginOriginKind,
      originId: unblockInput.originId,
      wake: true,
      wakeReason: "Escalation: issue is blocked",
    });

    // Record in state immediately after creating the unblock issue (before relations.get / issues.update)
    // This guards against orphaned unblock issues if issues.update fails
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

    return { id: unblockIssue.id, level: level.level, created: true };
  }

  // All levels skipped
  return { skipped: "no-target" };
}

/**
 * The stuck issue left `blocked`: cancel its open Unblock issues with a one-line
 * reason comment and close their state records, so a later block starts clean.
 * `extraIssueIds` are Unblock issues the caller found that are not in state.
 * Returns the ids cancelled. One failure does not stop the others.
 */
export async function cancelUnblocksOnResolve(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  extraIssueIds: readonly string[] = [],
): Promise<string[]> {
  const stateKey = {
    scopeKind: "company" as const,
    scopeId: companyId,
    namespace: "pib-escalations",
    stateKey: `escalations:${issueId}`,
  };
  const records =
    ((await ctx.state.get(stateKey)) as Array<{ originId: string; createdAt: string | Date; open: boolean; issueId?: string }> | null) ?? [];
  const ids = new Set<string>(extraIssueIds);
  for (const r of records) if (r.open && r.issueId) ids.add(r.issueId);

  const cancelled: string[] = [];
  for (const id of ids) {
    try {
      const u = await ctx.issues.get(id, companyId);
      if (u && u.status !== "done" && u.status !== "cancelled") {
        await ctx.issues.update(id, { status: "cancelled" }, companyId);
        await ctx.issues.createComment(id, "Cancelled: the blocked issue is no longer blocked.", companyId);
        cancelled.push(id);
      }
    } catch {
      // Leave it open for the next tick
      continue;
    }
  }
  let changed = false;
  for (const r of records) {
    if (r.open && r.issueId && (cancelled.includes(r.issueId) || !ids.has(r.issueId))) {
      r.open = false;
      changed = true;
    }
  }
  if (changed) await ctx.state.set(stateKey, records);
  return cancelled;
}
