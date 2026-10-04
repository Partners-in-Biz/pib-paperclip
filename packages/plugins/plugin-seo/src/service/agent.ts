/**
 * The SEO Specialist agent, the SEO project, and the routines.
 *
 * The agent is hired through a normal Paperclip task (service/hire.ts) and
 * linked in plugin state; agents activated the old way (host-managed) are
 * still found through `legacyAgentLookup`. `wireAgent` sets a linked agent up
 * and never creates one.
 *
 * `permissions.pluginTools` is not enforced by the host and the tool gateway
 * denies by default, so wiring also gives the agent plugin tool access with
 * the kit's `mergePluginToolsGrant`: the host keeps ONE `tools:use` grant per
 * agent and `grants.set` replaces the whole set, so the existing tools grant
 * is widened (never a second one added) and every other grant is kept.
 */
import {
  COMPANY_OS_HIRE_SKILL,
  hireStatus,
  linkedAgentId,
  mergePluginToolsGrant,
  PLUGIN_TOOLS_GRANT as KIT_PLUGIN_TOOLS_GRANT,
  type GrantLike,
  type MergedGrants,
  tryLinkPendingHire,
  wakeIssue,
  type HireAgentSummary,
  type HireStatus,
  type LegacyAgentLookup,
  type OnAgentLinked,
} from "@partnersinbiz/pib-plugin-kit";
import { AGENT_KEY, PROJECT_KEY, ROUTINE_KEYS, ROUTINE_TITLES, SKILL_KEY, SKILL_SLUG } from "../constants.js";
import * as db from "../db.js";
import { isRehearsalSprint } from "../engine/rehearsal.js";
import type { AgentAvailability } from "../engine/sprint.js";
import { assignableUser, errorMessage, SeoError, type Actor, type Env } from "./common.js";
import { SEO_MATCH_ROLE, SEO_ROLE } from "./hire.js";
import { getIssue, patchIssue } from "./issues.js";
import { activateShippedRoutines } from "./routines.js";

export const PLUGIN_TOOLS_GRANT = KIT_PLUGIN_TOOLS_GRANT;

/** The agent's grants with plugin tool access merged in (kit `mergePluginToolsGrant`: one `tools:use` grant, widened, never duplicated). */
export function mergeGrants(existing: GrantLike[]): MergedGrants {
  return mergePluginToolsGrant(existing);
}

/** The SEO Specialist the host created before hiring moved to tasks. */
export function legacyAgentLookup(env: Env): LegacyAgentLookup {
  return async (companyId) => {
    const resolved = await env.ctx.agents.managed.get(AGENT_KEY, companyId);
    return resolved.agentId && resolved.agent ? resolved.agentId : null;
  };
}

/** Resolve (never create) the linked agent, or the legacy managed one. Jobs call this with an explicit company. */
export async function resolveAgent(env: Env, companyId: string): Promise<AgentAvailability> {
  try {
    const id = await linkedAgentId(env.ctx, companyId, SEO_ROLE, legacyAgentLookup(env));
    if (!id) return null;
    const agent = await env.ctx.agents.get(id, companyId);
    if (!agent) return null;
    return { id, status: String(agent.status), name: agent.name ?? null };
  } catch (error) {
    env.ctx.logger.info("SEO agent lookup failed", { companyId, error: errorMessage(error) });
    return null;
  }
}

export async function ensureProject(env: Env, companyId: string): Promise<string | null> {
  try {
    const resolved = await env.ctx.projects.managed.reconcile(PROJECT_KEY, companyId);
    return resolved.projectId ?? null;
  } catch (error) {
    env.ctx.logger.info("SEO project reconcile failed", { companyId, error: errorMessage(error) });
    return null;
  }
}

export interface WireResult {
  agent: { id: string; name: string; status: string };
  project: { id: string | null; status: string };
  routines: Array<{ key: string; id: string | null; status: string; routineStatus: string | null; reassigned: boolean; lostStatus: string | null }>;
  grant: "added" | "already_present" | "conflict" | "failed";
  grantError?: string;
  adoptedIssues: number;
  skills: Array<{ skillKey: string; action: string; error?: string }>;
  /** False when the agent's skills do not list pib-seo-sprint (the plugin cannot attach it). */
  skillAttached: boolean;
  /** Next steps for a person. */
  instructions: string[];
  /** What was done, one line each (posted on the hire task). */
  steps: string[];
}

function words(value: string): string {
  return value.replace(/_/g, " ");
}

function desiredSkills(agent: unknown): string[] {
  const config = (agent as { adapterConfig?: unknown } | null)?.adapterConfig;
  if (!config || typeof config !== "object") return [];
  const sync = (config as Record<string, unknown>).paperclipSkillSync;
  if (!sync || typeof sync !== "object") return [];
  const list = (sync as Record<string, unknown>).desiredSkills;
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string") : [];
}

/** True when the agent carries the company operating manual (`pib-company-os`). */
export function hasCompanyOs(agent: unknown): boolean {
  const key = COMPANY_OS_HIRE_SKILL.key.toLowerCase();
  const slug = COMPANY_OS_HIRE_SKILL.slug.toLowerCase();
  return desiredSkills(agent)
    .map((s) => s.toLowerCase())
    .some((k) => k === key || k === slug || k.endsWith(`/${slug}`) || k.endsWith("/company-os"));
}

function hasSeoSkill(agent: unknown): boolean {
  const keys = SEO_MATCH_ROLE.skills.map((s) => s.key.toLowerCase());
  return desiredSkills(agent)
    .map((s) => s.toLowerCase())
    .some((k) => keys.includes(k) || k === SKILL_SLUG || k.endsWith(`/${SKILL_SLUG}`) || k.endsWith(`/${SKILL_KEY}`));
}

type RoutineResolution = Awaited<ReturnType<Env["ctx"]["routines"]["managed"]["reconcile"]>>;

/**
 * Reconcile a managed routine for the agent. The host ignores
 * `assigneeAgentId` on reconcile when the routine already exists, so a
 * routine that belongs to another agent is reset to this one (reset puts it
 * back to the declared paused status) and its previous status restored. When
 * the host refuses the restore, `lostStatus` holds the status a person has to
 * set again. The reconcile also rewrites the routine's stored issue template
 * from the manifest, so a re-sync repairs a routine created by 0.21.0 or older
 * (service/routines.ts healRoutineTemplates does the same hourly).
 */
async function assignRoutine(env: Env, companyId: string, key: string, agentId: string, projectId: string | null) {
  const managed = env.ctx.routines.managed;
  const overrides = { assigneeAgentId: agentId, ...(projectId ? { projectId } : {}) };
  let resolved: RoutineResolution = await managed.reconcile(key, companyId, overrides);
  let reassigned = false;
  let lostStatus: string | null = null;
  if (resolved.routine && resolved.routine.assigneeAgentId !== agentId) {
    const previous = String(resolved.routine.status);
    resolved = await managed.reset(key, companyId, overrides);
    reassigned = true;
    if (resolved.routine && String(resolved.routine.status) !== previous) {
      try {
        const restored = await managed.update(key, companyId, { status: previous });
        resolved = { ...resolved, routine: restored };
      } catch (error) {
        lostStatus = previous;
        env.ctx.logger.info("SEO routine status restore failed", { key, companyId, error: errorMessage(error) });
      }
    }
  }
  return { resolved, reassigned, lostStatus };
}

/**
 * Set up an agent that is already linked: skill sync, SEO project, routines,
 * plugin tool access, sprints and waiting tasks. Safe to run again (Re-sync).
 * `userId` is null for automatic links.
 */
export async function wireAgent(env: Env, companyId: string, agentId: string, userId: string | null): Promise<WireResult> {
  const agent = await env.ctx.agents.get(agentId, companyId);
  if (!agent) throw new SeoError("That agent was not found in this company.");
  const name = String(agent.name ?? "the agent");
  const status = String(agent.status ?? "");
  const steps: string[] = [];
  const instructions: string[] = [];

  const skills = await env.skills.force(companyId);
  const skillFailed = skills.filter((s) => s.action === "failed");
  steps.push(
    skillFailed.length === 0
      ? `Synced the \`${SKILL_SLUG}\` skill to its latest version.`
      : `The \`${SKILL_SLUG}\` skill did not sync (${skillFailed.map((s) => s.error ?? "failed").join("; ")}). Re-sync the SEO agent in Setup → Team to try again.`,
  );
  const skillAttached = hasSeoSkill(agent);
  if (!skillAttached) {
    const ask = `Attach the \`${SKILL_SLUG}\` skill to ${name} (Agents → ${name} → Skills). The plugin keeps the skill up to date but cannot attach it.`;
    steps.push(ask);
    instructions.push(ask);
  }
  if (!hasCompanyOs(agent)) {
    const ask = `Attach the company operating manual \`${COMPANY_OS_HIRE_SKILL.slug}\` to ${name} (Agents → ${name} → Skills); opening the SEO page attaches it for you.`;
    steps.push(ask);
    instructions.push(ask);
  }

  let project: WireResult["project"];
  try {
    const res = await env.ctx.projects.managed.reconcile(PROJECT_KEY, companyId);
    project = { id: res.projectId ?? null, status: res.status };
  } catch (error) {
    project = { id: null, status: `failed: ${errorMessage(error)}` };
  }
  steps.push(project.id ? "The SEO project is ready." : `The SEO project could not be set up (${project.status}).`);

  const routines: WireResult["routines"] = [];
  for (const key of ROUTINE_KEYS) {
    try {
      const { resolved, reassigned, lostStatus } = await assignRoutine(env, companyId, key, agentId, project.id);
      routines.push({ key, id: resolved.routineId, status: resolved.status, routineStatus: resolved.routine ? String(resolved.routine.status) : null, reassigned, lostStatus });
    } catch (error) {
      routines.push({ key, id: null, status: `failed: ${errorMessage(error)}`, routineStatus: null, reassigned: false, lostStatus: null });
    }
  }
  const readyRoutines = routines.filter((r) => r.id);
  if (readyRoutines.length > 0) {
    const titles = readyRoutines.map((r) => `"${ROUTINE_TITLES[r.key as keyof typeof ROUTINE_TITLES] ?? r.key}"`).join(" and ");
    const moved = readyRoutines.some((r) => r.reassigned) ? " (moved over from the previous agent)" : "";
    steps.push(`Assigned the ${titles} routine${readyRoutines.length > 1 ? "s" : ""} to ${name}${moved}.`);
  }
  for (const r of routines.filter((r) => !r.id)) {
    steps.push(`The "${ROUTINE_TITLES[r.key as keyof typeof ROUTINE_TITLES] ?? r.key}" routine could not be set up (${r.status}).`);
  }
  // Routines created paused by an older version go active (a person's pause is kept).
  const activated = await activateShippedRoutines(env, companyId);
  for (const r of routines) if (activated.includes(r.key as (typeof activated)[number])) r.routineStatus = "active";
  if (activated.length) steps.push(`Switched on ${activated.map((key) => `"${ROUTINE_TITLES[key]}"`).join(" and ")}.`);
  for (const r of readyRoutines.filter((r) => r.lostStatus)) {
    const title = ROUTINE_TITLES[r.key as keyof typeof ROUTINE_TITLES] ?? r.key;
    const ask = `Moving "${title}" to ${name} set it to ${words(r.routineStatus ?? "paused")} (it was ${words(r.lostStatus!)}). Open Routines → "${title}" and set it ${words(r.lostStatus!)} again.`;
    steps.push(ask);
    instructions.push(ask);
  }
  if (readyRoutines.some((r) => r.routineStatus !== "active" && !r.lostStatus)) {
    instructions.push("An SEO routine is paused. Switch it on from the SEO page (one click), or under Routines.");
  }
  if (readyRoutines.length) {
    steps.push("The routines run daily at 06:30 and Mondays at 07:00. Routines from an older version may still have their schedule off: the SEO page shows it and switches it on in one click.");
  }

  let grant: WireResult["grant"] = "failed";
  let grantError: string | undefined;
  try {
    const existing = await env.ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId });
    const merged = mergeGrants(existing.map((g) => ({ permissionKey: String(g.permissionKey), scope: (g.scope as Record<string, unknown> | null) ?? null })));
    if (merged.changed) {
      await env.ctx.authorization.grants.set({
        companyId,
        principalType: "agent",
        principalId: agentId,
        grants: merged.grants as Parameters<Env["ctx"]["authorization"]["grants"]["set"]>[0]["grants"],
        grantedByUserId: assignableUser(userId),
      });
    }
    if (merged.conflict) {
      grant = "conflict";
      grantError = merged.conflict;
    } else {
      grant = merged.changed ? "added" : "already_present";
    }
  } catch (error) {
    grantError = errorMessage(error);
  }
  if (grant === "added") steps.push("Granted plugin tool access (`tools:use` for plugin tools).");
  else if (grant === "already_present") steps.push("Plugin tool access was already granted.");
  else if (grant === "conflict") {
    const ask = `${name} cannot use the SEO tools yet. ${grantError}`;
    steps.push(ask);
    instructions.push(ask);
  } else {
    const ask = `Tool access could not be granted automatically (${grantError ?? "unknown error"}). Grant the agent tools:use for plugin tools in its permissions.`;
    steps.push(ask);
    instructions.push(ask);
  }

  await db.setAgentForCompany(env.ctx.db, companyId, agentId);
  const adopted = await adoptUnassignedAgentTasks(env, companyId, { id: agentId, status });
  steps.push(
    adopted > 0
      ? `Pointed every SEO sprint at ${name} and handed it ${adopted} waiting SEO task${adopted === 1 ? "" : "s"}.`
      : `Pointed every SEO sprint at ${name} (no SEO tasks were waiting for an agent).`,
  );

  if (status === "pending_approval") {
    instructions.unshift(`Approve the ${name} hire in Approvals (this company requires board approval for new agents).`);
  }
  if (status === "paused" || status === "pending_approval") {
    instructions.push(`Open Agents → ${name}, check its adapter has a working model key, then click Resume.`);
  }

  return {
    agent: { id: agentId, name, status },
    project,
    routines,
    grant,
    ...(grantError ? { grantError } : {}),
    adoptedIssues: adopted,
    skills: skills.map((s) => ({ skillKey: s.skillKey, action: s.action, ...(s.error ? { error: s.error } : {}) })),
    skillAttached,
    instructions,
    steps,
  };
}

/** "Re-sync": wire the linked (or legacy managed) agent again. Never creates an agent. */
export async function resyncAgent(env: Env, companyId: string, actor: Actor): Promise<WireResult> {
  if (actor.kind !== "user") throw new SeoError("Only a board user can re-sync the SEO agent");
  const agentId = await linkedAgentId(env.ctx, companyId, SEO_ROLE, legacyAgentLookup(env));
  if (!agentId) {
    throw new SeoError("No SEO agent is linked yet. Hire one or pick an agent you already have in Setup → Team.");
  }
  return wireAgent(env, companyId, agentId, actor.userId);
}

/** Called by the hire helpers when an agent is linked (automatically or by hand). */
export function seoOnLinked(env: Env, capture?: (result: WireResult) => void): OnAgentLinked {
  return async (companyId, agentId, by) => {
    const result = await wireAgent(env, companyId, agentId, by.userId);
    capture?.(result);
    return result.steps;
  };
}

/** Link the pending hire when exactly one new agent matches. Never throws. */
export async function linkPendingHire(env: Env, companyId: string): Promise<HireAgentSummary | null> {
  try {
    return await tryLinkPendingHire(env.ctx, companyId, SEO_MATCH_ROLE, seoOnLinked(env));
  } catch (error) {
    env.ctx.logger.info("SEO hire link check failed", { companyId, error: errorMessage(error) });
    return null;
  }
}

export function seoHireStatus(env: Env, companyId: string): Promise<HireStatus> {
  return hireStatus(env.ctx, companyId, SEO_MATCH_ROLE, legacyAgentLookup(env));
}

export interface HireView {
  agent: HireAgentSummary | null;
  linkedBy: HireStatus["linkedBy"];
  hire: (NonNullable<HireStatus["hire"]> & { issueStatus: string | null; assigneeName: string | null }) | null;
  candidates: HireAgentSummary[];
}

/** Hire status for the SEO page, with the hire task's live status and assignee. */
export async function seoHireView(env: Env, companyId: string, userId: string | null): Promise<HireView> {
  const status = await seoHireStatus(env, companyId);
  if (!status.hire) return { ...status, hire: null };
  const issue = await getIssue(env, companyId, status.hire.issueId);
  const assigneeAgentId = issue ? issue.assigneeAgentId ?? null : status.hire.assigneeAgentId;
  const assigneeUserId = issue ? issue.assigneeUserId ?? null : status.hire.assigneeUserId;
  let assigneeName: string | null = null;
  if (assigneeAgentId) {
    try {
      const assignee = await env.ctx.agents.get(assigneeAgentId, companyId);
      assigneeName = assignee ? String(assignee.name) : null;
    } catch {
      assigneeName = null;
    }
  } else if (assigneeUserId) {
    assigneeName = userId && assigneeUserId === userId ? "you" : "a board member";
  }
  return {
    ...status,
    hire: {
      ...status.hire,
      identifier: status.hire.identifier ?? issue?.identifier ?? null,
      issueStatus: issue ? String(issue.status) : null,
      assigneeName,
    },
  };
}

/** The agent that hires for the company by default: the first one with the CEO role. */
export function defaultHireAssignee(agents: HireAgentSummary[]): string | null {
  return agents.find((a) => a.role === "ceo")?.id ?? null;
}

/** Hand agent-owned issues that were created before the agent existed to the agent. */
export async function adoptUnassignedAgentTasks(env: Env, companyId: string, agent: { id: string; status: string }): Promise<number> {
  const sprints = await db.listSprints(env.ctx.db, companyId);
  let adopted = 0;
  for (const sprint of sprints) {
    // A rehearsal sprint is never handed to the agent, not even an issue it was left with before issues were refused for it.
    if (sprint.autopilotMode === "off" || sprint.status === "archived" || isRehearsalSprint(sprint)) continue;
    const tasks = await db.listTasks(env.ctx.db, companyId, sprint.id, { status: ["not_started", "in_progress"], owner: "agent" });
    for (const task of tasks) {
      if (!task.issueId || task.assigneeKind !== "unassigned") continue;
      const issue = await getIssue(env, companyId, task.issueId);
      if (!issue || issue.assigneeAgentId || issue.assigneeUserId || !["todo", "backlog"].includes(String(issue.status))) continue;
      const updated = await patchIssue(env, companyId, task.issueId, { assigneeAgentId: agent.id, status: "todo" });
      if (!updated) continue;
      await db.updateTask(env.ctx.db, companyId, task.id, { assignee_kind: "agent" });
      if (!["paused", "pending_approval", "terminated"].includes(agent.status)) {
        await wakeIssue(env.ctx, task.issueId, companyId, "SEO task assigned to the SEO Specialist");
      }
      adopted += 1;
    }
  }
  return adopted;
}
