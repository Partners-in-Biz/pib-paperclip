/**
 * Who works a campaign's issues, and who approves its launch.
 *
 * - Work (step issues, replies, failed sends, revisions): the agent that
 *   created the campaign while it is running, else the Account Manager, else
 *   the Operator, else the owner (kit `routeWork`). Never unassigned when the
 *   company has an owner.
 * - Approvals: only a person. The campaign's creator when a person made it,
 *   else the company owner from the Cockpit roles.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { companyRoles, roleAgentUsable, routeWork } from "@partnersinbiz/pib-plugin-kit";
import type { CampaignDraft } from "./domain.js";

export const LOCAL_BOARD_USER_ID = "local-board";

export interface WorkAssignee {
  assigneeAgentId?: string;
  assigneeUserId?: string;
  /** creator: the campaign's own agent; else the route the kit picked. */
  via: "creator" | "account-manager" | "operator" | "owner" | "none" | string;
}

/** True when the agent exists in the company and is not paused, in error, or removed. Unknown counts as usable. */
export async function agentUsable(ctx: PluginContext, companyId: string, agentId: string): Promise<boolean> {
  try {
    const agent = await ctx.agents.get(agentId, companyId);
    if (!agent) return false;
    return roleAgentUsable((agent as { status?: string | null }).status ?? null);
  } catch {
    return true;
  }
}

export async function workOwner(ctx: PluginContext, companyId: string, campaign: Pick<CampaignDraft, "ownerAgentId">): Promise<WorkAssignee> {
  if (campaign.ownerAgentId && (await agentUsable(ctx, companyId, campaign.ownerAgentId))) {
    return { assigneeAgentId: campaign.ownerAgentId, via: "creator" };
  }
  const route = await routeWork(ctx, companyId, ["account-manager"]);
  if (route.assigneeAgentId) return { assigneeAgentId: route.assigneeAgentId, via: route.via };
  if (route.assigneeUserId) return { assigneeUserId: route.assigneeUserId, via: route.via };
  return { via: "none" };
}

/** The assignee fields only, for `createWorkIssue`. */
export function assigneeFields(owner: WorkAssignee): { assigneeAgentId?: string; assigneeUserId?: string } {
  if (owner.assigneeAgentId) return { assigneeAgentId: owner.assigneeAgentId };
  if (owner.assigneeUserId) return { assigneeUserId: owner.assigneeUserId };
  return {};
}

/** The person who approves a launch: the campaign's creator (a person), else the company owner. */
export async function approverUserId(ctx: PluginContext, companyId: string, campaign: Pick<CampaignDraft, "ownerUserId">): Promise<string | null> {
  if (campaign.ownerUserId && campaign.ownerUserId !== LOCAL_BOARD_USER_ID) return campaign.ownerUserId;
  return (await companyRoles(ctx, companyId))?.ownerUserId ?? null;
}
