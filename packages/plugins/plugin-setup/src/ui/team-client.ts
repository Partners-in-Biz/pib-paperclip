/**
 * Setup → Team from the page (same origin, board session cookie).
 *
 * Every role lives in its own plugin, so the page calls that plugin's actions
 * over HTTP (`POST /api/plugins/<key>/actions/<action>`), like "Do it for me":
 * - plugin roles: `<p>.hire-options`, `<p>.start-hire`, `<p>.link-agent`,
 *   `<p>.unlink-agent` and the optional re-sync;
 * - Operator and Reviewer: `cockpit.load` (`{ team: true }`),
 *   `cockpit.hire-options` / `cockpit.start-hire` (`{ role }`) and
 *   `cockpit.save-team` with a partial payload.
 * Skills are attached by the page (a plugin worker cannot change an agent's
 * skills; the signed-in board user can), with the kit's agent-client.
 */
import { agentSkills, attachAgentSkills } from "@partnersinbiz/pib-plugin-kit/agent-client";
import {
  actionSummary,
  COCKPIT_PLUGIN_KEY,
  extraSkillStates,
  extrasToAttach,
  failedRoleState,
  missingActionError,
  parseBoardUsers,
  parseCockpitTeam,
  parseCompanyAgents,
  parseHire,
  parseHireOptions,
  pluginProblem,
  roleLoadError,
  roleNotReady,
  roleStateFromCockpit,
  roleStateFromHireOptions,
  skillNames,
  type BoardUser,
  type ExtraSkillState,
  type CockpitTeam,
  type CockpitTeamPatch,
  type HireOptionsLite,
  type TeamAgent,
  type TeamHire,
  type TeamRole,
  type TeamRoleKey,
  type TeamRoleState,
} from "../team.js";
import { runPluginAction, savePluginConfig } from "./api.js";

const enc = encodeURIComponent;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const text = record.error ?? record.message;
    throw new Error(typeof text === "string" && text ? text : `Request failed (${res.status})`);
  }
  return body;
}

function message(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  return String(error ?? "failed");
}

/**
 * Runs a role's plugin action. A plugin older than its Setup → Team actions
 * (the CRM before it staffed the Account Manager) says so plainly instead of
 * the host's "no handler" error.
 */
export class RoleNotReadyError extends Error {}

async function roleAction(role: TeamRole, key: string, companyId: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    return await runPluginAction(role.pluginKey, key, companyId, { ...params, ...(role.actions.params ?? {}) });
  } catch (error) {
    if (missingActionError(message(error))) throw new RoleNotReadyError(roleNotReady(role));
    throw error;
  }
}

/** The company's agents (name, role, title, status, URL key). Null when the list cannot be read. */
export async function fetchCompanyAgents(companyId: string): Promise<TeamAgent[] | null> {
  try {
    return parseCompanyAgents(await getJson(`/api/companies/${enc(companyId)}/agents`));
  } catch {
    return null;
  }
}

/** The raw agent records (permissions, reporting line, adapter settings), for the bootstrap. Null when the list cannot be read. */
export async function fetchCompanyAgentsRaw(companyId: string): Promise<unknown[] | null> {
  try {
    const body = await getJson(`/api/companies/${enc(companyId)}/agents`);
    return Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : null;
  } catch {
    return null;
  }
}

/** The company's board members, for "Who gets the daily brief". Null when they cannot be read. */
export async function fetchBoardUsers(companyId: string): Promise<BoardUser[] | null> {
  try {
    return parseBoardUsers(await getJson(`/api/companies/${enc(companyId)}/user-directory`));
  } catch {
    return null;
  }
}

export interface TeamLoad {
  states: Partial<Record<TeamRoleKey, TeamRoleState>>;
  agents: TeamAgent[] | null;
  users: BoardUser[] | null;
  /** What `cockpit.load` said (null when the Cockpit is off, missing or failed). */
  cockpit: CockpitTeam | null;
}

type Installed = Record<string, { id?: string; status?: string | null }> | null;

/**
 * Every role's state, in parallel: one `hire-options` per plugin role, one
 * `cockpit.load` for the Operator and Reviewer, the company agents (links)
 * and the board members (owner). A role whose plugin is not running or whose
 * action fails gets an error instead; nothing here throws.
 */
export async function loadTeam(input: { companyId: string; roles: TeamRole[]; installed: Installed }): Promise<TeamLoad> {
  const { companyId, roles, installed } = input;
  const cockpitRoles = roles.filter((role) => role.cockpitRole);
  const pluginRoles = roles.filter((role) => !role.cockpitRole);
  const cockpitProblem = cockpitRoles.length ? pluginProblem(cockpitRoles[0]!, installed) : null;
  const wantCockpit = cockpitRoles.length > 0 && !cockpitProblem;

  const [agents, users, cockpitResult, pluginResults] = await Promise.all([
    fetchCompanyAgents(companyId),
    cockpitRoles.length ? fetchBoardUsers(companyId) : Promise.resolve(null),
    wantCockpit
      ? runPluginAction(COCKPIT_PLUGIN_KEY, "cockpit.load", companyId, { team: true }).then(
        (body) => ({ ok: true as const, body }),
        (error: unknown) => ({ ok: false as const, error: message(error) }),
      )
      : Promise.resolve(null),
    Promise.all(pluginRoles.map(async (role) => {
      const problem = pluginProblem(role, installed);
      if (problem) return { role, ok: false as const, error: problem };
      try {
        return { role, ok: true as const, body: await roleAction(role, role.actions.options, companyId, {}) };
      } catch (error) {
        return { role, ok: false as const, error: error instanceof RoleNotReadyError ? error.message : roleLoadError(role, message(error)) };
      }
    })),
  ]);

  const states: TeamLoad["states"] = {};
  for (const result of pluginResults) {
    states[result.role.key] = result.ok ? roleStateFromHireOptions(result.role, result.body, agents) : failedRoleState(result.role, result.error);
  }
  let cockpit: CockpitTeam | null = null;
  if (cockpitResult?.ok) cockpit = parseCockpitTeam(cockpitResult.body);
  for (const role of cockpitRoles) {
    if (cockpitProblem) states[role.key] = failedRoleState(role, cockpitProblem);
    else if (!cockpitResult || !cockpitResult.ok) states[role.key] = failedRoleState(role, roleLoadError(role, cockpitResult?.error ?? "no answer"));
    else if (!cockpit) states[role.key] = failedRoleState(role, `The Cockpit did not say who the ${role.title} is. Upgrade it, then check again.`);
    else states[role.key] = roleStateFromCockpit(role, cockpit, agents);
  }
  return { states, agents, users, cockpit };
}

export interface SkillCheck {
  /** Role skills (including the company operating manual) the agent lacks; [] when unknown or all there. */
  missing: string[];
  /** The role's extra skills and whether the agent has each (never counted as missing). */
  extras: ExtraSkillState[];
}

/**
 * The skill keys in the company's library (`GET /api/companies/:id/skills`),
 * or null when it cannot be read. An extra skill is attached only once it
 * exists there (its module installed and synced).
 */
export async function companySkillKeys(companyId: string): Promise<Set<string> | null> {
  try {
    const body = await getJson(`/api/companies/${enc(companyId)}/skills`);
    const rows = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { skills?: unknown }).skills) ? (body as { skills: unknown[] }).skills : null;
    if (!rows) return null;
    return new Set(rows.map((row) => (row && typeof row === "object" ? String((row as { key?: unknown }).key ?? "") : "")).filter(Boolean));
  } catch {
    return null;
  }
}

/** One read of each linked agent's skills: which role skills it lacks, and its extra skills' state. */
export async function checkSkills(companyId: string, states: TeamRoleState[], installed: Installed = null): Promise<Partial<Record<TeamRoleKey, SkillCheck>>> {
  const out: Partial<Record<TeamRoleKey, SkillCheck>> = {};
  const library = states.some((state) => state.agent && state.role.extraSkills?.length) ? await companySkillKeys(companyId) : null;
  await Promise.all(states.map(async (state) => {
    if (!state.agent) return;
    let current: string[] | null = null;
    try {
      current = await agentSkills(state.agent.id, companyId);
    } catch {
      current = null;
    }
    out[state.role.key] = {
      missing: current ? state.role.skills.filter((key) => !current!.includes(key)) : [],
      extras: extraSkillStates(state.role, installed, current, library),
    };
  }));
  return out;
}

/** The hire dialog's prefill: `<p>.hire-options`, or `cockpit.hire-options { role }`. */
export async function fetchHireOptions(companyId: string, role: TeamRole): Promise<HireOptionsLite> {
  const body = await roleAction(role, role.actions.options, companyId, role.cockpitRole ? { role: role.cockpitRole } : {});
  const options = parseHireOptions(body);
  if (!options) throw new Error(`The ${role.title} hire options could not be read. Upgrade the plugin, then try again.`);
  return options;
}

export interface HireTask {
  title: string;
  description: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

/** Opens the hire task (`<p>.start-hire`, or `cockpit.start-hire` with the role). */
export async function startHire(companyId: string, role: TeamRole, task: HireTask): Promise<TeamHire | null> {
  const body = await roleAction(role, role.actions.start, companyId, role.cockpitRole ? { role: role.cockpitRole, ...task } : { ...task });
  // SEO, Accounting, Payroll and the Cockpit answer `{ hire }`; Social answers the hire record itself.
  const record = body && typeof body === "object" && "hire" in body ? (body as { hire: unknown }).hire : body;
  return parseHire(record);
}

export interface SaveTeamResult {
  steps: string[];
  /** Set when the Cockpit settings still had to be saved and could not be. */
  settingsNote: string | null;
}

/**
 * `cockpit.save-team` with only what changes. The first save also saves the
 * Cockpit settings (as its Team tab did), so its hourly jobs can act for the
 * company.
 */
export async function saveCockpitTeam(input: { companyId: string; patch: CockpitTeamPatch; settingsSaved: boolean; cockpitPluginId?: string | null }): Promise<SaveTeamResult> {
  const body = await runPluginAction(COCKPIT_PLUGIN_KEY, "cockpit.save-team", input.companyId, input.patch as Record<string, unknown>);
  let settingsNote: string | null = null;
  if (!input.settingsSaved) {
    try {
      await savePluginConfig(input.cockpitPluginId || COCKPIT_PLUGIN_KEY, input.companyId, { healthIssue: true });
    } catch (error) {
      settingsNote = `The Cockpit settings could not be saved (${message(error)}). Save them once in Settings → Plugins → Cockpit, or its hourly health check cannot act for this company.`;
    }
  }
  return { steps: actionSummary(body).steps, settingsNote };
}

/**
 * After a person links an agent: attach the role's skills (the company
 * operating manual included) and the extra skills of installed modules. Its
 * other skills stay. Says what happened.
 */
export async function attachRoleSkills(input: { companyId: string; agentId: string; agentName: string; role: TeamRole; installed?: Installed }): Promise<{ ok: boolean; line: string }> {
  const { companyId, agentId, agentName, role } = input;
  const library = role.extraSkills?.length ? await companySkillKeys(companyId) : null;
  const extras = extrasToAttach(extraSkillStates(role, input.installed ?? null, [], library));
  try {
    const added = await attachAgentSkills(agentId, companyId, [...role.skills, ...extras]);
    if (added.length === 0) return { ok: true, line: `${agentName} already has ${skillNames(role.skills)}.` };
    return { ok: true, line: `Attached ${skillNames(added)} to ${agentName}, so it knows the ${role.title} procedure.` };
  } catch (error) {
    return { ok: false, line: `Could not attach ${skillNames(role.skills)} to ${agentName} (${message(error)}). Add ${role.skills.length === 1 ? "it" : "them"} in Agents → ${agentName} → Skills.` };
  }
}

/** Attach only the skills the agent lacks (the "Attach missing skills" button). */
export async function attachMissingSkills(input: { companyId: string; agentId: string; agentName: string; skills: string[] }): Promise<string[]> {
  return attachAgentSkills(input.agentId, input.companyId, input.skills);
}

/** Re-sync a plugin role's agent (tools, routines, skills). */
export async function resyncRole(companyId: string, role: TeamRole): Promise<{ steps: string[]; instructions: string[] }> {
  if (!role.actions.resync) throw new Error(`The ${role.title} has no re-sync.`);
  return actionSummary(await roleAction(role, role.actions.resync, companyId, {}));
}

/** Link a plugin role's agent (`<p>.link-agent`). */
export async function linkPluginRole(companyId: string, role: TeamRole, agentId: string): Promise<{ steps: string[]; instructions: string[] }> {
  if (!role.actions.link) throw new Error(`${role.title} is saved with the Cockpit team.`);
  return actionSummary(await roleAction(role, role.actions.link, companyId, { agentId }));
}

/** Unlink a plugin role's agent (`<p>.unlink-agent`); the agent itself is not changed. */
export async function unlinkPluginRole(companyId: string, role: TeamRole): Promise<void> {
  if (!role.actions.unlink) throw new Error(`${role.title} is saved with the Cockpit team.`);
  await roleAction(role, role.actions.unlink, companyId, {});
}
