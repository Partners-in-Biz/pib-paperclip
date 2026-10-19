/**
 * Governor: pausing agents when quota errors exceed a threshold (imperative shell).
 * Reads the pure model from governor-model.ts; handles I/O (state, repairs, agent pause calls).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_PAUSE_ORDER, DEFAULT_TRIGGER_AGENTS, DEFAULT_TRIGGER_FAILURES, FAILURE_WINDOW_MINUTES, NEVER_PAUSE, pauseList, resumeAtFor, shouldTrigger } from "./governor-model.js";
import { readLimitFailures } from "./measure.js";
import { recordRepair } from "./repairs.js";
import type { Env } from "./env.js";
import { message } from "./env.js";

export const GOVERNOR_NS = "pib-governor";
export const GOVERNOR_STATE_KEY = "state";

export interface GovernorConfig {
  enabled?: boolean;
  pauseOrder?: string[];
  triggerFailures?: number;
  triggerAgents?: number;
}

export interface GovernorState {
  pausedIds: string[];
  pausedAt: string;
  resumeAt: string;
}

export interface GovernorDeps {
  readLimitFailures: typeof readLimitFailures;
  recordRepair: typeof recordRepair;
}

export type GovernorOutcome = "disabled" | "idle" | "already_paused" | "paused";

export interface GovernorResult {
  companyId: string;
  outcome: GovernorOutcome;
  paused: number;
  errors: number;
}

const defaultDeps: GovernorDeps = { readLimitFailures, recordRepair };

/**
 * Governs a company by detecting limit failures and pausing agents if needed.
 * Idempotent: second tick sees the state and returns "already_paused".
 */
export async function governCompany(env: Env, companyId: string, config: GovernorConfig | undefined, deps: GovernorDeps = defaultDeps): Promise<GovernorResult> {
  // a. Disabled config
  if (config?.enabled === false) {
    return { companyId, outcome: "disabled", paused: 0, errors: 0 };
  }

  // b. Read state; if already paused, return early (resume is C8c).
  const stateKey = { scopeKind: "company" as const, scopeId: companyId, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };
  const raw = await env.ctx.state.get(stateKey);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const existing = raw as Record<string, unknown>;
    const pausedIds = existing.pausedIds;
    if (Array.isArray(pausedIds) && pausedIds.length > 0) {
      return { companyId, outcome: "already_paused", paused: pausedIds.length, errors: 0 };
    }
  }

  // c. Read failures in the window; check trigger.
  const now = env.now();
  const since = new Date(now.getTime() - FAILURE_WINDOW_MINUTES * 60_000).toISOString();
  const failures = await deps.readLimitFailures(env.ctx, companyId, since);
  if (!shouldTrigger(failures, { triggerFailures: config?.triggerFailures, triggerAgents: config?.triggerAgents })) {
    return { companyId, outcome: "idle", paused: 0, errors: 0 };
  }

  // d. List agents and drop already-paused ones; build pause list.
  const allAgents = await env.ctx.agents.list({ companyId, limit: 200 });
  const activeAgents = (allAgents as unknown as Array<{ id: string; name: string; status?: string }>)
    .filter((a) => a.status !== "paused")
    .map((a) => ({ id: String(a.id), name: String(a.name ?? "") }));
  const toPause = pauseList(config?.pauseOrder ?? DEFAULT_PAUSE_ORDER, activeAgents, NEVER_PAUSE);
  if (toPause.length === 0) {
    return { companyId, outcome: "idle", paused: 0, errors: 0 };
  }

  // e. Pause agents in order; record repairs.
  let errors = 0;
  const pausedIds: string[] = [];
  for (const agent of toPause) {
    try {
      await env.ctx.agents.pause(agent.id, companyId);
      pausedIds.push(agent.id);
      try {
        await deps.recordRepair(env.ctx, companyId, {
          kind: "governor",
          targetKind: "agent",
          targetId: agent.id,
          action: "pause",
          outcome: "success",
          detail: `Paused ${agent.name}: ${failures.total} limit failures across ${failures.byAgent.length} agents in 30 min`,
          actor: "governor",
        });
      } catch (e) {
        env.ctx.logger.warn("Failed to record governor pause repair", { agentId: agent.id, error: message(e) });
      }
    } catch (e) {
      errors += 1;
      try {
        await deps.recordRepair(env.ctx, companyId, {
          kind: "governor",
          targetKind: "agent",
          targetId: agent.id,
          action: "pause",
          outcome: "error",
          detail: message(e),
          actor: "governor",
        });
      } catch (repairError) {
        env.ctx.logger.warn("Failed to record governor pause error repair", { agentId: agent.id, error: message(repairError) });
      }
    }
  }

  // f. Write state if any paused; otherwise return idle (next tick retries).
  if (pausedIds.length > 0) {
    const resumeAt = resumeAtFor([], now); // C8c: refine from failing runs' error text
    const state: GovernorState = { pausedIds, pausedAt: now.toISOString(), resumeAt: resumeAt.toISOString() };
    await env.ctx.state.set(stateKey, state);
    return { companyId, outcome: "paused", paused: pausedIds.length, errors };
  }

  return { companyId, outcome: "idle", paused: 0, errors };
}
