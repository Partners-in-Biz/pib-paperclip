import type { Db } from "@paperclipai/db";
import { recordMemberRestrictionDenial } from "../member-restriction/admin.js";
import {
  memberRestrictionFor,
  memberRestrictionKillSwitchOn,
  memberRestrictionUnavailable,
} from "../member-restriction/resolver.js";

/**
 * Invariant A (PAR-12608 4.1 and 4.7): in a company on `enforce`, no run of an
 * agent works for a restricted person unless that agent is on his list at the
 * moment the run starts. Checked where the run is created (`enqueueWakeup`) and
 * again when a queued run is claimed (`claimQueuedRun`), from the run's person.
 */

/** Skip reason of the wake, and error code of a run cancelled at claim. */
export const MEMBER_RESTRICTED_AGENT_NOT_LISTED = "member_restricted_agent_not_listed";
export const MEMBER_AGENT_LIST_RULE_ID = "R-wake";
export const MEMBER_AGENT_NOT_LISTED_MESSAGE = "This agent is not on the list of agents the run's person may instruct";

/** Thrown inside the run insert so its transaction rolls back; the queue then records the skip. */
export class MemberAgentNotListedError extends Error {
  constructor(readonly personId: string) {
    super(MEMBER_AGENT_NOT_LISTED_MESSAGE);
    this.name = "MemberAgentNotListedError";
  }
}

/**
 * Whether a run of `agentId` may work for `personId`. A person restricted under
 * `enforce` whose list lacks the agent: false, and one `member_restriction.denied`
 * entry. Under `report`: the "would refuse" is recorded and the answer is true.
 * Kill switch, mode `off`, an unflagged person or no person: true, and nothing
 * beyond the resolver's own reads. A failed read throws 503
 * `MEMBER_RESTRICTION_UNAVAILABLE`; the caller never starts the run.
 */
export async function runPersonMayUseAgent(
  db: Db,
  input: { companyId: string; agentId: string; personId: string | null | undefined; target: string },
): Promise<boolean> {
  if (!input.personId || memberRestrictionKillSwitchOn()) return true;
  let restriction: Awaited<ReturnType<typeof memberRestrictionFor>>;
  try {
    restriction = await memberRestrictionFor(db, input.personId, input.companyId);
  } catch (error) {
    throw memberRestrictionUnavailable(error);
  }
  if (!restriction.restricted || restriction.mode === "off") return true;
  if (restriction.agentIds.includes(input.agentId)) return true;
  await recordMemberRestrictionDenial(db, {
    companyId: input.companyId,
    personId: input.personId,
    ruleId: MEMBER_AGENT_LIST_RULE_ID,
    target: input.target,
    objectId: input.agentId,
    mode: restriction.mode,
  });
  return restriction.mode !== "enforce";
}
