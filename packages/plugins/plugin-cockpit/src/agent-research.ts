/**
 * Weekly agent research (Monday 06:00 SAST): the five distilled agents that fail
 * most get one issue each for the Reflection Coach, with the numbers it needs
 * to propose one change. An agent is a candidate only when it runs a distilled
 * template (`metadata.pibPack` with an `evalFile` Cockpit ships), nobody is
 * already changing it (no open improvement, no open `Distill:` issue) and it ran
 * enough in the last 7 days for a rate to mean something.
 */
import { configSaved, createWorkIssue } from "@partnersinbiz/pib-plugin-kit";
import { ORIGIN } from "./constants.js";
import { listRoles } from "./db.js";
import type { Env } from "./env.js";
import { message, throwIfEveryCompanyFailed } from "./env.js";
import { AGENT_EVALS } from "./eval-scenarios.js";
import { isoWeek } from "./growth-own-metrics.js";
import { listImprovements } from "./improvements.js";
import { breakdowns, failRate, type Breakdown } from "./measure-model.js";
import { readAgentRuns } from "./measure.js";
import { isReflectionCoach } from "./skill-policy.js";

/** At most this many agents get an issue in a week. */
export const RESEARCH_TOP = 5;
/** An agent with fewer runs than this in the window is not ranked: a rate over a handful of runs is noise. */
export const RESEARCH_MIN_RUNS = 20;
export const RESEARCH_WINDOW_DAYS = 7;

type Raw = Record<string, unknown>;
const DAY_MS = 86_400_000;
const INACTIVE = new Set(["terminated", "archived", "deleted"]);

export interface ResearchPack {
  key: string;
  hash: string;
  evalFile: string;
}

/** The distilled-template stamp on an agent, or null when it has none, it is malformed, or it names no eval file. */
export function readResearchPack(raw: unknown): ResearchPack | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.key !== "string" || o.key === "" || typeof o.hash !== "string" || !/^[0-9a-f]{16}$/.test(o.hash)) return null;
  if (typeof o.evalFile !== "string" || o.evalFile === "") return null;
  return { key: o.key, hash: o.hash, evalFile: o.evalFile };
}

/** Whether Cockpit ships this eval file (bundled as `evals/agents/<name>.json`). */
export function evalShipped(evalFile: string): boolean {
  return Object.prototype.hasOwnProperty.call(AGENT_EVALS, evalFile.replace(/\.json$/, ""));
}

export interface ResearchCandidate {
  agentId: string;
  name: string;
  pack: ResearchPack;
  runs: number;
  failed: number;
  failRate: number;
  failures: Breakdown[];
}

/** Worst 7-day fail rate first; more runs, then name, break ties so the order is stable. */
export function rankCandidates(candidates: ResearchCandidate[]): ResearchCandidate[] {
  return [...candidates].sort((a, b) => b.failRate - a.failRate || b.runs - a.runs || a.name.localeCompare(b.name));
}

export function researchOriginId(agentId: string, week: string): string {
  return `autoresearch:${agentId}:${week}`;
}

/** What open improvements are aimed at (a template key, an agent id or an agent name, lower-case), so a candidate under change is left alone. */
async function underChange(env: Env, companyId: string): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const row of await listImprovements(env.ctx, companyId, { status: "open", limit: 200 })) {
    if (row.targetRef) refs.add(row.targetRef.toLowerCase());
  }
  return refs;
}

/**
 * The words of every open `Distill:` issue's title and description, split on anything outside [a-z0-9-] and
 * lower-cased, so a key matches only as a whole word (`developer` is not in `senior-developer`).
 */
async function openDistillWords(env: Env, companyId: string): Promise<Set<string>> {
  const rows = await env.ctx.db.query<Raw>(
    `SELECT title, description FROM public.issues
      WHERE company_id = $1::uuid AND hidden_at IS NULL AND status NOT IN ('done', 'cancelled') AND title ILIKE 'Distill:%'
      LIMIT 200`,
    [companyId],
  );
  const words = new Set<string>();
  for (const r of rows) {
    for (const word of `${String(r.title ?? "")}\n${String(r.description ?? "")}`.toLowerCase().split(/[^a-z0-9-]+/)) if (word) words.add(word);
  }
  return words;
}

async function alreadyOpened(env: Env, companyId: string, originId: string): Promise<boolean> {
  const rows = await env.ctx.db.query<Raw>(
    `SELECT id FROM public.issues WHERE company_id = $1::uuid AND origin_kind = $2 AND origin_id = $3 LIMIT 1`,
    [companyId, ORIGIN.autoresearch, originId],
  );
  return rows.length > 0;
}

function pct(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

export function researchDescription(c: ResearchCandidate, week: string): string {
  const reasons = c.failures.length > 0 ? c.failures.map((f) => `- ${f.reason}: ${f.count}`).join("\n") : "- (no failure reason recorded)";
  return [
    `Weekly agent research (${week}). ${c.name} is one of the most failing distilled agents this week.`,
    "",
    "## Measure brief",
    `- Window: last ${RESEARCH_WINDOW_DAYS} days`,
    `- Runs: ${c.runs}, failed: ${c.failed}, fail rate: ${pct(c.failRate)}`,
    `- Template: \`${c.pack.key}\`, current hash: \`${c.pack.hash}\``,
    `- Eval file: \`evals/agents/${c.pack.evalFile}\``,
    "",
    "## Failure breakdown",
    reasons,
    "",
    "## The one metric to move",
    `The 7-day run failure rate of ${c.name} (now ${pct(c.failRate)}, lower is better). \`review_pass_rate\` and \`cycle_hours\` are available through \`measure-report\` to check that a change does not trade one for the other.`,
    "",
    "## What to do",
    "Cluster the failures above, propose the smallest template change that should lower the rate (`propose-skill-change`, kind template), and run the agent's eval before and after. Change one thing.",
  ].join("\n");
}

export type ResearchResult = {
  companies: number;
  eligible: number;
  opened: number;
  alreadyOpened: number;
  noCoach: number;
  failed: number;
};

/** One company: rank the eligible agents and open an issue for each of the worst few. */
export async function researchCompany(env: Env, companyId: string): Promise<Omit<ResearchResult, "companies" | "failed">> {
  const out = { eligible: 0, opened: 0, alreadyOpened: 0, noCoach: 0 };
  const now = env.now();
  const week = isoWeek(now);
  const agents = (await env.ctx.agents.list({ companyId, limit: 200 })) as unknown as Raw[];
  const live = agents.filter((a) => !INACTIVE.has(String(a.status)));

  const packed = live.flatMap((a) => {
    const pack = readResearchPack((a.metadata as Raw | null | undefined)?.pibPack);
    return pack && evalShipped(pack.evalFile) ? [{ agent: a, pack }] : [];
  });
  if (packed.length === 0) return out;

  const [change, distill, read] = await Promise.all([
    underChange(env, companyId),
    openDistillWords(env, companyId),
    readAgentRuns(env.ctx, companyId, new Date(now.getTime() - RESEARCH_WINDOW_DAYS * DAY_MS).toISOString()),
  ]);

  const candidates: ResearchCandidate[] = [];
  for (const { agent, pack } of packed) {
    const agentId = String(agent.id);
    if ([pack.key, agentId, String(agent.name ?? "")].some((ref) => change.has(ref.toLowerCase()))) continue;
    if (distill.has(pack.key.toLowerCase())) continue;
    const agg = read.aggregates.get(agentId);
    if (!agg || agg.runs < RESEARCH_MIN_RUNS) continue;
    const rate = failRate(agg);
    if (rate === null) continue; // no run ended in a verdict (all cancelled, say): there is no rate to rank
    candidates.push({
      agentId,
      name: String(agent.name ?? "Agent"),
      pack,
      runs: agg.runs,
      failed: agg.failed,
      failRate: rate,
      failures: breakdowns(read.reasons, agentId).failures,
    });
  }
  out.eligible = candidates.length;
  if (candidates.length === 0) return out;

  const coach = live.find((a) => isReflectionCoach(a));
  if (!coach) {
    out.noCoach = 1;
    return out;
  }

  for (const c of rankCandidates(candidates).slice(0, RESEARCH_TOP)) {
    const originId = researchOriginId(c.agentId, week);
    if (await alreadyOpened(env, companyId, originId)) {
      out.alreadyOpened += 1;
      continue;
    }
    await createWorkIssue(env.ctx, {
      companyId,
      title: `Autoresearch: ${c.name} (week ${Number(week.slice(week.indexOf("W") + 1))})`,
      description: researchDescription(c, week),
      priority: "medium",
      assigneeAgentId: String(coach.id),
      originKind: ORIGIN.autoresearch as `plugin:${string}`,
      originId,
      wakeReason: "Weekly agent research",
    });
    out.opened += 1;
  }
  return out;
}

/** Weekly job: every company with saved Cockpit settings. */
export async function agentResearch(env: Env): Promise<ResearchResult> {
  const total: ResearchResult = { companies: 0, eligible: 0, opened: 0, alreadyOpened: 0, noCoach: 0, failed: 0 };
  for (const row of await listRoles(env.ctx)) {
    if (!(await configSaved(env.ctx, row.companyId))) continue;
    total.companies += 1;
    try {
      const r = await researchCompany(env, row.companyId);
      total.eligible += r.eligible;
      total.opened += r.opened;
      total.alreadyOpened += r.alreadyOpened;
      total.noCoach += r.noCoach;
    } catch (error) {
      total.failed += 1;
      env.ctx.logger.info("Agent research failed for a company", { companyId: row.companyId, error: message(error) });
    }
  }
  throwIfEveryCompanyFailed("The agent research", total.companies, total.failed);
  return total;
}
