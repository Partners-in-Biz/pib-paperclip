import { and, eq, inArray, ne } from "drizzle-orm";
import { agents, companyMemberships, plugins, type Db } from "@paperclipai/db";
import type { UpdateMemberRestriction } from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";

/**
 * Writes of the member-restriction columns (PAR-12608 4.2). Deciding access
 * stays with `memberRestrictionFor`; this module only stores what an owner sets.
 */

export const MEMBER_RESTRICTION_CHANGED_ACTION = "company_member.restriction_changed";
export const MEMBER_RESTRICTED_ROLE_CODE = "MEMBER_RESTRICTED_ROLE";

const PROTECTED_ROLES = new Set(["owner", "admin"]);

/**
 * 4.1: nobody is both flagged and owner or admin. Uses the stored flag in
 * every mode (a flag set under `off` still blocks the role).
 */
export function assertRoleAllowedForRestriction(
  member: { restricted?: boolean | null },
  nextRole: string | null | undefined,
) {
  if (member.restricted === true && nextRole && PROTECTED_ROLES.has(nextRole)) {
    throw unprocessable(
      `This member is restricted (member restriction flag is set). Remove the restriction before making them ${nextRole}.`,
      { code: MEMBER_RESTRICTED_ROLE_CODE },
    );
  }
}

type StoredRestriction = { restricted: boolean; pluginKeys: string[]; agentIds: string[] };

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

/** Set the flag and both lists on one person's membership. Returns null when the member does not exist. */
export async function setMemberRestriction(
  db: Db,
  companyId: string,
  memberId: string,
  input: UpdateMemberRestriction,
): Promise<{ principalId: string; before: StoredRestriction; after: StoredRestriction } | null> {
  const next: StoredRestriction = {
    restricted: input.restricted,
    pluginKeys: uniqueSorted(input.pluginKeys),
    agentIds: uniqueSorted(input.agentIds),
  };
  if (next.pluginKeys.length > 0) {
    const found = new Set(await db
      .select({ key: plugins.pluginKey })
      .from(plugins)
      .where(and(inArray(plugins.pluginKey, next.pluginKeys), ne(plugins.status, "uninstalled")))
      .then((rows) => rows.map((row) => row.key)));
    const unknown = next.pluginKeys.filter((key) => !found.has(key));
    if (unknown.length > 0) throw unprocessable(`Unknown or uninstalled plugin: ${unknown.join(", ")}`);
  }
  if (next.agentIds.length > 0) {
    const found = new Set(await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, next.agentIds)))
      .then((rows) => rows.map((row) => row.id)));
    const unknown = next.agentIds.filter((id) => !found.has(id));
    if (unknown.length > 0) throw unprocessable(`Agent not in this company: ${unknown.join(", ")}`);
  }

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!existing) return null;
    if (existing.principalType !== "user") throw unprocessable("Only a person's membership can be restricted");
    if (next.restricted && existing.membershipRole && PROTECTED_ROLES.has(existing.membershipRole)) {
      throw unprocessable(`An ${existing.membershipRole} cannot be restricted. Change the role first.`, {
        code: MEMBER_RESTRICTED_ROLE_CODE,
      });
    }
    await tx
      .update(companyMemberships)
      .set({
        restricted: next.restricted,
        restrictedPluginKeys: next.pluginKeys,
        restrictedAgentIds: next.agentIds,
        updatedAt: new Date(),
      })
      .where(eq(companyMemberships.id, existing.id));
    return {
      principalId: existing.principalId,
      before: {
        restricted: existing.restricted,
        pluginKeys: [...existing.restrictedPluginKeys],
        agentIds: [...existing.restrictedAgentIds],
      },
      after: next,
    };
  });
}
