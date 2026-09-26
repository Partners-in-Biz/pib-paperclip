/**
 * The Social agent. It is hired through a normal Paperclip task (kit
 * agent-hire) or linked by hand; the plugin never creates it directly. Once
 * linked, `wireAgent` sets it up.
 *
 * `permissions.pluginTools` is not enforced by the host and the tool gateway
 * denies by default, so wiring merges a `tools:use` grant scoped to Paperclip
 * plugin tools into the agent's existing grants (grants.set replaces the
 * whole set, so existing grants are kept).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  hireStatus,
  hireTaskDraft,
  linkedAgentId,
  listCompanyAgents,
  tryLinkPendingHire,
  type HireAgentSummary,
  type HireRecord,
  type HireState,
  type OnAgentLinked,
} from "@partnersinbiz/pib-plugin-kit";
import { SocialError } from "./domain.js";
import { legacySocialAgent, missingSocialSkills, skillsHint, SOCIAL_AGENT_NAME, SOCIAL_HIRE_ROLE, SOCIAL_SKILLS } from "./hire.js";
import { agentStatusActive } from "./issues.js";
import { PLAN_ROUTINE_KEY, SOCIAL_AGENT_KEY, SOCIAL_PROJECT_KEY } from "./platforms.js";

export { PLAN_ROUTINE_KEY };
export const TOOLS_GRANT = { permissionKey: "tools:use" as const, scope: { providerType: "paperclip_plugin" } };
const ROUTINE_TITLE = "\"Plan next week's social\"";

function sameScope(a: Record<string, unknown> | null | undefined, b: Record<string, unknown>): boolean {
  const norm = (v: Record<string, unknown> | null | undefined) => JSON.stringify(Object.keys(v ?? {}).sort().map((k) => [k, (v ?? {})[k]]));
  return norm(a) === norm(b);
}

/** Merge the tools grant into existing grants without duplicating it. */
export function mergeToolsGrant(existing: Array<{ permissionKey: string; scope: Record<string, unknown> | null }>) {
  const grants = existing.map((g) => ({ permissionKey: g.permissionKey, scope: g.scope ?? null }));
  const covered = grants.some((g) => g.permissionKey === "tools:use" && (!g.scope || Object.keys(g.scope).length === 0 || sameScope(g.scope, TOOLS_GRANT.scope)));
  return { grants: covered ? grants : [...grants, { ...TOOLS_GRANT }], added: !covered };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Project, then the weekly routine assigned to the agent (reassigned when it belongs to another agent). */
async function wireRoutine(ctx: PluginContext, companyId: string, agentId: string, name: string): Promise<{ status: string | null; step: string }> {
  const retry = "Click Re-sync on the Social page to try again.";
  try {
    await ctx.projects.managed.reconcile(SOCIAL_PROJECT_KEY, companyId);
    const current = await ctx.routines.managed.get(PLAN_ROUTINE_KEY, companyId);
    if (!current.routine) {
      const created = await ctx.routines.managed.reconcile(PLAN_ROUTINE_KEY, companyId, { assigneeAgentId: agentId });
      if (!created.routine) return { status: created.status, step: `The weekly ${ROUTINE_TITLE} routine could not be created (${created.status}). ${retry}` };
      return { status: created.status, step: `Created the weekly ${ROUTINE_TITLE} routine for ${name}. Its Monday trigger stays off until you enable it under Routines.` };
    }
    if (current.routine.assigneeAgentId === agentId) {
      await ctx.routines.managed.reconcile(PLAN_ROUTINE_KEY, companyId, { assigneeAgentId: agentId });
      return { status: "resolved", step: `The weekly ${ROUTINE_TITLE} routine is assigned to ${name}.` };
    }
    // reconcile never changes an existing routine; reset does, and puts it back to the declared (paused) status.
    const previous = current.routine.status;
    const reset = await ctx.routines.managed.reset(PLAN_ROUTINE_KEY, companyId, { assigneeAgentId: agentId });
    if (!reset.routine) return { status: reset.status, step: `The weekly ${ROUTINE_TITLE} routine could not be reassigned (${reset.status}). ${retry}` };
    let restored = !previous || reset.routine.status === previous;
    if (!restored) {
      try {
        await ctx.routines.managed.update(PLAN_ROUTINE_KEY, companyId, { status: previous });
        restored = true;
      } catch (error) {
        ctx.logger.info("Social routine status restore skipped", { error: errorMessage(error) });
      }
    }
    return {
      status: "reassigned",
      step: `Reassigned the weekly ${ROUTINE_TITLE} routine to ${name}.${restored ? "" : ` It was ${previous} and is now ${reset.routine.status}; switch it back under Routines.`}`,
    };
  } catch (error) {
    ctx.logger.info("Social routine wiring skipped", { error: errorMessage(error) });
    return { status: null, step: `The weekly ${ROUTINE_TITLE} routine was not set up: ${errorMessage(error)}. ${retry}` };
  }
}

export interface WireResult {
  agentId: string;
  name: string;
  status: string | null;
  toolsGrantAdded: boolean;
  routine: string | null;
  /** Social skill slugs the agent does not have. */
  missingSkills: string[];
  /** One human-readable line per step (posted on the hire task). */
  steps: string[];
}

/**
 * Sets up a linked agent: plugin tool grant, Social project, weekly routine.
 * Never creates an agent. An existing agent keeps its own skills; the steps
 * say which social skills a person still has to attach.
 */
export async function wireAgent(ctx: PluginContext, companyId: string, agentId: string, userId: string | null): Promise<WireResult> {
  const agent = await ctx.agents.get(agentId, companyId);
  if (!agent) throw new SocialError("That agent was not found in this company.");
  const name = agent.name || SOCIAL_AGENT_NAME;
  const existing = await ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId });
  const merged = mergeToolsGrant(existing as Array<{ permissionKey: string; scope: Record<string, unknown> | null }>);
  if (merged.added) {
    await ctx.authorization.grants.set({
      companyId,
      principalType: "agent",
      principalId: agentId,
      grants: merged.grants as Parameters<PluginContext["authorization"]["grants"]["set"]>[0]["grants"],
      grantedByUserId: userId,
    });
  }
  const steps = [merged.added ? `Granted ${name} access to plugin tools (Social and CRM).` : `${name} already has plugin tool access.`];
  const routine = await wireRoutine(ctx, companyId, agentId, name);
  steps.push(routine.step);
  const missingSkills = missingSocialSkills(agent);
  steps.push(skillsHint(name, missingSkills) ?? `${name} has the ${SOCIAL_SKILLS.map((s) => `\`${s.slug}\``).join(" and ")} skills.`);
  return { agentId, name, status: agent.status ?? null, toolsGrantAdded: merged.added, routine: routine.status, missingSkills, steps };
}

/** What a person must still do before the agent works, or null. */
export function resumeHint(name: string, status: string | null): string | null {
  if (status === "pending_approval") return `${name} is waiting for board approval. Approve it under Approvals, then resume it.`;
  if (status === "paused") return `${name} is paused. Open it and click Resume once its adapter has a working model key.`;
  return null;
}

/** The hook the kit calls once an agent is linked (auto or by hand). */
export function onSocialAgentLinked(ctx: PluginContext): OnAgentLinked {
  return async (companyId, agentId, by) => (await wireAgent(ctx, companyId, agentId, by.userId)).steps;
}

/** Links an open hire when its agent has appeared. Never throws (page load and jobs call it). */
export async function tryLinkSocialHire(ctx: PluginContext, companyId: string): Promise<void> {
  try {
    await tryLinkPendingHire(ctx, companyId, SOCIAL_HIRE_ROLE, onSocialAgentLinked(ctx));
  } catch (error) {
    ctx.logger.info("Social hire link check failed", { companyId, error: errorMessage(error) });
  }
}

/** "Re-sync": wire the already linked agent again. */
export async function resyncAgent(ctx: PluginContext, companyId: string, userId: string | null) {
  const agentId = await linkedAgentId(ctx, companyId, SOCIAL_HIRE_ROLE, legacySocialAgent(ctx));
  if (!agentId) {
    throw new SocialError("No Social agent is linked yet. Use \"Hire Social agent\" to open a hire task, or \"Use an existing agent\" to link one you already have.");
  }
  const result = await wireAgent(ctx, companyId, agentId, userId);
  return { ok: true, ...result, message: [...result.steps, resumeHint(result.name, result.status)].filter(Boolean).join(" ") };
}

export interface SocialAgentSummary {
  agentKey: string;
  agentId: string | null;
  name: string | null;
  status: string | null;
  active: boolean;
  linkedBy: HireState["linkedBy"];
  /** The latest hire task (own page only). */
  hire: HireRecord | null;
  /** New agents that match an open hire when more than one does (own page only). */
  candidates: HireAgentSummary[];
  missingSkills: string[];
}

/** The agent card on the Social page. `hire: false` (client workspaces) skips the hire lookup. */
export async function agentSummary(ctx: PluginContext, companyId: string, options: { hire?: boolean } = {}): Promise<SocialAgentSummary> {
  const summary: SocialAgentSummary = {
    agentKey: SOCIAL_AGENT_KEY,
    agentId: null,
    name: null,
    status: null,
    active: false,
    linkedBy: null,
    hire: null,
    candidates: [],
    missingSkills: [],
  };
  try {
    let agentId: string | null;
    if (options.hire === false) {
      agentId = await linkedAgentId(ctx, companyId, SOCIAL_HIRE_ROLE, legacySocialAgent(ctx));
    } else {
      const status = await hireStatus(ctx, companyId, SOCIAL_HIRE_ROLE, legacySocialAgent(ctx));
      agentId = status.agent?.id ?? null;
      summary.linkedBy = status.linkedBy;
      summary.hire = status.hire;
      summary.candidates = status.candidates;
    }
    const agent = agentId ? await ctx.agents.get(agentId, companyId) : null;
    if (agent) {
      summary.agentId = agent.id;
      summary.name = agent.name || SOCIAL_AGENT_NAME;
      summary.status = agent.status ?? null;
      summary.active = agentStatusActive(agent.status);
      summary.missingSkills = missingSocialSkills(agent);
    }
  } catch (error) {
    ctx.logger.info("Social agent summary skipped", { companyId, error: errorMessage(error) });
  }
  return summary;
}

/** Everything the hire popup and the link picker need. */
export async function hireOptions(ctx: PluginContext, companyId: string) {
  const [agents, raw, status] = await Promise.all([
    listCompanyAgents(ctx, companyId),
    ctx.agents.list({ companyId, limit: 200 }),
    hireStatus(ctx, companyId, SOCIAL_HIRE_ROLE, legacySocialAgent(ctx)),
  ]);
  const missing = new Map(raw.map((agent) => [agent.id, missingSocialSkills(agent)]));
  const allSlugs = SOCIAL_SKILLS.map((s) => s.slug);
  return {
    draft: hireTaskDraft(SOCIAL_HIRE_ROLE),
    agents: agents.map((agent) => ({ ...agent, missingSkills: missing.get(agent.id) ?? allSlugs })),
    defaultAssigneeAgentId: agents.find((agent) => agent.role === "ceo")?.id ?? null,
    status,
  };
}
