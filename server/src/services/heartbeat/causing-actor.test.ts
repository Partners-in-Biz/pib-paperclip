import { describe, expect, it } from "vitest";
import type { heartbeatService } from "../heartbeat.js";
import {
  SYSTEM_CAUSING_ACTOR,
  wakeCausingActorFromActor,
  wakeCausingActorFromActorRef,
  wakeCausingActorFromStoredWake,
} from "./causing-actor.js";

type Heartbeat = ReturnType<typeof heartbeatService>;

// AC-A10, type half. The server typecheck fails if a wake without the causing
// actor compiles: `@ts-expect-error` is then an unused directive. The function
// is never called; only its types matter.
function wakeCallsThatMustNotCompile(heartbeat: Heartbeat) {
  // @ts-expect-error causingActor is required on every wake
  void heartbeat.wakeup("agent-1", { source: "on_demand", reason: "manual" });
  // @ts-expect-error the wake options themselves are required
  void heartbeat.wakeup("agent-1");
  void heartbeat.wakeup("agent-1", { source: "on_demand", causingActor: SYSTEM_CAUSING_ACTOR });
  void heartbeat.wakeup("agent-1", { causingActor: { type: "user", userId: "user-1" } });
  void heartbeat.wakeup("agent-1", { causingActor: { type: "agent", agentId: "agent-2", runId: null } });
}

describe("wake causing actor", () => {
  it("keeps the type-level check in the program", () => {
    expect(typeof wakeCallsThatMustNotCompile).toBe("function");
  });

  it("maps the signed-in actor of a request", () => {
    expect(wakeCausingActorFromActor({ actorType: "user", actorId: "user-1", agentId: null, runId: null }))
      .toEqual({ type: "user", userId: "user-1" });
    expect(wakeCausingActorFromActor({ actorType: "agent", actorId: "agent-1", agentId: "agent-1", runId: "run-1" }))
      .toEqual({ type: "agent", agentId: "agent-1", runId: "run-1" });
  });

  it("maps a generic actor reference, falling back to system", () => {
    expect(wakeCausingActorFromActorRef({ actorType: "agent", actorId: "agent-1" }))
      .toEqual({ type: "agent", agentId: "agent-1", runId: null });
    expect(wakeCausingActorFromActorRef({ actorType: "system", actorId: "heartbeat_scheduler" })).toBe("system");
    expect(wakeCausingActorFromActorRef({ actorType: "user", actorId: null })).toBe("system");
    expect(wakeCausingActorFromActorRef(undefined)).toBe("system");
  });

  it("reads a stored wake of the previous version, which has no causing actor", () => {
    expect(wakeCausingActorFromStoredWake({ requestedByActorType: null, requestedByActorId: null })).toBe("system");
    expect(wakeCausingActorFromStoredWake({})).toBe("system");
    expect(wakeCausingActorFromStoredWake({ requestedByActorType: "user", requestedByActorId: "board" }))
      .toEqual({ type: "user", userId: "board" });
    expect(wakeCausingActorFromStoredWake({ requestedByActorType: "unknown", requestedByActorId: "x" })).toBe("system");
  });
});
