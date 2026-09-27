/**
 * The Account Manager's skills and hire state, browser side (no React here,
 * so tests can import it).
 *
 * The agent is hired, picked, changed or removed in Setup → Team (kit
 * `team`). The CRM page only shows a box when something is wrong
 * (`agentProblem`), with a link back to Setup → Team.
 *
 * A plugin worker cannot change an agent's skills, but the page runs as the
 * signed-in board user, who can. So the page attaches the role's skills to
 * the linked agent (kit `agent-client`), plus its extra skills from the other
 * modules when those skills exist in the company (best effort; never counted
 * as missing).
 */
import { attachAgentSkills, missingAgentSkills, pluginSkillKey } from "@partnersinbiz/pib-plugin-kit/agent-client";
import { COMPANY_OS_SKILL_KEY, teamRole, teamRoleHealth, teamSetupPath, type TeamRoleHealth, type TeamRoleKey } from "@partnersinbiz/pib-plugin-kit/team";

/** A role skill: the host's canonical key and the `pib-` slug people see. */
export interface RoleSkill {
  key: string;
  slug: string;
}

/** This plugin's role in the company team. */
export const TEAM_ROLE: TeamRoleKey = "account-manager";
/** Setup → Team, scrolled to the role: where the agent is hired, picked, changed or removed. */
export const TEAM_SETUP_HREF = teamSetupPath(TEAM_ROLE);

/** The Account Manager's skills: the CRM's two plus the company operating manual (the hire role asks for these). */
export const ROLE_SKILLS: RoleSkill[] = [
  { key: pluginSkillKey("partnersinbiz.crm", "crm-records"), slug: "pib-crm-records" },
  { key: pluginSkillKey("partnersinbiz.crm", "crm-outbound"), slug: "pib-crm-outbound" },
  { key: COMPANY_OS_SKILL_KEY, slug: "pib-company-os" },
];

/** Other modules' skills it uses when those modules are installed (kit TEAM_ROLES `extraSkills`). */
export const EXTRA_SKILLS: string[] = teamRole(TEAM_ROLE).extraSkills ?? [];

/** "…, so it knows <purpose>." */
export const ROLE_SKILL_PURPOSE = "how to run leads, clients and outbound email";

/** How the page names the agent and its work in the one-line problem. */
const COPY = {
  agent: "Account Manager",
  work: "lead follow-ups, replies and sequence steps",
  missing: "lead follow-ups, replies and sequence steps go to the Operator or to you",
};

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
  mode: RoleMode;
  closed: boolean;
  stale: boolean;
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

/**
 * The skill keys that exist in the company (the host's skill library), or
 * null when the list cannot be read. A skill that does not exist yet (its
 * module is not installed or not upgraded) cannot be attached.
 */
export async function companySkillKeys(companyId: string, fetchImpl: typeof fetch = fetch): Promise<Set<string> | null> {
  try {
    const res = await fetchImpl(`/api/companies/${encodeURIComponent(companyId)}/skills`, { credentials: "include" });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    const list = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { skills?: unknown }).skills) ? (body as { skills: unknown[] }).skills : null;
    if (!list) return null;
    return new Set(list.map((item) => (item && typeof item === "object" ? String((item as { key?: unknown }).key ?? "") : "")).filter(Boolean));
  } catch {
    return null;
  }
}

/** Skills that can be attached: those in the company's library (all of them when the library cannot be read). */
function available(keys: string[], present: Set<string> | null): string[] {
  return present ? keys.filter((key) => present.has(key)) : keys;
}

export interface SkillNote {
  ok: boolean;
  line: string;
}

/**
 * Attach the role's skills now (the agent box's Attach skills button), plus
 * the extra skills that exist. Keeps the agent's other skills.
 */
export async function attachRoleSkills(input: { agentId: string; agentName: string; companyId: string | null | undefined; skills: RoleSkill[]; purpose: string; extras?: string[] }): Promise<SkillNote> {
  const { agentId, agentName: name, companyId, skills, purpose } = input;
  if (!companyId) return { ok: false, line: `Add ${skillNames(skills)} in Agents → ${name} → Skills.` };
  const present = await companySkillKeys(companyId);
  const wanted = available(skills.map((s) => s.key), present);
  const unknown = skills.filter((s) => !wanted.includes(s.key));
  try {
    const added = await attachAgentSkills(agentId, companyId, wanted);
    await attachExtras(agentId, companyId, input.extras ?? [], present);
    const attached = skills.filter((s) => added.includes(s.key));
    const later = unknown.length ? ` ${skillNames(unknown)} ${unknown.length === 1 ? "is" : "are"} not in this company yet; ${pronoun(unknown)} will be attached once ${unknown.length === 1 ? "it exists" : "they exist"}.` : "";
    if (!attached.length) return { ok: true, line: `${name} already has ${skillNames(skills.filter((s) => wanted.includes(s.key)))}.${later}` };
    return { ok: true, line: `Attached ${skillNames(attached)} to ${name}, so it knows ${purpose}.${later}` };
  } catch (error) {
    return { ok: false, line: `Could not attach ${skillNames(skills)} to ${name} (${message(error)}). Add ${pronoun(skills)} in Agents → ${name} → Skills.` };
  }
}

/** Extra skills that exist in the company and the agent lacks. Never fails. */
async function attachExtras(agentId: string, companyId: string, extras: string[], present: Set<string> | null): Promise<string[]> {
  // Unknown library: never guess, an unknown key would fail the whole attach.
  if (!present || extras.length === 0) return [];
  const wanted = extras.filter((key) => present.has(key));
  if (wanted.length === 0) return [];
  try {
    return await attachAgentSkills(agentId, companyId, wanted);
  } catch {
    return [];
  }
}

/**
 * On page load for a linked agent: attach missing role skills (those that
 * exist in the company) and the extra skills that exist, for the person
 * viewing. Null when nothing was missing or the agent's skills could not be
 * read. A viewer without permission gets a note, never an error.
 */
export async function attachIfMissing(input: { agentId: string; agentName: string; companyId: string; skills: RoleSkill[]; extras?: string[] }): Promise<SkillNote | null> {
  const { agentId, agentName: name, companyId, skills } = input;
  const present = await companySkillKeys(companyId);
  const extras = await attachExtras(agentId, companyId, input.extras ?? [], present);
  const missingKeys = available(await missingAgentSkills(agentId, companyId, skills.map((s) => s.key)), present);
  const extraLine = extras.length ? ` Also added ${extras.length} skill${extras.length === 1 ? "" : "s"} from the other modules it uses.` : "";
  if (!missingKeys.length) return extras.length ? { ok: true, line: `${name} has its role skills.${extraLine}` } : null;
  const missing = skills.filter((s) => missingKeys.includes(s.key));
  try {
    await attachAgentSkills(agentId, companyId, missingKeys);
    return { ok: true, line: `Attached ${skillNames(missing)} to ${name}.${extraLine}` };
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
 * The agent box shows only when something is wrong: no Account Manager and no
 * open hire, a hire open without an agent, the agent paused, in error or
 * waiting for approval, or a role skill missing. Null when all is well.
 */
export function agentProblem(input: {
  agent: { name: string | null; status: string | null } | null;
  hire: (RoleHire & { identifier?: string | null }) | null | undefined;
  missingSkills?: string[];
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
    ? `${name} is paused, so ${COPY.work} go to the Operator or to you.`
    : status === "pending_approval"
      ? `${name} is waiting for approval: approve the hire, then resume it.`
      : status === "error"
        ? `${name} is in error, so ${COPY.work} go to the Operator or to you.`
        : null;
  const skills = missing.length ? `${state ? "It is also" : `${name} is`} missing ${skillNames(missing.map((slug) => ({ key: slug, slug })))}.` : null;
  return { health, tone: status === "error" ? "bad" : "warn", text: [state, skills].filter(Boolean).join(" "), skills: missing.length > 0 };
}

/**
 * The role skills the agent still lacks (slugs): the page's own check first
 * (it attaches what it can), else what the worker saw on the agent. Nothing
 * until the page's check has run, so the box does not flash.
 */
export function stillMissing(input: { checked: boolean; attached: boolean; attachFailed: boolean; workerMissing?: string[] }): string[] {
  if (!input.checked || input.attached) return [];
  const worker = input.workerMissing ?? [];
  if (input.attachFailed) return worker.length ? worker : ROLE_SKILLS.map((s) => s.slug);
  return worker;
}
