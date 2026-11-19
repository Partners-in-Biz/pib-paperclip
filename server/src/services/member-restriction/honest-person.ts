import { and, eq } from "drizzle-orm";
import { companyMemberships, instanceUserRoles, type Db } from "@paperclipai/db";
import type { MemberRestrictionMode } from "@paperclipai/shared";
import { memberRestrictionFor, memberRestrictionUnavailable } from "./resolver.js";

/**
 * Rule group H, "honest person" (PAR-12608 4.1 and 4.10): it binds every active
 * member who is not owner or admin, flagged or not. Owners, admins, instance
 * admins and people who are not members are never bound.
 */

/** The rule id written on H1 records ("a run works for the person who caused it"). */
export const HONEST_PERSON_RUN_RULE_ID = "H1";

const UNBOUND_ROLES = new Set(["owner", "admin"]);

export interface HonestPersonRule {
  bound: boolean;
  mode: MemberRestrictionMode;
}

/**
 * Whether rule group H binds one person in one company, and under which mode.
 * The mode comes from the resolver, so the kill switch and mode `off` answer
 * "not bound, off" without reading the membership. A failed read throws 503
 * `MEMBER_RESTRICTION_UNAVAILABLE`; the caller never continues as "not bound".
 */
export async function honestPersonRuleFor(
  db: Db,
  personId: string,
  companyId: string,
): Promise<HonestPersonRule> {
  try {
    const { mode } = await memberRestrictionFor(db, personId, companyId);
    if (mode === "off") return { bound: false, mode };
    const membership = await db
      .select({ role: companyMemberships.membershipRole, status: companyMemberships.status })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, personId),
      ))
      .then((rows) => rows[0] ?? null);
    // A null role is read as operator everywhere else (authorization.ts), so it is bound.
    if (membership?.status !== "active" || UNBOUND_ROLES.has(membership.role ?? "")) return { bound: false, mode };
    const instanceAdmin = await db
      .select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, personId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    return { bound: !instanceAdmin, mode };
  } catch (error) {
    throw memberRestrictionUnavailable(error);
  }
}
