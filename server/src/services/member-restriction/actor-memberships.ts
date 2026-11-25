import { and, eq, sql, type SQL } from "drizzle-orm";
import { companies, companyMemberships, type Db } from "@paperclipai/db";
import {
  MEMBER_RESTRICTION_MODES,
  type ActorCompanyMembership,
  type MemberRestriction,
  type MemberRestrictionMode,
} from "@paperclipai/shared";
import {
  memberRestrictionKillSwitchOn,
  memberRestrictionOrUnavailable,
  type MemberRestrictionResolver,
} from "./resolver.js";

/**
 * The restriction fields every actor membership carries (PAR-12608 4.2, "A
 * missing field is unknown"). Like the resolver, this module is the only code
 * that reads the flag and the company mode for an actor.
 */

function isMode(value: unknown): value is MemberRestrictionMode {
  return typeof value === "string" && (MEMBER_RESTRICTION_MODES as readonly string[]).includes(value);
}

/** True when both fields are present and well-formed; otherwise the membership is "unknown". */
export function hasMemberRestrictionFields(
  membership: Partial<ActorCompanyMembership> | null | undefined,
): membership is ActorCompanyMembership {
  return typeof membership?.restricted === "boolean" && isMode(membership.restrictionMode);
}

/**
 * The resolver's answer for one stored row, without the lists: the kill switch
 * or mode `off` yields "not restricted, off"; otherwise the flag, whatever the
 * row's status. A value that cannot be read leaves both fields out, so the
 * membership stays "unknown" and the resolver reads the database later.
 */
function restrictionFields(flag: unknown, mode: unknown): Pick<ActorCompanyMembership, "restricted" | "restrictionMode"> | null {
  if (memberRestrictionKillSwitchOn()) return { restricted: false, restrictionMode: "off" };
  if (!isMode(mode) || typeof flag !== "boolean") return null;
  return { restricted: mode !== "off" && flag, restrictionMode: mode };
}

/**
 * Load one person's user memberships with both restriction fields. The company
 * mode is a correlated subquery so the query keeps the shape
 * `select().from(companyMemberships).where()` of the loaders it replaces.
 */
export async function loadActorMemberships(
  db: Pick<Db, "select">,
  input: { userId: string; companyId?: string | null; activeOnly: boolean },
): Promise<ActorCompanyMembership[]> {
  const conditions: SQL[] = [
    eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.principalId, input.userId),
  ];
  if (input.companyId) conditions.push(eq(companyMemberships.companyId, input.companyId));
  if (input.activeOnly) conditions.push(eq(companyMemberships.status, "active"));
  const rows = await db
    .select({
      companyId: companyMemberships.companyId,
      membershipRole: companyMemberships.membershipRole,
      status: companyMemberships.status,
      restrictedFlag: companyMemberships.restricted,
      companyMode: sql<string | null>`(select ${companies.memberRestrictionMode} from ${companies} where ${companies.id} = ${companyMemberships.companyId})`,
    })
    .from(companyMemberships)
    .where(and(...conditions));
  return rows.map(({ restrictedFlag, companyMode, ...membership }) => {
    const fields = restrictionFields(restrictedFlag, companyMode);
    // Without readable fields the membership is deliberately "unknown" (see
    // `memberRestrictionForMembership`); this is the one place that may omit them.
    return (fields ? { ...membership, ...fields } : membership) as ActorCompanyMembership;
  });
}

type MembershipCarryingActor = {
  type: string;
  userId?: string | null;
  memberships?: Array<Partial<ActorCompanyMembership> & { companyId: string }>;
  onBehalfOfUserId?: string | null;
  onBehalfOfMemberships?: Array<Partial<ActorCompanyMembership> & { companyId: string }>;
};

/**
 * The person an actor works for in one company, and the membership it carries
 * for him: a board user's own, or the person an agent works for. Null when the
 * actor carries no person (local board without a user, an agent with no person).
 */
export function actorPersonMembership(actor: MembershipCarryingActor, companyId: string) {
  if (actor.type === "board" && actor.userId) {
    return { personId: actor.userId, membership: actor.memberships?.find((m) => m.companyId === companyId) ?? null };
  }
  if (actor.type === "agent" && actor.onBehalfOfUserId) {
    return {
      personId: actor.onBehalfOfUserId,
      membership: actor.onBehalfOfMemberships?.find((m) => m.companyId === companyId) ?? null,
    };
  }
  return null;
}

/**
 * The resolver, fed by the fields a membership already carries. A known
 * "not restricted" answers without a read; a flagged member reads the database
 * (for his lists); a membership without the fields, or none at all, reads the
 * database. A failed read throws 503 `MEMBER_RESTRICTION_UNAVAILABLE`.
 */
export async function memberRestrictionForMembership(
  resolve: MemberRestrictionResolver,
  personId: string,
  companyId: string,
  membership: Partial<ActorCompanyMembership> | null | undefined,
): Promise<MemberRestriction> {
  if (memberRestrictionKillSwitchOn()) return { restricted: false, mode: "off", pluginKeys: [], agentIds: [] };
  if (membership?.companyId === companyId && hasMemberRestrictionFields(membership) && !membership.restricted) {
    return { restricted: false, mode: membership.restrictionMode, pluginKeys: [], agentIds: [] };
  }
  return memberRestrictionOrUnavailable(resolve, personId, companyId);
}

/** Restriction of the person an actor works for in one company; null when it carries no person. */
export async function memberRestrictionForActor(
  resolve: MemberRestrictionResolver,
  actor: MembershipCarryingActor,
  companyId: string,
): Promise<(MemberRestriction & { personId: string }) | null> {
  const carried = actorPersonMembership(actor, companyId);
  if (!carried) return null;
  const restriction = await memberRestrictionForMembership(resolve, carried.personId, companyId, carried.membership);
  return { ...restriction, personId: carried.personId };
}
