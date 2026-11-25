import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  planningCanvasAgentGrants,
  planningCanvasComments,
  planningCanvases,
  planningCanvasItems,
  principalPermissionGrants,
  projectAccessMembers,
  projects,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { forbidden } from "../errors.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { planningCanvasCommentRoutes } from "../routes/planning-canvas-comments.js";
import { planningCanvasRoutes } from "../routes/planning-canvases.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { MEMBER_RESTRICTION_DENIED_ACTION } from "../services/member-restriction/admin.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { PLANNING_CANVAS_AGENT_GRANTS_ENV } from "../services/planning-canvas-access.js";
import { PLANNING_CANVAS_SINGLE_BUCKET_PER_HOUR } from "../services/planning-canvas-comments.js";
import { planningCanvasOpsService } from "../services/planning-canvas-ops.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13935 (Planning Canvas C6): node comments and @agent mentions on the
 * real routes through the real `actorMiddleware`, on embedded Postgres.
 * CRUD, reply, resolve and reopen at `comment` level; mention create and
 * repeat; Q11 guards on the built body; dedupe under two simultaneous
 * mentions; J.4 limits; grant rows; node links through the C2 engine; and the
 * thread read-through that merges issue comments only with `issue:read`.
 * The woken run's person is proven in planning-canvas-comments-wakes.test.ts.
 */

const guardRefuses = vi.hoisted(() => ({ on: false, bodies: [] as Array<Record<string, unknown>> }));
vi.mock("../services/member-restriction/body-allowlist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/body-allowlist.js")>();
  return {
    ...actual,
    restrictedTaskBody: async (...args: Parameters<typeof actual.restrictedTaskBody>) => {
      if (args[3] === "createIssue") guardRefuses.bodies.push(args[4]);
      if (guardRefuses.on) throw forbidden("Not available for your access level: fixture", { code: "MEMBER_RESTRICTED" });
      return actual.restrictedTaskBody(...args);
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();
const JWT_SECRET = "planning-canvas-comments-routes";

beforeEach(() => {
  vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", JWT_SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
  guardRefuses.on = false;
  guardRefuses.bodies = [];
});

describe("planning canvas comments database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("planning canvas comments and mentions (plan PAR-13925 C6)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  const wakes: Array<{ agentId: string; reason: string | null | undefined; payload: Record<string, unknown> | null | undefined; requestedByActorId: string | null | undefined }> = [];

  const OWNER = `owner-${randomUUID()}`;
  const MEMBER = `member-${randomUUID()}`;
  const VIEWER = `viewer-${randomUUID()}`;
  /** Restricted member; his agent list is [A(0)]. */
  const RESTRICTED = `restricted-${randomUUID()}`;
  /** Operator without a `tasks:assign` grant. */
  const NOGRANT = `nogrant-${randomUUID()}`;
  let Y = "";
  let projectP = "";
  let projectQ = "";
  const agentIds: string[] = [];
  const A = (i: number) => agentIds[i]!;
  const mention = (agentId: string) => `[@Agent](agent://${agentId})`;

  const session = (userId: string) => ({ "x-test-session": userId, origin: "http://localhost" });
  /** A run token for a real run row (activity rows reference the run). */
  const agentJwt = async (agentId: string) => {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: Y, agentId, status: "running", invocationSource: "on_demand", triggerDetail: "manual" }).returning();
    return { authorization: `Bearer ${createLocalAgentJwt(agentId, Y, "process", run!.id, null)}` };
  };

  async function makeBoard(values: Partial<typeof planningCanvases.$inferInsert> = {}) {
    const [row] = await db
      .insert(planningCanvases)
      .values({ companyId: Y, userId: OWNER, title: `Board ${randomUUID().slice(0, 6)}`, ...values })
      .returning();
    const ops = planningCanvasOpsService(db);
    await ops.applyOps({
      companyId: Y,
      boardId: row!.id,
      actor: { type: "user", id: OWNER },
      batch: {
        ops: ["n1", "n2", "n3"].map((key) => ({
          op: "add",
          item: { itemType: "node", key, kind: "sticky", x: 0, y: 0, width: 100, height: 80, zIndex: 1, color: "yellow", title: `Title ${key}`, content: `Content ${key}` },
        })),
      },
    });
    return row!;
  }

  const url = (boardId: string, rest = "") => `/api/companies/${Y}/planning-canvases/${boardId}/comments${rest}`;
  const post = (headers: Record<string, string>, boardId: string, body: Record<string, unknown>) =>
    request(app).post(url(boardId)).set(headers).send(body);

  async function canvasIssues(boardId: string) {
    return db.select().from(issues).where(and(eq(issues.companyId, Y), eq(issues.originKind, "planning_canvas"), like(issues.originId, `${boardId}%`)));
  }

  async function item(boardId: string, key: string) {
    const [row] = await db
      .select()
      .from(planningCanvasItems)
      .where(and(eq(planningCanvasItems.boardId, boardId), eq(planningCanvasItems.itemKey, key)));
    return row!;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-planning-canvas-comments-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async (req) => {
        const userId = req.header("x-test-session");
        return userId
          ? ({ session: { id: `session-${userId}`, userId }, user: { id: userId, name: userId, email: null } } as never)
          : null;
      },
    }));
    const api = express.Router();
    api.use(memberRestrictionRouteGuard(db));
    api.use(planningCanvasRoutes(db));
    api.use(planningCanvasCommentRoutes(db, {
      heartbeat: {
        wakeup: async (agentId, opts) => {
          wakes.push({ agentId, reason: opts.reason, payload: opts.payload, requestedByActorId: opts.requestedByActorId });
          return null;
        },
      },
    }));
    app.use("/api", api);
    app.use(errorHandler);

    const [y] = await db.insert(companies).values({ name: "Y", issuePrefix: `C${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" }).returning();
    Y = y!.id;
    const now = new Date();
    await db.insert(authUsers).values([OWNER, MEMBER, VIEWER, RESTRICTED, NOGRANT].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: OWNER, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: MEMBER, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: VIEWER, status: "active", membershipRole: "viewer" },
      { companyId: Y, principalType: "user", principalId: NOGRANT, status: "active", membershipRole: "operator" },
    ]);
    const rows = await db.insert(agents).values(
      Array.from({ length: 7 }, (_, i) => ({ companyId: Y, name: `Agent ${i}`, role: "engineer", adapterType: "process", status: "idle" })),
    ).returning();
    agentIds.push(...rows.map((row) => row.id));
    await db.insert(companyMemberships).values({
      companyId: Y, principalType: "user", principalId: RESTRICTED, status: "active", membershipRole: "operator",
      restricted: true, restrictedAgentIds: [A(0)],
    });
    // Operators assign work through the `tasks:assign` grant (owners and admins have it by role).
    await db.insert(principalPermissionGrants).values([OWNER, MEMBER, RESTRICTED].map((principalId) => ({
      companyId: Y, principalType: "user" as const, principalId, permissionKey: "tasks:assign",
    })));
    const [p, q] = await db.insert(projects).values([
      { companyId: Y, name: "Open project", privacyOwnerUserId: OWNER },
      { companyId: Y, name: "Private project", privacyOwnerUserId: OWNER, visibility: "private" },
    ]).returning();
    projectP = p!.id;
    projectQ = q!.id;
    await db.insert(projectAccessMembers).values({ companyId: Y, projectId: projectQ, subjectType: "user", subjectId: OWNER });
  }, 120_000);

  afterEach(() => {
    wakes.length = 0;
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe("CRUD, reply, resolve and reopen", () => {
    it("needs comment level: a viewer reads but cannot write; a `view` board refuses members", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "comment" });
      const viewer = await post(session(VIEWER), board.id, { itemKey: "n1", body: "hi" });
      expect(viewer.status).toBe(403);
      expect(viewer.body.details.code).toBe("PLANNING_CANVAS_ACCESS_TOO_LOW");
      expect((await request(app).get(url(board.id)).set(session(VIEWER))).status).toBe(200);
      const viewOnly = await makeBoard({ scope: "company", memberAccess: "view" });
      expect((await post(session(MEMBER), viewOnly.id, { body: "hi" })).status).toBe(403);
      // A personal board answers others exactly the unknown-id 404.
      const personal = await makeBoard();
      const denied = await post(session(MEMBER), personal.id, { body: "hi" });
      const unknown = await post(session(MEMBER), randomUUID(), { body: "hi" });
      expect(denied.status).toBe(404);
      expect(denied.text).toBe(unknown.text);
    });

    it("creates, replies, edits, resolves, reopens and deletes", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "comment" });
      const first = await post(session(MEMBER), board.id, { itemKey: "n1", body: "First" });
      expect(first.status, first.text).toBe(201);
      expect(first.body).toMatchObject({ itemKey: "n1", parentId: null, body: "First", authorUserId: MEMBER, mentionState: {} });

      const reply = await post(session(OWNER), board.id, { parentId: first.body.id, body: "Reply" });
      expect(reply.status, reply.text).toBe(201);
      expect(reply.body).toMatchObject({ itemKey: "n1", parentId: first.body.id });
      expect((await post(session(OWNER), board.id, { parentId: reply.body.id, body: "Nested" })).status).toBe(422);
      expect((await post(session(OWNER), board.id, { parentId: first.body.id, itemKey: "n2", body: "Wrong node" })).status).toBe(422);
      expect((await post(session(OWNER), board.id, { itemKey: "missing", body: "No node" })).status).toBe(422);

      const edited = await request(app).patch(url(board.id, `/${first.body.id}`)).set(session(MEMBER)).send({ body: "First, edited" });
      expect(edited.status, edited.text).toBe(200);
      expect(edited.body.body).toBe("First, edited");
      expect((await request(app).patch(url(board.id, `/${first.body.id}`)).set(session(OWNER)).send({ body: "Not mine" })).status).toBe(403);

      const resolved = await request(app).post(url(board.id, `/${first.body.id}/resolve`)).set(session(OWNER)).send({ resolved: true });
      expect(resolved.status, resolved.text).toBe(200);
      expect(resolved.body.resolvedAt).toEqual(expect.any(String));
      expect(resolved.body.resolvedByUserId).toBe(OWNER);
      expect((await request(app).post(url(board.id, `/${reply.body.id}/resolve`)).set(session(OWNER)).send({ resolved: true })).status).toBe(422);
      const reopened = await request(app).post(url(board.id, `/${first.body.id}/resolve`)).set(session(MEMBER)).send({ resolved: false });
      expect(reopened.body).toMatchObject({ resolvedAt: null, resolvedByUserId: null });

      // Members may not delete another's comment; the board admin (owner) and the author may.
      expect((await request(app).delete(url(board.id, `/${reply.body.id}`)).set(session(MEMBER))).status).toBe(403);
      const removed = await request(app).delete(url(board.id, `/${first.body.id}`)).set(session(MEMBER));
      expect(removed.status).toBe(200);
      expect(removed.body).toMatchObject({ body: "", deletedAt: expect.any(String) });
      expect((await request(app).delete(url(board.id, `/${reply.body.id}`)).set(session(OWNER))).status).toBe(200);
      expect((await request(app).delete(url(board.id, `/${randomUUID()}`)).set(session(OWNER))).status).toBe(404);

      const listed = await request(app).get(url(board.id)).set(session(MEMBER));
      expect(listed.body.comments.map((c: { id: string }) => c.id)).toEqual([first.body.id, reply.body.id]);
    });

    it("an archived board is read-only", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "comment" });
      await db.update(planningCanvases).set({ archivedAt: new Date() }).where(eq(planningCanvases.id, board.id));
      expect((await post(session(MEMBER), board.id, { body: "hi" })).status).toBe(409);
      expect((await request(app).get(url(board.id)).set(session(MEMBER))).status).toBe(200);
    });
  });

  describe("mentions", () => {
    it("create: issue with canvas origin, commenter as creator, board project, agent_default; wake; node link", async () => {
      const board = await makeBoard({ scope: "project", projectId: projectP, memberAccess: "comment" });
      const res = await post(session(MEMBER), board.id, { itemKey: "n1", body: `Please look ${mention(A(0))}` });
      expect(res.status, res.text).toBe(201);
      expect(res.body.mentionState).toEqual({ [A(0)]: "sent" });
      const [issue, ...rest] = await canvasIssues(board.id);
      expect(rest).toEqual([]);
      expect(issue).toMatchObject({
        originKind: "planning_canvas",
        originId: `${board.id}:n1`,
        createdByUserId: MEMBER,
        responsibleUserId: MEMBER,
        projectId: projectP,
        assigneeAgentId: A(0),
        status: "todo",
      });
      expect(issue!.executionWorkspaceSettings).toMatchObject({ mode: "agent_default" });
      // X3: the key and a board link, never node text.
      expect(issue!.description).toContain("node `n1`");
      expect(issue!.description).toContain(`/planning-canvas?board=${board.id}`);
      expect(`${issue!.title}\n${issue!.description}`).not.toMatch(/Content n1|Title n1/);
      expect(res.body.linkedIssueId).toBe(issue!.id);
      expect(wakes).toEqual([{ agentId: A(0), reason: "issue_assigned", payload: expect.objectContaining({ issueId: issue!.id, mutation: "create" }), requestedByActorId: MEMBER }]);
      // The Q11 guard saw exactly the built body.
      expect(guardRefuses.bodies).toEqual([expect.objectContaining({ assigneeAgentId: A(0), projectId: projectP, executionWorkspaceSettings: { mode: "agent_default" } })]);
      // Node links through the C2 engine: version bumped, link added.
      const node = await item(board.id, "n1");
      expect((node.data as { links?: unknown[] }).links).toEqual([{ type: "issue", issueId: issue!.id }]);
      expect(node.version).toBe(2);
      // A company board's mention issue has no project.
      const company = await makeBoard({ scope: "company", memberAccess: "comment" });
      await post(session(MEMBER), company.id, { itemKey: "n1", body: mention(A(0)) });
      expect((await canvasIssues(company.id))[0]!.projectId).toBeNull();
    });

    it("repeat mention adds a comment to the open issue and wakes with issue_commented; a done issue gets a new one", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "comment" });
      await post(session(MEMBER), board.id, { itemKey: "n1", body: mention(A(1)) });
      const [issue] = await canvasIssues(board.id);
      wakes.length = 0;
      const again = await post(session(OWNER), board.id, { itemKey: "n1", body: `Again ${mention(A(1))}` });
      expect(again.body.mentionState).toEqual({ [A(1)]: "added_to_open" });
      expect(await canvasIssues(board.id)).toHaveLength(1);
      const added = await db.select().from(issueComments).where(eq(issueComments.issueId, issue!.id));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ authorUserId: OWNER });
      expect(added[0]!.body).toContain("Again");
      expect(wakes).toEqual([{ agentId: A(1), reason: "issue_commented", payload: expect.objectContaining({ issueId: issue!.id, wakeCommentId: added[0]!.id }), requestedByActorId: OWNER }]);
      // The link is not duplicated.
      expect((await item(board.id, "n1")).data).toMatchObject({ links: [{ type: "issue", issueId: issue!.id }] });

      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issue!.id));
      const fresh = await post(session(MEMBER), board.id, { itemKey: "n1", body: mention(A(1)) });
      expect(fresh.body.mentionState).toEqual({ [A(1)]: "sent" });
      expect(await canvasIssues(board.id)).toHaveLength(2);
    });

    it("dedupe: two simultaneous mentions of one agent on one node make one issue", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "comment" });
      const [a, b] = await Promise.all([
        post(session(MEMBER), board.id, { itemKey: "n2", body: `one ${mention(A(2))}` }),
        post(session(OWNER), board.id, { itemKey: "n2", body: `two ${mention(A(2))}` }),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(await canvasIssues(board.id)).toHaveLength(1);
      expect([a.body.mentionState[A(2)], b.body.mentionState[A(2)]].sort()).toEqual(["added_to_open", "sent"]);
    });

    it("limits: 5 agents per comment; agent-authored comments never create or wake; self-mention ignored", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "comment" });
      const six = agentIds.slice(0, 6);
      const res = await post(session(MEMBER), board.id, { itemKey: "n3", body: six.map(mention).join(" ") });
      expect(res.status).toBe(201);
      expect(six.map((id) => res.body.mentionState[id])).toEqual(["sent", "sent", "sent", "sent", "sent", "not_sent:mention_limit"]);
      expect(await canvasIssues(board.id)).toHaveLength(5);

      const other = await makeBoard({ scope: "company", memberAccess: "comment" });
      wakes.length = 0;
      const byAgent = await post(await agentJwt(A(6)), other.id, { itemKey: "n1", body: `${mention(A(6))} ${mention(A(0))}` });
      expect(byAgent.status, byAgent.text).toBe(201);
      expect(byAgent.body.authorAgentId).toBe(A(6));
      expect(byAgent.body.mentionState).toEqual({ [A(0)]: "not_sent:agent_author" });
      expect(await canvasIssues(other.id)).toEqual([]);
      expect(wakes).toEqual([]);
    });

    it("single bucket: over 20 created issues per board per rolling hour the comment is saved, not_sent:rate_limited, nothing created or woken", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "comment" });
      const seed = (createdAt: Date, n: number) =>
        db.insert(issues).values(Array.from({ length: n }, (_, i) => ({
          companyId: Y, title: `Seed ${i}`, status: "done", originKind: "planning_canvas", originId: `${board.id}:seed${i}`, createdAt,
        })));
      // Older than an hour: outside the rolling window.
      await seed(new Date(Date.now() - 2 * 60 * 60 * 1000), PLANNING_CANVAS_SINGLE_BUCKET_PER_HOUR);
      const allowed = await post(session(MEMBER), board.id, { itemKey: "n1", body: mention(A(3)) });
      expect(allowed.body.mentionState).toEqual({ [A(3)]: "sent" });
      await seed(new Date(), PLANNING_CANVAS_SINGLE_BUCKET_PER_HOUR - 1);
      const before = (await canvasIssues(board.id)).length;
      wakes.length = 0;
      const limited = await post(session(MEMBER), board.id, { itemKey: "n2", body: `Text kept ${mention(A(4))}` });
      expect(limited.status).toBe(201);
      expect(limited.body.body).toBe(`Text kept ${mention(A(4))}`);
      expect(limited.body.mentionState).toEqual({ [A(4)]: "not_sent:rate_limited" });
      expect(limited.body.linkedIssueId).toBeNull();
      expect((await canvasIssues(board.id)).length).toBe(before);
      expect(wakes).toEqual([]);
      expect((await item(board.id, "n2")).data).not.toHaveProperty("links");
    });

    it("Q11 guards refuse: the comment is saved, the mention is not_sent with the reason, nothing created or woken", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "comment" });
      guardRefuses.on = true;
      const res = await post(session(MEMBER), board.id, { itemKey: "n1", body: `Hello ${mention(A(5))}` });
      expect(res.status).toBe(201);
      expect(res.body.mentionState).toEqual({ [A(5)]: "not_sent:member_restricted" });
      expect(guardRefuses.bodies).toEqual([expect.objectContaining({ assigneeAgentId: A(5), title: expect.stringMatching(/^Canvas: /) })]);
      expect(await canvasIssues(board.id)).toEqual([]);
      expect(wakes).toEqual([]);
      expect((await db.select().from(planningCanvasComments).where(eq(planningCanvasComments.id, res.body.id)))).toHaveLength(1);
    });

    it("an edit sends only newly mentioned agents", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "comment" });
      const created = await post(session(MEMBER), board.id, { itemKey: "n1", body: mention(A(0)) });
      const edited = await request(app).patch(url(board.id, `/${created.body.id}`)).set(session(MEMBER)).send({ body: `${mention(A(0))} ${mention(A(1))}` });
      expect(edited.body.mentionState).toEqual({ [A(0)]: "sent", [A(1)]: "sent" });
      expect(await canvasIssues(board.id)).toHaveLength(2);
    });
  });

  describe("Q11 assignment checks with the real guards (no mock switch)", () => {
    it("a restricted member: an agent off his list is not_sent:agent_not_listed, nothing created or woken; a listed agent is sent", async () => {
      const board = await makeBoard({ userId: RESTRICTED });
      const off = await post(session(RESTRICTED), board.id, { itemKey: "n1", body: `Hi ${mention(A(1))}` });
      expect(off.status, off.text).toBe(201);
      expect(off.body.body).toBe(`Hi ${mention(A(1))}`);
      expect(off.body.mentionState).toEqual({ [A(1)]: "not_sent:agent_not_listed" });
      expect(await canvasIssues(board.id)).toEqual([]);
      expect(wakes).toEqual([]);
      const denials = await db.select().from(activityLog)
        .where(and(eq(activityLog.companyId, Y), eq(activityLog.action, MEMBER_RESTRICTION_DENIED_ACTION)));
      expect(denials.some((row) => JSON.stringify(row.details).includes(RESTRICTED))).toBe(true);

      const listed = await post(session(RESTRICTED), board.id, { itemKey: "n2", body: mention(A(0)) });
      expect(listed.body.mentionState).toEqual({ [A(0)]: "sent" });
      expect(await canvasIssues(board.id)).toEqual([expect.objectContaining({ assigneeAgentId: A(0), createdByUserId: RESTRICTED })]);
      expect(wakes).toEqual([expect.objectContaining({ agentId: A(0), reason: "issue_assigned" })]);
    });

    it("tasks:assign: a protected agent needs the grant; without it the comment is saved, not_sent, nothing created or woken", async () => {
      // In simple mode every non-viewer member may assign; a protected agent needs an explicit `tasks:assign` grant.
      const [guarded] = await db.insert(agents).values({
        companyId: Y, name: "Protected", role: "engineer", adapterType: "process", status: "idle",
        permissions: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } },
      }).returning();
      const board = await makeBoard({ scope: "company", memberAccess: "comment" });
      const refused = await post(session(NOGRANT), board.id, { itemKey: "n1", body: `Hi ${mention(guarded!.id)}` });
      expect(refused.status, refused.text).toBe(201);
      expect(refused.body.mentionState[guarded!.id]).toMatch(/^not_sent:deny_/);
      expect(await canvasIssues(board.id)).toEqual([]);
      expect(wakes).toEqual([]);

      const granted = await post(session(MEMBER), board.id, { itemKey: "n1", body: mention(guarded!.id) });
      expect(granted.body.mentionState).toEqual({ [guarded!.id]: "sent" });
      expect(await canvasIssues(board.id)).toHaveLength(1);
    });
  });

  describe("grant rows (Q6, Q14)", () => {
    it("written only for the board owner's own session on a personal board, with the switch on", async () => {
      vi.stubEnv(PLANNING_CANVAS_AGENT_GRANTS_ENV, "on");
      const personal = await makeBoard();
      await post(session(OWNER), personal.id, { itemKey: "n1", body: mention(A(0)) });
      const [issue] = await canvasIssues(personal.id);
      const grants = await db.select().from(planningCanvasAgentGrants).where(eq(planningCanvasAgentGrants.boardId, personal.id));
      expect(grants).toEqual([expect.objectContaining({ agentId: A(0), issueId: issue!.id, grantedByUserId: OWNER, source: "mention" })]);

      const company = await makeBoard({ scope: "company", memberAccess: "comment" });
      await post(session(MEMBER), company.id, { itemKey: "n1", body: mention(A(0)) });
      await post(session(OWNER), company.id, { itemKey: "n2", body: mention(A(1)) });
      expect(await db.select().from(planningCanvasAgentGrants).where(eq(planningCanvasAgentGrants.boardId, company.id))).toEqual([]);
    });

    it("switch off: the issue is created (private, without node text), no grant", async () => {
      const personal = await makeBoard();
      await post(session(OWNER), personal.id, { itemKey: "n2", body: mention(A(2)) });
      const [issue] = await canvasIssues(personal.id);
      expect(issue!.visibility).toBe("private");
      expect(issue!.description).toContain("node `n2`");
      expect(issue!.description).not.toContain("Content n2");
      expect(await db.select().from(planningCanvasAgentGrants).where(eq(planningCanvasAgentGrants.boardId, personal.id))).toEqual([]);
    });

    it("reading the switch throws: no grant is written, the issue is still created", async () => {
      const personal = await makeBoard();
      const original = process.env;
      process.env = new Proxy({ ...original, [PLANNING_CANVAS_AGENT_GRANTS_ENV]: "on" }, {
        get(target, prop) {
          if (prop === PLANNING_CANVAS_AGENT_GRANTS_ENV) throw new Error("fixture: env unreadable");
          return Reflect.get(target, prop);
        },
      });
      try {
        const res = await post(session(OWNER), personal.id, { itemKey: "n1", body: mention(A(3)) });
        expect(res.body.mentionState).toEqual({ [A(3)]: "sent" });
      } finally {
        process.env = original;
      }
      expect(await canvasIssues(personal.id)).toHaveLength(1);
      expect(await db.select().from(planningCanvasAgentGrants).where(eq(planningCanvasAgentGrants.boardId, personal.id))).toEqual([]);
    });
  });

  describe("thread read-through (Q8)", () => {
    it("merges linked issue comments only for readers with issue:read; others see the issue as hidden", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "comment" });
      // The owner mentions, so the issue is his (a creator keeps reading his own issue).
      await post(session(OWNER), board.id, { itemKey: "n1", body: mention(A(4)) });
      const [issue] = await canvasIssues(board.id);
      await db.insert(issueComments).values({ companyId: Y, issueId: issue!.id, authorAgentId: A(4), body: "Agent reply" });

      const open = await request(app).get(url(board.id)).query({ itemKey: "n1" }).set(session(MEMBER));
      expect(open.status, open.text).toBe(200);
      expect(open.body.comments).toHaveLength(1);
      expect(open.body.linkedIssues).toEqual([expect.objectContaining({ id: issue!.id, identifier: issue!.identifier, status: "todo" })]);
      expect(open.body.issueComments).toEqual([expect.objectContaining({ issueId: issue!.id, body: "Agent reply", authorAgentId: A(4) })]);
      // Another node's thread does not carry this issue.
      expect((await request(app).get(url(board.id)).query({ itemKey: "n2" }).set(session(MEMBER))).body).toMatchObject({ linkedIssues: [], issueComments: [] });

      // Move the issue into the owner's private project: the member loses issue:read, the owner keeps it.
      await db.update(issues).set({ projectId: projectQ }).where(eq(issues.id, issue!.id));
      const hidden = await request(app).get(url(board.id)).query({ itemKey: "n1" }).set(session(MEMBER));
      expect(hidden.body.linkedIssues).toEqual([{ id: issue!.id, hidden: true }]);
      expect(hidden.body.issueComments).toEqual([]);
      expect(JSON.stringify(hidden.body)).not.toContain("Agent reply");
      const owner = await request(app).get(url(board.id)).query({ itemKey: "n1" }).set(session(OWNER));
      expect(owner.body.issueComments).toEqual([expect.objectContaining({ body: "Agent reply" })]);
    });
  });
});
