import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Db } from "@paperclipai/db";
import { MEMBER_RESTRICTED_CODE, type ActorCompanyMembership, type MemberRestrictionMode } from "@paperclipai/shared";
import { HttpError } from "../../errors.js";
import { recordMemberRestrictionDenial } from "./admin.js";
import { hasMemberRestrictionFields, loadActorMemberships, memberRestrictionForMembership } from "./actor-memberships.js";
import {
  memberRestrictionKillSwitchOn,
  memberRestrictionResolver,
  memberRestrictionUnavailable,
  type MemberRestrictionResolver,
} from "./resolver.js";
import { stripHostKeysFromResponses } from "./response-strip.js";
import { createRouteClassifier, type MemberRestrictionRouteEntry, type MemberRestrictionRouteMatch } from "./route-table.js";
import { restrictionPersonIds } from "./strict-read.js";

/**
 * The route-table middleware of PAR-12608 4.6: the first line of the `api`
 * router, above the avatar router (C10). Assistant-connection tool calls are
 * injected into the same router (C33), so they pass here too.
 *
 * For a caller who works for a restricted person it puts the companies where he
 * is restricted under `enforce` on the actor, then lets the route table decide.
 * Everybody else (no restricted person, kill switch on, local board, instance
 * admin) passes untouched. `report` records a "would refuse" and passes;
 * `enforce` records and refuses. A failed read answers 503.
 */

export const MEMBER_RESTRICTION_ROUTE_RULE_ID = "R-route";
export const MEMBER_RESTRICTED_MESSAGE = "Not available for your access level";

type Restricted = { mode: Exclude<MemberRestrictionMode, "off">; personId: string };
type Actor = Request["actor"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The company a path names (`/api/companies/:companyId/...`), lower case; null when the segment is not a UUID. */
export function companyIdInPath(path: string): string | null {
  const segment = /^\/api\/companies\/([^/?]+)/i.exec(path)?.[1];
  if (!segment) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return UUID.test(decoded) ? decoded.toLowerCase() : null;
}

/** The memberships an actor carries for one of its people; undefined when it carries none for him. */
function carriedMemberships(actor: Actor, personId: string) {
  if (actor.type === "board" && actor.userId === personId) return actor.memberships;
  if (actor.type === "agent" && actor.onBehalfOfUserId === personId) return actor.onBehalfOfMemberships;
  return undefined;
}

function add(into: Map<string, Restricted>, companyId: string, mode: MemberRestrictionMode, personId: string) {
  if (mode === "off") return;
  const known = into.get(companyId.toLowerCase());
  if (!known || (known.mode === "report" && mode === "enforce")) into.set(companyId.toLowerCase(), { mode, personId });
}

/**
 * Where each person the actor carries is restricted, by company. The fields on
 * the carried memberships answer without a read; a membership without them,
 * a person with no carried memberships, the agent's own company and the
 * company the path names when not carried are read through the resolver
 * (AC-X3). Throws when a read fails.
 */
async function restrictedCompanies(
  db: Db,
  resolve: MemberRestrictionResolver,
  actor: Actor,
  pathCompanyId: string | null,
): Promise<Map<string, Restricted>> {
  const out = new Map<string, Restricted>();
  for (const personId of restrictionPersonIds(actor)) {
    const memberships: Array<Partial<ActorCompanyMembership> & { companyId: string }> =
      carriedMemberships(actor, personId) ?? await loadActorMemberships(db, { userId: personId, activeOnly: false });
    const covered = new Set<string>();
    for (const membership of memberships) {
      covered.add(membership.companyId.toLowerCase());
      if (hasMemberRestrictionFields(membership)) {
        if (membership.restricted) add(out, membership.companyId, membership.restrictionMode, personId);
        continue;
      }
      const answer = await memberRestrictionForMembership(resolve, personId, membership.companyId, membership);
      if (answer.restricted) add(out, membership.companyId, answer.mode, personId);
    }
    const extra = [actor.type === "agent" ? actor.companyId?.toLowerCase() : null, pathCompanyId];
    for (const companyId of new Set(extra)) {
      if (!companyId || covered.has(companyId)) continue;
      const answer = await memberRestrictionForMembership(resolve, personId, companyId, null);
      if (answer.restricted) add(out, companyId, answer.mode, personId);
    }
  }
  return out;
}

/** Whether the route table lets the caller through; `markByCompany` when the handler must refuse the set itself. */
function verdict(match: MemberRestrictionRouteMatch, actor: Actor): { pass: boolean; markByCompany?: true } {
  if (match.kind !== "matched") return { pass: false };
  switch (match.entry.class) {
    case "open":
    case "plugin": // the plugin gate (4.8) decides.
      return { pass: true };
    case "run":
      return { pass: actor.type === "agent" };
    case "by-company":
      return { pass: true, markByCompany: true };
    default:
      return { pass: false };
  }
}

export function memberRestrictionRouteGuard(
  db: Db,
  options: { entries?: readonly MemberRestrictionRouteEntry[]; resolve?: MemberRestrictionResolver } = {},
): RequestHandler {
  const classify = createRouteClassifier(options.entries);
  const resolve = options.resolve ?? memberRestrictionResolver(db);

  return async function memberRestrictionRoutes(req: Request, res: Response, next: NextFunction) {
    const actor = req.actor;
    if (!actor || actor.type === "none" || actor.source === "local_implicit" || actor.isInstanceAdmin) return next();
    if (memberRestrictionKillSwitchOn() || restrictionPersonIds(actor).length === 0) return next();

    // Mounted on the `api` router: the table's patterns carry the `/api` prefix.
    const path = `${req.baseUrl}${req.url}`;
    const pathCompanyId = companyIdInPath(path.split("?")[0] ?? "");
    let restricted: Map<string, Restricted>;
    try {
      restricted = await restrictedCompanies(db, resolve, actor, pathCompanyId);
    } catch (error) {
      return next(error instanceof HttpError && error.status === 503 ? error : memberRestrictionUnavailable(error));
    }
    if (restricted.size === 0) return next();
    actor.memberRestrictedCompanyIds = [...restricted]
      .filter(([, entry]) => entry.mode === "enforce")
      .map(([companyId]) => companyId)
      .sort();

    const match = await classify(req.method, path);
    let decision: { pass: boolean; markByCompany?: true };
    let deciding: Restricted & { companyId: string };
    const anywhere = [...restricted].map(([companyId, entry]) => ({ companyId, ...entry }));
    const strongest = anywhere.find((entry) => entry.mode === "enforce") ?? anywhere[0]!;
    if (match.kind === "refused") {
      // An unsafe or unclassifiable path is refused for a bound caller whatever company it seems to name.
      decision = { pass: false };
      deciding = strongest;
    } else if (pathCompanyId) {
      const here = restricted.get(pathCompanyId);
      if (!here) return next();
      decision = verdict(match, actor);
      deciding = { companyId: pathCompanyId, ...here };
    } else {
      decision = verdict(match, actor);
      deciding = strongest;
    }

    if (decision.pass) {
      if (decision.markByCompany) actor.memberRestrictionByCompany = true;
      // PAR-12951: no host or secret key at any depth of a JSON response to him.
      // PAR-13327: the matched row names the shape of the top-level body.
      if (deciding.mode === "enforce") {
        stripHostKeysFromResponses(res, match.kind === "matched" ? `${match.entry.method} ${match.entry.path}` : undefined);
      }
      return next();
    }
    await recordMemberRestrictionDenial(db, {
      companyId: deciding.companyId,
      personId: deciding.personId,
      ruleId: MEMBER_RESTRICTION_ROUTE_RULE_ID,
      target: `${req.method.toUpperCase()} ${path.split("?")[0]}`,
      mode: deciding.mode,
    });
    if (deciding.mode === "report") return next();
    // Exactly this body (4.6); the error handler would add `details`.
    res.status(403).json({ error: MEMBER_RESTRICTED_MESSAGE, code: MEMBER_RESTRICTED_CODE });
  };
}
