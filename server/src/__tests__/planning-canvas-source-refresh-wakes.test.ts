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
  connectionGrants,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  issueComments,
  issues,
  planningCanvases,
  planningCanvasItems,
  principalPermissionGrants,
  projects,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolPolicies,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.ts";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { planningCanvasSourceRoutes } from "../routes/planning-canvas-sources.js";
import { planningCanvasRoutes } from "../routes/planning-canvases.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { planningCanvasOpsService } from "../services/planning-canvas-ops.js";
import { PLANNING_CANVAS_SOURCE_REFRESH_CONTEXT } from "../services/planning-canvas-sources.js";
import { PLANNING_CANVAS_CHAT_ENV } from "../services/planning-canvas-switches.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-14282 acceptance `acceptance-par-14282` s.1 and s.4: the refresh wake
 * call site (`planning_canvas.source_refresh`). The refresh run works for the
 * refresher, read through the real `actorMiddleware` with the run's own JWT
 * (never the person who first fetched the source, never the company default).
 * During that run the gateway rule is checked again on the same board, and the
 * source the run writes back carries the refresher as `fetchedBy`. The own
 * personal board positive control is in planning-canvas-source-rule.test.ts.
 */

type Seen = { person: string | null; personalCall: string; write?: string };
const seen = vi.hoisted(() => ({
  app: null as null | express.Express,
  db: null as unknown,
  runs: new Map<string, Seen>(),
  personalTool: "",
  boardOf: new Map<string, string>(),
}));

const mockAdapterExecute = vi.hoisted(() => vi.fn(async (ctx: { runId: string; agent: { id: string; companyId: string }; authToken?: string; context?: Record<string, unknown> }) => {
  const auth = { authorization: `Bearer ${ctx.authToken}`, "x-paperclip-run-id": ctx.runId };
  const issueId = typeof ctx.context?.issueId === "string" ? ctx.context.issueId : null;
  const probe = await request(seen.app!).get("/api/probe").set(auth);
  // The run calls the personal connector's read action through the real gateway.
  const { createToolGatewayService: gatewayFor } = await import("../services/tool-gateway.js");
  const gw = gatewayFor(seen.db as never, {
    toolActionSigningSecret: "planning-canvas-source-refresh-wakes",
    remoteHttpRequest: async (_url, init) => new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(init.body)).id,
      result: { content: [{ type: "text", text: "rows" }] } }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  let personalCall = "";
  try {
    const session = await gw.createSession({ companyId: ctx.agent.companyId, agentId: ctx.agent.id, runId: ctx.runId });
    personalCall = (await gw.executeTool({ sessionToken: session.token, tool: seen.personalTool, parameters: {} })).status;
  } catch (error) {
    personalCall = (error as { reasonCode?: string }).reasonCode ?? String(error);
  }
  const entry: Seen = { person: probe.status === 200 ? probe.body.onBehalfOfUserId : `status ${probe.status}`, personalCall };
  // The run writes the fetched rows back with the source (fields it may not choose are forged here).
  const boardId = issueId ? seen.boardOf.get(issueId) : undefined;
  if (boardId) {
    const companyId = ctx.agent.companyId;
    const write = await request(seen.app!).post(`/api/companies/${companyId}/planning-canvases/${boardId}/ops`).set(auth).send({ ops: [{
      op: "add", item: { itemType: "node", key: `fetched-${ctx.runId}`, kind: "table", x: 0, y: 0, width: 300, height: 200, zIndex: 2, color: "slate",
        title: "Rows", content: "", data: { columns: [], rows: [], source: { tool: seen.personalTool, params: {}, fetchedBy: "forged" } } },
    }] });
    entry.write = write.status === 200 ? write.body.results[0].status : `status ${write.status}`;
  }
  seen.runs.set(ctx.runId, entry);
  if (issueId) {
    await request(seen.app!).patch(`/api/issues/${issueId}`).set(auth).send({ status: "done", comment: "Refreshed." });
  }
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Refresh test run.", provider: "test", model: "test-model" };
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: true, execute: mockAdapterExecute })) };
});
// Rule H read, as in planning-canvas-chat-wakes.test.ts: a throwing read must fail the refresh closed.
const honestRead = vi.hoisted(() => ({ fails: false }));
vi.mock("../services/member-restriction/honest-person.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/honest-person.js")>();
  return {
    ...actual,
    honestPersonRuleFor: async (...args: Parameters<typeof actual.honestPersonRuleFor>) => {
      if (honestRead.fails) throw new Error("fixture: rule H read failed");
      return actual.honestPersonRuleFor(...args);
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();

describe("planning canvas source refresh wake database support", () => {
  it("embedded Postgres runs here", () => {
    expect(support.supported, JSON.stringify(support)).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("a source refresh run works for the refresher (PAR-14282 s.1, s.4)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const FETCHER = `fetcher-${randomUUID()}`;
  const REFRESHER = `refresher-${randomUUID()}`;
  const DEFAULT = `default-${randomUUID()}`;
  let companyId = "";
  let agentId = "";

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "planning-canvas-source-refresh-wakes");
    vi.stubEnv(PLANNING_CANVAS_CHAT_ENV, "on");
    seen.runs.clear();
    mockAdapterExecute.mockClear();
    honestRead.fails = false;
  });

  const setMode = (mode: "off" | "report" | "enforce") =>
    db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, companyId));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-planning-canvas-source-refresh-");
    db = createDb(tempDb.connectionString);
    seen.db = db;
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
    api.use(memberRestrictionRouteGuard(db));
    api.get("/probe", (req, res) => {
      res.json({ onBehalfOfUserId: req.actor.type === "agent" ? req.actor.onBehalfOfUserId ?? null : null });
    });
    api.use(planningCanvasRoutes(db));
    api.use(planningCanvasSourceRoutes(db, { heartbeat }));
    api.use(issueRoutes(db, {} as never));
    app.use("/api", api);
    app.use(errorHandler);
    seen.app = app;

    companyId = randomUUID();
    // The company default person is someone else, so a fallback would fail the test.
    await db.insert(companies).values({ id: companyId, name: "Source refresh",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, defaultResponsibleUserId: DEFAULT });
    const now = new Date();
    const people = [FETCHER, REFRESHER, DEFAULT];
    await db.insert(authUsers).values(people.map((id) => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values(people.map((principalId) => ({
      companyId, principalType: "user" as const, principalId, status: "active", membershipRole: principalId === DEFAULT ? "owner" : "operator" })));
    await db.insert(principalPermissionGrants).values([FETCHER, REFRESHER].map((principalId) => ({
      companyId, principalType: "user" as const, principalId, permissionKey: "tasks:assign" })));
    const [agent] = await db.insert(agents).values({ companyId, name: "Fetcher agent", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} }).returning();
    agentId = agent!.id;

    // A read action on a connection where every person has a personal grant (and there is no shared one).
    const [application] = await db.insert(toolApplications).values({ companyId, applicationKey: "sheets", name: "Sheets", type: "mcp_http", status: "active" }).returning();
    const [conn] = await db.insert(toolConnections).values({ companyId, applicationId: application!.id, name: "Sheets", uid: `test/${randomUUID()}`,
      transport: "mcp_remote", status: "active", enabled: true, healthStatus: "ok", credentialPolicy: "per_user", config: { url: "https://8.8.8.8/mcp" } }).returning();
    await db.insert(connectionGrants).values([FETCHER, REFRESHER, DEFAULT].map((subjectUserId) => ({
      companyId, connectionId: conn!.id, kind: "user" as const, subjectUserId, credentialSecretRefs: [], status: "active" as const })));
    await db.insert(toolCatalogEntries).values({ companyId, applicationId: application!.id, connectionId: conn!.id, entryKind: "tool", name: "read_values",
      toolName: "read_values", title: "Read values", riskLevel: "read", isReadOnly: true, status: "active", versionHash: randomUUID(), schemaHash: randomUUID() });
    await db.insert(toolPolicies).values({ companyId, name: "Allow reads", policyType: "allow", selectors: { riskLevel: "read" } });
    const [listed] = await createToolGatewayService(db).listCanvasReadActionsForAgent({ companyId, agentId });
    seen.personalTool = listed!.tool;
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    runningProcesses.clear();
    if (heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  }, 60_000);

  /** A board with a table whose source FETCHER's chat run stored. */
  async function boardWithSource(scope: "company" | "project") {
    const projectId = scope === "project"
      ? (await db.insert(projects).values({ companyId, name: `Client ${randomUUID().slice(0, 6)}` }).returning())[0]!.id
      : null;
    const [board] = await db.insert(planningCanvases).values({ companyId, userId: FETCHER, title: `Board ${scope}`, scope, projectId, memberAccess: "edit" }).returning();
    const [thread] = await db.insert(issues).values({ companyId, title: "Earlier chat", status: "done", assigneeAgentId: agentId,
      originKind: "planning_canvas", originId: `${board!.id}:chat`, createdByUserId: FETCHER }).returning();
    await planningCanvasOpsService(db).applyOps({ companyId, boardId: board!.id, actor: { type: "agent", id: agentId },
      sourceWriter: { personId: FETCHER, agentId, issueId: thread!.id },
      batch: { ops: [{ op: "add", item: { itemType: "node", key: "t1", kind: "table", x: 0, y: 0, width: 300, height: 200, zIndex: 1, color: "slate",
        title: "Rows", content: "", data: { columns: [], rows: [], source: { tool: seen.personalTool, params: {} } } } }] } });
    // Each case gets its own thread.
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, thread!.id));
    return board!;
  }

  async function refreshRuns(boardId: string, as: string) {
    const started = new Date();
    const res = await request(seen.app!).post(`/api/companies/${companyId}/planning-canvases/${boardId}/items/t1/refresh`)
      .set({ "x-test-session": as, origin: "http://localhost" }).send({ clientRequestId: randomUUID() });
    expect(res.status, res.text).toBe(201);
    seen.boardOf.set(res.body.threadIssueId, boardId);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
      .filter((run) => run.createdAt >= started && (run.contextSnapshot as { wakeCommentId?: string } | null)?.wakeCommentId === res.body.commentId);
    return { res, runs };
  }

  async function fetchedSource(boardId: string, runId: string) {
    const [row] = await db.select().from(planningCanvasItems)
      .where(and(eq(planningCanvasItems.boardId, boardId), eq(planningCanvasItems.itemKey, `fetched-${runId}`)));
    return (row?.data as { data?: { source?: Record<string, unknown> } } | undefined)?.data?.source;
  }

  // s.1: the refresh wake call site, under rule H `off`, `report` and `enforce`. The three people
  // are distinct, so a run acting for the first fetcher or the company default fails the equality.
  describe.each(["off", "report", "enforce"] as const)("rule H %s", (mode) => {
    it.each(["company", "project"] as const)(
      "%s board: one run, for the refresher; the personal credential is refused again; the written source carries the refresher",
      async (scope) => {
        await setMode(mode);
        const board = await boardWithSource(scope);
        const { res, runs } = await refreshRuns(board.id, REFRESHER);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.contextSnapshot).toMatchObject({ source: PLANNING_CANVAS_SOURCE_REFRESH_CONTEXT, issueId: res.body.threadIssueId });
        expect(seen.runs.get(runs[0]!.id)).toEqual({ person: REFRESHER, personalCall: "canvas_personal_source_refused", write: "applied" });
        expect(await fetchedSource(board.id, runs[0]!.id)).toMatchObject({ fetchedBy: REFRESHER, agentId, issueId: res.body.threadIssueId });
      },
    );
  });

  it("control: the probe follows the refresher, so the assertion above is not a constant (the first fetcher refreshing gets a run for the fetcher)", async () => {
    expect(new Set([FETCHER, REFRESHER, DEFAULT]).size).toBe(3);
    await setMode("enforce");
    const board = await boardWithSource("company");
    const { runs } = await refreshRuns(board.id, FETCHER);
    expect(runs).toHaveLength(1);
    expect(seen.runs.get(runs[0]!.id)).toMatchObject({ person: FETCHER, write: "applied" });
    expect(await fetchedSource(board.id, runs[0]!.id)).toMatchObject({ fetchedBy: FETCHER });
  });

  it("rule H read throwing: the refresh fails closed (non-2xx), no comment, no thread, no run", async () => {
    await setMode("enforce");
    const board = await boardWithSource("company");
    const started = new Date();
    honestRead.fails = true;
    const res = await request(seen.app!).post(`/api/companies/${companyId}/planning-canvases/${board.id}/items/t1/refresh`)
      .set({ "x-test-session": REFRESHER, origin: "http://localhost" }).send({ clientRequestId: randomUUID() });
    expect(res.status).toBeGreaterThanOrEqual(400);
    honestRead.fails = false;
    const threads = await db.select().from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originId, `${board.id}:chat`), eq(issues.createdByUserId, REFRESHER)));
    expect(threads).toEqual([]);
    const comments = await db.select().from(issueComments)
      .where(and(eq(issueComments.companyId, companyId), eq(issueComments.authorUserId, REFRESHER)));
    expect(comments.filter((c) => c.createdAt >= started)).toEqual([]);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs.filter((run) => run.createdAt >= started)).toEqual([]);
  });
});
