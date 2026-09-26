/**
 * Team roles: the Operator and Reviewer agents, the owner user and the
 * "review outward-facing work" switch. Saved per company, broadcast to every
 * PiB plugin as `roles.updated` (kit RolesPayload) and re-sent hourly.
 *
 * Linking an agent (by hand, or when a hire task's agent appears) wires it:
 * plugin tool access, the managed skill, and for the Operator the two
 * routines. It never creates an agent.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  COCKPIT_EVENTS,
  configSaved,
  hireStatus,
  linkAgent,
  linkedAgentId,
  tryLinkPendingHire,
  unlinkAgent,
  type HireAgentSummary,
  type HireStatus,
  type OnAgentLinked,
  type RolesPayload,
} from "@partnersinbiz/pib-plugin-kit";
import { assignableUser, ROUTINES, ROUTINE_TITLES, SKILL_SLUGS, type RoleKind } from "./constants.js";
import { getRoles, listRoles, saveRoles, type RolesRow } from "./db.js";
import { CockpitError, message, type Env } from "./env.js";
import { HIRE_ROLES } from "./hire.js";

export const PLUGIN_TOOLS_GRANT = { permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } } as const;

type GrantInput = { permissionKey: string; scope?: Record<string, unknown> | null };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Existing grants plus one more, without duplicates (`grants.set` replaces the whole set). */
export function mergeGrants(existing: GrantInput[], add: GrantInput): { grants: GrantInput[]; added: boolean } {
  const key = (g: GrantInput) => `${g.permissionKey}|${stable(g.scope ?? null)}`;
  const seen = new Set<string>();
  const grants: GrantInput[] = [];
  for (const g of existing) {
    const k = key(g);
    if (seen.has(k)) continue;
    seen.add(k);
    grants.push({ permissionKey: g.permissionKey, scope: g.scope ?? null });
  }
  if (seen.has(key(add))) return { grants, added: false };
  grants.push({ permissionKey: add.permissionKey, scope: add.scope ?? null });
  return { grants, added: true };
}

// ---------------------------------------------------------------------------
// Payload and events
// ---------------------------------------------------------------------------

export function rolesPayload(row: RolesRow): RolesPayload {
  return {
    companyId: row.companyId,
    operatorAgentId: row.operatorAgentId,
    reviewerAgentId: row.reviewerAgentId,
    ownerUserId: row.ownerUserId,
    reviewOutward: row.reviewOutward,
    updatedAt: row.updatedAt,
  };
}

export async function emitRoles(ctx: PluginContext, row: RolesRow): Promise<boolean> {
  try {
    await ctx.events.emit(COCKPIT_EVENTS.rolesUpdated, row.companyId, rolesPayload(row) as unknown as Record<string, unknown>);
    return true;
  } catch (error) {
    ctx.logger.info("Roles emit failed", { companyId: row.companyId, error: message(error) });
    return false;
  }
}

/**
 * Events are at-most-once: re-send every company's saved roles (hourly), and
 * link hires whose agent appeared while an agent event was missed. Only
 * companies with saved Cockpit settings: the host refuses job calls otherwise.
 */
export async function reemitRoles(env: Env): Promise<{ emitted: number; skipped: number; failed: number }> {
  const result = { emitted: 0, skipped: 0, failed: 0 };
  for (const row of await listRoles(env.ctx)) {
    if (!(await configSaved(env.ctx, row.companyId))) {
      result.skipped += 1;
      continue;
    }
    for (const kind of ["operator", "reviewer"] as const) {
      try {
        await tryLinkPendingHire(env.ctx, row.companyId, HIRE_ROLES[kind], onLinkedFor(env, kind));
      } catch (error) {
        env.ctx.logger.info("Cockpit hire link check failed", { companyId: row.companyId, kind, error: message(error) });
      }
    }
    const current = (await getRoles(env.ctx, row.companyId)) ?? row;
    if (await emitRoles(env.ctx, current)) result.emitted += 1;
    else result.failed += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Saving the team
// ---------------------------------------------------------------------------

export interface TeamInput {
  operatorAgentId?: string | null;
  reviewerAgentId?: string | null;
  ownerUserId?: string | null;
  reviewOutward?: boolean;
}

function optionalId(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new CockpitError(`${field} must be a string or null`);
  return value.trim() || null;
}

export function parseTeamInput(params: Record<string, unknown>): TeamInput {
  const input: TeamInput = {};
  const operator = optionalId(params.operatorAgentId, "operatorAgentId");
  const reviewer = optionalId(params.reviewerAgentId, "reviewerAgentId");
  const owner = optionalId(params.ownerUserId, "ownerUserId");
  if (operator !== undefined) input.operatorAgentId = operator;
  if (reviewer !== undefined) input.reviewerAgentId = reviewer;
  if (owner !== undefined) input.ownerUserId = owner;
  if (params.reviewOutward !== undefined) {
    if (typeof params.reviewOutward !== "boolean") throw new CockpitError("reviewOutward must be true or false");
    input.reviewOutward = params.reviewOutward;
  }
  if (input.operatorAgentId && input.operatorAgentId === input.reviewerAgentId) {
    throw new CockpitError("The Operator and the Reviewer must be different agents");
  }
  return input;
}

export interface SaveTeamResult {
  roles: RolesPayload;
  steps: string[];
  firstSave: boolean;
}

/**
 * Save the team. Changed agents are linked (and wired) or unlinked; the owner
 * defaults to the person saving. Emits `roles.updated`.
 */
export async function saveTeam(env: Env, companyId: string, input: TeamInput, userId: string | null): Promise<SaveTeamResult> {
  const now = env.now().toISOString();
  const previous = await getRoles(env.ctx, companyId);
  const owner = input.ownerUserId !== undefined ? input.ownerUserId : previous?.ownerUserId ?? assignableUser(userId);
  const next: RolesRow = {
    companyId,
    operatorAgentId: input.operatorAgentId !== undefined ? input.operatorAgentId : previous?.operatorAgentId ?? null,
    reviewerAgentId: input.reviewerAgentId !== undefined ? input.reviewerAgentId : previous?.reviewerAgentId ?? null,
    ownerUserId: assignableUser(owner),
    reviewOutward: input.reviewOutward ?? previous?.reviewOutward ?? false,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    updatedBy: userId,
  };
  if (next.operatorAgentId && next.operatorAgentId === next.reviewerAgentId) {
    throw new CockpitError("The Operator and the Reviewer must be different agents");
  }
  for (const kind of ["operator", "reviewer"] as const) {
    const id = kind === "operator" ? next.operatorAgentId : next.reviewerAgentId;
    if (!id) continue;
    const agent = await env.ctx.agents.get(id, companyId).catch(() => null);
    if (!agent || ["terminated", "archived", "deleted"].includes(String(agent.status))) {
      throw new CockpitError(`The ${kind === "operator" ? "Operator" : "Reviewer"} agent was not found in this company, or it has been terminated.`);
    }
  }
  await saveRoles(env.ctx, next);

  const steps: string[] = [];
  for (const kind of ["operator", "reviewer"] as const) {
    const before = kind === "operator" ? previous?.operatorAgentId ?? null : previous?.reviewerAgentId ?? null;
    const after = kind === "operator" ? next.operatorAgentId : next.reviewerAgentId;
    const label = kind === "operator" ? "Operator" : "Reviewer";
    if (after && after !== before) {
      try {
        const linked = await linkAgent(env.ctx, companyId, HIRE_ROLES[kind], after, { by: "manual", userId, onLinked: onLinkedFor(env, kind) });
        steps.push(`${label}: ${linked.agent.name}.`, ...linked.steps);
      } catch (error) {
        steps.push(`${label} could not be linked: ${message(error)}`);
      }
    } else if (!after && before) {
      await unlinkAgent(env.ctx, companyId, HIRE_ROLES[kind]);
      steps.push(`${label} removed. The agent itself, its routines and its tasks were not changed.`);
    }
  }
  const saved = (await getRoles(env.ctx, companyId)) ?? next;
  await emitRoles(env.ctx, saved);
  return { roles: rolesPayload(saved), steps, firstSave: !previous };
}

/** Set one role's agent (used when a hire links automatically). */
async function setRoleAgent(env: Env, companyId: string, kind: RoleKind, agentId: string): Promise<RolesRow> {
  const now = env.now().toISOString();
  const previous = await getRoles(env.ctx, companyId);
  const next: RolesRow = {
    companyId,
    operatorAgentId: kind === "operator" ? agentId : previous?.operatorAgentId ?? null,
    reviewerAgentId: kind === "reviewer" ? agentId : previous?.reviewerAgentId ?? null,
    ownerUserId: previous?.ownerUserId ?? null,
    reviewOutward: previous?.reviewOutward ?? false,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    updatedBy: previous?.updatedBy ?? null,
  };
  if (kind === "operator" && next.reviewerAgentId === agentId) next.reviewerAgentId = null;
  if (kind === "reviewer" && next.operatorAgentId === agentId) next.operatorAgentId = null;
  await saveRoles(env.ctx, next);
  return next;
}

/** Called by the hire helpers when an agent is linked (automatically or by hand). */
export function onLinkedFor(env: Env, kind: RoleKind): OnAgentLinked {
  return async (companyId, agentId, by) => {
    const current = await getRoles(env.ctx, companyId);
    const already = kind === "operator" ? current?.operatorAgentId === agentId : current?.reviewerAgentId === agentId;
    const row = already && current ? current : await setRoleAgent(env, companyId, kind, agentId);
    const steps = await wireRole(env, companyId, kind, agentId, by.userId);
    if (!already) await emitRoles(env.ctx, row);
    return steps;
  };
}

// ---------------------------------------------------------------------------
// Wiring a linked agent
// ---------------------------------------------------------------------------

type RoutineResolution = Awaited<ReturnType<PluginContext["routines"]["managed"]["reconcile"]>>;

/**
 * Reconcile a managed routine for the agent. The host ignores the assignee on
 * reconcile when the routine exists, so a routine that belongs to another
 * agent is reset to this one and its previous status restored.
 */
async function assignRoutine(env: Env, companyId: string, key: string, agentId: string) {
  const managed = env.ctx.routines.managed;
  const overrides = { assigneeAgentId: agentId };
  let resolved: RoutineResolution = await managed.reconcile(key, companyId, overrides);
  let reassigned = false;
  if (resolved.routine && resolved.routine.assigneeAgentId !== agentId) {
    const previous = String(resolved.routine.status);
    resolved = await managed.reset(key, companyId, overrides);
    reassigned = true;
    if (resolved.routine && String(resolved.routine.status) !== previous) {
      try {
        const restored = await managed.update(key, companyId, { status: previous });
        resolved = { ...resolved, routine: restored };
      } catch (error) {
        env.ctx.logger.info("Cockpit routine status restore failed", { key, companyId, error: message(error) });
      }
    }
  }
  return { resolved, reassigned };
}

async function grantPluginTools(env: Env, companyId: string, agentId: string, userId: string | null): Promise<"added" | "already_present" | string> {
  try {
    const existing = await env.ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId });
    const merged = mergeGrants(
      existing.map((g) => ({ permissionKey: String(g.permissionKey), scope: (g.scope as Record<string, unknown> | null) ?? null })),
      PLUGIN_TOOLS_GRANT,
    );
    if (!merged.added) return "already_present";
    await env.ctx.authorization.grants.set({
      companyId,
      principalType: "agent",
      principalId: agentId,
      grants: merged.grants as Parameters<PluginContext["authorization"]["grants"]["set"]>[0]["grants"],
      grantedByUserId: assignableUser(userId),
    });
    return "added";
  } catch (error) {
    return message(error);
  }
}

/** Tool access, skill sync and (Operator) routines. Returns one line per step. Safe to run again. */
export async function wireRole(env: Env, companyId: string, kind: RoleKind, agentId: string, userId: string | null): Promise<string[]> {
  const steps: string[] = [];
  const agent = await env.ctx.agents.get(agentId, companyId).catch(() => null);
  const name = agent ? String(agent.name) : "the agent";
  const slug = SKILL_SLUGS[kind];

  const skills = await env.skills.force(companyId).catch((error) => [{ skillKey: slug, action: "failed" as const, error: message(error) }]);
  const failed = skills.filter((s) => s.action === "failed");
  steps.push(failed.length === 0 ? `Synced the \`${slug}\` skill.` : `The skills did not sync (${failed.map((s) => s.error ?? "failed").join("; ")}). Save the team again to retry.`);

  const grant = await grantPluginTools(env, companyId, agentId, userId);
  if (grant === "added") steps.push("Granted plugin tool access (`tools:use` for plugin tools).");
  else if (grant === "already_present") steps.push("Plugin tool access was already granted.");
  else steps.push(`Tool access could not be granted automatically (${grant}). Grant ${name} tools:use for plugin tools in its permissions.`);

  if (kind === "operator") {
    for (const key of [ROUTINES.daily, ROUTINES.weekly]) {
      try {
        const { resolved, reassigned } = await assignRoutine(env, companyId, key, agentId);
        steps.push(resolved.routineId
          ? `Assigned the "${ROUTINE_TITLES[key]}" routine to ${name}${reassigned ? " (moved over from the previous Operator)" : ""}.`
          : `The "${ROUTINE_TITLES[key]}" routine could not be set up (${resolved.status}).`);
      } catch (error) {
        steps.push(`The "${ROUTINE_TITLES[key]}" routine could not be set up (${message(error)}).`);
      }
    }
  }
  const status = agent ? String(agent.status) : "";
  if (status === "pending_approval") steps.push(`Approve the ${name} hire in Approvals.`);
  if (status === "paused" || status === "pending_approval") steps.push(`Open Agents → ${name}, check its adapter has a working model key, then click Resume.`);
  return steps;
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

export interface RoleView {
  agent: HireAgentSummary | null;
  hire: HireStatus["hire"];
  candidates: HireAgentSummary[];
  linkedBy: HireStatus["linkedBy"];
}

export async function roleViews(env: Env, companyId: string): Promise<Record<RoleKind, RoleView>> {
  const out = {} as Record<RoleKind, RoleView>;
  for (const kind of ["operator", "reviewer"] as const) {
    try {
      await tryLinkPendingHire(env.ctx, companyId, HIRE_ROLES[kind], onLinkedFor(env, kind));
    } catch (error) {
      env.ctx.logger.info("Cockpit hire link check failed", { companyId, kind, error: message(error) });
    }
    try {
      const status = await hireStatus(env.ctx, companyId, HIRE_ROLES[kind]);
      out[kind] = { agent: status.agent, hire: status.hire, candidates: status.candidates, linkedBy: status.linkedBy };
    } catch {
      out[kind] = { agent: null, hire: null, candidates: [], linkedBy: null };
    }
  }
  return out;
}

/** The linked Operator agent id, when it is usable. */
export async function operatorAgentId(env: Env, companyId: string): Promise<string | null> {
  const roles = await getRoles(env.ctx, companyId);
  if (roles?.operatorAgentId) {
    const agent = await env.ctx.agents.get(roles.operatorAgentId, companyId).catch(() => null);
    if (agent && !["terminated", "archived", "deleted"].includes(String(agent.status))) return agent.id;
  }
  return linkedAgentId(env.ctx, companyId, HIRE_ROLES.operator).catch(() => null);
}
