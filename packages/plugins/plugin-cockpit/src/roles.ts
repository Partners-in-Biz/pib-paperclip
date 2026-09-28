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
  mergePluginToolsGrant,
  roleAgentUsable,
  tryLinkPendingHire,
  unlinkAgent,
  type HireAgentSummary,
  type HireStatus,
  type OnAgentLinked,
  type RolesPayload,
  type TeamRoleKey,
  type WorkRoute,
} from "@partnersinbiz/pib-plugin-kit";
import { assignableUser, ROUTINES, ROUTINE_TITLES, SKILL_SLUGS, type RoleKind } from "./constants.js";
import { getRoles, listRoles, saveRoles, type RolesRow } from "./db.js";
import { CockpitError, message, type Env } from "./env.js";
import { storedSnapshots } from "./health.js";
import { HIRE_MATCH_ROLES } from "./hire.js";


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

/**
 * An agent's current Paperclip status: null when there is no agent or the
 * lookup failed (the kit treats unknown as usable), "terminated" when it no
 * longer exists, so plugins stop routing work to it.
 */
export async function agentStatus(env: Env, companyId: string, agentId: string | null | undefined): Promise<string | null> {
  if (!agentId) return null;
  try {
    const agent = await env.ctx.agents.get(agentId, companyId);
    return agent ? String(agent.status ?? "") || null : "terminated";
  } catch {
    return null;
  }
}

/**
 * Every staffed role from the plugins' snapshots (kit `CockpitSnapshot.team`),
 * with each agent's current status. Only switched-on modules count.
 */
export async function teamFromSnapshots(env: Env, companyId: string): Promise<NonNullable<RolesPayload["team"]>> {
  const team: NonNullable<RolesPayload["team"]> = {};
  for (const { snapshot } of await storedSnapshots(env, companyId)) {
    for (const member of snapshot.team ?? []) {
      if (team[member.role]) continue;
      const status = member.agentId ? (await agentStatus(env, companyId, member.agentId)) ?? member.status ?? null : null;
      team[member.role] = { agentId: member.agentId, status };
    }
  }
  return team;
}

/**
 * The broadcast: the saved roles plus the Operator's and Reviewer's current
 * status and every staffed role (`team`), so any plugin routes work to a
 * running agent (kit `routeWork`).
 */
export async function fullRolesPayload(env: Env, row: RolesRow): Promise<RolesPayload> {
  const [operatorStatus, reviewerStatus, team] = await Promise.all([
    agentStatus(env, row.companyId, row.operatorAgentId),
    agentStatus(env, row.companyId, row.reviewerAgentId),
    teamFromSnapshots(env, row.companyId).catch((error) => {
      env.ctx.logger.info("Cockpit team read failed", { companyId: row.companyId, error: message(error) });
      return {} as NonNullable<RolesPayload["team"]>;
    }),
  ]);
  return {
    ...rolesPayload(row),
    operatorStatus,
    reviewerStatus,
    team: {
      ...team,
      ...(row.operatorAgentId ? { operator: { agentId: row.operatorAgentId, status: operatorStatus } } : {}),
      ...(row.reviewerAgentId ? { reviewer: { agentId: row.reviewerAgentId, status: reviewerStatus } } : {}),
    },
  };
}

/** The company's roles as the Cockpit broadcasts them, or null before the team is saved. */
export async function currentRoles(env: Env, companyId: string): Promise<RolesPayload | null> {
  const row = await getRoles(env.ctx, companyId);
  return row ? fullRolesPayload(env, row) : null;
}

/**
 * Who gets a piece of work, with kit `routeWork`'s rules (the first running
 * agent among `roles`, else the Operator, else the owner, else nobody),
 * computed from the Cockpit's own roles so it never waits for its broadcast.
 */
export function routeFromRoles(roles: RolesPayload | null, wanted: TeamRoleKey[]): WorkRoute {
  const agentFor = (role: TeamRoleKey): string | null => {
    if (!roles) return null;
    if (role === "operator") return roles.operatorAgentId && roleAgentUsable(roles.operatorStatus) ? roles.operatorAgentId : null;
    if (role === "reviewer") return roles.reviewerAgentId && roleAgentUsable(roles.reviewerStatus) ? roles.reviewerAgentId : null;
    const member = roles.team?.[role];
    return member?.agentId && roleAgentUsable(member.status) ? member.agentId : null;
  };
  for (const role of [...wanted, "operator" as const]) {
    const agentId = agentFor(role);
    if (agentId) return { assigneeAgentId: agentId, assigneeUserId: null, via: role };
  }
  const owner = assignableUser(roles?.ownerUserId ?? null);
  return owner ? { assigneeAgentId: null, assigneeUserId: owner, via: "owner" } : { assigneeAgentId: null, assigneeUserId: null, via: "none" };
}

/**
 * Where kit `registerRoleWatch` keeps a plugin's copy of the roles. The
 * Cockpit keeps its own copy there too, so the kit helpers it runs that route
 * work (a done-check handing an issue to the Operator) see the same team.
 */
export const KIT_ROLES_STATE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "pib-cockpit", stateKey: "roles" });

export async function keepKitRoles(env: Env, payload: RolesPayload): Promise<void> {
  try {
    await env.ctx.state.set(KIT_ROLES_STATE(payload.companyId), payload);
  } catch (error) {
    env.ctx.logger.info("Roles copy for the kit not saved", { companyId: payload.companyId, error: message(error) });
  }
}

/** Refreshes the kit's copy from the saved roles (before a done-check may hand an issue on). */
export async function refreshKitRoles(env: Env, companyId: string): Promise<void> {
  const roles = await currentRoles(env, companyId);
  if (roles) await keepKitRoles(env, roles);
}

export async function emitRoles(env: Env, row: RolesRow): Promise<boolean> {
  try {
    const payload = await fullRolesPayload(env, row);
    await keepKitRoles(env, payload);
    await env.ctx.events.emit(COCKPIT_EVENTS.rolesUpdated, row.companyId, payload as unknown as Record<string, unknown>);
    return true;
  } catch (error) {
    env.ctx.logger.info("Roles emit failed", { companyId: row.companyId, error: message(error) });
    return false;
  }
}

/** Re-send the roles now (a plugin's snapshot changed a role's agent or status). False before the team is saved. */
export async function rebroadcastRoles(env: Env, companyId: string): Promise<boolean> {
  const row = await getRoles(env.ctx, companyId);
  return row ? emitRoles(env, row) : false;
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
        await tryLinkPendingHire(env.ctx, row.companyId, HIRE_MATCH_ROLES[kind], onLinkedFor(env, kind));
      } catch (error) {
        env.ctx.logger.info("Cockpit hire link check failed", { companyId: row.companyId, kind, error: message(error) });
      }
    }
    const current = (await getRoles(env.ctx, row.companyId)) ?? row;
    if (await emitRoles(env, current)) result.emitted += 1;
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
        const linked = await linkAgent(env.ctx, companyId, HIRE_MATCH_ROLES[kind], after, { by: "manual", userId, onLinked: onLinkedFor(env, kind) });
        steps.push(`${label}: ${linked.agent.name}.`, ...linked.steps);
      } catch (error) {
        steps.push(`${label} could not be linked: ${message(error)}`);
      }
    } else if (!after && before) {
      await unlinkAgent(env.ctx, companyId, HIRE_MATCH_ROLES[kind]);
      steps.push(`${label} removed. The agent itself, its routines and its tasks were not changed.`);
    }
  }
  const saved = (await getRoles(env.ctx, companyId)) ?? next;
  await emitRoles(env, saved);
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
    if (!already) await emitRoles(env, row);
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

/**
 * Plugin tool access for the agent. The host keeps ONE `tools:use` grant per
 * agent, so the kit merges plugin tools into the existing one: saved only
 * when it changed, and a grant limited some other way is left for a person.
 */
export async function grantPluginTools(env: Env, companyId: string, agentId: string, userId: string | null): Promise<{ state: "added" | "already_present" | "conflict" | "failed"; detail: string | null }> {
  try {
    const existing = await env.ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId });
    const merged = mergePluginToolsGrant(existing.map((g) => ({ permissionKey: String(g.permissionKey), scope: (g.scope as Record<string, unknown> | null) ?? null })));
    if (merged.conflict) return { state: "conflict", detail: merged.conflict };
    if (!merged.changed) return { state: "already_present", detail: null };
    await env.ctx.authorization.grants.set({
      companyId,
      principalType: "agent",
      principalId: agentId,
      grants: merged.grants as Parameters<PluginContext["authorization"]["grants"]["set"]>[0]["grants"],
      grantedByUserId: assignableUser(userId),
    });
    return { state: "added", detail: null };
  } catch (error) {
    return { state: "failed", detail: message(error) };
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
  if (grant.state === "added") steps.push("Granted plugin tool access (`tools:use` for plugin tools).");
  else if (grant.state === "already_present") steps.push("Plugin tool access was already granted.");
  else if (grant.state === "conflict") steps.push(`Plugin tool access was not changed: ${grant.detail}`);
  else steps.push(`Tool access could not be granted automatically (${grant.detail}). Grant ${name} tools:use for plugin tools in its permissions.`);

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
      await tryLinkPendingHire(env.ctx, companyId, HIRE_MATCH_ROLES[kind], onLinkedFor(env, kind));
    } catch (error) {
      env.ctx.logger.info("Cockpit hire link check failed", { companyId, kind, error: message(error) });
    }
    try {
      const status = await hireStatus(env.ctx, companyId, HIRE_MATCH_ROLES[kind]);
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
  return linkedAgentId(env.ctx, companyId, HIRE_MATCH_ROLES.operator).catch(() => null);
}
