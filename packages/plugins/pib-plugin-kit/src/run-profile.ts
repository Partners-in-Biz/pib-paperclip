/**
 * A run profile per team role: model, effort, timeout, turn cap, concurrency
 * (Q8-7, Q9-7). Browser-safe (no node imports).
 *
 * Why. Nothing in the kit, the hire task or the ops scripts said which model
 * or limits an agent should have. Models were set by hand per agent; nine
 * agents were left unpinned, so they ran on the host default (Opus). 21 of 22
 * claude_local agents had no effective timeout (PiB and Steve had 0, which the
 * host reads as unlimited). Partners in Apps' 8 agents on default Opus burned
 * through a Claude limit in 20 minutes (69 failed runs on 2026-09-28).
 *
 * What a plugin can and cannot do. A plugin worker has no API to write an
 * agent's adapter or runtime settings (`ctx.agents` reads, pauses, resumes and
 * invokes only). So the profile travels in the hire task (`hireTaskDraft` prints
 * it as rows and a JSON block) for the hiring agent or the person to set, and
 * `unpinnedRunProfileCheck` tells the Cockpit about any agent that still has
 * none. Fixing an existing agent is a board action (Agents → Configuration, or
 * `PATCH /api/agents/<id>` with the FULL adapterConfig: the payload replaces it).
 */
import type { HealthCheck } from "./cockpit.js";
import type { TeamRoleKey } from "./team.js";

export type RunEffort = "low" | "medium" | "high";

export interface RunProfile {
  /** Model for the `claude_local` adapter, pinned so an agent never falls back to the host default (Opus). */
  model: string;
  /** The cheap Hermes pair for roles that may run on `hermes_local`; absent means use claude_local. */
  hermes?: { provider: string; model: string };
  effort: RunEffort;
  /** Wall-clock cap per run in seconds. Never 0: the host reads 0 as unlimited. */
  timeoutSec: number;
  /** Cap on agent turns per run. */
  maxTurnsPerRun: number;
  /** Runs of this agent at once (heartbeat `maxConcurrentRuns`). */
  maxConcurrentRuns: number;
}

export const CLAUDE_SONNET_MODEL = "claude-sonnet-5-5";
export const CLAUDE_HAIKU_MODEL = "claude-haiku-4-5";
export const HERMES_FLASH_MODEL = { provider: "nous", model: "deepseek/deepseek-v4-flash-0731" } as const;

/** For a role with no entry (a hire role the registry does not know): Sonnet, an hour, 3 at once. */
export const DEFAULT_RUN_PROFILE: RunProfile = { model: CLAUDE_SONNET_MODEL, effort: "medium", timeoutSec: 3600, maxTurnsPerRun: 200, maxConcurrentRuns: 3 };

const sonnet = (patch: Partial<RunProfile> = {}): RunProfile => ({ ...DEFAULT_RUN_PROFILE, ...patch });
const haiku = (patch: Partial<RunProfile> = {}): RunProfile => ({ ...DEFAULT_RUN_PROFILE, model: CLAUDE_HAIKU_MODEL, effort: "low", timeoutSec: 1800, ...patch });

/**
 * Defaults per team role. Sonnet for anything that writes to customers, money
 * or the books; the Reviewer is the quality gate for outward work, so Sonnet,
 * never Haiku. Cheap families (Haiku on Claude, DeepSeek flash on Hermes) only
 * for high-volume qualification and tidying work. SEO runs wide (6 at once,
 * per the SEO pacing rule) but with a turn cap, since its Hermes runs had none.
 */
export const RUN_PROFILES: Record<TeamRoleKey, RunProfile> = {
  operator: sonnet({ maxTurnsPerRun: 300, maxConcurrentRuns: 4 }),
  reviewer: sonnet({ maxTurnsPerRun: 200, maxConcurrentRuns: 4 }),
  "account-manager": sonnet({ maxTurnsPerRun: 250 }),
  "sales-lead": sonnet({ hermes: HERMES_FLASH_MODEL }),
  "inbound-qualifier": haiku({ hermes: HERMES_FLASH_MODEL, maxTurnsPerRun: 120, maxConcurrentRuns: 4 }),
  "crm-data-steward": haiku({ hermes: HERMES_FLASH_MODEL, maxTurnsPerRun: 150 }),
  "deal-desk": sonnet(),
  "seo-specialist": sonnet({ hermes: HERMES_FLASH_MODEL, maxConcurrentRuns: 6 }),
  social: sonnet(),
  bookkeeper: sonnet({ maxTurnsPerRun: 250 }),
  "payroll-clerk": sonnet(),
};

/** Hire role keys that differ from their team role key (Social's hire role is `social-media-manager`, its team role `social`). */
export const RUN_PROFILE_ALIASES: Record<string, TeamRoleKey> = { "social-media-manager": "social" };

/** The profile for a role key (a team role, or a hire role whose key is a team role or a known alias), else the default. */
export function runProfileForRole(roleKey: string | null | undefined): RunProfile {
  const key = roleKey ?? "";
  return (RUN_PROFILES as Record<string, RunProfile>)[RUN_PROFILE_ALIASES[key] ?? key] ?? DEFAULT_RUN_PROFILE;
}

/** The adapter and runtime settings that carry the profile, as the host stores them. */
export function runProfileConfig(profile: RunProfile, adapterType: "claude_local" | "hermes_local" | string = "claude_local"): { adapterConfig: Record<string, unknown>; runtimeConfig: Record<string, unknown> } {
  const hermes = adapterType === "hermes_local" && profile.hermes ? { provider: profile.hermes.provider, model: profile.hermes.model } : null;
  return {
    adapterConfig: { model: hermes ? hermes.model : profile.model, ...(hermes ? { provider: hermes.provider } : {}), effort: profile.effort, timeoutSec: profile.timeoutSec, maxTurnsPerRun: profile.maxTurnsPerRun },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: profile.maxConcurrentRuns } },
  };
}

/** The markdown table rows `hireTaskDraft` prints for the profile. */
export function runProfileRows(profile: RunProfile, adapterPreference: string[] = []): string[] {
  const hermes = profile.hermes ? `; on \`hermes_local\`: \`${profile.hermes.model}\` (provider \`${profile.hermes.provider}\`)` : "";
  const rows = [
    `| **Model** | \`${profile.model}\` on \`claude_local\`${hermes} |`,
    `| **Effort** | ${profile.effort} |`,
    `| **Run timeout** | ${profile.timeoutSec} s (never 0: 0 means unlimited) |`,
    `| **Max turns per run** | ${profile.maxTurnsPerRun} |`,
    `| **Concurrent runs** | ${profile.maxConcurrentRuns} |`,
  ];
  if (!profile.hermes && adapterPreference[0] === "hermes_local") rows.push("| **Adapter note** | Choose `claude_local` for this role: it has no recommended Hermes model. |");
  return rows;
}

/** The paragraph and JSON block under the hire table: what to set, and why it cannot be set afterwards by the plugin. */
export function runProfileHireText(profile: RunProfile, adapterPreference: string[] = []): string {
  const adapter = adapterPreference[0] === "hermes_local" && profile.hermes ? "hermes_local" : "claude_local";
  const config = runProfileConfig(profile, adapter);
  return [
    "**Set the run profile when you create the agent** (adapter settings `model`, `effort`, `timeoutSec`, `maxTurnsPerRun`, and the heartbeat's `maxConcurrentRuns`). The plugin cannot change an agent's settings after the hire, and an agent created without them runs on the host default model (Opus) with no time limit.",
    "",
    "```json",
    JSON.stringify(config, null, 2),
    "```",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Finding agents with no profile
// ---------------------------------------------------------------------------

export interface AgentRunLike {
  id: string;
  name: string;
  status?: string | null;
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
  runtimeConfig?: Record<string, unknown> | null;
}

const GONE = new Set(["terminated", "archived", "deleted"]);

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** What is missing from one agent's run profile (claude_local agents only; others return []). */
export function agentRunProfileProblems(agent: AgentRunLike, options: { adapters?: string[] } = {}): string[] {
  const adapters = options.adapters ?? ["claude_local"];
  if (!agent.adapterType || !adapters.includes(agent.adapterType) || GONE.has(String(agent.status ?? ""))) return [];
  const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (!textValue(config.model)) problems.push("no model pinned (runs on the host default, Opus)");
  const timeout = Number(config.timeoutSec);
  if (!Number.isFinite(timeout) || timeout <= 0) problems.push("no run timeout (0 or unset means unlimited)");
  const turns = Number(config.maxTurnsPerRun);
  if (Number.isFinite(turns) && turns >= 1000) problems.push(`turn cap ${turns} is no cap`);
  return problems;
}

/**
 * Cockpit health check: agents with no pinned model or no run timeout. Warn
 * only; the fix is a board action (a plugin cannot write agent settings).
 * Returns null when every agent has a profile.
 */
export function unpinnedRunProfileCheck(agents: AgentRunLike[], options: { adapters?: string[] } = {}): HealthCheck | null {
  const flagged = agents.map((agent) => ({ agent, problems: agentRunProfileProblems(agent, options) })).filter((entry) => entry.problems.length > 0);
  if (flagged.length === 0) return null;
  const lines = flagged.slice(0, 8).map(({ agent, problems }) => `${agent.name}: ${problems.join(", ")}`);
  return {
    key: "agents:run-profile",
    title: "Agents with no run profile",
    status: "warn",
    detail: `${flagged.length} agent${flagged.length === 1 ? " has" : "s have"} no pinned model or run timeout, so ${flagged.length === 1 ? "it" : "they"} can burn the subscription on the default model or run without a time limit. ${lines.join("; ")}${flagged.length > 8 ? "; ..." : ""}.`,
    fix: "Open each agent's Configuration, set the model and a run timeout from its role's run profile (Setup → Team shows it). A plugin cannot change agent settings; PATCH /api/agents/<id> must send the full adapterConfig.",
    href: "/agents",
  };
}
