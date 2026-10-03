/**
 * Which agent does a company's hiring (Q7-4). Pure, browser-safe.
 *
 * Every hire task is assigned to "your hiring agent". The plugins defaulted to an
 * agent with role `ceo`, but neither live company has one (the company wizard
 * makes the head agent role `general`: PiB and Steve), and every agent has
 * `canCreateAgents` on by default, so the permission alone tells nobody apart.
 * So the hiring agent is, in this order:
 *
 *  1. an agent with role `ceo`;
 *  2. an agent whose title says CEO (or chief executive);
 *  3. the one agent at the top of the org chart (nobody above it), when there is
 *     exactly one.
 *
 * Only an agent that can hire counts: `canCreateAgents` not turned off, and a
 * status that can run (not paused, in error, awaiting approval, terminated).
 * When no agent qualifies Setup shows the problem and the fix instead of
 * opening hire tasks nobody will read.
 */
import { TEAM_ATTENTION_STATUSES, TEAM_INACTIVE_STATUSES } from "@partnersinbiz/pib-plugin-kit/team";

export interface HiringCandidate {
  id: string;
  name: string;
  title: string | null;
  role: string | null;
  status: string;
  reportsTo: string | null;
  /** null when the agent record does not say (treated as allowed: the host default is on). */
  canCreateAgents: boolean | null;
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** A host agent record (`GET /api/companies/:id/agents`) as a hiring candidate. */
export function toHiringCandidate(raw: unknown): HiringCandidate | null {
  const row = rec(raw);
  const id = text(row?.id);
  if (!row || !id) return null;
  const permissions = rec(row.permissions);
  return {
    id,
    name: text(row.name) ?? "Agent",
    title: text(row.title),
    role: text(row.role),
    status: text(row.status) ?? "",
    reportsTo: text(row.reportsTo),
    canCreateAgents: typeof permissions?.canCreateAgents === "boolean" ? permissions.canCreateAgents : null,
  };
}

/** A Team page agent (already parsed) as a hiring candidate. */
export function teamAgentCandidate(agent: { id: string; name: string; title?: string | null; role?: string | null; status: string; reportsTo?: string | null; canCreateAgents?: boolean | null }): HiringCandidate {
  return { id: agent.id, name: agent.name, title: agent.title ?? null, role: agent.role ?? null, status: agent.status, reportsTo: agent.reportsTo ?? null, canCreateAgents: agent.canCreateAgents ?? null };
}

export function toHiringCandidates(list: unknown): HiringCandidate[] {
  return (Array.isArray(list) ? list : []).map(toHiringCandidate).filter((candidate): candidate is HiringCandidate => candidate !== null);
}

const CEO_TITLE = /\bceo\b|chief executive/i;

/** An agent that could take a hire task now. */
export function canHire(agent: HiringCandidate): boolean {
  if ((TEAM_INACTIVE_STATUSES as readonly string[]).includes(agent.status) || (TEAM_ATTENTION_STATUSES as readonly string[]).includes(agent.status)) return false;
  return agent.canCreateAgents !== false;
}

export type HiringSource = "role" | "title" | "head";

export interface HiringPick {
  agent: HiringCandidate | null;
  source: HiringSource | null;
  /** Other agents that could hire, for a person to pick instead. */
  alternatives: HiringCandidate[];
  /** Why nobody was picked, in plain words; null when someone was. */
  problem: string | null;
  /** What to do about it. */
  fix: string | null;
}

export const NO_HIRING_FIX = "Create the company's CEO first: Agents -> New agent, role CEO, adapter claude_local (or run `new-company.py --create-ceo` on the server). If a head agent already exists, set its title to CEO in Agents, make sure it is not paused, and tick Can create agents. Then check again. Until then Setup assigns hire tasks to you.";

export function pickHiringAgent(agents: readonly HiringCandidate[]): HiringPick {
  const able = agents.filter(canHire);
  const byRole = able.find((agent) => (agent.role ?? "").toLowerCase() === "ceo");
  const byTitle = able.find((agent) => agent.title !== null && CEO_TITLE.test(agent.title));
  // The head of the org chart: nobody above it among the company's live agents.
  const live = agents.filter((agent) => !(TEAM_INACTIVE_STATUSES as readonly string[]).includes(agent.status));
  const liveIds = new Set(live.map((agent) => agent.id));
  const heads = able.filter((agent) => !agent.reportsTo || !liveIds.has(agent.reportsTo));
  const head = heads.length === 1 ? heads[0]! : null;
  const agent = byRole ?? byTitle ?? head ?? null;
  const source: HiringSource | null = byRole ? "role" : byTitle ? "title" : head ? "head" : null;
  const alternatives = able.filter((candidate) => candidate.id !== agent?.id);
  if (agent) return { agent, source, alternatives, problem: null, fix: null };
  let problem: string;
  if (agents.length === 0) problem = "This company has no agent yet, so nobody can do its hiring.";
  else if (able.length === 0) problem = "No agent can take a hire task: every agent is paused, in error, awaiting approval, terminated, or has Can create agents turned off.";
  else if (heads.length > 1) problem = `No agent is the CEO and ${heads.length} agents sit at the top of the org chart (${heads.slice(0, 4).map((candidate) => candidate.name).join(", ")}), so Setup cannot tell which one hires.`;
  else problem = "No agent is the CEO and none sits at the top of the org chart, so Setup cannot tell which one hires.";
  return { agent: null, source: null, alternatives, problem, fix: NO_HIRING_FIX };
}

const SOURCE_LABEL: Record<HiringSource, string> = { role: "its role is CEO", title: "its title is CEO", head: "it is the head of the org chart" };

/** One line for the Team section: who hires, and why. */
export function hiringLine(pick: HiringPick): string {
  if (!pick.agent) return pick.problem ?? "";
  return `${pick.agent.name} does the hiring (${SOURCE_LABEL[pick.source!]}).`;
}

/** The agent a hire task is assigned to by default: Setup's hiring agent when there is one, else the plugin's own default. */
export function defaultHireAssignee(hiring: HiringPick | null, pluginDefault: string | null | undefined): string | null {
  return hiring?.agent?.id ?? pluginDefault ?? null;
}
