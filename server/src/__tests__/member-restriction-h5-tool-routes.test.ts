import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pluginRoutes } from "../routes/plugins.js";
import { toolGatewayRoutes } from "../routes/tool-gateway.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// PAR-12714 (C2-4): H5, a long-lived agent key names only a run of its own
// agent that works for its own person (AC-H5), and the two tool routes refuse
// signed-in callers who are not owner or admin (AC-T1, AC-T2). Also the
// kill-switch (AC-F8) and failing-read (AC-X1) tests for these consumers.
// O = owner, U = unflagged operator, R = flagged operator.

const support = await getEmbeddedPostgresTestSupport();

describe("H5 and tool routes database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("H5 and the two tool routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const executeTool = vi.fn(async () => ({ content: "ok" }));
  const createSession = vi.fn(async (input: { runId: string }) => ({
    id: randomUUID(), token: `pcgt_${input.runId}`, expiresAt: new Date(Date.now() + 60_000),
  }));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-restriction-h5-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    executeTool.mockClear();
    createSession.mockClear();
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "member-restriction-h5-tool-routes");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function fixture(mode: "off" | "report" | "enforce" = "enforce") {
    const [company] = await db.insert(companies).values({
      name: "H5", issuePrefix: `H${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: mode,
    }).returning();
    const companyId = company!.id;
    const users = { O: `o-${randomUUID()}`, U: `u-${randomUUID()}`, R: `r-${randomUUID()}` };
    for (const id of Object.values(users)) {
      await db.insert(authUsers).values({
        id, name: id, email: `${id}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
      });
    }
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: users.O, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: users.U, status: "active", membershipRole: "operator" },
      { companyId, principalType: "user", principalId: users.R, status: "active", membershipRole: "operator", restricted: true },
    ]);
    const [agent] = await db.insert(agents).values({ companyId, name: "X" }).returning();
    const agentId = agent!.id;
    const runFor = async (person: string) => {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId, agentId, status: "running", responsibleUserId: person,
      }).returning();
      return run!.id;
    };
    const runs = { O: await runFor(users.O), U: await runFor(users.U) };
    const keyFor = async (person: string) => {
      const token = `pcp_${randomUUID()}`;
      await db.insert(agentApiKeys).values({
        companyId, agentId, responsibleUserId: person, name: "key",
        keyHash: createHash("sha256").update(token).digest("hex"),
      });
      return `Bearer ${token}`;
    };
    const keys = { O: await keyFor(users.O), U: await keyFor(users.U), R: await keyFor(users.R) };
    return { companyId, agentId, users, runs, keys };
  }

  function app() {
    const server = express();
    server.use(express.json());
    server.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async (req) => {
        const userId = req.header("x-test-user");
        return userId ? { session: { id: `s-${userId}`, userId }, user: { id: userId, name: userId, email: null } } as never : null;
      },
    }));
    server.get("/api/companies/:companyId/issues", (req, res) => { res.json({ actor: req.actor }); });
    server.post("/api/plugins/:pluginId/actions/:key", (req, res) => { res.json({ actor: req.actor }); });
    server.use("/api", pluginRoutes(db, {} as never, undefined, undefined, {
      toolDispatcher: { listToolsForAgent: vi.fn(), getTool: vi.fn(() => ({ name: "p:t" })), executeTool } as never,
    }));
    server.use("/api", toolGatewayRoutes(db, { createSession } as never));
    server.use(errorHandler);
    return server;
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const execute = (f: Fixture, runId: string) => ({
    tool: "p:t", parameters: {}, runContext: { agentId: f.agentId, runId, companyId: f.companyId, projectId: null },
  });
  const sessionBody = (f: Fixture, runId: string) => ({ companyId: f.companyId, agentId: f.agentId, runId });

  async function denials(companyId: string, ruleId: string) {
    const rows = await db.select({ details: activityLog.details }).from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "member_restriction.denied")));
    return rows.filter((row) => (row.details as { ruleId?: string }).ruleId === ruleId);
  }

  describe("AC-H5: a long-lived key names only its own person's run", () => {
    it("refuses (422) U's key naming O's run on a plugin action, a core task route and the tool route", async () => {
      const f = await fixture();
      const server = app();
      for (const call of [
        request(server).get(`/api/companies/${f.companyId}/issues`),
        request(server).post("/api/plugins/p/actions/a").send({}),
        request(server).post("/api/plugins/tools/execute").send(execute(f, f.runs.O)),
      ]) {
        const res = await call.set("authorization", f.keys.U).set("x-paperclip-run-id", f.runs.O);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe("agent_key_run_not_owned");
      }
      // In the tool run context, without a header.
      const res = await request(server).post("/api/plugins/tools/execute")
        .set("authorization", f.keys.U).send(execute(f, f.runs.O));
      expect(res.status).toBe(422);
      expect(executeTool).not.toHaveBeenCalled();
      expect(await denials(f.companyId, "H5")).toHaveLength(1);
    });

    it("accepts U's key naming a run that works for U, and with no header acts as U", async () => {
      const f = await fixture();
      const named = await request(app()).get(`/api/companies/${f.companyId}/issues`)
        .set("authorization", f.keys.U).set("x-paperclip-run-id", f.runs.U);
      expect(named.status).toBe(200);
      expect(named.body.actor).toMatchObject({ runId: f.runs.U, onBehalfOfUserId: f.users.U });
      const bare = await request(app()).get(`/api/companies/${f.companyId}/issues`).set("authorization", f.keys.U);
      expect(bare.status).toBe(200);
      expect(bare.body.actor).toMatchObject({ onBehalfOfUserId: f.users.U, source: "agent_key" });
      expect(bare.body.actor.runId).toBeUndefined();
    });

    it("refuses a run id that is no run of the key's agent", async () => {
      const f = await fixture();
      for (const runId of [randomUUID(), "not-a-uuid"]) {
        const res = await request(app()).get(`/api/companies/${f.companyId}/issues`)
          .set("authorization", f.keys.U).set("x-paperclip-run-id", runId);
        expect(res.status).toBe(422);
      }
    });

    it("does not bind the owner's key, and in report records and accepts", async () => {
      const f = await fixture("report");
      const res = await request(app()).get(`/api/companies/${f.companyId}/issues`)
        .set("authorization", f.keys.U).set("x-paperclip-run-id", f.runs.O);
      expect(res.status).toBe(200);
      expect(await denials(f.companyId, "H5")).toHaveLength(1);
      const e = await fixture();
      const owner = await request(app()).get(`/api/companies/${e.companyId}/issues`)
        .set("authorization", e.keys.O).set("x-paperclip-run-id", e.runs.U);
      expect(owner.status).toBe(200);
    });
  });

  describe("AC-T1: POST /plugins/tools/execute", () => {
    it("refuses U and R with their own session naming O's run (403), and lets O through", async () => {
      const f = await fixture();
      for (const user of [f.users.U, f.users.R]) {
        const res = await request(app()).post("/api/plugins/tools/execute")
          .set("x-test-user", user).send(execute(f, f.runs.O));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("TOOL_ROUTE_OWNER_ONLY");
      }
      expect(executeTool).not.toHaveBeenCalled();
      const owner = await request(app()).post("/api/plugins/tools/execute")
        .set("x-test-user", f.users.O).send(execute(f, f.runs.O));
      expect(owner.status).toBe(200);
      expect(executeTool).toHaveBeenCalledTimes(1);
    });

    it("in report records the call and lets it through; in off changes nothing", async () => {
      for (const mode of ["report", "off"] as const) {
        const f = await fixture(mode);
        const res = await request(app()).post("/api/plugins/tools/execute")
          .set("x-test-user", f.users.U).send(execute(f, f.runs.O));
        expect(res.status).toBe(200);
        expect(await denials(f.companyId, "H-tool-route")).toHaveLength(mode === "report" ? 1 : 0);
      }
    });
  });

  describe("AC-T2: POST /tool-gateway/sessions", () => {
    it("refuses U and R naming O's run (403, no token); an agent run gets a token for itself", async () => {
      const f = await fixture();
      for (const user of [f.users.U, f.users.R]) {
        const res = await request(app()).post("/api/tool-gateway/sessions")
          .set("x-test-user", user).send(sessionBody(f, f.runs.O));
        expect(res.status).toBe(403);
        expect(res.body.token).toBeUndefined();
      }
      expect(createSession).not.toHaveBeenCalled();
      const jwt = createLocalAgentJwt(f.agentId, f.companyId, "process", f.runs.O, f.users.O);
      const run = await request(app()).post("/api/tool-gateway/sessions")
        .set("authorization", `Bearer ${jwt}`).send({});
      expect(run.status).toBe(201);
      expect(run.body.token).toBe(`pcgt_${f.runs.O}`);
      const owner = await request(app()).post("/api/tool-gateway/sessions")
        .set("x-test-user", f.users.O).send(sessionBody(f, f.runs.O));
      expect(owner.status).toBe(201);
    });

    it("refuses U's key naming O's run in the body (H5)", async () => {
      const f = await fixture();
      const res = await request(app()).post("/api/tool-gateway/sessions")
        .set("authorization", f.keys.U).send(sessionBody(f, f.runs.O));
      expect(res.status).toBe(422);
      expect(createSession).not.toHaveBeenCalled();
    });
  });

  describe("AC-F8: kill switch", () => {
    it("with the variable `off` and the column on enforce, the tool routes and H5 behave as mode off", async () => {
      const f = await fixture();
      vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
      expect((await request(app()).post("/api/plugins/tools/execute")
        .set("x-test-user", f.users.R).send(execute(f, f.runs.O))).status).toBe(200);
      expect((await request(app()).post("/api/tool-gateway/sessions")
        .set("x-test-user", f.users.U).send(sessionBody(f, f.runs.O))).status).toBe(201);
      expect((await request(app()).get(`/api/companies/${f.companyId}/issues`)
        .set("authorization", f.keys.U).set("x-paperclip-run-id", f.runs.O)).status).toBe(200);
      expect(await denials(f.companyId, "H5")).toHaveLength(0);
    });

    it("with the variable `false` or `OFF ` enforcement stays on", async () => {
      const f = await fixture();
      for (const value of ["false", "OFF "]) {
        vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", value);
        expect((await request(app()).post("/api/plugins/tools/execute")
          .set("x-test-user", f.users.U).send(execute(f, f.runs.O))).status).toBe(403);
        expect((await request(app()).get(`/api/companies/${f.companyId}/issues`)
          .set("authorization", f.keys.U).set("x-paperclip-run-id", f.runs.O)).status).toBe(422);
      }
    });
  });

  describe("AC-X1: a failed restriction read refuses", () => {
    it("answers 503 MEMBER_RESTRICTION_UNAVAILABLE on both tool routes and on H5 for R, with no data", async () => {
      const f = await fixture();
      // A malformed stored list makes the resolver throw on R's row.
      await db.update(companyMemberships).set({ restrictedPluginKeys: [1] as never })
        .where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.users.R)));
      const runR = (await db.insert(heartbeatRuns).values({
        companyId: f.companyId, agentId: f.agentId, status: "running", responsibleUserId: f.users.R,
      }).returning())[0]!.id;
      for (const call of [
        request(app()).post("/api/plugins/tools/execute").set("x-test-user", f.users.R).send(execute(f, f.runs.O)),
        request(app()).post("/api/tool-gateway/sessions").set("x-test-user", f.users.R).send(sessionBody(f, f.runs.O)),
        request(app()).get(`/api/companies/${f.companyId}/issues`).set("authorization", f.keys.R).set("x-paperclip-run-id", runR),
      ]) {
        const res = await call;
        expect(res.status).toBe(503);
        expect(res.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
        expect(res.body.actor).toBeUndefined();
        expect(res.body.token).toBeUndefined();
      }
      expect(executeTool).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    });
  });
});
