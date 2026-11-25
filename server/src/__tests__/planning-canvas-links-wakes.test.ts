import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  planningCanvases,
  principalPermissionGrants,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.ts";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { planningCanvasLinkRoutes } from "../routes/planning-canvas-links.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { planningCanvasOpsService } from "../services/planning-canvas-ops.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13937 (Planning Canvas C8, plan J.4, rule PAR-12618): the run a handoff
 * wakes works for the person who handed off, not the board owner and not the
 * company default. Each run's own token (the one the heartbeat hands the
 * adapter) goes through the real `actorMiddleware`, and the request it makes
 * carries `onBehalfOfUserId` = the caller. Site: handoff create
 * (`issue_assigned`), in both modes.
 */

const seen = vi.hoisted(() => ({ app: null as null | express.Express, persons: new Map<string, string | null>() }));
const mockAdapterExecute = vi.hoisted(() => vi.fn(async (ctx: { runId: string; authToken?: string }) => {
  const res = await request(seen.app!).get("/api/probe").set("authorization", `Bearer ${ctx.authToken}`);
  seen.persons.set(ctx.runId, res.status === 200 ? res.body.onBehalfOfUserId : `status ${res.status}`);
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Canvas handoff wake test run.", provider: "test", model: "test-model" };
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: true, execute: mockAdapterExecute })) };
});

const support = await getEmbeddedPostgresTestSupport();

describe("planning canvas handoff wake database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("planning canvas handoff wakes work for the caller (PAR-12618)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const OWNER = `owner-${randomUUID()}`;
  const MEMBER = `member-${randomUUID()}`;
  const DEFAULT = `default-${randomUUID()}`;
  let companyId = "";
  let agentId = "";
  let boardId = "";

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "planning-canvas-links-wakes");
    seen.persons.clear();
    mockAdapterExecute.mockClear();
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-planning-canvas-handoff-wakes-");
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
    api.use(planningCanvasLinkRoutes(db, { heartbeat }));
    app.use("/api", api);
    app.use(errorHandler);
    seen.app = app;

    companyId = randomUUID();
    // The company default person is someone else, so a fallback would fail the test.
    await db.insert(companies).values({ id: companyId, name: "Canvas handoff wakes",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, defaultResponsibleUserId: DEFAULT });
    const now = new Date();
    await db.insert(authUsers).values([OWNER, MEMBER, DEFAULT].map((id) => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values([OWNER, MEMBER, DEFAULT].map((principalId) => ({
      companyId, principalType: "user" as const, principalId, status: "active", membershipRole: principalId === DEFAULT ? "owner" : "operator" })));
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user" as const, principalId: MEMBER, permissionKey: "tasks:assign" });
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Planner", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    const [board] = await db.insert(planningCanvases)
      .values({ companyId, userId: OWNER, title: "Shared board", scope: "company", memberAccess: "edit" }).returning();
    boardId = board!.id;
    await planningCanvasOpsService(db).applyOps({ companyId, boardId, actor: { type: "user", id: OWNER },
      batch: { ops: ["n1", "n2", "n3"].map((key) => ({ op: "add", item: { itemType: "node", key, kind: "sticky", x: 0, y: 0, width: 100, height: 80, zIndex: 1, color: "yellow", title: `Plan ${key}`, content: "" } })) } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    runningProcesses.clear();
    if (heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  }, 60_000);

  const handoff = (body: Record<string, unknown>) =>
    request(seen.app!).post(`/api/companies/${companyId}/planning-canvases/${boardId}/handoff`)
      .set({ "x-test-session": MEMBER, origin: "http://localhost" })
      .send({ assigneeAgentId: agentId, ...body });

  async function runsFor(issueIds: string[], started: Date) {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.agentId, [agentId])));
    return runs.filter((run) => run.createdAt >= started && issueIds.includes((run.contextSnapshot as { issueId?: string } | null)?.issueId ?? ""));
  }

  it.each([
    ["one_per_node", ["n1", "n2"]],
    ["single", ["n3"]],
  ])("%s handoff: the issue_assigned run works for the caller, not the board owner", async (mode, keys) => {
    const started = new Date();
    const res = await handoff({ keys, mode, idempotencyKey: `wake-${mode}` });
    expect(res.status, res.text).toBe(201);
    const runs = await runsFor(res.body.issues.map((issue: { id: string }) => issue.id), started);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.map((run) => run.responsibleUserId)).toEqual(runs.map(() => MEMBER));
    expect(mockAdapterExecute).toHaveBeenCalled();
    // Each run's own token, through the real middleware, works for the caller.
    // (A run still waiting as a scheduled retry has not executed yet.)
    const executed = runs.filter((run) => seen.persons.has(run.id));
    expect(executed.length).toBeGreaterThan(0);
    expect(executed.map((run) => seen.persons.get(run.id))).toEqual(executed.map(() => MEMBER));
  });
});
