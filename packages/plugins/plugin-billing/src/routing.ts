/**
 * Who gets Billing's issues, so nothing is left unassigned.
 *
 * - Work (drafting, follow-ups, replies): the Account Manager, else the
 *   Bookkeeper, else the Operator, else the owner (`routeWork`).
 * - Outward approvals (sending an invoice, quote or reminder): the Reviewer
 *   first when one is running, else the Billing approver (settings
 *   `reviewerUserId`), else the owner.
 * - Money decisions (payments, credit notes, proof-of-payment checks, bank
 *   matches, bills): the Billing approver, else the owner. Never an agent.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { companyRoles, reviewerAgentId, routeWork, teamAgentId, teamSetupPath, type TeamRoleKey, type WorkRoute } from "@partnersinbiz/pib-plugin-kit";
import type { BillingSettings } from "./config.js";

/** Billing work goes to these roles, in order (then the Operator, then the owner). */
export const WORK_ROLES: TeamRoleKey[] = ["account-manager", "bookkeeper"];

export async function workRoute(ctx: PluginContext, companyId: string): Promise<WorkRoute> {
  try {
    return await routeWork(ctx, companyId, WORK_ROLES);
  } catch {
    return { assigneeAgentId: null, assigneeUserId: null, via: "none" };
  }
}

/** `createWorkIssue` assignee fields for a work route. */
export function assigneeOf(route: Pick<WorkRoute, "assigneeAgentId" | "assigneeUserId">): { assigneeAgentId?: string; assigneeUserId?: string } {
  if (route.assigneeAgentId) return { assigneeAgentId: route.assigneeAgentId };
  return route.assigneeUserId ? { assigneeUserId: route.assigneeUserId } : {};
}

/** The person who decides Billing's approvals: the Billing approver in settings, else the company owner. */
export async function approverUserId(ctx: PluginContext, companyId: string, settings: BillingSettings): Promise<string | null> {
  const configured = typeof settings.reviewerUserId === "string" ? settings.reviewerUserId.trim() : "";
  if (configured) return configured;
  return (await companyRoles(ctx, companyId))?.ownerUserId ?? null;
}

/** Assignee for a money decision: always a person. */
export async function personAssignee(ctx: PluginContext, companyId: string, settings: BillingSettings): Promise<{ assigneeUserId?: string }> {
  const userId = await approverUserId(ctx, companyId, settings);
  return userId ? { assigneeUserId: userId } : {};
}

export interface ApprovalRoute {
  assignee: { assigneeAgentId?: string; assigneeUserId?: string };
  /** The Reviewer agent checking first, when one is running and outward review is on. */
  reviewer: string | null;
  /** The person who decides (the Reviewer hands the issue to them). */
  approver: string | null;
}

/** Outward approvals: the Reviewer first when one is running, else the person. */
export async function sendApprovalRoute(ctx: PluginContext, companyId: string, settings: BillingSettings): Promise<ApprovalRoute> {
  const [reviewer, approver] = await Promise.all([reviewerAgentId(ctx, companyId).catch(() => null), approverUserId(ctx, companyId, settings)]);
  if (reviewer) return { assignee: { assigneeAgentId: reviewer }, reviewer, approver };
  return { assignee: approver ? { assigneeUserId: approver } : {}, reviewer: null, approver };
}

/** Where the Account Manager is staffed, and who Billing's work goes to right now (for the page). */
export async function teamStatus(ctx: PluginContext, companyId: string): Promise<{ accountManager: boolean; via: WorkRoute["via"]; setupHref: string }> {
  const [agent, route] = await Promise.all([teamAgentId(ctx, companyId, "account-manager").catch(() => null), workRoute(ctx, companyId)]);
  return { accountManager: Boolean(agent), via: route.via, setupHref: teamSetupPath("account-manager") };
}

/** The company's issue prefix, for links in issue text (`/PIB/billing?...`). */
export async function companyPrefix(ctx: PluginContext, companyId: string): Promise<string | null> {
  try {
    return (await ctx.companies.get(companyId))?.issuePrefix ?? null;
  } catch {
    return null;
  }
}

/** A Paperclip path with the company prefix when known: `/PIB/billing?tab=quotes`. */
export function pagePath(prefix: string | null, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return prefix ? `/${prefix}${clean}` : clean;
}

/** Billing page link, optionally on a tab and in a client's workspace. */
export function billingPath(prefix: string | null, input: { tab?: string | null; client?: string | null } = {}): string {
  // `client=company:<id>` stays readable (the page decodes either form).
  const part = (key: string, value: string) => `${key}=${encodeURIComponent(value).replace(/%3A/gi, ":")}`;
  const query = [input.tab ? part("tab", input.tab) : null, input.client ? part("client", input.client) : null].filter(Boolean).join("&");
  return pagePath(prefix, `/billing${query ? `?${query}` : ""}`);
}

export function issuePath(prefix: string | null, issue: { id: string; identifier?: string | null }): string {
  return pagePath(prefix, `/issues/${issue.identifier ?? issue.id}`);
}
