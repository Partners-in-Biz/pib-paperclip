import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isOwnerCompany } from "./new-company.js";

/** Every company visible to the plugin, paged. */
export async function listAllCompanies(ctx: PluginContext): Promise<Array<{ id: string }>> {
  const all: Array<{ id: string }> = [];
  for (let offset = 0; ; offset += 100) {
    const page = await ctx.companies.list({ limit: 100, offset });
    all.push(...page);
    if (page.length < 100) return all;
  }
}

const ADMIN_ROLES = new Set(["owner", "admin"]);

/** Whether the user is an active owner or admin of the company. Fails closed (false) on any error. */
export async function isCompanyAdmin(ctx: PluginContext, companyId: string, userId: string): Promise<boolean> {
  try {
    const members = await ctx.access.members.list({ companyId });
    return members.some(
      (member) => member.principalType === "user" && member.principalId === userId && member.status === "active" && member.membershipRole != null && ADMIN_ROLES.has(member.membershipRole),
    );
  } catch {
    return false;
  }
}

/**
 * Whether the user is an owner or admin of Partners in Biz's own company (the one with the
 * ownerCompany setting). Only they may write entitlements: a hosted client's owner owns their
 * own company, not ours. The host gives a plugin action no instance-admin flag, so this is the check.
 * Fails closed (false) on any error.
 */
export async function isOperatorAdmin(ctx: PluginContext, userId: string): Promise<boolean> {
  try {
    for (const company of await listAllCompanies(ctx)) {
      if (!(await isOwnerCompany(ctx, company.id))) continue;
      if (await isCompanyAdmin(ctx, company.id, userId)) return true;
    }
  } catch {
    return false;
  }
  return false;
}
