import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";
import { issueService } from "../services/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13056 (access C4k-11, PAR-12608 4.6, AC-G3): a scoped plugin route
 * declared `companyResolution: { from: "issue" }` reads the task first, with
 * the real authorization service and the row `issuesSvc.getById` returns. A
 * caller who cannot read the task gets 404 "Issue not found" and the worker is
 * never called. The helper's per-caller behaviour is owned by PAR-13017's tests.
 */

const mockRegistry = vi.hoisted(() => ({ getById: vi.fn(), getByKey: vi.fn() }));
vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => mockRegistry }));
vi.mock("../services/plugin-lifecycle.js", () => ({ pluginLifecycleManager: () => ({}) }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));

const support = await getEmbeddedPostgresTestSupport();
// No silent skip: on CI this file must fail, not skip, without embedded Postgres.
if (process.env.CI && !support.supported) throw new Error("embedded Postgres required on CI");

(support.supported ? describe : describe.skip)("issue-scoped plugin routes read the task first (real resolver)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const PLUGIN_ID = randomUUID();
  const plugin = {
    id: PLUGIN_ID, pluginKey: "paperclip.issue-smoke", version: "1.0.0", status: "ready",
    manifestJson: { id: "paperclip.issue-smoke", capabilities: ["api.routes.register"], apiRoutes: [{
      routeKey: "smoke", method: "GET", path: "/issues/:issueId/smoke", auth: "board-or-agent",
      capability: "api.routes.register", companyResolution: { from: "issue", param: "issueId" },
    }] },
  };
  const call = vi.fn(async () => ({ status: 200, body: { ok: true } }));

  // O owner of the private task P, U operator who cannot read it, Y an agent assigned to P.
  const O = `o-${randomUUID()}`, U = `u-${randomUUID()}`;
  const roles: Record<string, string> = { [O]: "owner", [U]: "operator" };
  let companyId = "", Y = "", P = "", runId = "";

  type RequestActor = Express.Request["actor"];
  const user = (userId: string): RequestActor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
    memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: false, restrictionMode: "off" }],
  });
  const agentFor = (personId: string | undefined): RequestActor => ({
    type: "agent", agentId: Y, companyId, runId, source: "agent_jwt", onBehalfOfUserId: personId,
    onBehalfOfMemberships: personId
      ? [{ companyId, membershipRole: roles[personId], status: "active", restricted: false, restrictionMode: "off" }]
      : undefined,
  } as RequestActor);
  const smoke = (actor: RequestActor) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", pluginRoutes(db, {} as never, undefined, undefined, undefined,
      { workerManager: { call, isRunning: () => true } } as never));
    app.use(errorHandler);
    call.mockClear();
    return request(app).get(`/api/plugins/${PLUGIN_ID}/api/issues/${P}/smoke`);
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-scoped-issue-read-guard-");
    db = createDb(tempDb.connectionString);
    mockRegistry.getById.mockResolvedValue(plugin);
    mockRegistry.getByKey.mockResolvedValue(plugin);
    const [company] = await db.insert(companies).values({
      name: "Plugin issue guard", issuePrefix: `G${randomUUID().slice(0, 5).toUpperCase()}`, requireBoardApprovalForNewAgents: false,
    }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values(Object.keys(roles).map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole: membershipRole as "owner", grantedByUserId: null });
    }
    const [y] = await db.insert(agents).values({ companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "process" }).returning();
    Y = y!.id;
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: Y, status: "active", membershipRole: "member" });
    P = (await issueService(db).create(companyId, {
      title: "Private plan", visibility: "private", status: "in_progress", assigneeAgentId: Y,
      createdByUserId: O, responsibleUserId: O,
    })).id;
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: Y, status: "running", responsibleUserId: U,
      contextSnapshot: { issueId: P, taskId: P, taskKey: P } }).returning();
    runId = run!.id;
  }, 120_000);

  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  it("member U on O's private task P gets 404 Issue not found and the worker is not called", async () => {
    const res = await smoke(user(U));
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
    expect(call).not.toHaveBeenCalled();
  });

  it("O, the owner of P, gets 200 and the worker is called", async () => {
    const res = await smoke(user(O));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(call).toHaveBeenCalledWith(PLUGIN_ID, "handleApiRequest", expect.objectContaining({ companyId, params: { issueId: P } }));
  });

  it("agent Y working for U on P gets 404 and the worker is not called", async () => {
    const res = await smoke(agentFor(U));
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
    expect(call).not.toHaveBeenCalled();
  });

  it("agent Y working for O, P's assignee, gets 200: the 404 above comes from U, not from Y", async () => {
    const res = await smoke(agentFor(O));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(call).toHaveBeenCalled();
  });

  it("with PAPERCLIP_ISSUE_PRIVACY_MODE=off U on P keeps today's 200", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
    const res = await smoke(user(U));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(call).toHaveBeenCalled();
  });
});
