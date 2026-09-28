/**
 * Who gets a CRM issue. Every issue the CRM opens has an assignee:
 *
 * - work: the record's explicit owner when it has one and can work (its
 *   agent, or a person), else the role for that kind of work: new leads the
 *   Inbound Qualifier, pipeline hand-offs the Sales Lead, duplicates the Data
 *   Steward, everything else the Account Manager. A sales role with no agent
 *   falls back to the Account Manager, then the Operator, then the owner;
 * - approvals: only a person decides, so the Reviewer checks first when there
 *   is one, else the company owner.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { companyRoles, readConfig, reviewerAgentId, roleAgentUsable, routeWork, teamRoleChain } from "@partnersinbiz/pib-plugin-kit";
import { CRM_HIRE_ROLES, isCrmRoleKey, roleAgent, type CrmRoleKey } from "./agent.js";
import { LOCAL_BOARD_USER_ID } from "./domain.js";

export interface Assignee {
  assigneeAgentId?: string;
  assigneeUserId?: string;
}

/** `contact` (default): an explicit owner first. `team`: always the Account Manager. Old `none` counts as `team`. */
export type AssigneeMode = "contact" | "team";

export async function assigneeMode(ctx: PluginContext, companyId: string): Promise<AssigneeMode> {
  try {
    const value = (await readConfig(ctx, companyId)).sequenceIssueAssignee;
    return value === "team" || value === "none" ? "team" : "contact";
  } catch {
    return "contact";
  }
}

/** True when the agent exists and is not paused, in error, awaiting approval or gone. */
export async function agentCanWork(ctx: PluginContext, companyId: string, agentId: string): Promise<boolean> {
  try {
    const agent = await ctx.agents.get(agentId, companyId);
    return Boolean(agent) && roleAgentUsable(String(agent!.status ?? ""));
  } catch {
    return false;
  }
}

/**
 * A role's agent, else the roles covering it (kit `teamRoleChain`: a sales
 * role falls back to the Account Manager), then the Operator, then the owner.
 * The CRM staffs these roles, so its own linked agents count at once, before
 * the Cockpit has shared them in `roles.updated`. Empty only when the company
 * has none of them.
 */
export async function teamAssignee(ctx: PluginContext, companyId: string, role: CrmRoleKey = "account-manager"): Promise<Assignee> {
  const chain = teamRoleChain(role);
  for (const key of chain) {
    if (!isCrmRoleKey(key)) continue;
    const own = await roleAgent(ctx, companyId, CRM_HIRE_ROLES[key]);
    if (own && roleAgentUsable(own.status)) return { assigneeAgentId: own.id };
  }
  const route = await routeWork(ctx, companyId, chain);
  if (route.assigneeAgentId) return { assigneeAgentId: route.assigneeAgentId };
  if (route.assigneeUserId) return { assigneeUserId: route.assigneeUserId };
  return {};
}

/**
 * Work about a contact or deal: its explicit owner when set (an agent that can
 * work, or a person), else the team route. `team` mode skips the owner.
 */
export async function recordAssignee(
  ctx: PluginContext,
  companyId: string,
  owner: { assigneeAgentId?: string | null; ownerUserId?: string | null } | null,
  role: CrmRoleKey = "account-manager",
): Promise<Assignee> {
  if (owner && (await assigneeMode(ctx, companyId)) === "contact") {
    if (owner.assigneeAgentId && (await agentCanWork(ctx, companyId, owner.assigneeAgentId))) return { assigneeAgentId: owner.assigneeAgentId };
    if (owner.ownerUserId && owner.ownerUserId !== LOCAL_BOARD_USER_ID) return { assigneeUserId: owner.ownerUserId };
  }
  return teamAssignee(ctx, companyId, role);
}

/** An approval: the Reviewer first (when the company reviews outward work), else the company owner. */
export async function approvalAssignee(ctx: PluginContext, companyId: string): Promise<{ reviewer: string | null; approverUserId: string | null }> {
  const [reviewer, roles] = await Promise.all([reviewerAgentId(ctx, companyId), companyRoles(ctx, companyId)]);
  return { reviewer, approverUserId: roles?.ownerUserId ?? null };
}
