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
 * they are empty the wake runs as "system", which is never restricted.
 */
export function wakeCausingActorFromStoredWake(wake: {
  requestedByActorType?: string | null;
  requestedByActorId?: string | null;
}): WakeCausingActor {
  return wakeCausingActorFromActorRef({
    actorType: wake.requestedByActorType,
    actorId: wake.requestedByActorId,
  });
}
