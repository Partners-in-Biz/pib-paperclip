// PAR-15336 (plan PAR-15073, section 7 "Stage 3, identity"): the per-turn
// voice bridge of the Hermes adapter in front of the real actor middleware.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentApiKeys, agents, boardApiKeys, heartbeatRuns } from "@paperclipai/db";
import { startVoiceTurnBridge, type VoiceTurnBridge } from "@paperclipai/hermes-paperclip-adapter/server";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";

type RunRow = { status: string; resultJson: Record<string, unknown>; contextSnapshot: Record<string, unknown> };

/** Just enough of the database for the agent JWT path of `actorMiddleware`. */
function fakeDb(agent: { id: string; companyId: string }, run: RunRow) {
  const rowsFor = (table: unknown) => {
    if (table === boardApiKeys || table === agentApiKeys) return [];
    if (table === agents) return [{ ...agent, status: "active", lifecycleHolds: [] }];
    if (table === heartbeatRuns) return [{ activeIdentityContextId: null, responsibleUserId: null, ...run }];
    return [];
  };
  const db: unknown = {
    select: () => ({ from: (table: unknown) => ({ where: () => Promise.resolve(rowsFor(table)) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => Promise.resolve([]) }),
  };
  return db as Parameters<typeof actorMiddleware>[0];
}

describe("voice turn bridge identity against the server's actor middleware", () => {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const original = { secret: process.env.PAPERCLIP_AGENT_JWT_SECRET, instance: process.env.PAPERCLIP_INSTANCE_ID };
  let run: RunRow;
  let writes: Array<{ runId: string | undefined; source: string | undefined; body: unknown }>;
  let held: Array<() => void>;
  let closedEarly: number;
  let server: Server;
  let serverUrl: string;
  let bridge: VoiceTurnBridge;

  beforeEach(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "voice-bridge-identity-secret";
    delete process.env.PAPERCLIP_INSTANCE_ID;
    run = { status: "running", resultJson: {}, contextSnapshot: { conversationMode: true } };
    writes = [];
    held = [];
    closedEarly = 0;
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(fakeDb({ id: agentId, companyId }, run), { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.post("/api/issues/:id/comments", (req, res) => {
      if (req.actor.type !== "agent") return void res.status(401).json({ error: "agent only" });
      const commit = () => {
        writes.push({ runId: req.actor.runId, source: req.actor.source, body: req.body });
        res.status(201).json({ runId: req.actor.runId });
      };
      res.on("close", () => {
        if (!res.writableFinished) closedEarly += 1;
      });
      if (req.query.hold) held.push(commit);
      else commit();
    });
    app.use(errorHandler);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    bridge = await startVoiceTurnBridge({ upstreamUrl: `${serverUrl}/api` });
  });

  afterEach(async () => {
    await bridge.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (original.secret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = original.secret;
    if (original.instance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = original.instance;
  });

  const bindTurn = (runId: string) =>
    bridge.bind({ runId, runToken: createLocalAgentJwt(agentId, companyId, "hermes_local", runId, null)! });

  /** What the warm process sends: only the bridge token, plus whatever stale headers it kept. */
  const post = (body: unknown, extra: Record<string, string> = {}, query = "") =>
    fetch(`${bridge.url}/api/issues/${issueId}/comments${query}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json", ...extra },
      body: JSON.stringify(body),
    });

  it("records a write in turn 2 under turn 2's run, and refuses between turns", async () => {
    const run1 = randomUUID();
    const run2 = randomUUID();
    const t1 = bindTurn(run1);
    expect((await post({ turn: 1 })).status).toBe(201);
    bridge.unbind(t1.generation);

    const between = await post({ turn: "between" });
    expect(between.status).toBe(403);
    expect((await between.json()).code).toBe("voice_bridge_no_turn");

    bindTurn(run2);
    // A stale run id header kept by the process is replaced, not rejected as a mismatch.
    const second = await post({ turn: 2 }, { "x-paperclip-run-id": run1 });
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({ runId: run2 });
    expect(writes).toEqual([
      { runId: run1, source: "agent_jwt", body: { turn: 1 } },
      { runId: run2, source: "agent_jwt", body: { turn: 2 } },
    ]);
  });

  it("the bridge token is refused by the server itself", async () => {
    bindTurn(randomUUID());
    for (const headers of [{}, { "x-paperclip-run-id": bridge.current()!.runId }]) {
      const direct = await fetch(`${serverUrl}/api/issues/${issueId}/comments`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json", ...headers },
        body: "{}",
      });
      expect(direct.status).toBe(401);
    }
    expect(writes).toEqual([]);
  });

  it("the bridge token is refused by another process's bridge", async () => {
    const other = await startVoiceTurnBridge({ upstreamUrl: serverUrl });
    try {
      other.bind({ runId: randomUUID(), runToken: createLocalAgentJwt(agentId, companyId, "hermes_local", randomUUID(), null)! });
      const res = await fetch(`${other.url}/api/issues/${issueId}/comments`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(401);
      expect(writes).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it("a cancelled turn gets 403 and its request in flight is aborted", async () => {
    const turn = bindTurn(randomUUID());
    const inflight = post({ late: true }, {}, "?hold=1");
    for (let i = 0; i < 200 && held.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(held).toHaveLength(1);

    // Stop: the run is cancelled in the database; until the host unbinds, the
    // server's own check refuses the turn's writes behind the bridge.
    run.status = "cancelled";
    const stillBound = await post({ afterStop: true });
    expect(stillBound.status).toBe(403);
    expect((await stillBound.json()).code).toBe("conversation_turn_cancelled");

    // The host unbinds: the request in flight is cut off and the process gets 403.
    bridge.unbind(turn.generation);
    const aborted = await inflight;
    expect(aborted.status).toBe(403);
    expect((await aborted.json()).code).toBe("voice_bridge_turn_ended");
    for (let i = 0; i < 200 && closedEarly === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(closedEarly).toBe(1);
    const afterUnbind = await post({ afterUnbind: true });
    expect(afterUnbind.status).toBe(403);
    expect((await afterUnbind.json()).code).toBe("voice_bridge_no_turn");
    expect(writes).toEqual([]);
  });
});
