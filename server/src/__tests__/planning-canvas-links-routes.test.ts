import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  goals,
  issues,
  planningCanvasAgentGrants,
  planningCanvases,
  planningCanvasItems,
  principalPermissionGrants,
  projectAccessMembers,
  projects,
} from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { planningCanvasLinkRoutes } from "../routes/planning-canvas-links.js";
import { planningCanvasRoutes } from "../routes/planning-canvases.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { PLANNING_CANVAS_AGENT_GRANTS_ENV } from "../services/planning-canvas-access.js";
import { PLANNING_CANVAS_SINGLE_BUCKET_PER_HOUR } from "../services/planning-canvas-comments.js";
import { PLANNING_CANVAS_BATCH_BUCKET_PER_HOUR, PLANNING_CANVAS_HANDOFF_ORIGIN_KIND } from "../services/planning-canvas-links.js";
import { planningCanvasOpsService } from "../services/planning-canvas-ops.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13937 (Planning Canvas C8): refs hydration, handoff and issue query on
 * the real routes through the real `actorMiddleware`, on embedded Postgres.
 * Refs hide unreadable ids (private issue, private project) and cap at 500;
 * handoff `single` and `one_per_node` with Q11 guards, idempotent replay,
 * both J.4 buckets (an over-limit call creates nothing), grant rows and node
 * links; query through `issueReadSqlCondition`, cap 200. The woken run's
 * person is proven in planning-canvas-links-wakes.test.ts.
 */

const guardRefuses = vi.hoisted(() => ({ on: false }));
vi.mock("../services/member-restriction/body-allowlist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/body-allowlist.js")>();
  return {
    ...actual,
    restrictedTaskBody: async (...args: Parameters<typeof actual.restrictedTaskBody>) => {
      if (guardRefuses.on && args[3] === "createIssue") throw forbidden("Not available for your access level: fixture", { code: "MEMBER_RESTRICTED" });
      return actual.restrictedTaskBody(...args);
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();

afterEach(() => {
  vi.unstubAllEnvs();
  guardRefuses.on = false;
});

describe("planning canvas links database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("planning canvas refs, handoff and query (plan PAR-13925 C8)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  const wakes: Array<{ agentId: string; reason: string | null | undefined; payload: Record<string, unknown> | null | undefined; requestedByActorId: string | null | undefined }> = [];

  const OWNER = `owner-${randomUUID()}`;
  const MEMBER = `member-${randomUUID()}`;
  const VIEWER = `viewer-${randomUUID()}`;
  let Y = "";
  let projectP = "";
  let projectQ = "";
  let goalG = "";
  let agentA = "";
  let agentB = "";

  const session = (userId: string) => ({ "x-test-session": userId, origin: "http://localhost" });
  const node = (key: string, extra: Record<string, unknown> = {}) => ({
    itemType: "node", key, kind: "sticky", x: 0, y: 0, width: 100, height: 80, zIndex: 1, color: "yellow", title: `Title ${key}`, content: `Content ${key}`, ...extra,
  });

  async function makeBoard(values: Partial<typeof planningCanvases.$inferInsert> = {}, items = ["n1", "n2", "n3"].map((key) => node(key))) {
    const [row] = await db.insert(planningCanvases).values({ companyId: Y, userId: OWNER, title: `Board ${randomUUID().slice(0, 6)}`, ...values }).returning();
    await planningCanvasOpsService(db).applyOps({ companyId: Y, boardId: row!.id, actor: { type: "user", id: OWNER }, batch: { ops: items.map((item) => ({ op: "add", item })) } });
    return row!;
  }

  const url = (boardId: string, rest: string) => `/api/companies/${Y}/planning-canvases/${boardId}/${rest}`;
  const handoff = (headers: Record<string, string>, boardId: string, body: Record<string, unknown>) =>
    request(app).post(url(boardId, "handoff")).set(headers).send(body);

  async function boardIssues(boardId: string) {
    return db.select().from(issues).where(and(eq(issues.companyId, Y), like(issues.originId, `${boardId}%`)));
  }
  async function links(boardId: string, key: string) {
    const [row] = await db.select().from(planningCanvasItems).where(and(eq(planningCanvasItems.boardId, boardId), eq(planningCanvasItems.itemKey, key)));
    return ((row!.data as { links?: Array<{ issueId: string }> }).links ?? []).map((link) => link.issueId);
  }
  async function grants(boardId: string) {
    return db.select().from(planningCanvasAgentGrants).where(eq(planningCanvasAgentGrants.boardId, boardId));
  }

  beforeEach(() => {
    wakes.length = 0;
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-planning-canvas-links-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
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
    api.use(planningCanvasRoutes(db));
    api.use(planningCanvasLinkRoutes(db, {
      heartbeat: {
        wakeup: async (agentId, opts) => {
          wakes.push({ agentId, reason: opts.reason, payload: opts.payload, requestedByActorId: opts.requestedByActorId });
          return null;
        },
      },
    }));
    app.use("/api", api);
    app.use(errorHandler);

    const [y] = await db.insert(companies).values({ name: "Y", issuePrefix: `L${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" }).returning();
    Y = y!.id;
    const now = new Date();
    await db.insert(authUsers).values([OWNER, MEMBER, VIEWER].map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: OWNER, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: MEMBER, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: VIEWER, status: "active", membershipRole: "viewer" },
    ]);
    await db.insert(principalPermissionGrants).values([OWNER, MEMBER].map((principalId) => ({ companyId: Y, principalType: "user" as const, principalId, permissionKey: "tasks:assign" })));
    const rows = await db.insert(agents).values([
      { companyId: Y, name: "Agent A", role: "engineer", adapterType: "process", status: "idle" },
      { companyId: Y, name: "Agent B", role: "engineer", adapterType: "process", status: "idle" },
    ]).returning();
    agentA = rows[0]!.id;
    agentB = rows[1]!.id;
    const [p, q] = await db.insert(projects).values([
      { companyId: Y, name: "Open project", privacyOwnerUserId: OWNER },
      { companyId: Y, name: "Private project", privacyOwnerUserId: OWNER, visibility: "private" },
    ]).returning();
    projectP = p!.id;
    projectQ = q!.id;
    await db.insert(projectAccessMembers).values({ companyId: Y, projectId: projectQ, subjectType: "user", subjectId: OWNER });
    const [g] = await db.insert(goals).values({ companyId: Y, title: "Grow" }).returning();
    goalG = g!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe("refs (Q17)", () => {
    it("hydrates issue, agent, project and goal ids per reader; private issue and private project are hidden", async () => {
      const [open, secret] = await db.insert(issues).values([
        { companyId: Y, title: "Open issue", status: "todo", projectId: projectP, createdByUserId: OWNER },
        { companyId: Y, title: "Secret issue", status: "todo", projectId: projectQ, createdByUserId: OWNER },
      ]).returning();
      const unknown = randomUUID();
      const board = await makeBoard({ scope: "company", memberAccess: "view" }, [
        node("i1", { kind: "issue", ref: { id: open!.id } }),
        node("i2", { kind: "issue", ref: { id: secret!.id } }),
        node("a1", { kind: "agent", ref: { id: agentA } }),
        node("p1", { kind: "project", ref: { id: projectP } }),
        node("p2", { kind: "project", ref: { id: projectQ } }),
        node("g1", { kind: "goal", ref: { id: goalG } }),
        node("s1", { links: [{ type: "issue", issueId: open!.id }, { type: "issue", issueId: unknown }] }),
      ]);

      const member = await request(app).get(url(board.id, "refs")).set(session(VIEWER));
      expect(member.status, member.text).toBe(200);
      expect(member.body.truncated).toBe(false);
      expect(member.body.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: open!.id, title: "Open issue", identifier: open!.identifier, status: "todo" }),
        { id: secret!.id, hidden: true },
        { id: unknown, hidden: true },
      ]));
      expect(member.body.issues).toHaveLength(3);
      expect(member.body.agents).toEqual([expect.objectContaining({ id: agentA, name: "Agent A", status: "idle" })]);
      expect(member.body.projects).toEqual([expect.objectContaining({ id: projectP, name: "Open project" }), { id: projectQ, hidden: true }]);
      expect(member.body.goals).toEqual([expect.objectContaining({ id: goalG, title: "Grow" })]);
      expect(JSON.stringify(member.body)).not.toContain("Secret issue");
      expect(JSON.stringify(member.body)).not.toContain("Private project");

      const owner = await request(app).get(url(board.id, "refs")).set(session(OWNER));
      expect(owner.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ id: secret!.id, title: "Secret issue" })]));
      expect(owner.body.projects).toEqual(expect.arrayContaining([expect.objectContaining({ id: projectQ, name: "Private project" })]));

      const some = await request(app).get(url(board.id, "refs")).query({ keys: "a1,g1" }).set(session(OWNER));
      expect(some.body).toMatchObject({ issues: [], projects: [], agents: [{ id: agentA }], goals: [{ id: goalG }] });
    });

    it("caps at 500 distinct ids and says so", async () => {
      const items = Array.from({ length: 11 }, (_, i) => node(`m${i}`, { links: Array.from({ length: 50 }, () => ({ type: "issue", issueId: randomUUID() })) }));
      const board = await makeBoard({}, items);
      const res = await request(app).get(url(board.id, "refs")).set(session(OWNER));
      expect(res.status, res.text).toBe(200);
      expect(res.body.truncated).toBe(true);
      expect(res.body.issues).toHaveLength(500);
    });
  });

  describe("query", () => {
    it("answers only issues the reader may read, with filters, capped at 200", async () => {
      await db.insert(issues).values([
        { companyId: Y, title: "Q open todo", status: "todo", projectId: projectP, assigneeAgentId: agentB, createdByUserId: OWNER },
        { companyId: Y, title: "Q open done", status: "done", projectId: projectP, assigneeAgentId: agentB, createdByUserId: OWNER },
        { companyId: Y, title: "Q private", status: "todo", projectId: projectQ, assigneeAgentId: agentB, createdByUserId: OWNER },
      ]);
      const board = await makeBoard({ scope: "company", memberAccess: "view" });
      const query = (userId: string, filter: Record<string, unknown>, limit = 50) =>
        request(app).post(url(board.id, "query")).set(session(userId)).send({ kind: "issues", filter, limit });

      const viewer = await query(VIEWER, { assigneeAgentId: agentB });
      expect(viewer.status, viewer.text).toBe(200);
      expect(viewer.body.issues.map((issue: { title: string }) => issue.title).sort()).toEqual(["Q open done", "Q open todo"]);
      const owner = await query(OWNER, { assigneeAgentId: agentB, status: ["todo"] });
      expect(owner.body.issues.map((issue: { title: string }) => issue.title).sort()).toEqual(["Q open todo", "Q private"]);
      expect((await query(OWNER, { projectId: projectP, assigneeAgentId: agentB }, 1)).body.issues).toHaveLength(1);
      expect((await query(OWNER, {}, 201)).status).toBe(400);
    });
  });

  describe("handoff", () => {
    it("one_per_node: one issue per node, assigned and woken, linked on its node; a replay returns the same issues and writes nothing", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit", projectId: null });
      const body = { keys: ["n1", "n2"], mode: "one_per_node", idempotencyKey: "k-one", assigneeAgentId: agentA };
      const res = await handoff(session(MEMBER), board.id, body);
      expect(res.status, res.text).toBe(201);
      expect(res.body).toMatchObject({ mode: "one_per_node", replayed: false });
      expect(res.body.issues.map((issue: { itemKeys: string[] }) => issue.itemKeys)).toEqual([["n1"], ["n2"]]);
      const created = await boardIssues(board.id);
      expect(created).toHaveLength(2);
      for (const issue of created) {
        expect(issue).toMatchObject({ originKind: PLANNING_CANVAS_HANDOFF_ORIGIN_KIND, assigneeAgentId: agentA, createdByUserId: MEMBER });
      }
      const byKey = Object.fromEntries(res.body.issues.map((issue: { id: string; itemKeys: string[] }) => [issue.itemKeys[0], issue.id]));
      expect(created.find((issue) => issue.id === byKey.n1)!.description).toContain("Content n1");
      expect(await links(board.id, "n1")).toEqual([byKey.n1]);
      expect(await links(board.id, "n2")).toEqual([byKey.n2]);
      expect(await links(board.id, "n3")).toEqual([]);
      expect(wakes.map((wake) => [wake.agentId, wake.reason, wake.requestedByActorId])).toEqual([[agentA, "issue_assigned", MEMBER], [agentA, "issue_assigned", MEMBER]]);

      wakes.length = 0;
      const replay = await handoff(session(MEMBER), board.id, body);
      expect(replay.status, replay.text).toBe(200);
      expect(replay.body.replayed).toBe(true);
      expect(replay.body.issues.map((issue: { id: string }) => issue.id)).toEqual(res.body.issues.map((issue: { id: string }) => issue.id));
      expect(await boardIssues(board.id)).toHaveLength(2);
      expect(wakes).toEqual([]);
      // Another caller with the same key is another call.
      const other = await handoff(session(OWNER), board.id, { ...body, keys: ["n3"] });
      expect(other.status).toBe(201);
      expect(await boardIssues(board.id)).toHaveLength(3);
    });

    it("single: one issue for all nodes, linked on each; two simultaneous identical calls make one", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      const body = { keys: ["n1", "n2", "n3"], mode: "single", idempotencyKey: "k-single", assigneeAgentId: agentB };
      const [first, second] = await Promise.all([handoff(session(MEMBER), board.id, body), handoff(session(MEMBER), board.id, body)]);
      expect([first.status, second.status].sort()).toEqual([200, 201]);
      const created = await boardIssues(board.id);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ originKind: "planning_canvas", assigneeAgentId: agentB });
      for (const text of ["Content n1", "Content n2", "Content n3"]) expect(created[0]!.description).toContain(text);
      expect(first.body.issues[0].id).toBe(created[0]!.id);
      expect(second.body.issues[0].id).toBe(created[0]!.id);
      for (const key of ["n1", "n2", "n3"]) expect(await links(board.id, key)).toEqual([created[0]!.id]);
      expect(wakes).toHaveLength(1);
    });

    it("single bucket: over 20 per board per hour answers 409 canvas_issue_rate_limited and creates nothing", async () => {
      vi.stubEnv(PLANNING_CANVAS_AGENT_GRANTS_ENV, "on");
      const board = await makeBoard();
      await db.insert(issues).values(Array.from({ length: PLANNING_CANVAS_SINGLE_BUCKET_PER_HOUR }, (_, i) => ({
        companyId: Y, title: `Mention ${i}`, status: "todo", originKind: "planning_canvas", originId: `${board.id}:n1`, createdByUserId: OWNER,
      })));
      const res = await handoff(session(OWNER), board.id, { keys: ["n2"], mode: "single", idempotencyKey: "k-limit", assigneeAgentId: agentA });
      expect(res.status, res.text).toBe(409);
      expect(res.body.details).toMatchObject({ code: "canvas_issue_rate_limited", bucket: "single", limit: PLANNING_CANVAS_SINGLE_BUCKET_PER_HOUR });
      expect(await boardIssues(board.id)).toHaveLength(PLANNING_CANVAS_SINGLE_BUCKET_PER_HOUR);
      expect(await links(board.id, "n2")).toEqual([]);
      expect(await grants(board.id)).toEqual([]);
      expect(wakes).toEqual([]);
      // The batch bucket is counted separately.
      expect((await handoff(session(OWNER), board.id, { keys: ["n2"], mode: "one_per_node", idempotencyKey: "k-batch" })).status).toBe(201);
    });

    it("batch bucket: 100 per board per hour, 50 per call; over it answers 409 and creates nothing", async () => {
      const board = await makeBoard();
      await db.insert(issues).values(Array.from({ length: PLANNING_CANVAS_BATCH_BUCKET_PER_HOUR - 2 }, (_, i) => ({
        companyId: Y, title: `Handoff ${i}`, status: "todo", originKind: PLANNING_CANVAS_HANDOFF_ORIGIN_KIND, originId: `${board.id}:seed:${i}`, createdByUserId: OWNER,
      })));
      const over = await handoff(session(OWNER), board.id, { keys: ["n1", "n2", "n3"], mode: "one_per_node", idempotencyKey: "k-over", assigneeAgentId: agentA });
      expect(over.status, over.text).toBe(409);
      expect(over.body.details).toMatchObject({ code: "canvas_issue_rate_limited", bucket: "batch", used: 98, requested: 3 });
      expect(await boardIssues(board.id)).toHaveLength(PLANNING_CANVAS_BATCH_BUCKET_PER_HOUR - 2);
      for (const key of ["n1", "n2", "n3"]) expect(await links(board.id, key)).toEqual([]);
      expect(wakes).toEqual([]);
      expect((await handoff(session(OWNER), board.id, { keys: ["n1", "n2"], mode: "one_per_node", idempotencyKey: "k-fits" })).status).toBe(201);
      const tooMany = await handoff(session(OWNER), board.id, { keys: Array.from({ length: 51 }, (_, i) => `x${i}`), mode: "one_per_node", idempotencyKey: "k-51" });
      expect(tooMany.status).toBe(400);
    });

    it("needs edit level, the idempotency key, live nodes and a writable board", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "comment" });
      expect((await handoff(session(MEMBER), board.id, { keys: ["n1"], mode: "single", idempotencyKey: "k" })).status).toBe(403);
      expect((await handoff(session(OWNER), board.id, { keys: ["n1"], mode: "single" })).status).toBe(400);
      const missing = await handoff(session(OWNER), board.id, { keys: ["n1", "nope"], mode: "single", idempotencyKey: "k" });
      expect(missing.status).toBe(422);
      await db.update(planningCanvases).set({ archivedAt: new Date() }).where(eq(planningCanvases.id, board.id));
      expect((await handoff(session(OWNER), board.id, { keys: ["n1"], mode: "single", idempotencyKey: "k" })).status).toBe(409);
      expect(await boardIssues(board.id)).toEqual([]);
    });

    it("Q11 guards refuse: 403, nothing created, linked or woken", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      guardRefuses.on = true;
      const res = await handoff(session(MEMBER), board.id, { keys: ["n1", "n2"], mode: "one_per_node", idempotencyKey: "k-guard", assigneeAgentId: agentA });
      expect(res.status, res.text).toBe(403);
      expect(await boardIssues(board.id)).toEqual([]);
      expect(await links(board.id, "n1")).toEqual([]);
      expect(wakes).toEqual([]);
    });
  });

  describe("grant rows (Q6, Q14)", () => {
    it("written only for the board owner's own session on a personal board, with the switch on", async () => {
      vi.stubEnv(PLANNING_CANVAS_AGENT_GRANTS_ENV, "on");
      const personal = await makeBoard();
      const res = await handoff(session(OWNER), personal.id, { keys: ["n1"], mode: "single", idempotencyKey: "k-grant", assigneeAgentId: agentA });
      expect(res.status, res.text).toBe(201);
      expect(await grants(personal.id)).toEqual([expect.objectContaining({ agentId: agentA, issueId: res.body.issues[0].id, grantedByUserId: OWNER, source: "handoff" })]);

      const company = await makeBoard({ scope: "company", memberAccess: "edit" });
      await handoff(session(MEMBER), company.id, { keys: ["n1"], mode: "single", idempotencyKey: "k-grant", assigneeAgentId: agentA });
      await handoff(session(OWNER), company.id, { keys: ["n2"], mode: "single", idempotencyKey: "k-grant", assigneeAgentId: agentA });
      expect(await boardIssues(company.id)).toHaveLength(2);
      expect(await grants(company.id)).toEqual([]);
    });

    it("reading the switch throws: no grant is written, the issues are still created", async () => {
      const personal = await makeBoard();
      const original = process.env;
      process.env = new Proxy({ ...original, [PLANNING_CANVAS_AGENT_GRANTS_ENV]: "on" }, {
        get(target, prop) {
          if (prop === PLANNING_CANVAS_AGENT_GRANTS_ENV) throw new Error("fixture: env unreadable");
          return Reflect.get(target, prop);
        },
      });
      let res;
      try {
        res = await handoff(session(OWNER), personal.id, { keys: ["n1", "n2"], mode: "one_per_node", idempotencyKey: "k-throw", assigneeAgentId: agentA });
      } finally {
        process.env = original;
      }
      expect(res.status, res.text).toBe(201);
      expect(await boardIssues(personal.id)).toHaveLength(2);
      expect(await grants(personal.id)).toEqual([]);
    });
  });
});
