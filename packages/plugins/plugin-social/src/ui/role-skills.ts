/**
 * The plugin agent's skills and hire state, browser side (no React here, so
 * tests can import it).
 *
 * A plugin worker cannot change an agent's skills, but the page runs as the
 * signed-in board user, who can. So when someone links an existing agent (or
 * the plugin linked one after a hire), the page attaches the role's skills
 * through the host's Agents → Skills endpoint (kit `agent-client`).
 */
import { attachAgentSkills, missingAgentSkills, pluginSkillKey } from "@partnersinbiz/pib-plugin-kit/agent-client";

/** A role skill: the host's canonical key and the `pib-` slug people see. */
export interface RoleSkill {
  key: string;
  slug: string;
}

/** The Social agent's skills: the keys the manifest puts in desiredSkills (plugin/partnersinbiz-social/<skillKey>). */
export const ROLE_SKILLS: RoleSkill[] = [
  { key: pluginSkillKey("partnersinbiz.social", "social-publish"), slug: "pib-social-publish" },
  { key: pluginSkillKey("partnersinbiz.social", "social-content"), slug: "pib-social-content" },
];
/** "…, so it knows <purpose>." */
export const ROLE_SKILL_PURPOSE = "how to use the Social tools";

/** An open hire task older than this offers "Open a new hire task" again. */
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
  /** linked: show the agent and Change agent. hiring: show the open hire task. none: show the Hire button. */
  mode: RoleMode;
  /** The open hire's task was closed without an agent being linked. */
  closed: boolean;
  /** The open hire is older than {@link HIRE_STALE_DAYS} days. */
  stale: boolean;
  /** Offer "Open a new hire task" next to the open hire (closed or stale only). */
  canRehire: boolean;
}

/** What the agent card shows. The Hire button only appears in mode "none". */
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
 * Drops the worker's "attach the skill by hand" lines from a link result once
 * the page has attached the skills itself.
 */
export function dropSkillAsks(lines: string[], skills: RoleSkill[]): string[] {
  return lines.filter((line) => !(skills.some((s) => line.includes(s.slug)) && /\battach\b|does not have| has the /i.test(line)));
}

export interface SkillNote {
  ok: boolean;
  line: string;
}

/**
 * After someone links an agent by hand: attach the role's skills (keeps the
 * agent's other skills) and say what happened.
 */
export async function attachOnLink(input: { agentId: string; agentName: string; companyId: string | null | undefined; skills: RoleSkill[]; purpose: string }): Promise<SkillNote> {
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
