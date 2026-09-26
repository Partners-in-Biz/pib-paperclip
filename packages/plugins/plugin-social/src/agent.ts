/**
 * Managed "Social Media Manager" agent.
 *
 * `permissions.pluginTools` is not enforced by the host and the tool gateway
 * denies by default, so activation merges a `tools:use` grant scoped to
 * Paperclip plugin tools into the agent's existing grants (grants.set
 * replaces the whole set, so existing grants are kept).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { socialAgent } from "./issues.js";
import { PLAN_ROUTINE_KEY, SOCIAL_AGENT_KEY, SOCIAL_PROJECT_KEY } from "./platforms.js";

export { PLAN_ROUTINE_KEY };
export const TOOLS_GRANT = { permissionKey: "tools:use" as const, scope: { providerType: "paperclip_plugin" } };

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

export async function activateAgent(ctx: PluginContext, companyId: string, userId: string | null) {
  const resolution = await ctx.agents.managed.reconcile(SOCIAL_AGENT_KEY, companyId);
  const agentId = resolution.agentId;
  const status = resolution.agent?.status ?? null;
  if (!agentId) {
    return {
      ok: false,
      agentId: null,
      status,
      approvalId: resolution.approvalId ?? null,
      message: resolution.approvalId
        ? "The Social Media Manager hire is waiting for board approval. Approve it under Approvals, then click Activate again."
        : "The Social Media Manager agent could not be created. Check the plugin's agent settings.",
    };
  }
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
  let routine: string | null = null;
  try {
    await ctx.projects.managed.reconcile(SOCIAL_PROJECT_KEY, companyId);
    const r = await ctx.routines.managed.reconcile(PLAN_ROUTINE_KEY, companyId, { assigneeAgentId: agentId });
    routine = r.status;
  } catch (error) {
    ctx.logger.info("Social routine reconcile skipped", { error: error instanceof Error ? error.message : String(error) });
  }
  const paused = status === "paused" || status === "pending_approval";
  return {
    ok: true,
    agentId,
    status,
    approvalId: resolution.approvalId ?? null,
    toolsGrantAdded: merged.added,
    routine,
    message: [
      merged.added ? "Plugin tool access granted to the Social Media Manager." : "The Social Media Manager already has plugin tool access.",
      status === "pending_approval" ? "Approve the hire under Approvals first." : null,
      paused ? "Open the agent and click Resume to start it. The weekly planning routine stays paused until you enable its trigger." : null,
    ].filter(Boolean).join(" "),
  };
}

export async function agentSummary(ctx: PluginContext, companyId: string) {
  const agent = await socialAgent(ctx, companyId);
  return { agentKey: SOCIAL_AGENT_KEY, agentId: agent.agentId, status: agent.status, active: agent.active };
}
