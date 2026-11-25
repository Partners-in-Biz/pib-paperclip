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
  issues,
  planningCanvasAgentGrants,
  planningCanvases,
  planningCanvasItems,
  principalPermissionGrants,
} from "@paperclipai/db";
import { planningCanvasBlueprint } from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { forbidden } from "../errors.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { planningCanvasBlueprintRoutes } from "../routes/planning-canvas-blueprints.js";
import { planningCanvasRoutes } from "../routes/planning-canvases.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { PLANNING_CANVAS_AGENT_GRANTS_ENV } from "../services/planning-canvas-access.js";
import {
  PLANNING_CANVAS_BLUEPRINT_ISSUES_PER_HOUR,
  PLANNING_CANVAS_BLUEPRINT_ORIGIN_KIND,
  planningCanvasBlueprintBoardId,
  planningCanvasBlueprintsService,
} from "../services/planning-canvas-blueprints.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13941 (Planning Canvas C14): blueprint apply on the real route through
 * the real `actorMiddleware`, on embedded Postgres. It creates the board, an
 * optional parent issue and one issue per chosen marked node, written as
 * issue cards; replays and simultaneous calls return the same board; the
 * per-caller bucket (50 per call, 100 per hour) refuses with 409 and creates
 * nothing, not even the board; viewers, agents and the Q11 guards are
 * refused. The woken run's person is proven in
 * planning-canvas-blueprints-wakes.test.ts.
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

describe("planning canvas blueprints database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("planning canvas blueprint apply (plan PAR-13925 C14)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  const wakes: Array<{ agentId: string; reason: string | null | undefined; requestedByActorId: string | null | undefined }> = [];
  const heartbeat = {
    wakeup: async (agentId: string, opts: { reason?: string | null; requestedByActorId?: string | null }) => {
      wakes.push({ agentId, reason: opts.reason, requestedByActorId: opts.requestedByActorId });
      return null;
    },
  };

  const OWNER = `owner-${randomUUID()}`;
  const MEMBER = `member-${randomUUID()}`;
  const VIEWER = `viewer-${randomUUID()}`;
  let Y = "";
  let agentA = "";

  const session = (userId: string) => ({ "x-test-session": userId, origin: "http://localhost" });
  const apply = (headers: Record<string, string>, body: Record<string, unknown>) =>
    request(app).post(`/api/companies/${Y}/planning-canvases/from-blueprint`).set(headers).send(body);
  const boardIssues = (boardId: string) =>
    db.select().from(issues).where(and(eq(issues.companyId, Y), like(issues.originId, `${boardId}:%`)));
  const boardOf = async (userId: string, key: string) =>
    (await db.select().from(planningCanvases).where(eq(planningCanvases.id, planningCanvasBlueprintBoardId(Y, userId, key))))[0] ?? null;
  const items = (boardId: string) => db.select().from(planningCanvasItems).where(eq(planningCanvasItems.boardId, boardId));

  beforeEach(() => {
    wakes.length = 0;
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-planning-canvas-blueprints-");
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
    api.use(planningCanvasRoutes(db));
    api.use(planningCanvasBlueprintRoutes(db, { heartbeat }));
    app.use("/api", api);
    app.use(errorHandler);

    const [y] = await db.insert(companies).values({ name: "Y", issuePrefix: `B${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" }).returning();
    Y = y!.id;
    const now = new Date();
    await db.insert(authUsers).values([OWNER, MEMBER, VIEWER].map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: OWNER, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: MEMBER, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: VIEWER, status: "active", membershipRole: "viewer" },
    ]);
    await db.insert(principalPermissionGrants).values([OWNER, MEMBER].map((principalId) => ({ companyId: Y, principalType: "user" as const, principalId, permissionKey: "tasks:assign" })));
    const [a] = await db.insert(agents).values({ companyId: Y, name: "Agent A", role: "engineer", adapterType: "process", status: "idle" }).returning();
    agentA = a!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("creates the board, a parent issue and one issue per chosen node as issue cards; a replay returns the same and writes nothing", async () => {
    vi.stubEnv(PLANNING_CANVAS_AGENT_GRANTS_ENV, "on");
    const blueprint = planningCanvasBlueprint("sprint_plan")!;
    const body = {
      blueprintId: "sprint_plan",
      idempotencyKey: "k-sprint",
      title: "Sprint 12",
      parentIssue: true,
      issues: [{ key: "story-2", assigneeAgentId: agentA }, { key: "story-1" }],
    };
    const res = await apply(session(OWNER), body);
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ replayed: false, blueprintId: "sprint_plan", access: "admin", board: { title: "Sprint 12", scope: "personal" } });
    const boardId = res.body.board.id as string;
    const [board] = await db.select().from(planningCanvases).where(eq(planningCanvases.id, boardId));
    expect(board).toMatchObject({ userId: OWNER, scope: "personal", revision: 1 });
    expect(board!.legacyDataMd5).toBeTruthy();

    const created = await boardIssues(boardId);
    expect(created).toHaveLength(3);
    for (const issue of created) expect(issue).toMatchObject({ originKind: PLANNING_CANVAS_BLUEPRINT_ORIGIN_KIND, createdByUserId: OWNER, companyId: Y });
    const parent = created.find((issue) => issue.originId === `${boardId}:parent`)!;
    expect(parent).toMatchObject({ title: "Sprint 12", parentId: null, assigneeAgentId: null });
    expect(res.body.parentIssue.id).toBe(parent.id);
    expect(res.body.issues.map((issue: { itemKey: string }) => issue.itemKey)).toEqual(["story-2", "story-1"]);
    const byKey = Object.fromEntries(res.body.issues.map((issue: { id: string; itemKey: string }) => [issue.itemKey, issue.id]));
    const story2 = created.find((issue) => issue.id === byKey["story-2"])!;
    expect(story2).toMatchObject({ parentId: parent.id, assigneeAgentId: agentA, title: "Story 2" });
    expect(story2.description).toContain("As a user");

    // Every blueprint item is on the board; the chosen nodes are issue cards, the rest are unchanged.
    const rows = new Map((await items(boardId)).map((row) => [row.itemKey, row]));
    expect(rows.size).toBe(blueprint.items.length);
    expect(rows.get("story-1")).toMatchObject({ kind: "issue", data: { kind: "issue", ref: { id: byKey["story-1"] }, title: "Story 1" } });
    expect(rows.get("story-2")).toMatchObject({ kind: "issue", data: { ref: { id: byKey["story-2"] } } });
    expect(rows.get("story-3")).toMatchObject({ kind: "sticky" });
    expect(rows.get("committed")).toMatchObject({ kind: "frame" });
    expect(wakes).toEqual([{ agentId: agentA, reason: "issue_assigned", requestedByActorId: OWNER }]);
    // The owner's own session on a personal board, switch on: the assignee gets a grant row.
    expect(await db.select().from(planningCanvasAgentGrants).where(eq(planningCanvasAgentGrants.boardId, boardId)))
      .toEqual([expect.objectContaining({ agentId: agentA, issueId: story2.id, source: "handoff", grantedByUserId: OWNER })]);

    // The board reads back through the core route.
    const read = await request(app).get(`/api/companies/${Y}/planning-canvases/${boardId}`).set(session(OWNER));
    expect(read.status, read.text).toBe(200);

    wakes.length = 0;
    const replay = await apply(session(OWNER), body);
    expect(replay.status, replay.text).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, board: { id: boardId }, parentIssue: { id: parent.id } });
    expect(replay.body.issues.map((issue: { id: string; itemKey: string }) => [issue.itemKey, issue.id])).toEqual([["story-1", byKey["story-1"]], ["story-2", byKey["story-2"]]]);
    expect(await boardIssues(boardId)).toHaveLength(3);
    expect(wakes).toEqual([]);
    // Another caller with the same key is another call (and another board).
    const other = await apply(session(MEMBER), { blueprintId: "sprint_plan", idempotencyKey: "k-sprint", issues: [] });
    expect(other.status, other.text).toBe(201);
    expect(other.body.board.id).not.toBe(boardId);
    expect(other.body.issues).toEqual([]);
  });

  it("without `issues`, every marked node becomes an unassigned issue and nobody is woken", async () => {
    const res = await apply(session(MEMBER), { blueprintId: "retro", idempotencyKey: "k-retro" });
    expect(res.status, res.text).toBe(201);
    expect(res.body.parentIssue).toBeNull();
    expect(res.body.issues.map((issue: { itemKey: string }) => issue.itemKey)).toEqual(["action-1", "action-2", "action-3"]);
    expect((await boardIssues(res.body.board.id)).every((issue) => issue.assigneeAgentId === null)).toBe(true);
    expect(wakes).toEqual([]);
  });

  it("two simultaneous identical calls make one board and one set of issues", async () => {
    const body = { blueprintId: "roadmap", idempotencyKey: "k-race", parentIssue: true };
    const [first, second] = await Promise.all([apply(session(MEMBER), body), apply(session(MEMBER), body)]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(first.body.board.id).toBe(second.body.board.id);
    expect(await boardIssues(first.body.board.id)).toHaveLength(3);
    expect(second.body.issues.map((issue: { id: string }) => issue.id).sort()).toEqual(first.body.issues.map((issue: { id: string }) => issue.id).sort());
  });

  it("over 100 issues per caller per rolling hour answers 409 canvas_issue_rate_limited and creates nothing, not even the board", async () => {
    const caller = `limited-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: caller, name: caller, email: `${caller}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId: Y, principalType: "user", principalId: caller, status: "active", membershipRole: "operator" });
    await db.insert(principalPermissionGrants).values({ companyId: Y, principalType: "user" as const, principalId: caller, permissionKey: "tasks:assign" });
    await db.insert(issues).values([
      ...Array.from({ length: PLANNING_CANVAS_BLUEPRINT_ISSUES_PER_HOUR - 2 }, (_, i) => ({
        companyId: Y, title: `Seed ${i}`, status: "todo", originKind: PLANNING_CANVAS_BLUEPRINT_ORIGIN_KIND, originId: `${randomUUID()}:seed-${i}`, createdByUserId: caller,
      })),
      // Older than an hour: not counted.
      { companyId: Y, title: "Old", status: "todo", originKind: PLANNING_CANVAS_BLUEPRINT_ORIGIN_KIND, originId: `${randomUUID()}:old`, createdByUserId: caller, createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) },
    ]);
    const over = await apply(session(caller), { blueprintId: "retro", idempotencyKey: "k-over", issues: [{ key: "action-1", assigneeAgentId: agentA }, { key: "action-2" }, { key: "action-3" }] });
    expect(over.status, over.text).toBe(409);
    expect(over.body.details).toMatchObject({ code: "canvas_issue_rate_limited", used: PLANNING_CANVAS_BLUEPRINT_ISSUES_PER_HOUR - 2, requested: 3, limit: PLANNING_CANVAS_BLUEPRINT_ISSUES_PER_HOUR });
    expect(await boardOf(caller, "k-over")).toBeNull();
    expect(wakes).toEqual([]);
    // Per caller: another person is not limited by it; and two more still fit for this caller.
    expect((await apply(session(MEMBER), { blueprintId: "retro", idempotencyKey: "k-not-limited" })).status).toBe(201);
    const fits = await apply(session(caller), { blueprintId: "retro", idempotencyKey: "k-fits", issues: [{ key: "action-1" }, { key: "action-2" }] });
    expect(fits.status, fits.text).toBe(201);
  });

  it("more than 50 issues in one call answers 409 and creates nothing (service guard behind the 50-entry body cap)", async () => {
    const svc = planningCanvasBlueprintsService(db, { heartbeat });
    const caller = `percall-${randomUUID()}`;
    const input = { blueprintId: "retro" as const, idempotencyKey: "k-51", parentIssue: true, issues: Array.from({ length: 50 }, () => ({ key: "action-1" })) };
    await expect(svc.apply({ companyId: Y, userId: caller, actor: { type: "board", userId: caller, source: "session" } as never, guard: async () => {} }, input))
      .rejects.toMatchObject({ status: 409, details: { code: "canvas_issue_rate_limited", requested: 51, limit: 50 } });
    expect(await boardOf(caller, "k-51")).toBeNull();
  });

  it("refuses viewers, agents, bad bodies, unknown assignees and the Q11 guards, creating nothing", async () => {
    const viewer = await apply(session(VIEWER), { blueprintId: "retro", idempotencyKey: "k-viewer" });
    expect(viewer.status, viewer.text).toBe(403);
    expect(await boardOf(VIEWER, "k-viewer")).toBeNull();

    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "planning-canvas-blueprints");
    const agent = await apply({ authorization: `Bearer ${createLocalAgentJwt(agentA, Y, "process", randomUUID(), MEMBER)}` }, { blueprintId: "retro", idempotencyKey: "k-agent" });
    expect(agent.status, agent.text).toBe(403);

    expect((await apply(session(MEMBER), { blueprintId: "retro" })).status).toBe(400);
    expect((await apply(session(MEMBER), { blueprintId: "retro", idempotencyKey: "k-bad", issues: [{ key: "well-1" }] })).status).toBe(400);

    const unknown = await apply(session(MEMBER), { blueprintId: "retro", idempotencyKey: "k-unknown", issues: [{ key: "action-1", assigneeAgentId: randomUUID() }] });
    expect(unknown.status, unknown.text).toBe(422);
    expect(await boardOf(MEMBER, "k-unknown")).toBeNull();

    guardRefuses.on = true;
    const refused = await apply(session(MEMBER), { blueprintId: "retro", idempotencyKey: "k-guard", issues: [{ key: "action-1", assigneeAgentId: agentA }] });
    expect(refused.status, refused.text).toBe(403);
    expect(await boardOf(MEMBER, "k-guard")).toBeNull();
    expect(wakes).toEqual([]);
  });
});
