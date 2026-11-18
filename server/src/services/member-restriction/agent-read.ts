import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { issueReadSqlCondition, type AuthorizationActor } from "../authorization.js";
import { actorPersonMembership, memberRestrictionForMembership } from "./actor-memberships.js";
import { recordMemberRestrictionDenial } from "./admin.js";
import { memberRestrictionResolver } from "./resolver.js";
import { restrictionPersonIds } from "./strict-read.js";

type AgentReadActor = Parameters<typeof actorPersonMembership>[0] & Parameters<typeof restrictionPersonIds>[0] & {
  source?: string;
  isInstanceAdmin?: boolean;
};

/**
 * The people the actor carries (PAR-12608 4.1: the signed-in user, the person
 * an agent works for, the authorizer) who are restricted in `companyId` under
 * `enforce`, each with his agent list. A membership the actor carries as "not
 * restricted" answers without a read. The local board and instance admins are
 * never bound. A failed read throws 503 `MEMBER_RESTRICTION_UNAVAILABLE`.
 */
async function restrictedPeopleForActor(db: Db, actor: AgentReadActor, companyId: string) {
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return [];
  const carried = actorPersonMembership(actor, companyId);
  const resolve = memberRestrictionResolver(db);
  const bound: Array<{ personId: string; agentIds: string[] }> = [];
  for (const personId of restrictionPersonIds(actor)) {
    const membership = carried?.personId === personId ? carried.membership : null;
    const restriction = await memberRestrictionForMembership(resolve, personId, companyId, membership);
    if (restriction.restricted && restriction.mode === "enforce") bound.push({ personId, agentIds: restriction.agentIds });
  }
  return bound;
}

/**
 * PAR-12608 4.6 "Agents: list and detail" and 4.7: the agents a caller bound
 * by a restricted person may see in one company (his list; with more than one
 * such person, the agents on every list), or null when the caller is not bound.
 */
export async function restrictedAgentIdsForActor(db: Db, actor: AgentReadActor, companyId: string): Promise<Set<string> | null> {
  const bound = await restrictedPeopleForActor(db, actor, companyId);
  if (bound.length === 0) return null;
  return bound.slice(1).reduce(
    (listed, { agentIds }) => new Set(agentIds.filter((id) => listed.has(id))),
    new Set(bound[0]!.agentIds),
  );
}

/**
 * PAR-12608 4.3: of `ids` (task ids a route answers with, e.g. unresolved
 * blockers), the ones the caller may read, in their order. A caller not bound
 * by a restricted person gets `ids` with no extra query.
 */
export async function hideUnreadableIssueIds(
  db: Db, actor: AgentReadActor & AuthorizationActor, companyId: string, ids: string[],
): Promise<string[]> {
  if (ids.length === 0 || !(await restrictedAgentIdsForActor(db, actor, companyId))) return ids;
  const rows = await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids), await issueReadSqlCondition(db, actor)));
  const readable = new Set(rows.map((row) => row.id));
  return ids.filter((id) => readable.has(id));
}

/** Rule id of the route checks of 4.7 in `member_restriction.denied` entries. */
export const MEMBER_AGENT_ROUTE_RULE_ID = "R-agent";

/**
 * PAR-12608 4.7, early answers at the routes (wake, assign, execution policy):
 * whether the caller may instruct `agentId`. Under `enforce`, a restricted
 * person the caller carries whose list lacks the agent refuses it, with one
 * `member_restriction.denied` entry. Not bound (kill switch, mode `off` or
 * `report`, unflagged, local board, instance admin): true. A failed read
 * throws 503 `MEMBER_RESTRICTION_UNAVAILABLE`. The run-creation check in the
 * wake queue stays the control; this only gives a clear answer early.
 */
export async function actorMayInstructAgent(
  db: Db,
  actor: AgentReadActor,
  input: { companyId: string; agentId: string; target: string },
): Promise<boolean> {
  const bound = await restrictedPeopleForActor(db, actor, input.companyId);
  const refusing = bound.find((entry) => !entry.agentIds.includes(input.agentId));
  if (!refusing) return true;
  await recordMemberRestrictionDenial(db, {
    companyId: input.companyId, personId: refusing.personId, ruleId: MEMBER_AGENT_ROUTE_RULE_ID,
    target: input.target, objectId: input.agentId, mode: "enforce",
  });
  return false;
}

/** Error details of a refusal by the route checks of 4.7 (AC-A1). */
export const MEMBER_AGENT_NOT_LISTED_DETAILS = { reason: "deny_member_restricted", code: "agent_not_listed" } as const;
export const MEMBER_AGENT_NOT_LISTED_ROUTE_MESSAGE = "This agent is not on the list of agents this restricted member may instruct";

/** The five fields of an agent on his list (AC-G4). */
export function restrictedAgentView(agent: { id: string; name: string; title: string | null; icon: string | null; status: string }) {
  return { id: agent.id, name: agent.name, title: agent.title, icon: agent.icon, status: agent.status };
}

/**
 * PAR-12608 4.6 "One run's detail, log and events", AC-G5: for a caller
 * refused `company_scope:read` only by the member restriction, a run is his
 * only when it is on a task (whose `issue:read` the route checks next) and
 * works (`heartbeat_runs.responsible_user_id`) for every restricted person the
 * caller carries in the run's company.
 */
export async function runWorksForRestrictedCaller(
  db: Db,
  actor: AgentReadActor,
  run: { id: string; companyId: string; scopeKind?: string | null; issueId?: string | null },
): Promise<boolean> {
  if (run.scopeKind === "company" || !run.issueId) return false;
  const people = new Set((await restrictedPeopleForActor(db, actor, run.companyId)).map((entry) => entry.personId));
  if (people.size !== 1) return false;
  const [row] = await db.select({ responsibleUserId: heartbeatRuns.responsibleUserId }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
  return !!row?.responsibleUserId && people.has(row.responsibleUserId);
}
