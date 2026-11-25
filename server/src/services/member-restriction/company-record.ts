import type { Db } from "@paperclipai/db";
import { memberRestrictionEnforcedCompanyIds, memberRestrictionFor, memberRestrictionUnavailable } from "./resolver.js";
import { actorPersonMembership, memberRestrictionForMembership } from "./actor-memberships.js";
import { restrictionPersonIds } from "./strict-read.js";

/**
 * The company record a caller who works for a person restricted under
 * `enforce` reads (PAR-12608 4.6, "Company record"): id, name, logo and task
 * prefix, which the screen needs. Budget, spend, settings and the other set-up
 * fields are left out. The record has no colour field, so none is returned.
 */
type CompanyRecord = { id: string; name: string; issuePrefix: string; logoAssetId?: string | null; logoUrl?: string | null };

export function reducedCompanyRecord<T extends CompanyRecord>(company: T) {
  const { id, name, issuePrefix, logoAssetId = null, logoUrl = null } = company;
  return { id, name, issuePrefix, logoAssetId, logoUrl };
}

/**
 * The companies in which a person the actor works for is restricted under
 * `enforce`; empty with the kill switch on. A failed read throws 503
 * `MEMBER_RESTRICTION_UNAVAILABLE`, so the caller returns no data.
 */
export async function companiesRestrictedForActor(
  db: Pick<Db, "select">,
  actor: Parameters<typeof restrictionPersonIds>[0],
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const personId of restrictionPersonIds(actor)) {
    try {
      for (const companyId of await memberRestrictionEnforcedCompanyIds(db, personId)) ids.add(companyId);
    } catch (error) {
      throw memberRestrictionUnavailable(error);
    }
  }
  return ids;
}

/**
 * True when a person the actor works for is restricted in `companyId` under
 * `enforce`. A membership the actor carries as "not restricted" answers
 * without a read; a failed read throws 503 `MEMBER_RESTRICTION_UNAVAILABLE`.
 */
export async function actorRestrictedInCompany(
  db: Db,
  actor: Parameters<typeof restrictionPersonIds>[0] & Parameters<typeof actorPersonMembership>[0],
  companyId: string,
): Promise<boolean> {
  const carried = actorPersonMembership(actor, companyId);
  const resolve = (personId: string, id: string) => memberRestrictionFor(db, personId, id);
  for (const personId of restrictionPersonIds(actor)) {
    const membership = carried?.personId === personId ? carried.membership : null;
    const restriction = await memberRestrictionForMembership(resolve, personId, companyId, membership);
    if (restriction.restricted && restriction.mode === "enforce") return true;
  }
  return false;
}

/** The full record outside `restricted`, the reduced one inside. */
export function companyRecordFor<T extends CompanyRecord>(company: T, restricted: ReadonlySet<string>) {
  return restricted.has(company.id) ? reducedCompanyRecord(company) : company;
}
