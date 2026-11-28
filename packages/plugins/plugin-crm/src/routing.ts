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
import { accessCompanyScope, cachedAccessFor, companyRoles, parseAccessRow, readConfig, reviewerAgentId, roleAgentUsable, routeWork, teamRoleChain } from "@partnersinbiz/pib-plugin-kit";
import { CRM_HIRE_ROLES, isCrmRoleKey, roleAgent, type CrmRoleKey } from "./agent.js";
import type { ApprovalKind, ClientKey } from "./care-store.js";
import { table } from "./db.js";
import { LOCAL_BOARD_USER_ID } from "./domain.js";
import { managerIdsOf } from "./managers.js";

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

const DELIVERY_LEAD_NAME = /^delivery lead$/i;

/**
 * Work about a client's website or code: the Delivery Lead (a live agent found by its name; it is not a kit
 * role), else the Account Manager, then the Operator, then the owner, so nothing is left unassigned.
 */
export async function deliveryLeadAssignee(ctx: PluginContext, companyId: string): Promise<Assignee> {
  try {
    const agents = await ctx.agents.list({ companyId, limit: 200 });
    const lead = agents.find((agent) => DELIVERY_LEAD_NAME.test(String(agent.name ?? "").trim()) && roleAgentUsable(String(agent.status ?? "")));
    if (lead) return { assigneeAgentId: String(lead.id) };
  } catch {
    // no agent list: the team route below still finds someone
  }
  return teamAssignee(ctx, companyId, "account-manager");
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

// ---------------------------------------------------------------------------
// An approval about one client goes to that client's manager (access stage B, plan B-D7)
// ---------------------------------------------------------------------------

/**
 * Asks about one client that his manager decides when he is a limited member (Peet 2026-11-17): care
 * requests and reminders, support feedback asks, speed-to-lead replies and report sends.
 */
export const MANAGER_APPROVAL_KINDS = ["client_action", "client_reminder", "client_report", "feedback_request", "speed_to_lead"] as const satisfies readonly ApprovalKind[];
/**
 * Hard stops that keep today's route (the company owner) even on his companies: legal text (e-sign) and
 * deletes with no way back (privacy erasure). Site publishing and Billing never open a CRM approval.
 */
export const HARD_STOP_APPROVAL_KINDS = ["erasure", "esign_request", "esign_reminder", "esign_copy"] as const satisfies readonly ApprovalKind[];

/** The CRM companies a client belongs to: the company itself, or a contact's linked companies (oldest link first). */
async function clientAccountIds(ctx: PluginContext, companyId: string, client: ClientKey): Promise<string[]> {
  if (client.kind === "company") return [client.id];
  const rows = await ctx.db.query<{ account_id: string }>(
    `SELECT account_id FROM ${table(ctx, "contact_companies")} WHERE company_id = $1 AND contact_id = $2 ORDER BY created_at`,
    [companyId, client.id],
  );
  return rows.map((row) => row.account_id);
}

/**
 * The person who decides an approval about this client instead of the company owner, or null for today's
 * route. Only while the company's access switch is on `enforce`, only for `MANAGER_APPROVAL_KINDS`, and only
 * a manager (owner first, then the "Managed by" list) who is an active limited member with a grant: an owner
 * or admin, or someone with no access, keeps today's route. Any failed read is today's route. Never throws.
 */
export async function clientManagerApprover(ctx: PluginContext, companyId: string, kind: ApprovalKind, client: ClientKey | null): Promise<string | null> {
  if (!client || !(MANAGER_APPROVAL_KINDS as readonly string[]).includes(kind)) return null;
  try {
    // A plain read of the stored switch: routing never asks Setup for a fresh copy (the guard does that on calls).
    const row = parseAccessRow(await ctx.state.get(accessCompanyScope(companyId)));
    if (row === null || row === "invalid" || row.mode !== "enforce") return null;
    for (const accountId of await clientAccountIds(ctx, companyId, client)) {
      const rows = await ctx.db.query<{ owner_user_id: string | null; manager_user_ids: unknown }>(
        `SELECT owner_user_id, manager_user_ids FROM ${table(ctx, "companies")} WHERE company_id = $1 AND id = $2`,
        [companyId, accountId],
      );
      const row = rows[0];
      if (!row) continue;
      for (const userId of [row.owner_user_id, ...managerIdsOf(row.manager_user_ids)]) {
        if (!userId || userId === LOCAL_BOARD_USER_ID) continue;
        const person = await cachedAccessFor(ctx, companyId, userId);
        if (!person.bypass && !person.reason && person.grant) return userId;
      }
    }
  } catch (error) {
    ctx.logger.info("Client manager not read; the approval keeps the company route", { kind, error: error instanceof Error ? error.message : String(error) });
  }
  return null;
}

/** An approval: the Reviewer first (when the company reviews outward work), else the company owner. */
export async function approvalAssignee(ctx: PluginContext, companyId: string): Promise<{ reviewer: string | null; approverUserId: string | null }> {
  const [reviewer, roles] = await Promise.all([reviewerAgentId(ctx, companyId), companyRoles(ctx, companyId)]);
  return { reviewer, approverUserId: roles?.ownerUserId ?? null };
}
