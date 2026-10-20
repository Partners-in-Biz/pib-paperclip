/**
 * Governor rehearse: safely tests the quota governor with a synthetic failure list.
 * Feeds synthetic failures to governCompany, simulates a canary run, resumes the paused agent,
 * and writes repair ledger rows for the entire cycle.
 */
import { canaryDecision, DEFAULT_TRIGGER_FAILURES, NEVER_PAUSE, type CanaryDecision } from "./governor-model.js";
import type { GovernorDeps } from "./governor.js";
import { GOVERNOR_NS, GOVERNOR_STATE_KEY, governCompany } from "./governor.js";
import { recordRepair } from "./repairs.js";
import type { Env } from "./env.js";
import { message } from "./env.js";
import { readLimitFailures } from "./measure.js";
import type { LimitFailures } from "./measure-model.js";

export interface RehearseInput {
  agentName: string;
  canaryStatus?: string;
}

export type RehearseRefusal = "bad_input" | "never_pause" | "agent_not_found" | "agent_already_paused" | "governor_active" | "not_paused";

export interface RehearseResult {
  companyId: string;
  outcome: "completed" | "refused";
  reason?: RehearseRefusal;
  detail?: string;
  agentId?: string;
  agentName?: string;
  canary?: CanaryDecision;
  resumed?: boolean;
}

const localDefaultDeps: GovernorDeps = { readLimitFailures, recordRepair };

/**
 * Safely rehearses the governor with synthetic failures: pauses one agent,
 * simulates a canary run, resumes, and records repairs.
 */
export async function rehearseGovernor(
  env: Env,
  companyId: string,
  input: RehearseInput,
  deps: GovernorDeps = localDefaultDeps,
): Promise<RehearseResult> {
  // a. Validate agent name
  const agentName = input.agentName?.trim();
  if (!agentName) {
    return { companyId, outcome: "refused", reason: "bad_input", detail: "agentName must be a non-empty string" };
  }

  // Check NEVER_PAUSE
  const normalizedInput = agentName.trim().toLowerCase();
  const neverSet = new Set(NEVER_PAUSE.map((n) => n.trim().toLowerCase()));
  if (neverSet.has(normalizedInput)) {
    return { companyId, outcome: "refused", reason: "never_pause", detail: `Agent ${agentName} is in the never-pause list` };
  }

  // b. Check governor state
  const stateKey = { scopeKind: "company" as const, scopeId: companyId, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };
  const raw = await env.ctx.state.get(stateKey);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const existing = raw as Record<string, unknown>;
    const pausedIds = existing.pausedIds;
    if (Array.isArray(pausedIds) && pausedIds.length > 0) {
      return { companyId, outcome: "refused", reason: "governor_active", detail: "Governor has agents paused; rehearsal cannot run while active" };
    }
  }

  // c. List agents and find target by name
  const allAgents = (await env.ctx.agents.list({ companyId, limit: 200 })) as unknown as Array<{ id: string; name: string; status?: string }>;
  const matches = allAgents.filter((a) => String(a.name ?? "").trim().toLowerCase() === normalizedInput);
  if (matches.length > 1) {
    return { companyId, outcome: "refused", reason: "bad_input", detail: `More than one agent is named ${agentName}; rehearsal needs a unique name` };
  }
  const agent = matches[0];
  if (!agent) {
    return { companyId, outcome: "refused", reason: "agent_not_found", detail: `No agent found matching name ${agentName}` };
  }

  // Check if already paused
  if (allAgents.find((a) => a.id === agent.id)?.status === "paused") {
    return { companyId, outcome: "refused", reason: "agent_already_paused", detail: `Agent ${agentName} is already paused; rehearsal must not resume a manually paused agent` };
  }

  // d. Call governCompany with synthetic failures that trigger; use rehearsalDeps wrapper
  const syntheticFailures: LimitFailures = {
    total: DEFAULT_TRIGGER_FAILURES,
    byAgent: [
      { agentId: "rehearsal-1", count: 1 },
      { agentId: "rehearsal-2", count: 1 },
      { agentId: "rehearsal-3", count: DEFAULT_TRIGGER_FAILURES - 2 },
    ],
    since: null,
  };

  const rehearsalDeps: GovernorDeps = {
    readLimitFailures: async () => syntheticFailures,
    recordRepair: async (ctx, cid, input) => {
      const detail = "[rehearsal] " + (input.detail ?? "");
      return deps.recordRepair(ctx, cid, { ...input, detail });
    },
  };

  const govResult = await governCompany(env, companyId, { enabled: true, pauseOrder: [agentName] }, rehearsalDeps);
  if (govResult.outcome !== "paused" || govResult.paused !== 1 || govResult.errors > 0) {
    return {
      companyId,
      outcome: "refused",
      reason: "not_paused",
      detail: `Governor outcome was ${govResult.outcome}, paused ${govResult.paused}, errors ${govResult.errors}; expected outcome paused with 1 agent`,
    };
  }

  // e. Canary and resume
  const canaryStatus = input.canaryStatus ?? "succeeded";
  const decision = canaryDecision(canaryStatus, 1);
  let resumed = false;

  // Record canary repair
  try {
    await deps.recordRepair(env.ctx, companyId, {
      kind: "governor",
      targetKind: "agent",
      targetId: agent.id,
      action: "canary",
      actor: "governor",
      detail: `[rehearsal] simulated Summarizer canary run ${canaryStatus}: ${decision}`,
      outcome: decision === "succeeded" ? "success" : "error",
    });
  } catch (repairError) {
    env.ctx.logger.warn("Failed to record governor canary repair", { agentId: agent.id, error: message(repairError) });
  }

  // Resume agent
  try {
    await env.ctx.agents.resume(agent.id, companyId);
    resumed = true;

    let resumeDetail = `[rehearsal] resumed ${agentName}`;
    if (decision !== "succeeded") {
      resumeDetail += "; canary did not succeed, restored anyway";
    }

    try {
      await deps.recordRepair(env.ctx, companyId, {
        kind: "governor",
        targetKind: "agent",
        targetId: agent.id,
        action: "resume",
        actor: "governor",
        detail: resumeDetail,
        outcome: "success",
      });
    } catch (repairError) {
      env.ctx.logger.warn("Failed to record governor resume repair", { agentId: agent.id, error: message(repairError) });
    }
  } catch (resumeError) {
    try {
      await deps.recordRepair(env.ctx, companyId, {
        kind: "governor",
        targetKind: "agent",
        targetId: agent.id,
        action: "resume",
        actor: "governor",
        detail: `[rehearsal] resume failed: ${message(resumeError)}`,
        outcome: "error",
      });
    } catch (repairError) {
      env.ctx.logger.warn("Failed to record governor resume error repair", { agentId: agent.id, error: message(repairError) });
    }
    return { companyId, outcome: "completed", agentId: agent.id, agentName: agent.name, canary: decision, resumed: false };
  }

  // Clear state if it still has exactly this agent's id
  try {
    const currentRaw = await env.ctx.state.get(stateKey);
    if (currentRaw && typeof currentRaw === "object" && !Array.isArray(currentRaw)) {
      const current = currentRaw as Record<string, unknown>;
      const pausedIds = current.pausedIds;
      if (Array.isArray(pausedIds) && pausedIds.length === 1 && pausedIds[0] === agent.id) {
        await env.ctx.state.delete(stateKey);
      }
    }
  } catch (deleteError) {
    env.ctx.logger.warn("Failed to clear governor state after rehearse", { error: message(deleteError) });
  }

  return { companyId, outcome: "completed", agentId: agent.id, agentName: agent.name, canary: decision, resumed };
}
