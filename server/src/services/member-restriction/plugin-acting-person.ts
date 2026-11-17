import { MEMBER_RESTRICTION_UNAVAILABLE_CODE, type MemberRestriction } from "@paperclipai/shared";
import { HttpError } from "../../errors.js";
import { actorPersonMembership, memberRestrictionForMembership } from "./actor-memberships.js";
import type { MemberRestrictionResolver } from "./resolver.js";

/**
 * The acting person core hands a plugin (PAR-12608 4.10, H3): who the action,
 * API-route call or tool call works for, as core computed it, and whether that
 * person is restricted in a company on `enforce`. Sent in every mode; the mark
 * is false unless the company is on `enforce` and the person is flagged.
 */
export interface PluginActingPerson {
  onBehalfOfUserId: string | null;
  onBehalfOfRestricted: boolean;
}

const NO_PERSON: PluginActingPerson = { onBehalfOfUserId: null, onBehalfOfRestricted: false };

type ActingActor = Parameters<typeof actorPersonMembership>[0] & { source?: string };

function enforcedRestriction(restriction: MemberRestriction): boolean {
  return restriction.restricted && restriction.mode === "enforce";
}

/**
 * For a request actor: a board user's own id (null for the local board), or
 * the person an agent works for (a run's, a long-lived key's or an
 * agent-purpose connection's person). A failed read throws 503
 * `MEMBER_RESTRICTION_UNAVAILABLE`, so no call reaches the plugin.
 */
export async function pluginActingPersonForActor(
  resolve: MemberRestrictionResolver,
  actor: ActingActor,
  companyId: string | null | undefined,
): Promise<PluginActingPerson> {
  if (actor.source === "local_implicit") return NO_PERSON;
  const carried = actorPersonMembership(actor, companyId ?? "");
  if (!carried) return NO_PERSON;
  // A call with no company scope cannot be in a company on `enforce`.
  if (!companyId) return { onBehalfOfUserId: carried.personId, onBehalfOfRestricted: false };
  const restriction = await memberRestrictionForMembership(resolve, carried.personId, companyId, carried.membership);
  return { onBehalfOfUserId: carried.personId, onBehalfOfRestricted: enforcedRestriction(restriction) };
}

export function isMemberRestrictionUnavailable(error: unknown): error is HttpError {
  if (!(error instanceof HttpError) || error.status !== 503) return false;
  const details = error.details as { code?: unknown } | null | undefined;
  return details?.code === MEMBER_RESTRICTION_UNAVAILABLE_CODE;
}
