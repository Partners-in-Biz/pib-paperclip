import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  planningCanvases,
  principalPermissionGrants,
  projects,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { activityRoutes } from "../routes/activity.js";
import { issueRoutes } from "../routes/issues.js";
import { planningCanvasChatRoutes } from "../routes/planning-canvas-chat.js";
import { planningCanvasCommentRoutes } from "../routes/planning-canvas-comments.js";
import { planningCanvasSharingRoutes } from "../routes/planning-canvas-sharing.js";
import { planningCanvasRoutes } from "../routes/planning-canvases.js";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { planningCanvasOpsService } from "../services/planning-canvas-ops.js";
import { PLANNING_CANVAS_CHAT_ENV } from "../services/planning-canvas-switches.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-14276 (plan PAR-14257 C, D 1a and X3, E "1a/1b"; acceptance additions
 * `acceptance-par-14276` s.2 (v) and s.3): the board chat route through the
 * real router and the real `actorMiddleware` on embedded Postgres. The run's
 * person (s.1, s.2 (i)-(iv)) is proven in planning-canvas-chat-wakes.test.ts.
 */

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
const JWT_SECRET = "planning-canvas-chat-routes";

describe("planning canvas chat database support", () => {
  // Acceptance s.3: the denial tests fail, not skip, where embedded Postgres is unsupported.
  it("embedded Postgres runs here", () => {
    expect(support.supported, JSON.stringify(support)).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("planning canvas board chat (PAR-14276)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  const wakes: Array<{ agentId: string; reason: string | null | undefined; payload: Record<string, unknown> | null | undefined; requestedByActorId: string | null | undefined }> = [];

  const OWNER = `owner-${randomUUID()}`;
  const ADMIN = `admin-${randomUUID()}`;
  const EDITOR = `editor-${randomUUID()}`;
  const SECOND = `second-${randomUUID()}`;
  const VIEWER = `viewer-${randomUUID()}`;
  const RESTRICTED = `restricted-${randomUUID()}`;
  const OUTSIDER = `outsider-${randomUUID()}`;
  const OTHERCO = `otherco-${randomUUID()}`;
  let Y = "", X = "", agentA = "", agentB = "", projectP = "";

  const session = (userId: string) => ({ "x-test-session": userId, origin: "http://localhost" });
  const url = (boardId: string, companyId = Y) => `/api/companies/${companyId}/planning-canvases/${boardId}/chat`;
  const chat = (headers: Record<string, string>, boardId: string, body: Record<string, unknown>, companyId = Y) =>
    request(app).post(url(boardId, companyId)).set(headers).send(body);
  const msg = (extra: Record<string, unknown> = {}) => ({ agentId: agentA, body: "Please sort the stickies", clientRequestId: randomUUID(), ...extra });

  async function makeBoard(values: Partial<typeof planningCanvases.$inferInsert> = {}) {
    const [row] = await db
      .insert(planningCanvases)
      .values({ companyId: Y, userId: OWNER, title: `Board ${randomUUID().slice(0, 6)}`, ...values })
      .returning();
    await planningCanvasOpsService(db).applyOps({
      companyId: row!.companyId,
      boardId: row!.id,
      actor: { type: "user", id: row!.userId! },
      batch: {
        ops: [
          { op: "add", item: { itemType: "node", key: "n1", kind: "sticky", x: 0, y: 0, width: 100, height: 80, zIndex: 1, color: "yellow", title: "SECRET-TITLE", content: "SECRET-CONTENT" } },
          { op: "add", item: { itemType: "node", key: "f1", kind: "frame", x: 0, y: 0, width: 400, height: 400, zIndex: 0, color: "blue", title: "SECRET-FRAME", content: "" } },
        ],
      },
    });
    return row!;
  }

  async function threadsOf(boardId: string) {
    return db.select().from(issues).where(and(eq(issues.companyId, Y), eq(issues.originKind, "planning_canvas"), eq(issues.originId, `${boardId}:chat`)));
  }
  async function commentsOf(issueId: string) {
    return db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-planning-canvas-chat-");
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
      wakeup: async (agentId: string, opts: { reason?: string | null; payload?: Record<string, unknown> | null; requestedByActorId?: string | null }) => {
        wakes.push({ agentId, reason: opts.reason, payload: opts.payload, requestedByActorId: opts.requestedByActorId });
        // As the real queue does: a request row per accepted wake (the chat repeat path reads it).
        await db.insert(agentWakeupRequests).values({ companyId: Y, agentId, source: "assignment", reason: opts.reason ?? null, payload: opts.payload ?? null });
        return null;
      },
    };
    api.use(planningCanvasRoutes(db));
    api.use(planningCanvasSharingRoutes(db));
    api.use(planningCanvasCommentRoutes(db, { heartbeat }));
    api.use(planningCanvasChatRoutes(db, { heartbeat }));
    api.use(issueRoutes(db, {} as never));
    api.use(activityRoutes(db));
    api.use(sidebarBadgeRoutes(db));
    app.use("/api", api);
    app.use(errorHandler);

    const [y, x] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `C${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}` },
    ]).returning();
    Y = y!.id;
    X = x!.id;
    const now = new Date();
    const people = [OWNER, ADMIN, EDITOR, SECOND, VIEWER, RESTRICTED, OUTSIDER, OTHERCO];
    await db.insert(authUsers).values(people.map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now })));
    const [a, b] = await db.insert(agents).values([
      { companyId: Y, name: "Agent A", role: "engineer", adapterType: "process", status: "idle" },
      { companyId: Y, name: "Agent B", role: "engineer", adapterType: "process", status: "idle" },
    ]).returning();
    agentA = a!.id;
    agentB = b!.id;
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: OWNER, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: ADMIN, status: "active", membershipRole: "admin" },
      { companyId: Y, principalType: "user", principalId: EDITOR, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: SECOND, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: VIEWER, status: "active", membershipRole: "viewer" },
      { companyId: Y, principalType: "user", principalId: RESTRICTED, status: "active", membershipRole: "operator", restricted: true, restrictedAgentIds: [agentA] },
      { companyId: X, principalType: "user", principalId: OTHERCO, status: "active", membershipRole: "owner" },
    ]);
    await db.insert(principalPermissionGrants).values([OWNER, EDITOR, SECOND, RESTRICTED].map((principalId) => ({
      companyId: Y, principalType: "user" as const, principalId, permissionKey: "tasks:assign",
    })));
    const [p] = await db.insert(projects).values({ companyId: Y, name: "Open project", privacyOwnerUserId: OWNER }).returning();
    projectP = p!.id;
  }, 120_000);

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", JWT_SECRET);
    vi.stubEnv(PLANNING_CANVAS_CHAT_ENV, "on");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    wakes.length = 0;
    honestRead.fails = false;
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe("access matrix (E 1a/1b), one parametrised test", () => {
    type Cell = [label: string, who: string, board: Partial<typeof planningCanvases.$inferInsert>, expected: number | "unknown-id"];
    const cells: Cell[] = [
      ["board owner", "OWNER", { scope: "company", memberAccess: "comment" }, 201],
      ["company admin", "ADMIN", { scope: "company", memberAccess: "view" }, 201],
      ["member with edit", "EDITOR", { scope: "company", memberAccess: "edit" }, 201],
      ["member with edit on a project board", "EDITOR", { scope: "project", memberAccess: "edit" }, 201],
      ["member with comment", "EDITOR", { scope: "company", memberAccess: "comment" }, 403],
      ["member with view", "EDITOR", { scope: "company", memberAccess: "view" }, 403],
      ["viewer role on an edit board", "VIEWER", { scope: "company", memberAccess: "edit" }, 403],
      ["restricted member on a company board", "RESTRICTED", { scope: "company", memberAccess: "edit" }, "unknown-id"],
      ["non-member", "OUTSIDER", { scope: "company", memberAccess: "edit" }, "unknown-id"],
      ["member of another company", "OTHERCO", { scope: "company", memberAccess: "edit" }, "unknown-id"],
      ["member on the owner's personal board", "EDITOR", { scope: "personal" }, "unknown-id"],
    ];
    const ids: Record<string, string> = { OWNER, ADMIN, EDITOR, VIEWER, RESTRICTED, OUTSIDER, OTHERCO };

    it.each(cells)("%s", async (_label, who, values, expected) => {
      const board = await makeBoard({ ...values, ...(values.scope === "project" ? { projectId: projectP } : {}) });
      const res = await chat(session(ids[who]!), board.id, msg());
      if (expected === "unknown-id") {
        const unknown = await chat(session(ids[who]!), randomUUID(), msg());
        expect(res.status).toBe(404);
        expect(res.text).toBe(unknown.text);
        expect(await threadsOf(board.id)).toEqual([]);
        return;
      }
      expect(res.status, res.text).toBe(expected);
      if (expected === 403) {
        expect(res.body.details.code).toBe("PLANNING_CANVAS_ACCESS_TOO_LOW");
        expect(await threadsOf(board.id)).toEqual([]);
      }
    });

    it("agent caller: 403 with its own code (an agent that can open the board); nothing written", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      const [run] = await db.insert(heartbeatRuns).values({ companyId: Y, agentId: agentA, status: "running", invocationSource: "on_demand", triggerDetail: "manual" }).returning();
      const res = await chat({ authorization: `Bearer ${createLocalAgentJwt(agentA, Y, "process", run!.id, OWNER)}` }, board.id, msg());
      expect(res.status, res.text).toBe(403);
      expect(res.body.details.code).toBe("canvas_chat_agent_caller");
      expect(await threadsOf(board.id)).toEqual([]);
    });

    it("archived board: refused, nothing written", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      await db.update(planningCanvases).set({ archivedAt: new Date() }).where(eq(planningCanvases.id, board.id));
      expect((await chat(session(EDITOR), board.id, msg())).status).toBe(409);
      expect(await threadsOf(board.id)).toEqual([]);
    });
  });

  describe("actor types (s.2 v)", () => {
    it("board API key: the key's person is the asker; a caller-chosen run header changes nothing", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      const token = `pcp_${randomUUID()}`;
      await db.insert(boardApiKeys).values({ userId: EDITOR, name: "test", keyHash: createHash("sha256").update(token).digest("hex") });
      // An assistant-connection style call: board key plus a run of someone else's.
      const [run] = await db.insert(heartbeatRuns).values({ companyId: Y, agentId: agentB, status: "running", invocationSource: "on_demand", triggerDetail: "manual", responsibleUserId: OWNER }).returning();
      const res = await chat({ authorization: `Bearer ${token}`, "x-paperclip-run-id": run!.id }, board.id, msg());
      expect(res.status, res.text).toBe(201);
      const [thread] = await threadsOf(board.id);
      expect(thread).toMatchObject({ createdByUserId: EDITOR, responsibleUserId: EDITOR, parentId: null, originRunId: null });
      expect(wakes.at(-1)).toMatchObject({ requestedByActorId: EDITOR, payload: expect.objectContaining({ wakeCommentId: res.body.commentId }) });
    });

    it("a board actor with no person is refused with its own code before the board is read", async () => {
      const mini = express();
      mini.use(express.json());
      mini.use((req, _res, next) => {
        req.actor = { type: "board", source: "cloud_control", companyIds: [Y], isInstanceAdmin: true };
        next();
      });
      mini.use("/api", planningCanvasChatRoutes(db));
      mini.use(errorHandler);
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      const res = await request(mini).post(url(board.id)).send(msg());
      expect(res.status, res.text).toBe(403);
      expect(res.body.details.code).toBe("canvas_chat_person_required");
    });
  });

  describe("threads, context, repeats, limits, switch", () => {
    it("one thread per board, agent and asker; project, company and personal placement", async () => {
      const company = await makeBoard({ scope: "company", memberAccess: "edit" });
      const one = await chat(session(EDITOR), company.id, msg());
      const two = await chat(session(EDITOR), company.id, msg({ body: "And again" }));
      const other = await chat(session(SECOND), company.id, msg());
      const otherAgent = await chat(session(EDITOR), company.id, msg({ agentId: agentB }));
      for (const res of [one, two, other, otherAgent]) expect(res.status, res.text).toBe(201);
      expect(one.body.thread).toBe("created");
      expect(two.body).toMatchObject({ thread: "open", threadIssueId: one.body.threadIssueId, repeat: false });
      const threads = await threadsOf(company.id);
      expect(threads).toHaveLength(3);
      for (const thread of threads) {
        expect(thread).toMatchObject({ parentId: null, originKind: "planning_canvas", originId: `${company.id}:chat`, projectId: null, visibility: "open", status: "todo" });
        expect(thread.responsibleUserId).toBe(thread.createdByUserId);
      }
      expect(new Set(threads.map((t) => `${t.createdByUserId}:${t.assigneeAgentId}`))).toEqual(new Set([`${EDITOR}:${agentA}`, `${SECOND}:${agentA}`, `${EDITOR}:${agentB}`]));
      // Every message, the first included, is a comment by the asker whose wake names it.
      const comments = await commentsOf(one.body.threadIssueId);
      expect(comments.map((c) => c.authorUserId)).toEqual([EDITOR, EDITOR]);
      expect(wakes.slice(0, 2)).toEqual([
        { agentId: agentA, reason: "issue_commented", payload: expect.objectContaining({ issueId: one.body.threadIssueId, wakeCommentId: one.body.commentId }), requestedByActorId: EDITOR },
        { agentId: agentA, reason: "issue_commented", payload: expect.objectContaining({ wakeCommentId: two.body.commentId }), requestedByActorId: EDITOR },
      ]);

      const project = await makeBoard({ scope: "project", projectId: projectP, memberAccess: "edit" });
      expect((await chat(session(EDITOR), project.id, msg())).status).toBe(201);
      expect((await threadsOf(project.id))[0]).toMatchObject({ projectId: projectP, visibility: "open" });
    });

    it("personal board: the thread is private and lands in the asker's personal private project", async () => {
      const personal = await makeBoard({ scope: "personal" });
      const res = await chat(session(OWNER), personal.id, msg());
      expect(res.status, res.text).toBe(201);
      const [thread] = await threadsOf(personal.id);
      expect(thread).toMatchObject({ visibility: "private", createdByUserId: OWNER, responsibleUserId: OWNER, parentId: null });
      expect(thread!.projectId).toEqual(expect.any(String));
      const [project] = await db.select().from(projects).where(eq(projects.id, thread!.projectId!));
      expect(project).toMatchObject({ visibility: "private", privacyOwnerUserId: OWNER });
    });

    it("context keys: another board's keys or a non-frame frame key are refused; nothing written", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      const elsewhere = await makeBoard({ scope: "company", memberAccess: "edit" });
      await planningCanvasOpsService(db).applyOps({ companyId: Y, boardId: elsewhere.id, actor: { type: "user", id: OWNER },
        batch: { ops: [{ op: "add", item: { itemType: "node", key: "only-there", kind: "sticky", x: 0, y: 0, width: 100, height: 80, zIndex: 1, color: "yellow", title: "x", content: "" } }] } });
      for (const context of [{ itemKeys: ["only-there"] }, { itemKeys: ["n1", "missing"] }, { itemKeys: [], frameKey: "n1" }, { itemKeys: [], frameKey: "only-there" }]) {
        const res = await chat(session(EDITOR), board.id, msg({ context }));
        expect(res.status, JSON.stringify(context)).toBe(422);
        expect(res.body.details.code).toBe("canvas_chat_unknown_context_key");
      }
      expect(await threadsOf(board.id)).toEqual([]);
      expect(wakes).toEqual([]);
    });

    it("the stored comment holds the text, keys and a board link, never node text", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      const res = await chat(session(EDITOR), board.id, msg({ context: { itemKeys: ["n1"], frameKey: "f1" } }));
      expect(res.status, res.text).toBe(201);
      const [thread] = await threadsOf(board.id);
      const [comment] = await commentsOf(thread!.id);
      expect(comment!.body).toContain("Please sort the stickies");
      expect(comment!.body).toContain("items `n1`; frame `f1`");
      expect(comment!.body).toContain(`/planning-canvas?board=${board.id}`);
      for (const text of [comment!.body, thread!.title, thread!.description ?? ""]) {
        expect(text).not.toMatch(/SECRET-|Board [0-9a-f]{6}/);
      }
    });

    it("a repeat clientRequestId makes one comment and one wake; different text under the same id is 409", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      const body = msg();
      const first = await chat(session(EDITOR), board.id, body);
      const again = await chat(session(EDITOR), board.id, body);
      expect(first.status).toBe(201);
      expect(again.status, again.text).toBe(200);
      expect(again.body).toMatchObject({ repeat: true, commentId: first.body.commentId, threadIssueId: first.body.threadIssueId });
      expect(await commentsOf(first.body.threadIssueId)).toHaveLength(1);
      expect(wakes).toHaveLength(1);
      expect((await chat(session(EDITOR), board.id, { ...body, body: "Other text" })).status).toBe(409);
    });

    it("message 31 in an hour is canvas_chat_rate_limited and writes nothing", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      const first = await chat(session(SECOND), board.id, msg());
      expect(first.status, first.text).toBe(201);
      // 29 more of the person's chat messages this hour (any board counts), plus older ones that do not.
      const now = Date.now();
      await db.insert(issueComments).values([
        ...Array.from({ length: 29 }, (_, i) => ({ companyId: Y, issueId: first.body.threadIssueId, authorUserId: SECOND, body: `m${i}`, createdAt: new Date(now - 60_000) })),
        ...Array.from({ length: 5 }, (_, i) => ({ companyId: Y, issueId: first.body.threadIssueId, authorUserId: SECOND, body: `old${i}`, createdAt: new Date(now - 2 * 3_600_000) })),
      ]);
      const before = (await commentsOf(first.body.threadIssueId)).length;
      const res = await chat(session(SECOND), board.id, msg());
      expect(res.status, res.text).toBe(429);
      expect(res.body.details.code).toBe("canvas_chat_rate_limited");
      expect(await commentsOf(first.body.threadIssueId)).toHaveLength(before);
      expect(wakes).toHaveLength(1);
      // Another person is not limited by it.
      expect((await chat(session(EDITOR), board.id, msg())).status).toBe(201);
    });

    it("switch off, or its read throwing: refused with its own code, nothing written", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      vi.stubEnv(PLANNING_CANVAS_CHAT_ENV, "off");
      const off = await chat(session(EDITOR), board.id, msg());
      expect(off.status).toBe(403);
      expect(off.body.details.code).toBe("canvas_chat_disabled");
      vi.stubEnv(PLANNING_CANVAS_CHAT_ENV, "on");
      const original = process.env;
      process.env = new Proxy({ ...original }, {
        get(target, prop) {
          if (prop === PLANNING_CANVAS_CHAT_ENV) throw new Error("fixture: env unreadable");
          return Reflect.get(target, prop);
        },
      });
      try {
        const thrown = await chat(session(EDITOR), board.id, msg());
        expect(thrown.status).toBe(403);
        expect(thrown.body.details.code).toBe("canvas_chat_disabled");
      } finally {
        process.env = original;
      }
      expect(await threadsOf(board.id)).toEqual([]);
      expect(wakes).toEqual([]);
    });

    it("a throwing read (rule H) answers non-2xx and writes nothing", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      honestRead.fails = true;
      const res = await chat(session(EDITOR), board.id, msg());
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await threadsOf(board.id)).toEqual([]);
      expect(wakes).toEqual([]);
    });

    it("done and cancelled threads reopen on the next message, with one wake for the asker", async () => {
      const board = await makeBoard({ scope: "company", memberAccess: "edit" });
      const first = await chat(session(EDITOR), board.id, msg());
      for (const status of ["done", "cancelled"] as const) {
        await db.update(issues).set({ status }).where(eq(issues.id, first.body.threadIssueId));
        wakes.length = 0;
        const res = await chat(session(EDITOR), board.id, msg());
        expect(res.status, res.text).toBe(201);
        expect(res.body).toMatchObject({ thread: "reopened", threadIssueId: first.body.threadIssueId });
        const [thread] = await threadsOf(board.id);
        expect(thread!.status).toBe("todo");
        expect(wakes).toEqual([expect.objectContaining({ agentId: agentA, requestedByActorId: EDITOR, payload: expect.objectContaining({ wakeCommentId: res.body.commentId }) })]);
      }
      expect(await threadsOf(board.id)).toHaveLength(1);
    });
  });

  describe("X3: mentions carry keys and a board link, never node text; personal-board mentions are private", () => {
    it("mention issue and repeat comment", async () => {
      const personal = await makeBoard({ scope: "personal" });
      const mention = `[@Agent](agent://${agentA})`;
      const comments = `/api/companies/${Y}/planning-canvases/${personal.id}/comments`;
      expect((await request(app).post(comments).set(session(OWNER)).send({ itemKey: "n1", body: `Look ${mention}` })).status).toBe(201);
      const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, Y), like(issues.originId, `${personal.id}:n1`)));
      expect(issue).toMatchObject({ visibility: "private", createdByUserId: OWNER });
      expect(issue!.description).toContain("node `n1`");
      expect(issue!.description).toContain(`/planning-canvas?board=${personal.id}`);
      expect(`${issue!.title}\n${issue!.description}`).not.toContain("SECRET-");
      expect((await request(app).post(comments).set(session(OWNER)).send({ itemKey: "n1", body: `Again ${mention}` })).status).toBe(201);
      const repeat = (await commentsOf(issue!.id)).at(-1)!;
      expect(repeat.body).toContain("Again");
      expect(repeat.body).toContain(`/planning-canvas?board=${personal.id}`);
      expect(repeat.body).not.toContain("SECRET-");
      // Company board mentions stay open.
      const company = await makeBoard({ scope: "company", memberAccess: "comment" });
      await request(app).post(`/api/companies/${Y}/planning-canvases/${company.id}/comments`).set(session(EDITOR)).send({ itemKey: "n1", body: mention });
      const [open] = await db.select().from(issues).where(and(eq(issues.companyId, Y), eq(issues.originId, `${company.id}:n1`)));
      expect(open!.visibility).toBe("open");
      expect(open!.description).not.toContain("SECRET-");
    });
  });

  describe("a personal-board thread is unreadable to another member (s.3, check e)", () => {
    const MARK = `ZEBRA${randomUUID().slice(0, 8)}`;
    type Read = [route: string, path: (ctx: { threadId: string; identifier: string }) => string, direct: boolean];
    const reads: Read[] = [
      ["issue get by id", (c) => `/api/issues/${c.threadId}`, true],
      ["issue get by identifier", (c) => `/api/issues/${c.identifier}`, true],
      ["issue comments", (c) => `/api/issues/${c.threadId}/comments`, true],
      ["issue documents", (c) => `/api/issues/${c.threadId}/documents`, true],
      ["issue attachments", (c) => `/api/issues/${c.threadId}/attachments`, true],
      ["issue interactions", (c) => `/api/issues/${c.threadId}/interactions`, true],
      ["issue activity", (c) => `/api/issues/${c.threadId}/activity`, true],
      ["heartbeat-context", (c) => `/api/issues/${c.threadId}/heartbeat-context`, true],
      ["issue list", () => `/api/companies/${Y}/issues`, false],
      ["issue list q=", () => `/api/companies/${Y}/issues?q=${MARK}`, false],
      ["issue list q= title", () => `/api/companies/${Y}/issues?q=${encodeURIComponent("Board chat")}`, false],
      ["company search", () => `/api/companies/${Y}/search?q=${MARK}`, false],
      ["company activity", () => `/api/companies/${Y}/activity`, false],
      ["sidebar counts", () => `/api/companies/${Y}/sidebar-badges`, false],
    ];

    async function expectUnreadable(ctx: { threadId: string; identifier: string }) {
      for (const [route, path, direct] of reads) {
        const res = await request(app).get(path(ctx)).set(session(EDITOR));
        if (direct) expect([403, 404], `${route}: ${res.status} ${res.text.slice(0, 200)}`).toContain(res.status);
        else expect(res.status, `${route}: ${res.text.slice(0, 200)}`).toBeLessThan(500);
        // Search answers echo the query string; everything else in them must be free of the thread.
        let text = res.text;
        if (route === "company search") {
          const { query: _q, normalizedQuery: _n, ...rest } = res.body as Record<string, unknown>;
          expect(rest.results, route).toEqual([]);
          text = JSON.stringify(rest);
        }
        for (const leak of [ctx.threadId, ctx.identifier, MARK]) {
          const at = text.indexOf(leak);
          expect(at, `${route} leaks ${leak}: ${text.slice(Math.max(0, at - 400), at + 100)}`).toBe(-1);
        }
      }
    }

    it("through every read route; widening the board to company keeps the old thread private", async () => {
      const personal = await makeBoard({ scope: "personal" });
      const res = await chat(session(OWNER), personal.id, msg({ body: `Plan ${MARK}` }));
      expect(res.status, res.text).toBe(201);
      const ctx = { threadId: res.body.threadIssueId as string, identifier: res.body.threadIdentifier as string };
      // Positive control: the asker reads his thread on the same routes.
      expect((await request(app).get(`/api/issues/${ctx.threadId}`).set(session(OWNER))).status).toBe(200);
      const own = await request(app).get(`/api/issues/${ctx.threadId}/comments`).set(session(OWNER));
      expect(own.status).toBe(200);
      expect(own.text).toContain(MARK);
      await expectUnreadable(ctx);

      // Check (e): the owner widens the board; the thread stays private and is reused.
      const widened = await request(app).patch(`/api/companies/${Y}/planning-canvases/${personal.id}/sharing`).set(session(OWNER)).send({ scope: "company", memberAccess: "edit" });
      expect(widened.status, widened.text).toBe(200);
      const after = await chat(session(OWNER), personal.id, msg({ body: `More ${MARK}` }));
      expect(after.status, after.text).toBe(201);
      expect(after.body.threadIssueId).toBe(ctx.threadId);
      const [thread] = await threadsOf(personal.id);
      expect(thread!.visibility).toBe("private");
      await expectUnreadable(ctx);
      // The member can now chat on the widened board: his own thread is open, apart from the owner's.
      const mine = await chat(session(EDITOR), personal.id, msg());
      expect(mine.status, mine.text).toBe(201);
      expect(mine.body.threadIssueId).not.toBe(ctx.threadId);
    });
  });
});
