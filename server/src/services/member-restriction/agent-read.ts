import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { actorPersonMembership, memberRestrictionForActor } from "./actor-memberships.js";
import { memberRestrictionResolver } from "./resolver.js";

type AgentReadActor = Parameters<typeof memberRestrictionForActor>[1] & {
  source?: string;
  isInstanceAdmin?: boolean;
};

/**
 * PAR-12608 4.6 "Agents: list and detail" and 4.7: the agents a caller who
 * works for a person restricted under `enforce` may see in one company (his
 * list), or null when the caller is not bound. The local board and instance
 * admins are never bound. A failed read throws 503 `MEMBER_RESTRICTION_UNAVAILABLE`.
 */
export async function restrictedAgentIdsForActor(db: Db, actor: AgentReadActor, companyId: string): Promise<Set<string> | null> {
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return null;
  const restriction = await memberRestrictionForActor(memberRestrictionResolver(db), actor, companyId);
  return restriction?.restricted && restriction.mode === "enforce" ? new Set(restriction.agentIds) : null;
}

/** The five fields of an agent on his list (AC-G4). */
export function restrictedAgentView(agent: { id: string; name: string; title: string | null; icon: string | null; status: string }) {
  return { id: agent.id, name: agent.name, title: agent.title, icon: agent.icon, status: agent.status };
}

/**
 * PAR-12608 4.6 "One run's detail, log and events", AC-G5: for a caller
 * refused `company_scope:read` only by the member restriction, a run is his
 * only when it is on a task (whose `issue:read` the route checks next) and
 * works for his person (`heartbeat_runs.responsible_user_id`).
 */
export async function runWorksForRestrictedCaller(
  db: Db,
  actor: AgentReadActor,
  run: { id: string; companyId: string; scopeKind?: string | null; issueId?: string | null },
): Promise<boolean> {
  const personId = actorPersonMembership(actor, run.companyId)?.personId;
  if (!personId || run.scopeKind === "company" || !run.issueId) return false;
  const [row] = await db.select({ responsibleUserId: heartbeatRuns.responsibleUserId }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
  return row?.responsibleUserId === personId;
}
