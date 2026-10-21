/**
 * Social's side of the kit growth ports that are not storage: the approval
 * issue and scope resolution. The service takes them from `GrowthEnv`, else
 * builds these from the plugin context.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ApprovalIssuePort, ScopeResolver } from "@partnersinbiz/pib-plugin-kit";
import { formatClientParam, scopeFromParams, type ResolvedScope } from "../clients.js";
import { createIssueSafely } from "../issues.js";

const OPEN_ISSUE = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

type CreateApproval = Parameters<typeof createIssueSafely>[1];

export type SocialApprovalIssuePort = ApprovalIssuePort<CreateApproval>;
export type SocialScopeResolver = ScopeResolver<Record<string, unknown>, ResolvedScope>;

export function socialApprovalIssues(ctx: PluginContext): SocialApprovalIssuePort {
  return {
    createApproval: (input) => createIssueSafely(ctx, input),
    async isOpen(companyId, issueId) {
      try {
        const issue = await ctx.issues.get(issueId, companyId);
        return Boolean(issue && OPEN_ISSUE.has(String(issue.status)));
      } catch {
        return false;
      }
    },
    async setStatus(companyId, issueId, status) {
      await ctx.issues.update(issueId, { status }, companyId);
    },
    async comment(companyId, issueId, body) {
      await ctx.issues.createComment(issueId, body, companyId);
    },
  };
}

export function socialScopes(ctx: PluginContext): SocialScopeResolver {
  return {
    fromParams: (companyId, params) => scopeFromParams(ctx, companyId, params),
    toParam: formatClientParam,
  };
}
