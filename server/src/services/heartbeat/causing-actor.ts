import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { MemberRestrictionMode } from "@paperclipai/shared";
import { honestPersonRuleFor } from "../member-restriction/honest-person.js";
import { memberRestrictionKillSwitchOn, memberRestrictionUnavailable } from "../member-restriction/resolver.js";

/**
 * The causing actor of a wake: who led to an agent's run (PAR-12608 4.7).
 *
 * Every wake names one: the acting user, the acting agent and its run, or the
 * literal "system" when no person's request leads to the call (timers,
 * sweepers, events). The field is required on the wake options, so a call
 * site that forgets it does not compile. The acting run is always taken from
 * the signed-in actor by the server, never from a request body.
 */
export type WakeCausingActor =
  | { type: "user"; userId: string }
  | { type: "agent"; agentId: string; runId: string | null }
  | "system";

export const SYSTEM_CAUSING_ACTOR = "system" as const satisfies WakeCausingActor;

/** The signed-in actor of a request (the shape `getActorInfo` returns). */
export interface CausingRequestActor {
  actorType: "user" | "agent";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

export function wakeCausingActorFromActor(actor: CausingRequestActor): WakeCausingActor {
  if (actor.actorType === "user") return { type: "user", userId: actor.actorId };
  return { type: "agent", agentId: actor.agentId ?? actor.actorId, runId: actor.runId ?? null };
}

/** A causing actor from the generic `{ actorType, actorId }` shape services pass around. */
export function wakeCausingActorFromActorRef(
  actor: { actorType?: string | null; actorId?: string | null; runId?: string | null } | null | undefined,
): WakeCausingActor {
  if (!actor?.actorId) return SYSTEM_CAUSING_ACTOR;
  if (actor.actorType === "user") return { type: "user", userId: actor.actorId };
  if (actor.actorType === "agent") return { type: "agent", agentId: actor.actorId, runId: actor.runId ?? null };
  return SYSTEM_CAUSING_ACTOR;
}

/**
 * The causing actor of a stored wake request that is replayed. A wake stored
 * by the previous version carries only the optional requestedBy columns; when
 * they are empty the wake runs as "system", which is never restricted. The
 * stored wake context (server-written) may carry the stamp of H1; when it names
 * the same actor as the columns it is kept, so a causing run survives replay.
 */
export function wakeCausingActorFromStoredWake(
  wake: {
    requestedByActorType?: string | null;
    requestedByActorId?: string | null;
  },
  storedContext?: Record<string, unknown> | null,
): WakeCausingActor {
  const fromColumns = wakeCausingActorFromActorRef({
    actorType: wake.requestedByActorType,
    actorId: wake.requestedByActorId,
  });
  const stamped = readStampedWakeCausingActor(storedContext);
  if (stamped && stamped !== "system" && fromColumns !== "system" && stamped.type === fromColumns.type &&
      (stamped.type === "user" ? stamped.userId : stamped.agentId) ===
      (fromColumns.type === "user" ? fromColumns.userId : fromColumns.agentId)) {
    return stamped;
  }
  return fromColumns;
}

/**
 * Wake-context key of the H1 stamp (PAR-12608 4.10). The server writes it only
 * when the causing person is bound by rule group H, so a company on `off` keeps
 * today's context byte for byte. A value from a caller's context is never kept.
 */
export const WAKE_CAUSING_ACTOR_CONTEXT_KEY = "wakeCausingActor";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function readStampedWakeCausingActor(
  context: Record<string, unknown> | null | undefined,
): WakeCausingActor | null {
  const value = context?.[WAKE_CAUSING_ACTOR_CONTEXT_KEY];
  if (!value || typeof value !== "object") return null;
  const actor = value as Record<string, unknown>;
  if (actor.type === "user" && nonEmpty(actor.userId)) return { type: "user", userId: actor.userId };
  if (actor.type === "agent" && nonEmpty(actor.agentId)) {
    return { type: "agent", agentId: actor.agentId, runId: nonEmpty(actor.runId) ? actor.runId : null };
  }
  return null;
}

export interface CausingPerson {
  personId: string;
  mode: Exclude<MemberRestrictionMode, "off">;
}

/**
 * The person bound by H who caused a wake: the acting user, or the person the
 * acting run works for (read from the run row, scoped to its agent and
 * company). Null for "system", a run with no person, an agent with no run, or a
 * person H does not bind. A failed read throws 503 `MEMBER_RESTRICTION_UNAVAILABLE`.
 */
export async function causingPersonFor(
  db: Db,
  companyId: string,
  actor: WakeCausingActor | null | undefined,
): Promise<CausingPerson | null> {
  if (!actor || actor === "system" || memberRestrictionKillSwitchOn()) return null;
  let personId: string | null = actor.type === "user" ? actor.userId : null;
  if (actor.type === "agent" && actor.runId) {
    const runId = actor.runId;
    const run = await db
      .select({ responsibleUserId: heartbeatRuns.responsibleUserId })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, actor.agentId), eq(heartbeatRuns.id, runId)))
      .then((rows) => rows[0] ?? null)
      .catch((error: unknown) => { throw memberRestrictionUnavailable(error); });
    personId = run?.responsibleUserId ?? null;
  }
  if (!personId) return null;
  const rule = await honestPersonRuleFor(db, personId, companyId);
  if (!rule.bound || rule.mode === "off") return null;
  return { personId, mode: rule.mode };
}

/**
 * Replace any H1 stamp in a new wake's context with the server's own: the
 * causing actor, written only when its person is bound by H.
 */
export async function stampWakeCausingActor(
  db: Db,
  companyId: string,
  contexts: Array<Record<string, unknown>>,
  actor: WakeCausingActor | null | undefined,
): Promise<void> {
  for (const context of contexts) delete context[WAKE_CAUSING_ACTOR_CONTEXT_KEY];
  if (!actor || actor === "system" || !(await causingPersonFor(db, companyId, actor))) return;
  for (const context of contexts) context[WAKE_CAUSING_ACTOR_CONTEXT_KEY] = { ...actor };
}
