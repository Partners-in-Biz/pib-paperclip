import type { Db } from "@paperclipai/db";
import { recordMemberRestrictionDenial } from "./admin.js";
import { memberRestrictionFor, memberRestrictionUnavailable } from "./resolver.js";

/** PAR-12608 4.6a rows 6, 10 and 11: the rule id of an inbound refusal. */
export const INBOUND_MEMBER_RESTRICTION_RULE_ID = "R-inbound";

export type InboundChannel = "voice" | "email" | "chat";

/**
 * Asked where an inbound call, mail or chat message is mapped to a person,
 * before anything is written for it. True when that person is restricted in
 * the company under `enforce`: the caller refuses, creates nothing and starts
 * no run. Under `report` a "would refuse" is recorded and the answer is false.
 * With the kill switch on, or mode `off`, the resolver answers "not
 * restricted". A failed read throws 503 `MEMBER_RESTRICTION_UNAVAILABLE`.
 * `tx` is the caller's open transaction, if any: the membership is read in it,
 * and the denial is recorded on `db` so a refusal that rolls `tx` back keeps it.
 */
export async function inboundRefusedForPerson(
  db: Db,
  input: { companyId: string; personId: string; channel: InboundChannel; objectId?: string | null },
  tx?: Db | Parameters<Parameters<Db["transaction"]>[0]>[0],
): Promise<boolean> {
  let restriction: Awaited<ReturnType<typeof memberRestrictionFor>>;
  try {
    restriction = await memberRestrictionFor((tx ?? db) as Db, input.personId, input.companyId);
  } catch (error) {
    throw memberRestrictionUnavailable(error);
  }
  if (!restriction.restricted || restriction.mode === "off") return false;
  await recordMemberRestrictionDenial(db, {
    companyId: input.companyId,
    personId: input.personId,
    ruleId: INBOUND_MEMBER_RESTRICTION_RULE_ID,
    target: `inbound.${input.channel}`,
    objectId: input.objectId ?? null,
    mode: restriction.mode,
  });
  return restriction.mode === "enforce";
}
