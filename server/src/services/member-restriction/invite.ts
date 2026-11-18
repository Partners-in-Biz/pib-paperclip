import type { Db } from "@paperclipai/db";
import {
  MEMBER_RESTRICTED_CODE,
  MEMBER_RESTRICTION_REQUIRED_CODE,
  type InviteMemberRestriction,
  type InviteMemberRestrictionInput,
} from "@paperclipai/shared";
import { forbidden, unprocessable } from "../../errors.js";
import { memberRestrictionForActor } from "./actor-memberships.js";
import {
  MEMBER_RESTRICTED_ROLE_CODE,
  PROTECTED_ROLES,
  assertRestrictionListsValid,
  recordMemberRestrictionDenial,
  uniqueSorted,
} from "./admin.js";
import {
  memberRestrictionModeFor,
  memberRestrictionUnavailable,
  type MemberRestrictionResolver,
} from "./resolver.js";

/**
 * Invites and join requests that carry the restriction mark (PAR-12608 4.2a).
 * The mark lives under one reserved key of the invite's `defaults_payload`;
 * only `markForNewInvite` decides what is written there.
 */

export const INVITE_MEMBER_RESTRICTION_KEY = "memberRestriction";

/** A copy of a caller's free `defaultsPayload` without the reserved key (AC-I6). */
export function withoutInviteMemberRestriction(
  defaultsPayload: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return null;
  const { [INVITE_MEMBER_RESTRICTION_KEY]: _reserved, ...rest } = defaultsPayload;
  return rest;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** What the invite's creator chose (PAR-13091): stored either way, or `none` when nothing was recorded. */
export type InviteRestrictionChoice = "restricted" | "not_restricted" | "none";

/** What a new invite stores under the reserved key: the mark, or the recorded "not restricted" choice. */
export type StoredInviteRestriction =
  | InviteMemberRestriction
  | { restricted: false; pluginKeys: string[]; agentIds: string[] };

function storedRestriction(defaultsPayload: unknown): Record<string, unknown> | null {
  if (!defaultsPayload || typeof defaultsPayload !== "object" || Array.isArray(defaultsPayload)) return null;
  const stored = (defaultsPayload as Record<string, unknown>)[INVITE_MEMBER_RESTRICTION_KEY];
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  return stored as Record<string, unknown>;
}

/** The one parser of the reserved key. */
export function inviteRestrictionChoice(defaultsPayload: unknown): InviteRestrictionChoice {
  const stored = storedRestriction(defaultsPayload);
  if (stored?.restricted === true) return "restricted";
  if (stored?.restricted === false) return "not_restricted";
  return "none";
}

/** The mark stored on an invite, or null when the invite is unmarked. */
export function inviteMemberRestrictionFromDefaults(defaultsPayload: unknown): InviteMemberRestriction | null {
  if (inviteRestrictionChoice(defaultsPayload) !== "restricted") return null;
  const stored = storedRestriction(defaultsPayload)!;
  return { restricted: true, pluginKeys: stringList(stored.pluginKeys), agentIds: stringList(stored.agentIds) };
}

export type JoinMark = { mark: InviteMemberRestriction | null; isDefault: boolean };

/**
 * The mark a person joins with through an invite or a join request (PAR-13091).
 * A recorded choice wins. With none, a company on `report` or `enforce` gives the
 * restricted default to every role but owner and admin; `off` (or the kill switch)
 * gives none. A failed mode read is 503 `MEMBER_RESTRICTION_UNAVAILABLE`.
 * Callers compute it before any write of the join.
 */
export async function markForJoin(
  db: Db,
  input: { companyId: string; defaultsPayload: unknown; membershipRole: string | null },
): Promise<JoinMark> {
  const choice = inviteRestrictionChoice(input.defaultsPayload);
  if (choice === "restricted") return { mark: inviteMemberRestrictionFromDefaults(input.defaultsPayload), isDefault: false };
  if (choice === "not_restricted") return { mark: null, isDefault: false };
  let mode;
  try {
    mode = await memberRestrictionModeFor(db, input.companyId);
  } catch (error) {
    throw memberRestrictionUnavailable(error);
  }
  if (mode === "off" || (input.membershipRole && PROTECTED_ROLES.has(input.membershipRole))) {
    return { mark: null, isDefault: false };
  }
  return { mark: { restricted: true, pluginKeys: [], agentIds: [] }, isDefault: true };
}

/**
 * The person creating an invite may not be restricted in that company. Under
 * `enforce` the call is refused (403 `MEMBER_RESTRICTED`); under `report` it
 * goes through. Both are recorded (rule `R-invite`). A failed read is 503.
 */
export async function assertInviterNotRestricted(
  db: Db,
  resolve: MemberRestrictionResolver,
  actor: Parameters<typeof memberRestrictionForActor>[1],
  companyId: string,
) {
  const restriction = await memberRestrictionForActor(resolve, actor, companyId);
  if (!restriction?.restricted || restriction.mode === "off") return;
  await recordMemberRestrictionDenial(db, {
    companyId,
    personId: restriction.personId,
    ruleId: "R-invite",
    target: "invite.create",
    mode: restriction.mode,
  });
  if (restriction.mode === "enforce") {
    throw forbidden("Not available for your access level", { code: MEMBER_RESTRICTED_CODE });
  }
}

/**
 * What a new invite stores under the reserved key, or null to store nothing.
 *
 * - A human invite needs an explicit `restriction` when the company's mode is
 *   not `off` (422 `MEMBER_RESTRICTION_REQUIRED`); under `off` absent stores nothing.
 * - `restricted: false` on a human invite is stored too, so the join knows the
 *   creator chose (PAR-13091); only an absent choice gets the restricted default.
 * - A marked invite cannot carry the role owner or admin (422).
 * - A non-empty list needs `users:manage_permissions` (`assertCanSetLists`, 403),
 *   and must name installed plugins and agents of this company (422).
 */
export async function markForNewInvite(
  db: Db,
  input: {
    companyId: string;
    allowedJoinTypes: "human" | "agent" | "both";
    humanRole: string | null;
    restriction: InviteMemberRestrictionInput | undefined;
    assertCanSetLists: () => Promise<void>;
  },
): Promise<StoredInviteRestriction | null> {
  const { restriction } = input;
  if (input.allowedJoinTypes === "agent") {
    if (restriction?.restricted) throw unprocessable("Only an invite for a person can be marked restricted");
    return null;
  }
  if (restriction === undefined) {
    let mode;
    try {
      mode = await memberRestrictionModeFor(db, input.companyId);
    } catch (error) {
      throw memberRestrictionUnavailable(error);
    }
    if (mode !== "off") {
      throw unprocessable("Choose whether the person joins restricted (field `restriction`).", {
        code: MEMBER_RESTRICTION_REQUIRED_CODE,
      });
    }
    return null;
  }
  if (!restriction.restricted) return { restricted: false, pluginKeys: [], agentIds: [] };
  if (input.humanRole && PROTECTED_ROLES.has(input.humanRole)) {
    throw unprocessable(`An ${input.humanRole} cannot be restricted. Choose another role or remove the restriction.`, {
      code: MEMBER_RESTRICTED_ROLE_CODE,
    });
  }
  const mark: InviteMemberRestriction = {
    restricted: true,
    pluginKeys: uniqueSorted(restriction.pluginKeys),
    agentIds: uniqueSorted(restriction.agentIds),
  };
  if (mark.pluginKeys.length > 0 || mark.agentIds.length > 0) {
    await input.assertCanSetLists();
    await assertRestrictionListsValid(db, input.companyId, mark);
  }
  return mark;
}
