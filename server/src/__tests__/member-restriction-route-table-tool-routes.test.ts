import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  toolPolicies,
  type Db,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pluginRoutes } from "../routes/plugins.js";
import { projectToolRoutes } from "../routes/project-tools.js";
import { toolGatewayRoutes } from "../routes/tool-gateway.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { MEMBER_RESTRICTION_ROUTE_TABLE, createRouteClassifier } from "../services/member-restriction/route-table.js";
import { pluginToolGate } from "../services/member-restriction/tool-gate.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-15227 (C6 finding F1): the tool doors of a run working for a restricted
 * person R. Spec PAR-12608 rev 3, 4.8 "Tools", 4.9 decisions 1 to 3, AC-K2,
 * AC-T3. The route table lets his run through (class `run`); the dispatcher's
 * gate then decides with the run's person: a plugin on his list reaches the
 * worker through each path, one not on it is 403 `MEMBER_RESTRICTED`. His own
 * session stays refused at the route (R-route). AC-G3: his run cannot name O's
 * run. These rows add no resolver caller (the route guard and the dispatcher
 * gate keep their own kill-switch and failing-read tests).
 */

const support = await getEmbeddedPostgresTestSupport();
const THIS_FILE = "server/src/__tests__/member-restriction-route-table-tool-routes.test.ts";

const ROWS = [
  "GET /api/plugins/tools",
  "POST /api/plugins/tools/execute",
  "POST /api/tool-gateway/sessions",
  "GET /api/tool-gateway/tools",
  "POST /api/tool-gateway/tools/call",
  "POST /api/mcp/project-tools",
];

it("every row of this file is named here, and each is a run row", async () => {
  const rows = MEMBER_RESTRICTION_ROUTE_TABLE.filter((entry) => entry.test === THIS_FILE);
  expect(rows.map((entry) => `${entry.method} ${entry.path}`).sort()).toEqual([...ROWS].sort());
  const classify = createRouteClassifier();
  for (const entry of rows) {
    expect(entry.class, entry.path).toBe("run");
    const result = await classify(entry.method, entry.path);
    expect(result.kind === "matched" ? `${result.entry.method} ${result.entry.path}` : result.kind)
      .toBe(`${entry.method} ${entry.path}`);
  }
});

describe("tool route rows database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

const CRM = `partnersinbiz.crm-${randomUUID().slice(0, 8)}`;
const WIKI = `paperclip.llm-wiki-${randomUUID().slice(0, 8)}`;
const manifest = (key: string) => ({
  id: key, apiVersion: 1, version: "1.0.0", displayName: key, description: "Fixture", author: "Paperclip",
  categories: ["automation"], capabilities: [], entrypoints: { worker: "dist/worker.js" },
  tools: [{ name: "read", displayName: "Read", description: "Read", parametersSchema: { type: "object" } }],
}) as unknown as PaperclipPluginManifestV1;

(support.supported ? describe : describe.skip)("tool route rows (PAR-12608 4.8, 4.9, AC-K2, AC-G3)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  const call = vi.fn(async () => ({ content: "ok" }));
  const workerManager = { isRunning: () => true, call } as unknown as PluginWorkerManager;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-tool-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await tempDb?.cleanup(); });
  beforeEach(() => { vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "member-restriction-tool-routes"); });
  afterEach(() => { call.mockClear(); vi.unstubAllEnvs(); });

  /** Company Y on `enforce`: O owner, R flagged with CRM on his list, one agent with a running run for each. */
  async function fixture() {
    const [company] = await db.insert(companies).values({
      name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
    }).returning();
    const companyId = company!.id;
    const users = { O: `o-${randomUUID()}`, R: `r-${randomUUID()}` };
    for (const id of Object.values(users)) {
      await db.insert(authUsers).values({
        id, name: id, email: `${id}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
      });
    }
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: users.O, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: users.R, status: "active", membershipRole: "operator",
        restricted: true, restrictedPluginKeys: [CRM] },
    ]);
    const [agent] = await db.insert(agents).values({
      companyId, name: "Worker", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    const agentId = agent!.id;
    await db.update(companyMemberships).set({ restrictedAgentIds: [agentId] })
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, users.R)));
    await db.insert(toolPolicies).values({ companyId, name: "Allow all", policyType: "allow", selectors: { agentId } });
    const runFor = async (person: string) => {
      const [issue] = await db.insert(issues).values({
        companyId, title: "Work", status: "in_progress", assigneeAgentId: agentId, createdByUserId: person, responsibleUserId: person,
      }).returning();
      const [run] = await db.insert(heartbeatRuns).values({
        companyId, agentId, invocationSource: "assignment", status: "running",
        contextSnapshot: { issueId: issue!.id }, responsibleUserId: person,
      }).returning();
      return run!.id;
    };
    const runs = { O: await runFor(users.O), R: await runFor(users.R) };
    const jwt = (who: "O" | "R") => `Bearer ${createLocalAgentJwt(agentId, companyId, "process", runs[who], users[who])}`;
    return { companyId, agentId, users, runs, jwt };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  function app() {
    const dispatcher = createPluginToolDispatcher({ workerManager, toolGate: pluginToolGate(db) });
    dispatcher.registerPluginTools(CRM, manifest(CRM), randomUUID());
    dispatcher.registerPluginTools(WIKI, manifest(WIKI), randomUUID());
    const toolGateway = createToolGatewayService(db, { pluginToolDispatcher: dispatcher, toolActionSigningSecret: "tool-routes" });
    const server = express();
    server.use(express.json());
    server.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async (req) => {
        const userId = req.header("x-test-user");
        return userId ? { session: { id: `s-${userId}`, userId }, user: { id: userId, name: userId, email: null } } as never : null;
      },
    }));
    // As in `app.ts`: the route table is the first line of the `api` router.
    const api = Router();
    api.use(memberRestrictionRouteGuard(db));
    api.use(projectToolRoutes(db));
    api.use(toolGatewayRoutes(db, toolGateway));
    api.use(pluginRoutes(db, {} as never, undefined, undefined, { toolDispatcher: dispatcher }, undefined, { toolGateway }));
    server.use("/api", api);
    server.use(errorHandler);
    return server;
  }

  const execute = (f: Fixture, tool: string, runId: string) => ({
    tool, parameters: {}, runContext: { agentId: f.agentId, runId, companyId: f.companyId, projectId: null },
  });
  const restricted = (res: request.Response) => {
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code ?? res.body.reasonCode).toBe("MEMBER_RESTRICTED");
  };

  it("GET /api/plugins/tools: his run lists plugin tools; his own session is refused at the route", async () => {
    const f = await fixture();
    const server = app();
    const listed = await request(server).get("/api/plugins/tools").set("authorization", f.jwt("R"));
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.map((tool: { name: string }) => tool.name)).toContain(`${CRM}:read`);
    restricted(await request(server).get("/api/plugins/tools").set("x-test-user", f.users.R));
  });

  it("POST /api/plugins/tools/execute: his run reaches a listed plugin, an unlisted one is refused; O's run reaches both", async () => {
    const f = await fixture();
    const server = app();
    const send = (who: "O" | "R", tool: string) => request(server).post("/api/plugins/tools/execute")
      .set("authorization", f.jwt(who)).send(execute(f, tool, f.runs[who]));
    const reached = await send("R", `${CRM}:read`);
    expect(reached.status, JSON.stringify(reached.body)).toBe(200);
    expect(call).toHaveBeenCalledTimes(1);
    restricted(await send("R", `${WIKI}:read`));
    expect(call).toHaveBeenCalledTimes(1);
    expect((await send("O", `${WIKI}:read`)).status).toBe(200);
    expect(call).toHaveBeenCalledTimes(2);
    // His own session: refused by the route table before the handler.
    restricted(await request(server).post("/api/plugins/tools/execute")
      .set("x-test-user", f.users.R).send(execute(f, `${CRM}:read`, f.runs.R)));
  });

  it("AC-G3: his run naming O's run in the tool run context is refused and reaches no worker", async () => {
    const f = await fixture();
    const res = await request(app()).post("/api/plugins/tools/execute")
      .set("authorization", f.jwt("R")).send(execute(f, `${WIKI}:read`, f.runs.O));
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.reasonCode).toBe("actor_run_mismatch");
    expect(call).not.toHaveBeenCalled();
  });

  it("the tool gateway: his run gets a session, lists plugin tools, reaches a listed plugin; an unlisted one is refused", async () => {
    const f = await fixture();
    const server = app();
    // The body names O's run; an agent caller always gets a session for its own run (AC-G3).
    const session = await request(server).post("/api/tool-gateway/sessions")
      .set("authorization", f.jwt("R")).send({ companyId: f.companyId, agentId: f.agentId, runId: f.runs.O });
    expect(session.status, JSON.stringify(session.body)).toBe(201);
    const token = session.body.token as string;
    const gateway = (req: request.Test) => req.set("authorization", f.jwt("R")).set("x-paperclip-tool-gateway-token", token);

    const tools = await gateway(request(server).get("/api/tool-gateway/tools"));
    expect(tools.status, JSON.stringify(tools.body)).toBe(200);
    expect(JSON.stringify(tools.body)).toContain(`${CRM}:read`);

    const reached = await gateway(request(server).post("/api/tool-gateway/tools/call")).send({ tool: `${CRM}:read`, parameters: {} });
    expect(reached.status, JSON.stringify(reached.body)).toBe(200);
    expect(call).toHaveBeenCalledTimes(1);
    restricted(await gateway(request(server).post("/api/tool-gateway/tools/call")).send({ tool: `${WIKI}:read`, parameters: {} }));
    expect(call).toHaveBeenCalledTimes(1);

    // His own session cannot open a gateway session or use one.
    const own = await request(server).post("/api/tool-gateway/sessions")
      .set("x-test-user", f.users.R).send({ companyId: f.companyId, agentId: f.agentId, runId: f.runs.R });
    restricted(own);
    expect(own.body.token).toBeUndefined();
    restricted(await request(server).get("/api/tool-gateway/tools")
      .set("x-test-user", f.users.R).set("x-paperclip-tool-gateway-token", token));
    restricted(await request(server).post("/api/tool-gateway/tools/call")
      .set("x-test-user", f.users.R).set("x-paperclip-tool-gateway-token", token).send({ tool: `${CRM}:read`, parameters: {} }));
  });

  it("POST /api/mcp/project-tools: his run starts the project tools server and lists its tools; his session is refused", async () => {
    const f = await fixture();
    const server = app();
    const rpc = (body: Record<string, unknown>) => request(server).post("/api/mcp/project-tools")
      .set("authorization", f.jwt("R")).send({ jsonrpc: "2.0", id: 1, ...body });
    const init = await rpc({ method: "initialize" });
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("paperclip-project-tools");
    const list = await rpc({ method: "tools/list" });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.result.tools.map((tool: { name: string }) => tool.name)).toContain("list_projects");
    restricted(await request(server).post("/api/mcp/project-tools")
      .set("x-test-user", f.users.R).send({ jsonrpc: "2.0", id: 1, method: "initialize" }));
  });
});
