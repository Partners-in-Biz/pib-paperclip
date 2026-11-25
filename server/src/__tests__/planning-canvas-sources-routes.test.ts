import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentWakeupRequests,
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
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolPolicies,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { planningCanvasSourceRoutes } from "../routes/planning-canvas-sources.js";
import { planningCanvasRoutes } from "../routes/planning-canvases.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { planningCanvasOpsService } from "../services/planning-canvas-ops.js";
import { PLANNING_CANVAS_SOURCE_REFRESH_CONTEXT } from "../services/planning-canvas-sources.js";
import { PLANNING_CANVAS_CHAT_ENV } from "../services/planning-canvas-switches.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-14282 (plan PAR-14257 D 4a, E "4a"; acceptance `acceptance-par-14282`
 * s.3, s.4): the read-action list, the refresh route and the ops rule for a
 * table `source`, through the real router and `actorMiddleware` on embedded
 * Postgres. The refresh run's person is proven in
 * planning-canvas-source-refresh-wakes.test.ts; the gateway rule in
 * planning-canvas-source-rule.test.ts.
 */

const switchRead = vi.hoisted(() => ({ throws: false }));
vi.mock("../services/planning-canvas-switches.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/planning-canvas-switches.js")>();
  return {
    ...actual,
    planningCanvasChatOn: () => {
      if (switchRead.throws) throw new Error("fixture: switch read failed");
      return actual.planningCanvasChatOn();
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();
const JWT_SECRET = "planning-canvas-sources-routes";

describe("planning canvas sources database support", () => {
  it("embedded Postgres runs here", () => {
    expect(support.supported, JSON.stringify(support)).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("planning canvas connector sources (PAR-14282)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  const wakes: Array<{ agentId: string; opts: Record<string, unknown> }> = [];
  const OWNER = `owner-${randomUUID()}`;
  const EDITOR = `editor-${randomUUID()}`;
  const VIEWER = `viewer-${randomUUID()}`;
  const OTHERCO = `otherco-${randomUUID()}`;
  let Y = "", X = "", agentA = "", agentPaused = "";
  const tool = { read: "", write: "", blocked: "", unflagged: "" };

  const session = (userId: string) => ({ "x-test-session": userId, origin: "http://localhost" });
  const jwt = (runId: string, person: string | null, agentId = agentA) => ({
    authorization: `Bearer ${createLocalAgentJwt(agentId, Y, "process", runId, person)}`,
  });

  async function board(values: Partial<typeof planningCanvases.$inferInsert> = {}) {
    const [row] = await db.insert(planningCanvases)
      .values({ companyId: Y, userId: OWNER, title: "Board", scope: "company", memberAccess: "edit", ...values }).returning();
    return row!;
  }
  async function issue(values: Partial<typeof issues.$inferInsert>) {
    const [row] = await db.insert(issues).values({ companyId: Y, title: "Work", status: "in_progress", assigneeAgentId: agentA, ...values }).returning();
    return row!;
  }
  const chatThread = (boardId: string) => issue({ originKind: "planning_canvas", originId: `${boardId}:chat`, createdByUserId: OWNER });
  async function run(issueId: string | null, person: string | null, agentId = agentA) {
    const [row] = await db.insert(heartbeatRuns).values({
      companyId: Y, agentId, status: "running", invocationSource: "assignment", responsibleUserId: person,
      contextSnapshot: issueId ? { issueId } : {},
    }).returning();
    return row!;
  }
  const ops = (headers: Record<string, string>, boardId: string, opsList: unknown[]) =>
    request(app).post(`/api/companies/${Y}/planning-canvases/${boardId}/ops`).set(headers).send({ ops: opsList });
  const table = (key: string, source?: Record<string, unknown>) => ({
    op: "add",
    item: {
      itemType: "node", key, kind: "table", x: 0, y: 0, width: 400, height: 200, zIndex: 1, color: "slate", title: "Rows", content: "",
      data: { columns: [{ id: "c1", name: "Name", type: "text" }], rows: [{ id: "r1", cells: { c1: "SECRET-CELL" } }], ...(source ? { source } : {}) },
    },
  });
  async function item(boardId: string, key: string) {
    const [row] = await db.select().from(planningCanvasItems).where(and(eq(planningCanvasItems.boardId, boardId), eq(planningCanvasItems.itemKey, key)));
    return row;
  }
  const sourceOf = async (boardId: string, key: string) =>
    ((await item(boardId, key))?.data as { data?: { source?: Record<string, unknown> } } | undefined)?.data?.source;

  /** A table node with a stored source, written as a board chat run of `boardId` would. */
  async function seedSource(boardId: string, key: string, toolName: string, agentId = agentA) {
    const thread = await chatThread(boardId);
    await planningCanvasOpsService(db).applyOps({
      companyId: Y, boardId, actor: { type: "agent", id: agentId },
      sourceWriter: { personId: OWNER, agentId, issueId: thread.id },
      batch: { ops: [table(key, { tool: toolName, params: { range: "SECRET-RANGE" } })] },
    });
  }
  const refresh = (headers: Record<string, string>, boardId: string, key: string, body: Record<string, unknown> = { clientRequestId: randomUUID() }, companyId = Y) =>
    request(app).post(`/api/companies/${companyId}/planning-canvases/${boardId}/items/${key}/refresh`).set(headers).send(body);
  const commentsOnBoard = async (boardId: string) =>
    db.select({ id: issueComments.id, body: issueComments.body, author: issueComments.authorUserId })
      .from(issueComments).innerJoin(issues, eq(issues.id, issueComments.issueId))
      .where(and(eq(issues.originId, `${boardId}:chat`)));

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", JWT_SECRET);
    vi.stubEnv(PLANNING_CANVAS_CHAT_ENV, "on");
    switchRead.throws = false;
    wakes.length = 0;
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-planning-canvas-sources-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async (req) => {
        const userId = req.header("x-test-session");
        return userId ? ({ session: { id: `session-${userId}`, userId }, user: { id: userId, name: userId, email: null } } as never) : null;
      },
    }));
    const api = express.Router();
    api.use(memberRestrictionRouteGuard(db));
    const heartbeat = {
      wakeup: async (agentId: string, opts: Record<string, unknown>) => {
        wakes.push({ agentId, opts });
        await db.insert(agentWakeupRequests).values({ companyId: Y, agentId, source: "assignment", reason: (opts.reason as string) ?? null, payload: (opts.payload as Record<string, unknown>) ?? null });
        return null;
      },
    };
    api.use(planningCanvasRoutes(db));
    api.use(planningCanvasSourceRoutes(db, { heartbeat: heartbeat as never }));
    app.use("/api", api);
    app.use(errorHandler);

    Y = randomUUID();
    X = randomUUID();
    await db.insert(companies).values([
      { id: Y, name: "Sources Y", issuePrefix: `Y${Y.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
      { id: X, name: "Sources X", issuePrefix: `X${X.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
    ]);
    const now = new Date();
    await db.insert(authUsers).values([OWNER, EDITOR, VIEWER, OTHERCO].map((id) => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: OWNER, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: EDITOR, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: VIEWER, status: "active", membershipRole: "viewer" },
      { companyId: X, principalType: "user", principalId: OTHERCO, status: "active", membershipRole: "owner" },
    ]);
    await db.insert(principalPermissionGrants).values([OWNER, EDITOR].map((principalId) => ({
      companyId: Y, principalType: "user" as const, principalId, permissionKey: "tasks:assign" })));
    const [a, p] = await db.insert(agents).values([
      { companyId: Y, name: "Fetcher", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { companyId: Y, name: "Paused", role: "engineer", status: "paused", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]).returning();
    agentA = a!.id;
    agentPaused = p!.id;

    const [application] = await db.insert(toolApplications).values({ companyId: Y, applicationKey: "sheets", name: "Sheets", type: "mcp_http", status: "active" }).returning();
    const [conn] = await db.insert(toolConnections).values({
      companyId: Y, applicationId: application!.id, name: "Sheets", uid: `test/${randomUUID()}`, transport: "mcp_remote", status: "active",
      enabled: true, healthStatus: "ok", credentialPolicy: "shared", config: { url: "https://8.8.8.8/mcp" },
    }).returning();
    await db.insert(connectionGrants).values({ companyId: Y, connectionId: conn!.id, kind: "organization", credentialSecretRefs: [], status: "active", isDefault: true });
    const entry = (toolName: string, extra: Partial<typeof toolCatalogEntries.$inferInsert>) => ({
      companyId: Y, applicationId: application!.id, connectionId: conn!.id, entryKind: "tool" as const, name: toolName, toolName,
      title: `Title ${toolName}`, description: `Description ${toolName}`, status: "active" as const, versionHash: randomUUID(), schemaHash: randomUUID(), ...extra,
    });
    const entries = await db.insert(toolCatalogEntries).values([
      entry("read_values", { riskLevel: "read", isReadOnly: true }),
      entry("update_values", { riskLevel: "write", isWrite: true }),
      entry("read_blocked", { riskLevel: "read", isReadOnly: true }),
      entry("read_unflagged", { riskLevel: "read", isReadOnly: false }),
    ]).returning();
    await db.insert(toolPolicies).values([
      { companyId: Y, name: "Allow all", policyType: "allow", priority: 100, selectors: {} },
      { companyId: Y, name: "Block one read", policyType: "block", priority: 1, selectors: { catalogEntryId: entries[2]!.id } },
    ]);
    // Gateway names of the entries, from the gateway itself.
    const { createToolGatewayService } = await import("../services/tool-gateway.js");
    const gw = createToolGatewayService(db);
    const [r] = await db.insert(heartbeatRuns).values({ companyId: Y, agentId: agentA, status: "running", invocationSource: "assignment" }).returning();
    const sessionToken = (await gw.createSession({ companyId: Y, agentId: agentA, runId: r!.id })).token;
    const listed = await gw.listToolsForSession(sessionToken);
    const byUpstream = (upstream: string) => listed.find((t) => t.upstreamToolName === upstream)?.name ?? `missing:${upstream}`;
    tool.read = byUpstream("read_values");
    tool.write = byUpstream("update_values");
    tool.unflagged = byUpstream("read_unflagged");
    // A blocked tool is not listed for the session; its gateway name follows the same pattern.
    tool.blocked = tool.read.replace("read-values", "read-blocked");
    expect(tool.blocked).not.toBe(tool.read);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  describe("GET read-actions", () => {
    const list = (headers: Record<string, string>, boardId: string, agentId = agentA, companyId = Y) =>
      request(app).get(`/api/companies/${companyId}/planning-canvases/${boardId}/agents/${agentId}/read-actions`).set(headers);

    it("an editor gets only read-only actions the agent may use: names and descriptions only", async () => {
      const b = await board();
      const res = await list(session(EDITOR), b.id);
      expect(res.status, res.text).toBe(200);
      expect(res.body.actions.map((a: { tool: string }) => a.tool)).toEqual([tool.read]);
      expect(Object.keys(res.body.actions[0]).sort()).toEqual(["application", "description", "name", "tool"]);
      expect(JSON.stringify(res.body)).not.toMatch(/update_values|read_blocked|read_unflagged|inputSchema|connectionId/);
    });

    it("view access, another company and an inactive agent are refused", async () => {
      const b = await board();
      expect((await list(session(VIEWER), b.id)).status).toBe(403);
      expect((await list(session(OTHERCO), b.id, agentA, X)).status).toBe(404);
      const paused = await list(session(EDITOR), b.id, agentPaused);
      expect(paused.status).toBe(422);
      expect(paused.body.details.code).toBe("canvas_source_unknown_agent");
      expect((await list(session(EDITOR), b.id, randomUUID())).body.details.code).toBe("canvas_source_unknown_agent");
    });
  });

  describe("ops: a table source only from a board chat run of the same board (s.3)", () => {
    it("a chat run's source is stored with fetchedBy, agentId and issueId from the run, never from the op", async () => {
      const b = await board();
      const thread = await chatThread(b.id);
      const r = await run(thread.id, EDITOR);
      const forged = { tool: tool.read, params: { range: "A1:B2" }, fetchedAt: "1999-01-01", fetchedBy: OWNER, agentId: agentPaused, issueId: randomUUID() };
      const res = await ops(jwt(r.id, EDITOR), b.id, [table("t1", forged)]);
      expect(res.status, res.text).toBe(200);
      expect(res.body.results[0].status).toBe("applied");
      const stored = await sourceOf(b.id, "t1");
      expect(stored).toMatchObject({ tool: tool.read, params: { range: "A1:B2" }, fetchedBy: EDITOR, agentId: agentA, issueId: thread.id });
      expect(stored!.fetchedAt).not.toBe("1999-01-01");
    });

    it("a run with no person is refused, never fetchedBy null", async () => {
      const b = await board();
      const r = await run((await chatThread(b.id)).id, null);
      const res = await ops(jwt(r.id, null), b.id, [table("t1", { tool: tool.read, params: {} })]);
      expect(res.body.results?.[0]?.reason ?? res.status, res.text).toBe("source_not_allowed");
      expect(await item(b.id, "t1")).toBeUndefined();
    });

    it("a run on another task or another board's thread: source refused; a plain table is accepted (residual G.2, pinned)", async () => {
      const b = await board();
      const other = await board();
      for (const bound of [await issue({}), await chatThread(other.id)]) {
        const r = await run(bound.id, EDITOR);
        const refused = await ops(jwt(r.id, EDITOR), b.id, [table(`s-${bound.id}`, { tool: tool.read, params: {} })]);
        expect(refused.body.results[0], refused.text).toMatchObject({ status: "rejected", reason: "source_not_allowed" });
        const plain = await ops(jwt(r.id, EDITOR), b.id, [table(`p-${bound.id}`)]);
        expect(plain.body.results[0].status).toBe("applied");
      }
    });

    it("a person may round-trip or drop the stored source and edit cells, never add or change one", async () => {
      const b = await board();
      expect((await ops(session(EDITOR), b.id, [table("t0", { tool: tool.read, params: {} })])).body.results[0].reason).toBe("source_not_allowed");
      await seedSource(b.id, "t1", tool.read);
      const stored = (await item(b.id, "t1"))!;
      const node = stored.data as { data: { columns: unknown[]; rows: unknown[]; source: Record<string, unknown> } };
      // Keys in another order, a changed cell: the same source passes.
      const reordered = Object.fromEntries(Object.entries(node.data.source).reverse());
      const roundTrip = await ops(session(EDITOR), b.id, [{ op: "update", key: "t1", baseVersion: stored.version,
        set: { data: { ...node.data, rows: [{ id: "r1", cells: { c1: "edited" } }], source: reordered } } }]);
      expect(roundTrip.body.results[0].status, roundTrip.text).toBe("applied");
      expect(await sourceOf(b.id, "t1")).toEqual(node.data.source);
      const cell = await ops(session(EDITOR), b.id, [{ op: "table.setCell", key: "t1", rowId: "r1", colId: "c1", value: "again" }]);
      expect(cell.body.results[0].status).toBe("applied");
      expect(await sourceOf(b.id, "t1")).toEqual(node.data.source);
      const current = (await item(b.id, "t1"))!;
      const changed = await ops(session(EDITOR), b.id, [{ op: "update", key: "t1", baseVersion: current.version,
        set: { data: { ...node.data, source: { ...node.data.source, tool: tool.write } } } }]);
      expect(changed.body.results[0]).toMatchObject({ status: "rejected", reason: "source_not_allowed" });
      const dropped = await ops(session(EDITOR), b.id, [{ op: "update", key: "t1", baseVersion: current.version,
        set: { data: { columns: node.data.columns, rows: node.data.rows } } }]);
      expect(dropped.body.results[0].status).toBe("applied");
      expect(await sourceOf(b.id, "t1")).toBeUndefined();
    });
  });

  describe("POST refresh (s.4)", () => {
    it("wakes the source's agent with the refresher's own comment, carrying the item key only", async () => {
      const b = await board();
      await seedSource(b.id, "t1", tool.read);
      const clientRequestId = randomUUID();
      const res = await refresh(session(EDITOR), b.id, "t1", { clientRequestId });
      expect(res.status, res.text).toBe(201);
      expect(res.body).toMatchObject({ itemKey: "t1", agentId: agentA, thread: "created", repeat: false });
      const [thread] = await db.select().from(issues).where(eq(issues.id, res.body.threadIssueId));
      expect(thread).toMatchObject({ originKind: "planning_canvas", originId: `${b.id}:chat`, createdByUserId: EDITOR, assigneeAgentId: agentA });
      const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, res.body.commentId));
      expect(comment!.authorUserId).toBe(EDITOR);
      expect(comment!.body).toContain("`t1`");
      expect(comment!.body).not.toMatch(/read_values|SECRET-RANGE|SECRET-CELL|params/);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.agentId).toBe(agentA);
      expect(wakes[0]!.opts).toMatchObject({
        requestedByActorType: "user", requestedByActorId: EDITOR,
        payload: { wakeCommentId: res.body.commentId },
        contextSnapshot: { source: PLANNING_CANVAS_SOURCE_REFRESH_CONTEXT, wakeCommentId: res.body.commentId },
      });
      const again = await refresh(session(EDITOR), b.id, "t1", { clientRequestId });
      expect(again.status).toBe(200);
      expect(again.body.repeat).toBe(true);
    });

    it("a write action set by an editor, a blocked or unflagged tool: refused with its own code, nothing written or woken", async () => {
      const b = await board();
      for (const [key, name] of [["w", tool.write], ["b", tool.blocked], ["u", tool.unflagged]] as const) {
        await seedSource(b.id, key, tool.read);
        // An editor changes the stored tool directly (the ops route would refuse him).
        const row = (await item(b.id, key))!;
        const data = row.data as { data: { source: Record<string, unknown> } };
        data.data.source.tool = name;
        await db.update(planningCanvasItems).set({ data: data as never }).where(eq(planningCanvasItems.id, row.id));
        const res = await refresh(session(EDITOR), b.id, key);
        expect(res.status, `${key}: ${res.text}`).toBe(409);
        expect(res.body.details.code).toBe("canvas_source_tool_not_allowed");
      }
      expect(await commentsOnBoard(b.id)).toEqual([]);
      expect(wakes).toEqual([]);
    });

    it("no source, an inactive source agent, the switch off or unreadable: refused, nothing written", async () => {
      const b = await board();
      await ops(session(EDITOR), b.id, [table("plain")]);
      expect((await refresh(session(EDITOR), b.id, "plain")).body.details.code).toBe("canvas_source_missing");
      expect((await refresh(session(EDITOR), b.id, "nothing")).body.details.code).toBe("canvas_source_missing");
      await seedSource(b.id, "t1", tool.read);
      await seedSource(b.id, "tp", tool.read, agentPaused);
      expect((await refresh(session(EDITOR), b.id, "tp")).body.details.code).toBe("canvas_source_unknown_agent");
      vi.stubEnv(PLANNING_CANVAS_CHAT_ENV, "off");
      const off = await refresh(session(EDITOR), b.id, "t1");
      expect(off.status).toBe(403);
      expect(off.body.details.code).toBe("canvas_source_refresh_disabled");
      vi.stubEnv(PLANNING_CANVAS_CHAT_ENV, "on");
      switchRead.throws = true;
      expect((await refresh(session(EDITOR), b.id, "t1")).status).toBeGreaterThanOrEqual(400);
      expect(await commentsOnBoard(b.id)).toEqual([]);
      expect(wakes).toEqual([]);
    });

    it("callers: view access 403, another company 404, an agent 403", async () => {
      const b = await board();
      await seedSource(b.id, "t1", tool.read);
      expect((await refresh(session(VIEWER), b.id, "t1")).status).toBe(403);
      expect((await refresh(session(OTHERCO), b.id, "t1", undefined, X)).status).toBe(404);
      const r = await run((await chatThread(b.id)).id, EDITOR);
      const agent = await refresh(jwt(r.id, EDITOR), b.id, "t1");
      expect(agent.status).toBe(403);
      expect(agent.body.details.code).toBe("canvas_source_agent_caller");
      expect(wakes).toEqual([]);
    });
  });
});
