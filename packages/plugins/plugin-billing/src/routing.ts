/**
 * Who gets Billing's issues, so nothing is left unassigned.
 *
 * - Work (drafting, follow-ups, invoice replies): the Account Manager, else the
 *   Bookkeeper, else the Operator, else the owner (`routeWork`). Quote
 *   replies go to the Deal Desk first (`quoteRoute`).
 * - Approvals and money decisions (send, payments, credit notes, proof-of-payment
 *   checks, bank matches, bills): `approvals.ts` (the kit's `openApprovalIssue`:
 *   Reviewer first for outward work, then the Billing approver or the owner,
 *   then the Operator, then a loud unassigned).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { routeWork, teamAgentId, teamRoleChain, teamSetupPath, type TeamRoleKey, type WorkRoute } from "@partnersinbiz/pib-plugin-kit";

/** Billing work goes to these roles, in order (then the Operator, then the owner). */
export const WORK_ROLES: TeamRoleKey[] = ["account-manager", "bookkeeper"];

export async function workRoute(ctx: PluginContext, companyId: string): Promise<WorkRoute> {
  try {
    return await routeWork(ctx, companyId, WORK_ROLES);
  } catch {
    return { assigneeAgentId: null, assigneeUserId: null, via: "none" };
  }
}

/** Quote replies are sales work: the Deal Desk, else who covers it (the Account Manager), then the Bookkeeper. */
export const QUOTE_ROLES: TeamRoleKey[] = [...teamRoleChain("deal-desk"), "bookkeeper"];

export async function quoteRoute(ctx: PluginContext, companyId: string): Promise<WorkRoute> {
  try {
    return await routeWork(ctx, companyId, QUOTE_ROLES);
  } catch {
    return { assigneeAgentId: null, assigneeUserId: null, via: "none" };
  }
}

/** `createWorkIssue` assignee fields for a work route. */
export function assigneeOf(route: Pick<WorkRoute, "assigneeAgentId" | "assigneeUserId">): { assigneeAgentId?: string; assigneeUserId?: string } {
  if (route.assigneeAgentId) return { assigneeAgentId: route.assigneeAgentId };
  return route.assigneeUserId ? { assigneeUserId: route.assigneeUserId } : {};
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
