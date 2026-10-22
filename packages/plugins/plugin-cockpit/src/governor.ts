/**
 * Governor: pausing agents when quota errors exceed a threshold (imperative shell).
 * Reads the pure model from governor-model.ts; handles I/O (state, repairs, agent pause calls).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { CANARY_MAX_TRIES, CANARY_RETRY_MINUTES, DEFAULT_PAUSE_ORDER, DEFAULT_TRIGGER_AGENTS, DEFAULT_TRIGGER_FAILURES, FAILURE_WINDOW_MINUTES, NEVER_PAUSE, RESUME_BATCH_SIZE, canaryDecision, governorStuck, nextResume, pauseList, resumeAtFor, shouldTrigger } from "./governor-model.js";
import { readLimitFailures } from "./measure.js";
import { recordRepair } from "./repairs.js";
import type { Env } from "./env.js";
import { message } from "./env.js";
import { escalate } from "@partnersinbiz/pib-plugin-kit";

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
  canaryRunId?: string;
  canaryTries?: number;
  nextCanaryAt?: string;
  canaryOk?: boolean;
  escalatedAt?: string;
}

export interface GovernorDeps {
  readLimitFailures: typeof readLimitFailures;
  recordRepair: typeof recordRepair;
  escalate?: typeof escalate;
}

export type GovernorOutcome = "disabled" | "idle" | "paused" | "waiting" | "canary_started" | "resumed" | "cleared" | "stuck";

export interface GovernorResult {
  companyId: string;
  outcome: GovernorOutcome;
  paused: number;
  errors: number;
}

const defaultDeps: GovernorDeps = { readLimitFailures, recordRepair, escalate };

// Helper to record a repair and log errors silently
async function repair(ctx: PluginContext, companyId: string, input: Parameters<typeof recordRepair>[2], deps: GovernorDeps, fallbackId: string): Promise<void> {
  try {
    await deps.recordRepair(ctx, companyId, input);
  } catch (e) {
    ctx.logger.warn("Failed to record repair", { action: input.action, stage: "repair", reason: message(e) });
  }
}

// Helper to persist state or delete it if empty
async function save(ctx: PluginContext, stateKey: { scopeKind: "company"; scopeId: string; namespace: string; stateKey: string }, state: GovernorState | null): Promise<void> {
  if (state === null || (state.pausedIds.length === 0 && !state.canaryRunId && !state.escalatedAt)) {
    await ctx.state.delete(stateKey);
  } else {
    await ctx.state.set(stateKey, state);
  }
}

/**
 * Escalates a stuck governor state: persists escalatedAt, creates issue, calls escalate.
 * escalatedAt is persisted first to guard against double escalation.
 */
async function escalateStuck(env: Env, companyId: string, state: GovernorState, deps: GovernorDeps, stateKey: { scopeKind: "company"; scopeId: string; namespace: string; stateKey: string }): Promise<void> {
  const escalatedAt = env.now().toISOString();
  await save(env.ctx, stateKey, { ...state, escalatedAt });

  try {
    const allAgents = await env.ctx.agents.list({ companyId, limit: 200 });
    const agentMap = new Map((allAgents as unknown as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
    const agentNames = state.pausedIds.map((id) => agentMap.get(id) || id).join(", ");
    const issue = await env.ctx.issues.create({
      companyId,
      title: "Governor: paused agents did not resume",
      description: `Paused agents: ${agentNames}\nResume at: ${state.resumeAt}\nTries: ${state.canaryTries ?? 0}\nStarted: ${state.pausedAt}`,
      status: "blocked",
    });
    const escalateFn = deps.escalate || escalate;
    await escalateFn(env.ctx, issue.id, "governor_stuck", { companyId, startLevel: "owner" });
    await repair(env.ctx, companyId, {
      kind: "governor",
      targetKind: "agent",
      targetId: state.pausedIds[0] ?? "unknown",
      action: "escalate",
      outcome: "success",
      detail: `issue ${issue.id}`,
      actor: "governor",
    }, deps, "");
  } catch (e) {
    await repair(env.ctx, companyId, {
      kind: "governor",
      targetKind: "agent",
      targetId: state.pausedIds[0] ?? "unknown",
      action: "escalate",
      outcome: "error",
      detail: message(e),
      actor: "governor",
    }, deps, "");
  }
}

// Reconcile: drop agents that are not paused (resumed by hand).
async function reconcile(env: Env, companyId: string, pausedIds: string[], deps: GovernorDeps): Promise<string[]> {
  const still: string[] = [];
  for (const id of pausedIds) {
    const agent = await env.ctx.agents.get(id, companyId).catch(() => null);
    if (agent?.status === "paused") {
      still.push(id);
    } else {
      await repair(env.ctx, companyId, { kind: "governor", targetKind: "agent", targetId: id, action: "resume", outcome: "skipped", detail: "not paused (resumed by hand)", actor: "governor" }, deps, id);
    }
  }
  return still;
}

// Start a new canary (find Summarizer and invoke).
async function startCanary(env: Env, companyId: string, state: GovernorState, deps: GovernorDeps): Promise<{ state: GovernorState; outcome: "canary_started" | "waiting" } | null> {
  const now = env.now();
  const allAgents = await env.ctx.agents.list({ companyId, limit: 200 });
  const summarizer = (allAgents as unknown as Array<{ id: string; name: string }>).find((a) => a.name.trim().toLowerCase() === "summarizer");
  if (!summarizer) {
    const nextAt = new Date(now.getTime() + CANARY_RETRY_MINUTES * 60_000).toISOString();
    const next = { ...state, canaryTries: (state.canaryTries ?? 0) + 1, nextCanaryAt: nextAt };
    await repair(env.ctx, companyId, { kind: "governor", targetKind: "agent", targetId: state.pausedIds[0] ?? "unknown", action: "canary", outcome: "error", detail: `Summarizer not found; retry at ${nextAt}`, actor: "governor" }, deps, "");
    return { state: next, outcome: "waiting" };
  }
  try {
    const result = await env.ctx.agents.invoke(summarizer.id, companyId, { prompt: "governor canary: reply OK", reason: "governor canary" });
    const runId = String((result as { runId?: unknown }).runId ?? "");
    const next = { ...state, canaryRunId: runId, canaryTries: (state.canaryTries ?? 0) + 1, nextCanaryAt: undefined };
    await repair(env.ctx, companyId, { kind: "governor", targetKind: "agent", targetId: summarizer.id, action: "canary", outcome: "success", detail: `run ${runId}`, actor: "governor" }, deps, "");
    return { state: next, outcome: "canary_started" };
  } catch (e) {
    const nextAt = new Date(now.getTime() + CANARY_RETRY_MINUTES * 60_000).toISOString();
    const next = { ...state, canaryTries: (state.canaryTries ?? 0) + 1, nextCanaryAt: nextAt };
    await repair(env.ctx, companyId, { kind: "governor", targetKind: "agent", targetId: summarizer.id, action: "canary", outcome: "error", detail: message(e), actor: "governor" }, deps, "");
    return { state: next, outcome: "waiting" };
  }
}

// Resume agents in batches.
async function resumeBatch(env: Env, companyId: string, pausedIds: string[], deps: GovernorDeps): Promise<{ anyResumed: boolean; remaining: string[] }> {
  const toResume = nextResume(pausedIds, true);
  if (toResume.length === 0) return { anyResumed: false, remaining: pausedIds };
  let anyResumed = false;
  const remaining = [...pausedIds];
  for (const id of toResume) {
    try {
      await env.ctx.agents.resume(id, companyId);
      anyResumed = true;
      const idx = remaining.indexOf(id);
      if (idx >= 0) remaining.splice(idx, 1);
      await repair(env.ctx, companyId, { kind: "governor", targetKind: "agent", targetId: id, action: "resume", outcome: "success", actor: "governor" }, deps, id);
    } catch (e) {
      await repair(env.ctx, companyId, { kind: "governor", targetKind: "agent", targetId: id, action: "resume", outcome: "error", detail: message(e), actor: "governor" }, deps, id);
    }
  }
  return { anyResumed, remaining };
}

/**
 * Resumes paused agents from state. Reconciles, checks escalation, waits on
 * canary, then resumes in batches once canary confirms recovery.
 */
async function resumeCompany(env: Env, companyId: string, state: GovernorState, deps: GovernorDeps, stateKey: { scopeKind: "company"; scopeId: string; namespace: string; stateKey: string }): Promise<GovernorOutcome> {
  const now = env.now();
  const still = await reconcile(env, companyId, state.pausedIds, deps);
  if (still.length === 0) {
    await save(env.ctx, stateKey, null);
    return "cleared";
  }
  if (still.length < state.pausedIds.length) state = { ...state, pausedIds: still };
  if (state.escalatedAt) return "stuck";
  if (now < new Date(Date.parse(state.resumeAt))) return "waiting";
  if (governorStuck(new Date(Date.parse(state.resumeAt)), now)) {
    await escalateStuck(env, companyId, state, deps, stateKey);
    return "stuck";
  }

  // Canary flow if not confirmed.
  if (!state.canaryOk) {
    if (state.canaryRunId) {
      const rows = await env.ctx.db.query<{ status: string }>("SELECT status FROM public.heartbeat_runs WHERE id = $1 AND company_id = $2", [state.canaryRunId, companyId]);
      const status = rows[0]?.status ?? null;
      const decision = canaryDecision(status, state.canaryTries ?? 0);
      if (decision === "wait") return "waiting";
      if (decision === "succeeded") {
        state = { ...state, canaryOk: true, canaryRunId: undefined };
        await save(env.ctx, stateKey, state);
      } else if (decision === "retry") {
        const nextAt = new Date(now.getTime() + CANARY_RETRY_MINUTES * 60_000).toISOString();
        state = { ...state, canaryRunId: undefined, nextCanaryAt: nextAt };
        await save(env.ctx, stateKey, state);
        await repair(env.ctx, companyId, { kind: "governor", targetKind: "agent", targetId: still[0] ?? "unknown", action: "canary", outcome: "error", detail: `${status}; retry at ${nextAt}`, actor: "governor" }, deps, "");
        return "waiting";
      } else {
        await repair(env.ctx, companyId, { kind: "governor", targetKind: "agent", targetId: still[0] ?? "unknown", action: "canary", outcome: "error", detail: `${status}; max tries reached`, actor: "governor" }, deps, "");
        await escalateStuck(env, companyId, state, deps, stateKey);
        return "stuck";
      }
    }

    if (!state.canaryOk) {
      if (state.nextCanaryAt && now < new Date(Date.parse(state.nextCanaryAt))) return "waiting";
      if ((state.canaryTries ?? 0) >= CANARY_MAX_TRIES) {
        await escalateStuck(env, companyId, state, deps, stateKey);
        return "stuck";
      }
      const result = await startCanary(env, companyId, state, deps);
      if (!result) return "waiting";
      state = result.state;
      await save(env.ctx, stateKey, state);
      return result.outcome;
    }
  }

  // Resume phase: canaryOk is true.
  const { anyResumed, remaining } = await resumeBatch(env, companyId, state.pausedIds, deps);
  if (remaining.length === 0) {
    await save(env.ctx, stateKey, null);
    return "cleared";
  }
  state = { ...state, pausedIds: remaining };
  await save(env.ctx, stateKey, state);
  return anyResumed ? "resumed" : "waiting";
}

/**
 * Governs a company by detecting limit failures and pausing agents if needed,
 * or resuming paused agents once the canary confirms recovery.
 */
export async function governCompany(env: Env, companyId: string, config: GovernorConfig | undefined, deps: GovernorDeps = defaultDeps): Promise<GovernorResult> {
  // a. Disabled config
  if (config?.enabled === false) {
    return { companyId, outcome: "disabled", paused: 0, errors: 0 };
  }

  // b. Read state; if state exists with paused agents, enter resume path.
  const stateKey = { scopeKind: "company" as const, scopeId: companyId, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };
  const raw = await env.ctx.state.get(stateKey);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const existing = raw as Record<string, unknown>;
    const pausedIds = existing.pausedIds;
    if (Array.isArray(pausedIds) && pausedIds.length > 0) {
      const outcome = await resumeCompany(env, companyId, existing as unknown as GovernorState, deps, stateKey);
      return { companyId, outcome, paused: pausedIds.length, errors: 0 };
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
        env.ctx.logger.warn("Failed to record governor pause repair", { agentId: agent.id, stage: "pause", reason: message(e) });
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
        env.ctx.logger.warn("Failed to record governor pause error repair", { agentId: agent.id, stage: "pause", reason: message(repairError) });
      }
    }
  }

  // f. Write state if any paused; otherwise return idle (next tick retries).
  if (pausedIds.length > 0) {
    const resumeAt = resumeAtFor([], now);
    const state: GovernorState = { pausedIds, pausedAt: now.toISOString(), resumeAt: resumeAt.toISOString() };
    await env.ctx.state.set(stateKey, state);
    return { companyId, outcome: "paused", paused: pausedIds.length, errors };
  }

  return { companyId, outcome: "idle", paused: 0, errors };
}
