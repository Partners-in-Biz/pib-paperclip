/**
 * The plugin agent's skills and hire state, browser side (no React here, so
 * tests can import it).
 *
 * The agent is hired, picked, changed or removed in Setup → Team (kit
 * `team`). This page only shows a box when something is wrong
 * (`agentProblem`), with a link back to Setup → Team.
 *
 * A plugin worker cannot change an agent's skills, but the page runs as the
 * signed-in board user, who can. So the page attaches the role's skills to
 * the linked agent through the host's Agents → Skills endpoint (kit
 * `agent-client`).
 */
import { attachAgentSkills, missingAgentSkills, pluginSkillKey } from "@partnersinbiz/pib-plugin-kit/agent-client";
import { COMPANY_OS_SKILL_KEY, teamRole, teamRoleHealth, teamSetupPath, type TeamRoleHealth, type TeamRoleKey } from "@partnersinbiz/pib-plugin-kit/team";

/** A role skill: the host's canonical key and the `pib-` slug people see. */
export interface RoleSkill {
  key: string;
  slug: string;
}

/** The company operating manual every PiB agent carries (a Cockpit managed skill; kit `COMPANY_OS_SKILL`). */
export const COMPANY_OS_ROLE_SKILL: RoleSkill = { key: COMPANY_OS_SKILL_KEY, slug: "pib-company-os" };

/**
 * The SEO agent's skills: the SEO skill (the key the manifest puts in
 * desiredSkills, plugin/partnersinbiz-seo/seo-sprint), then the company
 * operating manual, so the page attaches the manual to linked agents too.
 */
export const ROLE_SKILLS: RoleSkill[] = [{ key: pluginSkillKey("partnersinbiz.seo", "seo-sprint"), slug: "pib-seo-sprint" }, COMPANY_OS_ROLE_SKILL];
/** "…, so it knows <purpose>." */
export const ROLE_SKILL_PURPOSE = "the SEO sprint procedure";

/** This plugin's role in the company team. */
export const TEAM_ROLE: TeamRoleKey = "seo-specialist";
/** Setup → Team, scrolled to the role: where the agent is hired, picked, changed or removed. */
export const TEAM_SETUP_HREF = teamSetupPath(TEAM_ROLE);

/** How the page names the agent and its work in the one-line problem. */
const COPY = { agent: "SEO agent", work: "SEO work", missing: "SEO tasks wait unassigned" };

/** An open hire task older than this counts as stuck. */
export const HIRE_STALE_DAYS = 7;
const DAY_MS = 86_400_000;
const CLOSED_ISSUE_STATUSES = ["done", "cancelled"];

export type RoleMode = "linked" | "hiring" | "none";

export interface RoleHire {
  status: string;
  createdAt?: string | null;
  issueStatus?: string | null;
}

export interface RoleView {
  /** linked: an agent is linked. hiring: a hire task is open. none: neither. */
  mode: RoleMode;
  /** The open hire's task was closed without an agent being linked. */
  closed: boolean;
  /** The open hire is older than {@link HIRE_STALE_DAYS} days. */
  stale: boolean;
  /** The open hire needs a person (closed or stale). */
  canRehire: boolean;
}

/** Where the role stands: linked, hiring (with a closed or stale hire task) or none. */
export function roleView(input: { agentId: string | null | undefined; hire: RoleHire | null | undefined; now?: number }): RoleView {
  if (input.agentId) return { mode: "linked", closed: false, stale: false, canRehire: false };
  const hire = input.hire;
  if (!hire || hire.status !== "open") return { mode: "none", closed: false, stale: false, canRehire: false };
  const closed = CLOSED_ISSUE_STATUSES.includes(hire.issueStatus ?? "");
  const created = hire.createdAt ? Date.parse(hire.createdAt) : Number.NaN;
  const stale = Number.isFinite(created) && (input.now ?? Date.now()) - created > HIRE_STALE_DAYS * DAY_MS;
  return { mode: "hiring", closed, stale, canRehire: closed || stale };
}

/** "the pib-x skill" / "the pib-x and pib-y skills". */
export function skillNames(skills: RoleSkill[]): string {
  const slugs = skills.map((s) => s.slug);
  if (slugs.length <= 1) return `the ${slugs[0] ?? "role"} skill`;
  return `the ${slugs.slice(0, -1).join(", ")} and ${slugs[slugs.length - 1]} skills`;
}

function pronoun(skills: RoleSkill[]): string {
  return skills.length === 1 ? "it" : "them";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SkillNote {
  ok: boolean;
  line: string;
}

/**
 * Attach the role's skills now (the agent box's Attach skills button). Keeps
 * the agent's other skills and says what happened.
 */
export async function attachRoleSkills(input: { agentId: string; agentName: string; companyId: string | null | undefined; skills: RoleSkill[]; purpose: string }): Promise<SkillNote> {
  const { agentId, agentName: name, companyId, skills, purpose } = input;
  if (!companyId) return { ok: false, line: `Add ${skillNames(skills)} in Agents → ${name} → Skills.` };
  try {
    const added = await attachAgentSkills(agentId, companyId, skills.map((s) => s.key));
    if (!added.length) return { ok: true, line: `${name} already has ${skillNames(skills)}.` };
    const attached = skills.filter((s) => added.includes(s.key));
    return { ok: true, line: `Attached ${skillNames(attached)} to ${name}, so it knows ${purpose}.` };
  } catch (error) {
    return { ok: false, line: `Could not attach ${skillNames(skills)} to ${name} (${message(error)}). Add ${pronoun(skills)} in Agents → ${name} → Skills.` };
  }
}

/**
 * On page load for a linked agent (linked after a hire, or earlier): attach
 * missing role skills for the person viewing. null when nothing was missing
 * (or the agent's skills could not be read). A viewer without permission
 * gets a note, never an error.
 */
export async function attachIfMissing(input: { agentId: string; agentName: string; companyId: string; skills: RoleSkill[] }): Promise<SkillNote | null> {
  const { agentId, agentName: name, companyId, skills } = input;
  const missingKeys = await missingAgentSkills(agentId, companyId, skills.map((s) => s.key));
  if (!missingKeys.length) return null;
  const missing = skills.filter((s) => missingKeys.includes(s.key));
  try {
    await attachAgentSkills(agentId, companyId, missingKeys);
    return { ok: true, line: `Attached ${skillNames(missing)} to ${name}.` };
  } catch {
    return { ok: false, line: `${name} is missing ${skillNames(missing)}. Add ${pronoun(missing)} in Agents → ${name} → Skills.` };
  }
}

export interface AgentProblem {
  /** kit `teamRoleHealth`; never "ok" (nothing to show then). */
  health: Exclude<TeamRoleHealth, "ok">;
  tone: "info" | "warn" | "bad";
  /** One sentence: what is wrong. */
  text: string;
  /** A role skill is missing: Attach skills (and Re-sync) fix it on this page. */
  skills: boolean;
}

/**
 * The agent box shows only when something is wrong: no agent and no open
 * hire (for a required role), a hire open without an agent, the agent paused,
 * in error or waiting for approval, or a role skill missing. Null when all is
 * well: the page shows nothing. Everything else is fixed in Setup → Team.
 */
export function agentProblem(input: {
  agent: { name: string | null; status: string | null } | null;
  hire: (RoleHire & { identifier?: string | null }) | null | undefined;
  /** Role skill slugs the agent still lacks (after the page tried to attach them). */
  missingSkills?: string[];
  /** New agents that look like this hire (more than one: someone has to pick). */
  candidates?: number;
  now?: number;
}): AgentProblem | null {
  const role = teamRole(TEAM_ROLE);
  const view = roleView({ agentId: input.agent ? "linked" : null, hire: input.hire, now: input.now });
  const missing = input.missingSkills ?? [];
  const health = teamRoleHealth({ agentStatus: input.agent?.status ?? null, hireOpen: view.mode === "hiring", missingSkills: missing.length });
  if (health === "ok") return null;
  if (health === "missing") return role.required ? { health, tone: "warn", text: `No ${COPY.agent} yet, so ${COPY.missing}.`, skills: false } : null;
  if (health === "hiring") {
    const task = input.hire?.identifier ? `The hire task ${input.hire.identifier}` : "The hire task";
    const text = view.closed
      ? `${task} was closed, but no ${COPY.agent} was linked.`
      : (input.candidates ?? 0) > 1
        ? `More than one new agent looks like the ${COPY.agent}: pick the right one in Setup.`
        : view.stale
          ? `${task} has been open for more than ${HIRE_STALE_DAYS} days and no ${COPY.agent} is linked yet.`
          : `${task} is open: the new ${COPY.agent} is linked as soon as it appears.`;
    return { health, tone: view.closed || view.stale ? "warn" : "info", text, skills: false };
  }
  const name = input.agent?.name || `The ${COPY.agent}`;
  const status = input.agent?.status ?? "";
  const state = status === "paused"
    ? `${name} is paused, so it does not pick up ${COPY.work}.`
    : status === "pending_approval"
      ? `${name} is waiting for approval: approve the hire, then resume it.`
      : status === "error"
        ? `${name} is in error, so it does not pick up ${COPY.work}.`
        : null;
  const skills = missing.length ? `${state ? "It is also" : `${name} is`} missing ${skillNames(missing.map((slug) => ({ key: slug, slug })))}.` : null;
  return { health, tone: status === "error" ? "bad" : "warn", text: [state, skills].filter(Boolean).join(" "), skills: missing.length > 0 };
}

/**
 * The role skills the agent still lacks (slugs): the page's own check first
 * (it attaches what it can for the person viewing), else what the worker saw
 * on the agent when the host could not say. Nothing until the page's check
 * has run, so the box does not flash while the page attaches them.
 */
export function stillMissing(input: { checked: boolean; attached: boolean; attachFailed: boolean; workerMissing?: string[] }): string[] {
  if (!input.checked || input.attached) return [];
  const worker = input.workerMissing ?? [];
  if (input.attachFailed) return worker.length ? worker : ROLE_SKILLS.map((s) => s.slug);
  return worker;
}
