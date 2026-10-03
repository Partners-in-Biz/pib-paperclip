/**
 * Agents that cannot use the company-memory tools (Q9-6, Q8-12), made visible
 * and fixable.
 *
 * An agent with no `tools:use` grant that reaches the memory tools cannot call
 * them, so it can never recall company memory, however much its skill tells it
 * to. Live (2026-10-03): Code Reviewer, Delivery Lead, Planner, PiB, Plan
 * Critic, Mac Builder, Summarizer and Wiki Maintainer. The wiki recorded the
 * grant as "left for Peet to approve" but no ask or issue ever put it in his
 * queue.
 *
 * The grant need not be wide. The host enforces `tools:use` scopes with
 * `toolNames` (exact tool names) and an `allow` list (`tool:<name>`), not only
 * the provider type (host `scopeAllowsTool`), so the recommended fix is a
 * MEMORY-ONLY grant (`MEMORY_TOOLS_GRANT`): the four memory tools and nothing
 * else. Granting all plugin tools (`PLUGIN_TOOLS_GRANT`) also opens CRM,
 * billing and payroll, so it is the alternative for an agent that really does
 * module work. The check therefore asks "can this agent call the tools it
 * needs" (default: the memory tools), and a memory-only grant satisfies it.
 *
 * What a plugin can do. It can detect this, and the Cockpit (which holds
 * `authorization.grants.write`) can apply the memory-only grant once the owner
 * says yes: `memoryGrantEffect` is the ask effect for that (register it with
 * `registerAskEffect(MEMORY_GRANT_EFFECT_KEY, memoryGrantEffect)`), and
 * `memoryGrantAsk` builds the ask. The Agents -> Permissions page has no field
 * for named tools, so without the effect the owner would have to call the API.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { agentDesiredSkills } from "./agent-hire.js";
import { COMPANY_OS_SKILL } from "./asking.js";
import type { AskEffectHandler, AskEffectInput } from "./ask-effects.js";
import { checkEffectParams } from "./ask-effects.js";
import type { HealthCheck, WaitingItem } from "./cockpit.js";
import { assignableUserId } from "./cockpit.js";
import { mergeMemoryToolsGrant, toolsMissing, type GrantLike } from "./grants.js";
import { MEMORY_AGENT_TOOLS } from "./memory.js";

export interface ToolsGrantProblem {
  agentId: string;
  agentName: string;
  /** `none`: no tools grant; `limited`: a grant that leaves some of the needed tools out. */
  state: "none" | "limited";
  /** The needed tools the agent cannot call (all of them when `none`). */
  missing: string[];
}

const GONE = new Set(["terminated", "archived", "deleted"]);

function carriesPibSkills(agent: Record<string, unknown>): boolean {
  return agentDesiredSkills(agent).some((key) => key === COMPANY_OS_SKILL.key || key.includes("partnersinbiz-") || key.endsWith(`/${COMPANY_OS_SKILL.slug}`));
}

/** The short names (`memory-recall`) for owner-facing text. */
function shortNames(tools: readonly string[]): string {
  return tools.map((name) => name.split(":").pop() ?? name).join(", ");
}

/**
 * Active agents that carry a PiB skill (so they are told to use PiB tools and
 * memory) but cannot call `requiredTools` (default: the memory tools). Agents
 * with no PiB skills are left out: they were never meant to. Returns
 * `unreadable` when grants cannot be read. A grant limited to named tools that
 * include the required ones is fine; so is an all-plugin-tools grant.
 */
export async function agentsWithoutPluginTools(
  ctx: PluginContext,
  companyId: string,
  options: { onlyWithPibSkills?: boolean; requiredTools?: readonly string[] } = {},
): Promise<{ problems: ToolsGrantProblem[]; checked: number; unreadable: boolean }> {
  const required = options.requiredTools ?? MEMORY_AGENT_TOOLS;
  const agents = (await ctx.agents.list({ companyId, limit: 200 })) as unknown as Array<Record<string, unknown>>;
  const problems: ToolsGrantProblem[] = [];
  let checked = 0;
  for (const agent of agents) {
    if (GONE.has(String(agent.status ?? ""))) continue;
    if (options.onlyWithPibSkills !== false && !carriesPibSkills(agent)) continue;
    checked += 1;
    try {
      const grants = await ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: String(agent.id) });
      const rows: GrantLike[] = grants.map((grant) => ({ permissionKey: String(grant.permissionKey), scope: (grant.scope as Record<string, unknown> | null) ?? null }));
      const missing = toolsMissing(rows, required);
      if (missing.length === 0) continue;
      const hasToolsGrant = rows.some((grant) => grant.permissionKey === "tools:use");
      problems.push({ agentId: String(agent.id), agentName: String(agent.name ?? "Agent"), state: hasToolsGrant ? "limited" : "none", missing });
    } catch {
      return { problems: [], checked, unreadable: true };
    }
  }
  return { problems, checked, unreadable: false };
}

/** Cockpit health check for agents that cannot use the tools they need (default: memory); null when none (or the grants cannot be read). */
export async function pluginToolsGrantCheck(ctx: PluginContext, companyId: string, options: { requiredTools?: readonly string[] } = {}): Promise<HealthCheck | null> {
  const required = options.requiredTools ?? MEMORY_AGENT_TOOLS;
  const { problems } = await agentsWithoutPluginTools(ctx, companyId, { requiredTools: required });
  if (problems.length === 0) return null;
  const names = problems.slice(0, 8).map((p) => p.agentName).join(", ");
  const memoryOnly = required === MEMORY_AGENT_TOOLS;
  return {
    key: "grants:plugin-tools",
    title: memoryOnly ? "Agents that cannot use company memory" : "Agents missing tool access",
    status: "warn",
    detail: `${problems.length} active agent${problems.length === 1 ? "" : "s"} carry PiB skills but cannot call ${memoryOnly ? "the memory tools" : "the tools they need"} (${shortNames(required)}), so ${problems.length === 1 ? "it" : "they"} never recall company memory: ${names}${problems.length > 8 ? ", ..." : ""}.`,
    fix: `Give each a tools:use grant limited to ${shortNames(required)}: the narrowest grant, it opens nothing else (the Needs-you item applies it when you say yes). Grant all plugin tools only to an agent that really works in the modules; that also opens CRM, billing and payroll.`,
    href: "/agents",
  };
}

/**
 * One batched Needs-you item for the owner: let these agents use company memory,
 * with the narrow option first and the wide one named. Null when there is
 * nothing to grant. `memoryGrantAsk` builds the matching ask with its effect.
 */
export function toolsGrantWaitingItem(problems: ToolsGrantProblem[], options: { prefix?: string | null; since?: string | null; requiredTools?: readonly string[] } = {}): WaitingItem | null {
  if (problems.length === 0) return null;
  const base = options.prefix ? `/${options.prefix}` : "";
  const required = options.requiredTools ?? MEMORY_AGENT_TOOLS;
  const many = problems.length !== 1;
  return {
    key: "grants:plugin-tools",
    title: `Let ${problems.length} agent${many ? "s" : ""} use company memory`,
    why: `${problems.map((p) => p.agentName).join(", ")} ${many ? "have" : "has"} PiB skills but cannot call the memory tools, so ${many ? "they" : "it"} never recall${many ? "" : "s"} what the company has learned. Recommended: a memory-only grant (tools:use limited to ${shortNames(required)}); it opens nothing else. Alternative, only for an agent that works in the modules: all plugin tools, which also opens CRM, billing and payroll.`,
    href: `${base}/agents`,
    kind: "grant",
    since: options.since ?? null,
  };
}

// ---------------------------------------------------------------------------
// Applying the memory-only grant (an ask effect the Cockpit registers)
// ---------------------------------------------------------------------------

/** The effect key an ask carries to have the memory-only grant applied to the agents it names. */
export const MEMORY_GRANT_EFFECT_KEY = "cockpit.grant-memory-tools";

export interface ApplyGrantResult {
  state: "added" | "already_present" | "conflict" | "failed";
  detail: string | null;
  /** Read back after the write: the agent can now call every memory tool. */
  verified: boolean;
}

/**
 * Gives one agent the memory tools and nothing more (`mergeMemoryToolsGrant`),
 * then reads the grants back to confirm. Needs `authorization.grants.read` and
 * `authorization.grants.write` (the Cockpit has both). An existing grant that
 * is limited some other way is not widened: `conflict`, for a person.
 */
export async function applyMemoryToolsGrant(ctx: PluginContext, companyId: string, agentId: string, options: { grantedByUserId?: string | null } = {}): Promise<ApplyGrantResult> {
  try {
    const read = async () => (await ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId })).map((g): GrantLike => ({ permissionKey: String(g.permissionKey), scope: (g.scope as Record<string, unknown> | null) ?? null }));
    const merged = mergeMemoryToolsGrant(await read());
    if (merged.conflict) return { state: "conflict", detail: merged.conflict, verified: false };
    if (!merged.changed) return { state: "already_present", detail: null, verified: true };
    await ctx.authorization.grants.set({
      companyId,
      principalType: "agent",
      principalId: agentId,
      grants: merged.grants as Parameters<PluginContext["authorization"]["grants"]["set"]>[0]["grants"],
      grantedByUserId: assignableUserId(options.grantedByUserId) ?? null,
    });
    return { state: "added", detail: null, verified: toolsMissing(await read(), MEMORY_AGENT_TOOLS).length === 0 };
  } catch (error) {
    return { state: "failed", detail: (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200), verified: false };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_GRANT_AGENTS = 20;

/** The agent ids an ask's effect names (`agentIds`: comma separated uuids). */
function grantAgentIds(input: AskEffectInput): string[] {
  const raw = input.ask.effect.params?.agentIds;
  return typeof raw === "string" ? [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))] : [];
}

/**
 * The ask effect that applies the memory-only grant: register it in the plugin
 * that holds `authorization.grants.write` (the Cockpit) with
 * `registerAskEffect(MEMORY_GRANT_EFFECT_KEY, memoryGrantEffect)`; the Cockpit
 * can call `runAskEffect` on its own asks directly, no event needed.
 *
 * It trusts nothing in the params (they come from the agent that asked): the
 * only accepted key is `agentIds`, a list of at most 20 uuids, and every id
 * must be an active agent of THIS company; the grant it writes is fixed (the
 * memory tools), never taken from the params.
 */
export const memoryGrantEffect: AskEffectHandler = {
  async validate(input) {
    const checked = checkEffectParams(input.ask.effect.params, { agentIds: { required: true, type: "string", maxLength: 20 * 37 } });
    if (!checked.ok) return checked.problems.join("; ");
    const ids = grantAgentIds(input);
    if (ids.length === 0 || ids.length > MAX_GRANT_AGENTS) return `name between 1 and ${MAX_GRANT_AGENTS} agents`;
    if (ids.some((id) => !UUID.test(id))) return "an agent id is not valid";
    for (const id of ids) {
      const agent = (await input.ctx.agents.get(id, input.companyId).catch(() => null)) as unknown as Record<string, unknown> | null;
      if (!agent || GONE.has(String(agent.status ?? ""))) return `agent ${id} is not an active agent of this company`;
    }
    return null;
  },
  async apply(input) {
    const results: string[] = [];
    const failed: string[] = [];
    for (const id of grantAgentIds(input)) {
      const agent = (await input.ctx.agents.get(id, input.companyId).catch(() => null)) as unknown as Record<string, unknown> | null;
      const name = String(agent?.name ?? id);
      const result = await applyMemoryToolsGrant(input.ctx, input.companyId, id, { grantedByUserId: input.ask.answeredByUserId });
      if (result.state === "added") results.push(`${name}: memory tools granted`);
      else if (result.state === "already_present") results.push(`${name}: already had them`);
      else failed.push(`${name}: ${result.detail ?? result.state}`);
    }
    if (failed.length > 0) throw new Error(`${failed.join("; ")}${results.length ? ` (done: ${results.join("; ")})` : ""}`);
    return { detail: `${results.join("; ")}. They can call ${shortNames(MEMORY_AGENT_TOOLS)} and nothing else.` };
  },
  async verify(input) {
    for (const id of grantAgentIds(input)) {
      const grants = await input.ctx.authorization.grants.list({ companyId: input.companyId, principalType: "agent", principalId: id });
      const missing = toolsMissing(grants.map((g) => ({ permissionKey: String(g.permissionKey), scope: (g.scope as Record<string, unknown> | null) ?? null })), MEMORY_AGENT_TOOLS);
      if (missing.length > 0) return { ok: false, detail: `agent ${id} still cannot call ${shortNames(missing)}` };
    }
    return true;
  },
};

/**
 * The ask the Cockpit opens (through `ask-owner`'s card, with its effect) so
 * the owner can answer once: memory-only (recommended), all plugin tools, or
 * no. It passes `askCardProblems` (a deep link and steps for a grant). Only the
 * first option has the effect; the second is for the owner to do by hand.
 */
export function memoryGrantAsk(problems: ToolsGrantProblem[], options: { prefix?: string | null } = {}) {
  const base = options.prefix ? `/${options.prefix}` : "";
  const names = problems.map((p) => p.agentName).join(", ");
  return {
    kind: "grant" as const,
    question: `May ${names} use company memory? They carry PiB skills but cannot call the memory tools.`,
    options: [
      `Yes: memory tools only (${shortNames(MEMORY_AGENT_TOOLS)})`,
      "Give them all plugin tools instead (also opens CRM, billing and payroll)",
      "No",
    ],
    links: [{ label: "Agents", href: `${base}/agents` }],
    steps: [
      "Answer yes and the Cockpit grants the four memory tools to each agent, then checks it worked.",
      "For all plugin tools instead: open the agent under Agents, then Permissions, and allow plugin tools yourself.",
    ],
    effect: { key: MEMORY_GRANT_EFFECT_KEY, params: { agentIds: problems.map((p) => p.agentId).slice(0, MAX_GRANT_AGENTS).join(",") } },
  };
}
