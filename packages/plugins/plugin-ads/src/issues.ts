/**
 * Paperclip issues opened by the ads plugin. Agent-assigned issues are `todo` and woken (kit `createWorkIssue`: plugin-created issues
 * do not wake on their own). Client work opens in the client's own project (Q1a-12), PiB's own in the managed Ads project.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createWorkIssue, linkedAgentId, ownerUserFor, resolveClientProjectId, routeWork } from "@partnersinbiz/pib-plugin-kit";
import { scopeOfKey } from "./domain.js";
import { ADS_HIRE_ROLE } from "./hire.js";
import { ADS_ORIGINS, ADS_PROJECT_KEY, PLUGIN_ID, type ScopeKey } from "./platforms.js";

export const ORIGIN_KIND = `plugin:${PLUGIN_ID}` as const;

const INACTIVE_AGENT = new Set(["paused", "terminated", "pending_approval", "archived", "deleted"]);

export function agentStatusActive(status: string | null | undefined): boolean {
  return Boolean(status && !INACTIVE_AGENT.has(status));
}

export interface AdsAssignee {
  assigneeAgentId?: string;
  assigneeUserId?: string;
  /** `ads` (the ads agent), `operator`, `owner`, or `none`. */
  via: string;
}

/** The agent linked through Setup -> Team and whether it runs. */
export async function adsAgent(ctx: PluginContext, companyId: string): Promise<{ agentId: string | null; active: boolean; status: string | null }> {
  try {
    const agentId = await linkedAgentId(ctx, companyId, ADS_HIRE_ROLE);
    if (!agentId) return { agentId: null, active: false, status: null };
    const agent = await ctx.agents.get(agentId, companyId);
    const status = agent?.status ?? null;
    return { agentId, active: agentStatusActive(status), status };
  } catch {
    return { agentId: null, active: false, status: null };
  }
}

/** Ads agent work: the linked ads agent when it runs, else the Operator, else the owner. Never left unassigned when anyone exists. */
export async function adsAssignee(ctx: PluginContext, companyId: string): Promise<AdsAssignee> {
  const agent = await adsAgent(ctx, companyId);
  if (agent.active && agent.agentId) return { assigneeAgentId: agent.agentId, via: "ads" };
  const route = await routeWork(ctx, companyId, []).catch(() => null);
  if (route?.assigneeAgentId) return { assigneeAgentId: route.assigneeAgentId, via: route.via };
  if (route?.assigneeUserId) return { assigneeUserId: route.assigneeUserId, via: "owner" };
  return { via: "none" };
}

/** Account Manager work (asking a client): the Account Manager role, then the Operator, then the owner. */
export async function accountManagerAssignee(ctx: PluginContext, companyId: string): Promise<AdsAssignee> {
  const route = await routeWork(ctx, companyId, ["account-manager"]).catch(() => null);
  if (route?.assigneeAgentId) return { assigneeAgentId: route.assigneeAgentId, via: route.via };
  if (route?.assigneeUserId) return { assigneeUserId: route.assigneeUserId, via: "owner" };
  return { via: "none" };
}

/** A person decides (a reconnect, a sign-in): the company owner. */
export async function ownerAssignee(ctx: PluginContext, companyId: string): Promise<AdsAssignee> {
  const owner = await ownerUserFor(ctx, companyId, { lastKnown: true }).catch(() => ({ userId: null }));
  if (owner.userId) return { assigneeUserId: owner.userId, via: "owner" };
  return adsAssignee(ctx, companyId);
}

export async function adsProjectId(ctx: PluginContext, companyId: string): Promise<string | undefined> {
  try {
    const res = await ctx.projects.managed.get(ADS_PROJECT_KEY, companyId);
    return res.projectId ?? undefined;
  } catch {
    return undefined;
  }
}

/** Creates the managed Ads project when it is missing (called from the company bootstrap). */
export async function ensureAdsProject(ctx: PluginContext, companyId: string): Promise<void> {
  await ctx.projects.managed.reconcile(ADS_PROJECT_KEY, companyId);
}

/** The project a scope's issue opens in: the client's own, else the Ads project. */
export async function projectForScope(ctx: PluginContext, companyId: string, scopeKey: ScopeKey): Promise<string | undefined> {
  const fallback = (await adsProjectId(ctx, companyId)) ?? null;
  try {
    const choice = await resolveClientProjectId(ctx, companyId, scopeOfKey(scopeKey), { fallbackProjectId: fallback });
    return choice.projectId ?? undefined;
  } catch {
    return fallback ?? undefined;
  }
}

/**
 * Opens an issue once per origin id: a retried job or event must not open a second one. Returns the existing issue's id when there is one
 * (open or closed: a closed alert issue is not reopened by the next sync that sees the same alert).
 */
export async function openIssueOnce(
  ctx: PluginContext,
  input: { companyId: string; originId: string; title: string; description: string; assignee: AdsAssignee; wakeReason: string; projectId?: string | null; priority?: "low" | "medium" | "high" | "critical" },
): Promise<{ id: string; created: boolean }> {
  try {
    const existing = await ctx.issues.list({ companyId: input.companyId, originKind: ORIGIN_KIND, originId: input.originId, limit: 1 });
    if (existing[0]) return { id: existing[0].id, created: false };
  } catch {
    // Listing is a best-effort guard; the create below is idempotent enough (one issue per sweep).
  }
  const assignee = { ...(input.assignee.assigneeAgentId ? { assigneeAgentId: input.assignee.assigneeAgentId } : {}), ...(input.assignee.assigneeUserId ? { assigneeUserId: input.assignee.assigneeUserId } : {}) };
  const create = (projectId: string | null | undefined) =>
    createWorkIssue(ctx, {
      companyId: input.companyId,
      title: input.title.slice(0, 200),
      description: input.description,
      originKind: ORIGIN_KIND,
      originId: input.originId,
      ...(projectId ? { projectId } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...assignee,
      wakeReason: input.wakeReason,
    });
  try {
    return { id: (await create(input.projectId)).id, created: true };
  } catch (error) {
    // The client's project may be gone or archived: the work still has to reach someone, so it opens without a project.
    if (!input.projectId) throw error;
    ctx.logger.info("Ads issue opened without its project", { originId: input.originId, error: error instanceof Error ? error.message : String(error) });
    return { id: (await create(null)).id, created: true };
  }
}

/** Comment on an issue; a failure is logged, never thrown (the work it describes already happened). */
export async function note(ctx: PluginContext, companyId: string, issueId: string | null | undefined, body: string): Promise<void> {
  if (!issueId) return;
  try {
    await ctx.issues.createComment(issueId, body, companyId);
  } catch (error) {
    ctx.logger.info("Ads comment skipped", { issueId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Closes an issue the plugin opened when its cause is gone. Never throws. */
export async function closeIssue(ctx: PluginContext, companyId: string, issueId: string | null | undefined, status: "done" | "cancelled", why: string): Promise<void> {
  if (!issueId) return;
  try {
    await ctx.issues.update(issueId, { status }, companyId);
    await note(ctx, companyId, issueId, why);
  } catch (error) {
    ctx.logger.info("Ads issue could not be closed", { issueId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Closes the "run the approved change" issue of a proposal, if one was opened. */
export async function closeRunIssue(ctx: PluginContext, companyId: string, proposalId: string, why: string): Promise<void> {
  try {
    const found = await ctx.issues.list({ companyId, originKind: ORIGIN_KIND, originId: `${ADS_ORIGINS.run}${proposalId}`, limit: 1 });
    if (found[0] && found[0].status !== "done" && found[0].status !== "cancelled") await closeIssue(ctx, companyId, found[0].id, "done", why);
  } catch (error) {
    ctx.logger.info("Ads run issue could not be closed", { proposalId, error: error instanceof Error ? error.message : String(error) });
  }
}
