import type { Db } from "@paperclipai/db";
import type { ActorCompanyMembership } from "@paperclipai/shared";
import { forbidden, unprocessable, type HttpError } from "../../errors.js";
import { recordMemberRestrictionDenial } from "./admin.js";
import { actorPersonMembership } from "./actor-memberships.js";
import { ruleGroupHBinding } from "./rule-group-h.js";

/**
 * Rules H2 and H6 (PAR-12608 4.10): a caller bound by rule group H names only
 * himself as the person a task or a routine works for. "Bound" is decided by
 * `ruleGroupHBinding`; mode `off` and the kill switch bind nobody.
 */

export const RESPONSIBLE_PERSON_NOT_SELF_CODE = "RESPONSIBLE_PERSON_NOT_SELF";
export const ROUTINE_NOT_OWN_CODE = "ROUTINE_NOT_OWN";

type ActingActor = {
  type: string;
  source?: string;
  userId?: string | null;
  isInstanceAdmin?: boolean;
  memberships?: Array<Partial<ActorCompanyMembership> & { companyId: string }>;
  onBehalfOfUserId?: string | null;
  onBehalfOfMemberships?: Array<Partial<ActorCompanyMembership> & { companyId: string }>;
};

export type ActingPerson = { personId: string; mode: "report" | "enforce" };

/**
 * The person rule group H binds for this caller in this company: a signed-in
 * member who is not owner or admin, or the person an agent works for. Null for
 * the local board, instance admins, owners, admins, agents with no person, and
 * companies on `off`. A failed read throws 503 `MEMBER_RESTRICTION_UNAVAILABLE`.
 */
export async function actingPersonBoundByH(
  db: Db,
  actor: ActingActor,
  companyId: string,
): Promise<ActingPerson | null> {
  if (actor.type === "board" && actor.source === "local_implicit") return null;
  const carried = actorPersonMembership(actor, companyId);
  if (!carried) return null;
  const binding = await ruleGroupHBinding(db, {
    personId: carried.personId,
    companyId,
    membership: carried.membership,
    isInstanceAdmin: actor.type === "board" ? actor.isInstanceAdmin === true : undefined,
  });
  return binding.bound ? { personId: carried.personId, mode: binding.mode } : null;
}

async function refuseOrRecord(
  db: Db,
  acting: ActingPerson,
  denial: { companyId: string; ruleId: "H2" | "H6"; target: string; objectId?: string | null },
  refusal: () => HttpError,
): Promise<void> {
  await recordMemberRestrictionDenial(db, { ...denial, personId: acting.personId, mode: acting.mode });
  if (acting.mode === "enforce") throw refusal();
}

/**
 * H2 (task create) and H6 (routine create): a bound caller may name only
 * himself. Naming another person is 422 under `enforce` and recorded under
 * `report`. Returns the person to store under `enforce` (himself, also when the
 * value was left out), or null to keep today's choice.
 */
export async function assertNamesOnlyHimself(
  db: Db,
  actor: ActingActor,
  input: { companyId: string; ruleId: "H2" | "H6"; target: string; requestedPersonId: string | null | undefined },
): Promise<string | null> {
  const acting = await actingPersonBoundByH(db, actor, input.companyId);
  if (!acting) return null;
  const requested = typeof input.requestedPersonId === "string" ? input.requestedPersonId.trim() : "";
  if (requested && requested !== acting.personId) {
    await refuseOrRecord(db, acting, { companyId: input.companyId, ruleId: input.ruleId, target: input.target }, () =>
      unprocessable("You can only name yourself as the responsible person", {
        code: RESPONSIBLE_PERSON_NOT_SELF_CODE,
      }));
  }
  return acting.mode === "enforce" ? acting.personId : null;
}

/**
 * H6 (routine change and run): a bound caller may change or run a routine only
 * when it works for him and keeps working for him. 403 under `enforce`,
 * recorded under `report`.
 */
export async function assertRoutineWorksForCaller(
  db: Db,
  actor: ActingActor,
  routine: { id: string; companyId: string; responsibleUserId: string | null },
  input: { target: string; nextResponsibleUserId?: string | null },
): Promise<void> {
  const acting = await actingPersonBoundByH(db, actor, routine.companyId);
  if (!acting) return;
  const staysHis = input.nextResponsibleUserId === undefined || input.nextResponsibleUserId === acting.personId;
  if (routine.responsibleUserId === acting.personId && staysHis) return;
  await refuseOrRecord(db, acting, {
    companyId: routine.companyId, ruleId: "H6", target: input.target, objectId: routine.id,
  }, () => forbidden("You can only change or run a routine that works for you", { code: ROUTINE_NOT_OWN_CODE }));
}
