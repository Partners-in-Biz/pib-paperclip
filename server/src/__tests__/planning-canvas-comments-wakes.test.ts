import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  issues,
  planningCanvases,
  principalPermissionGrants,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.ts";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { planningCanvasCommentRoutes } from "../routes/planning-canvas-comments.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { planningCanvasOpsService } from "../services/planning-canvas-ops.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13935 (Planning Canvas C6, plan J.4, rule PAR-12618): per wake site, the
 * run a mention wakes works for the person who wrote the comment, not the
 * board owner and not the company default. Each run's own token (the one the
 * heartbeat hands the adapter) goes through the real `actorMiddleware`, and
 * the request it makes carries `onBehalfOfUserId` = the commenter.
 * Sites: mention create (`issue_assigned`) and repeat mention (`issue_commented`).
 */

const seen = vi.hoisted(() => ({ app: null as null | express.Express, persons: new Map<string, string | null>() }));
const mockAdapterExecute = vi.hoisted(() => vi.fn(async (ctx: { runId: string; authToken?: string }) => {
  // While the run is live, call the API with the run's own token.
  const res = await request(seen.app!).get("/api/probe").set("authorization", `Bearer ${ctx.authToken}`);
  seen.persons.set(ctx.runId, res.status === 200 ? res.body.onBehalfOfUserId : `status ${res.status}`);
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Canvas wake test run.", provider: "test", model: "test-model" };
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: true, execute: mockAdapterExecute })) };
});

const support = await getEmbeddedPostgresTestSupport();

describe("planning canvas wake database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("planning canvas mention wakes work for the commenter (PAR-12618)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const OWNER = `owner-${randomUUID()}`;
  const MEMBER = `member-${randomUUID()}`;
  const OTHER = `other-${randomUUID()}`;
  const DEFAULT = `default-${randomUUID()}`;
  let companyId = "";
  let agentId = "";
  let boardId = "";

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "planning-canvas-comments-wakes");
    seen.persons.clear();
    mockAdapterExecute.mockClear();
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-planning-canvas-wakes-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async (req) => {
        const userId = req.header("x-test-session");
        return userId ? ({ session: { id: `s-${userId}`, userId }, user: { id: userId, name: userId, email: null } } as never) : null;
      },
    }));
    const api = express.Router();
    api.get("/probe", (req, res) => {
      res.json({ type: req.actor.type, onBehalfOfUserId: req.actor.type === "agent" ? req.actor.onBehalfOfUserId ?? null : null });
    });
    api.use(planningCanvasCommentRoutes(db, { heartbeat }));
    app.use("/api", api);
    app.use(errorHandler);
    seen.app = app;

    companyId = randomUUID();
    // The company default person is someone else, so a fallback would fail the test.
    await db.insert(companies).values({ id: companyId, name: "Canvas wakes",
      issuePrefix: `K${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, defaultResponsibleUserId: DEFAULT });
    const now = new Date();
    await db.insert(authUsers).values([OWNER, MEMBER, OTHER, DEFAULT].map((id) => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values([OWNER, MEMBER, OTHER, DEFAULT].map((principalId) => ({
      companyId, principalType: "user" as const, principalId, status: "active", membershipRole: principalId === DEFAULT ? "owner" : "operator" })));
    // Operators assign work through the `tasks:assign` grant, as on `POST /issues`.
    await db.insert(principalPermissionGrants).values([MEMBER, OTHER].map((principalId) => ({
      companyId, principalType: "user" as const, principalId, permissionKey: "tasks:assign" })));
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Planner", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    const [board] = await db.insert(planningCanvases)
      .values({ companyId, userId: OWNER, title: "Shared board", scope: "company", memberAccess: "comment" }).returning();
    boardId = board!.id;
    await planningCanvasOpsService(db).applyOps({ companyId, boardId, actor: { type: "user", id: OWNER },
      batch: { ops: [{ op: "add", item: { itemType: "node", key: "n1", kind: "sticky", x: 0, y: 0, width: 100, height: 80, zIndex: 1, color: "yellow", title: "Plan", content: "" } }] } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    runningProcesses.clear();
    if (heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  }, 60_000);

  const comment = (userId: string, itemKey = "n1") =>
    request(seen.app!).post(`/api/companies/${companyId}/planning-canvases/${boardId}/comments`)
      .set({ "x-test-session": userId, origin: "http://localhost" })
      .send({ itemKey, body: `Over to you [@Planner](agent://${agentId})` });

  async function runsSince(started: Date) {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    return runs.filter((run) => run.createdAt >= started);
  }

  it("mention create: the issue_assigned run works for the commenter, not the board owner", async () => {
    const started = new Date();
    const res = await comment(MEMBER);
    expect(res.status, res.text).toBe(201);
    expect(res.body.mentionState).toEqual({ [agentId]: "sent" });
    const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.originId, `${boardId}:n1`)));
    const runs = (await runsSince(started)).filter((run) => (run.contextSnapshot as { issueId?: string } | null)?.issueId === issue!.id);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.map((run) => run.responsibleUserId)).toEqual(runs.map(() => MEMBER));
    expect(mockAdapterExecute).toHaveBeenCalled();
    // Each run's own token, through the real middleware, works for the commenter.
    // (A run still waiting as a scheduled retry has not executed yet.)
    const executed = runs.filter((run) => seen.persons.has(run.id));
    expect(executed.length).toBeGreaterThan(0);
    expect(executed.map((run) => seen.persons.get(run.id))).toEqual(executed.map(() => MEMBER));
  });

  it("repeat mention: the issue_commented run works for the second commenter", async () => {
    // An open, idle issue the agent already holds for node n2 (no live run to coalesce into).
    const [issue] = await db.insert(issues).values({ companyId, title: "Canvas: earlier", status: "todo", assigneeAgentId: agentId,
      originKind: "planning_canvas", originId: `${boardId}:n2`, createdByUserId: MEMBER, responsibleUserId: MEMBER }).returning();
    await planningCanvasOpsService(db).applyOps({ companyId, boardId, actor: { type: "user", id: OWNER },
      batch: { ops: [{ op: "add", item: { itemType: "node", key: "n2", kind: "sticky", x: 0, y: 0, width: 100, height: 80, zIndex: 1, color: "yellow", title: "Again", content: "" } }] } });
    const started = new Date();
    const res = await comment(OTHER, "n2");
    expect(res.status, res.text).toBe(201);
    expect(res.body.mentionState).toEqual({ [agentId]: "added_to_open" });
    const runs = (await runsSince(started)).filter((run) => (run.contextSnapshot as { issueId?: string } | null)?.issueId === issue!.id);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.map((run) => run.responsibleUserId)).toEqual(runs.map(() => OTHER));
    // Each run's own token, through the real middleware, works for the commenter.
    // (A run still waiting as a scheduled retry has not executed yet.)
    const executed = runs.filter((run) => seen.persons.has(run.id));
    expect(executed.length).toBeGreaterThan(0);
    expect(executed.map((run) => seen.persons.get(run.id))).toEqual(executed.map(() => OTHER));
  });
});
