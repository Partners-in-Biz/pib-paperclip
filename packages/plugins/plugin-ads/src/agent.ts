/**
 * The ads agent. It is hired through a normal Paperclip task (kit agent-hire) or linked by hand; the plugin never creates it directly.
 * Once linked, `wireAgent` sets it up: plugin tool access (kit `mergePluginToolsGrant`: the host keeps ONE `tools:use` grant per agent and
 * `grants.set` replaces the whole set, so the existing grant is widened, never a second one added) and the Ads project.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  hireStatus,
  hireTaskDraft,
  linkedAgentId,
  listCompanyAgents,
  mergePluginToolsGrant,
  tryLinkPendingHire,
  type GrantLike,
  type HireAgentSummary,
  type HireRecord,
  type HireState,
  type MergedGrants,
  type OnAgentLinked,
} from "@partnersinbiz/pib-plugin-kit";
import { AdsError, errorMessage } from "./domain.js";
import { ADS_AGENT_NAME, ADS_HIRE_ROLE, ADS_MATCH_ROLE, ADS_ROLE_SKILLS, missingAdsSkills, skillsHint } from "./hire.js";
import { agentStatusActive, ensureAdsProject } from "./issues.js";

/** The agent's grants with plugin tool access merged in. */
export function mergeToolsGrant(existing: GrantLike[]): MergedGrants {
  return mergePluginToolsGrant(existing);
}

export interface WireResult {
  agentId: string;
  name: string;
  status: string | null;
  toolsGrantAdded: boolean;
  toolsGrantConflict: string | null;
  missingSkills: string[];
  /** One human-readable line per step (posted on the hire task). */
  steps: string[];
}

export async function wireAgent(ctx: PluginContext, companyId: string, agentId: string, userId: string | null): Promise<WireResult> {
  const agent = await ctx.agents.get(agentId, companyId);
  if (!agent) throw new AdsError("That agent was not found in this company.");
  const name = agent.name || ADS_AGENT_NAME;
  const existing = await ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId });
  const merged = mergeToolsGrant(existing.map((g) => ({ permissionKey: String(g.permissionKey), scope: (g.scope as Record<string, unknown> | null) ?? null })));
  if (merged.changed) {
    await ctx.authorization.grants.set({
      companyId,
      principalType: "agent",
      principalId: agentId,
      grants: merged.grants as Parameters<PluginContext["authorization"]["grants"]["set"]>[0]["grants"],
      grantedByUserId: userId,
    });
  }
  const steps = [
    merged.conflict
      ? `${name} cannot use the ads tools yet. ${merged.conflict}`
      : merged.changed
        ? `Granted ${name} access to plugin tools (Paid ads and CRM).`
        : `${name} already has plugin tool access.`,
  ];
  try {
    await ensureAdsProject(ctx, companyId);
    steps.push("The Ads project is ready for PiB's own ads issues.");
  } catch (error) {
    steps.push(`The Ads project could not be created (${errorMessage(error)}). Re-sync the agent in Setup -> Team to try again.`);
  }
  const missingSkills = missingAdsSkills(agent);
  const all = ADS_ROLE_SKILLS.map((s) => `\`${s.slug}\``);
  steps.push(skillsHint(name, missingSkills) ?? `${name} has the ${all.slice(0, -1).join(", ")} and ${all[all.length - 1]} skills.`);
  return { agentId, name, status: agent.status ?? null, toolsGrantAdded: merged.changed && !merged.conflict, toolsGrantConflict: merged.conflict, missingSkills, steps };
}

/** What a person must still do before the agent works, or null. */
export function resumeHint(name: string, status: string | null): string | null {
  if (status === "pending_approval") return `${name} is waiting for board approval. Approve it under Approvals, then resume it.`;
  if (status === "paused") return `${name} is paused. Open it and click Resume once its adapter has a working model key.`;
  return null;
}

/** The hook the kit calls once an agent is linked (auto or by hand). */
export function onAdsAgentLinked(ctx: PluginContext): OnAgentLinked {
  return async (companyId, agentId, by) => (await wireAgent(ctx, companyId, agentId, by.userId)).steps;
}

/** Links an open hire when its agent has appeared. Never throws (page load and jobs call it). */
export async function tryLinkAdsHire(ctx: PluginContext, companyId: string): Promise<void> {
  try {
    await tryLinkPendingHire(ctx, companyId, ADS_MATCH_ROLE, onAdsAgentLinked(ctx));
  } catch (error) {
    ctx.logger.info("Ads hire link check failed", { companyId, error: errorMessage(error) });
  }
}

/** "Re-sync": wire the already linked agent again. */
export async function resyncAgent(ctx: PluginContext, companyId: string, userId: string | null) {
  const agentId = await linkedAgentId(ctx, companyId, ADS_HIRE_ROLE);
  if (!agentId) throw new AdsError("No ads agent is linked yet. Hire one or pick an agent you already have in Setup -> Team.");
  const result = await wireAgent(ctx, companyId, agentId, userId);
  return { ok: true, ...result, message: [...result.steps, resumeHint(result.name, result.status)].filter(Boolean).join(" ") };
}

export interface AdsAgentSummary {
  agentId: string | null;
  name: string | null;
  status: string | null;
  active: boolean;
  linkedBy: HireState["linkedBy"];
  hire: HireRecord | null;
  candidates: HireAgentSummary[];
  missingSkills: string[];
}

/** The agent box on the Ads page (shown when something is wrong). */
export async function agentSummary(ctx: PluginContext, companyId: string): Promise<AdsAgentSummary> {
  const summary: AdsAgentSummary = { agentId: null, name: null, status: null, active: false, linkedBy: null, hire: null, candidates: [], missingSkills: [] };
  try {
    const status = await hireStatus(ctx, companyId, ADS_MATCH_ROLE);
    summary.linkedBy = status.linkedBy;
    summary.hire = status.hire;
    summary.candidates = status.candidates;
    const agent = status.agent ? await ctx.agents.get(status.agent.id, companyId) : null;
    if (agent) {
      summary.agentId = agent.id;
      summary.name = agent.name || ADS_AGENT_NAME;
      summary.status = agent.status ?? null;
      summary.active = agentStatusActive(agent.status);
      summary.missingSkills = missingAdsSkills(agent);
    }
  } catch (error) {
    ctx.logger.info("Ads agent summary skipped", { companyId, error: errorMessage(error) });
  }
  return summary;
}

/** Everything the hire popup and the link picker need. */
export async function hireOptions(ctx: PluginContext, companyId: string) {
  const [agents, raw, status] = await Promise.all([listCompanyAgents(ctx, companyId), ctx.agents.list({ companyId, limit: 200 }), hireStatus(ctx, companyId, ADS_MATCH_ROLE)]);
  const missing = new Map(raw.map((agent) => [agent.id, missingAdsSkills(agent)]));
  const allSlugs = ADS_ROLE_SKILLS.map((s) => s.slug);
  return {
    draft: hireTaskDraft(ADS_HIRE_ROLE),
    agents: agents.map((agent) => ({ ...agent, missingSkills: missing.get(agent.id) ?? allSlugs })),
    defaultAssigneeAgentId: agents.find((agent) => agent.role === "ceo")?.id ?? null,
    status,
  };
}
