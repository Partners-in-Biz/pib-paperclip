import type { Db } from "@paperclipai/db";
import type { ActorCompanyMembership } from "@paperclipai/shared";
import { recordMemberRestrictionDenial } from "./admin.js";
import { memberRestrictionForMembership } from "./actor-memberships.js";
import { memberRestrictionResolver } from "./resolver.js";
import { ruleGroupHBinding } from "./rule-group-h.js";

/**
 * The assistant connection (PAR-12608 4.6a, rows 3 and 4). R and H are read
 * on every approval and every call, never when a grant or token is made, so a
 * flag or a mode change takes effect on the connection's next call.
 */

export const ASSISTANT_CONNECTION_RULE_ID = "R-assistant-connection";

type Person = {
  personId: string;
  companyId: string;
  membership: ActorCompanyMembership | null | undefined;
};

/**
 * True when the person is restricted under `enforce`: he may not approve a
 * connection, and one he approved stops (the caller answers an invalid grant).
 * Under `report` the refusal is recorded only. `recordDb` is the root
 * database, so the record survives the caller's rolled-back transaction. A
 * failed read throws 503 `MEMBER_RESTRICTION_UNAVAILABLE`.
 */
export async function assistantConnectionRefused(
  db: Db,
  recordDb: Db,
  input: Person & { target: "approve" | "call" },
): Promise<boolean> {
  const restriction = await memberRestrictionForMembership(
    memberRestrictionResolver(db), input.personId, input.companyId, input.membership,
  );
  if (!restriction.restricted || restriction.mode === "off") return false;
  await recordMemberRestrictionDenial(recordDb, {
    companyId: input.companyId,
    personId: input.personId,
    ruleId: ASSISTANT_CONNECTION_RULE_ID,
    target: `assistant_connection.${input.target}`,
    mode: restriction.mode,
  });
  return restriction.mode === "enforce";
}

/**
 * The person an agent-purpose connection works for: the one who approved it,
 * when rule group H binds him (`report` or `enforce`, not owner or admin, not
 * an instance admin). Null otherwise, so the actor stays as it is today.
 */
export async function assistantConnectionPerson(
  db: Db,
  input: Person & { isInstanceAdmin: boolean },
): Promise<{ onBehalfOfUserId: string; onBehalfOfMemberships: ActorCompanyMembership[] } | null> {
  if (!input.membership) return null;
  const binding = await ruleGroupHBinding(db, input);
  if (!binding.bound) return null;
  return { onBehalfOfUserId: input.personId, onBehalfOfMemberships: [input.membership] };
}
