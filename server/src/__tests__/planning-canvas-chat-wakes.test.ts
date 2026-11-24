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
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  issueComments,
  issues,
  planningCanvases,
  principalPermissionGrants,
  projectAccessMembers,
  projects,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.ts";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { planningCanvasChatRoutes } from "../routes/planning-canvas-chat.js";
import { planningCanvasRoutes } from "../routes/planning-canvases.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { planningCanvasOpsService } from "../services/planning-canvas-ops.js";
import { PLANNING_CANVAS_CHAT_ENV } from "../services/planning-canvas-switches.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-14276 acceptance s.1 and s.2: who a chat run works for, asserted as the
 * run's acting person through the real `actorMiddleware` with the run's own
 * JWT (never a hand-set `req.actor`, never the issue's `responsibleUserId`).
 *
 * s.1: the asker cannot open project board X, the agent can. During the
 * asker's chat run the agent's call to X is refused; the same call to the chat
 * board succeeds. Under rule H `off`, `report` and `enforce`.
 * s.2: (i) first message, (ii) a second person's ordinary issue comment,
 * (iii) another person reassigns or changes status, (iv) the agent's own
 * comment, reopen of a done/cancelled thread.
 */

type Seen = { person: string | null; chatBoard: number; boardX: number; ownComment?: number };
const seen = vi.hoisted(() => ({
  app: null as null | express.Express,
  runs: new Map<string, Seen>(),
  paths: { companyId: "", chatBoardId: "", boardXId: "" },
  agentComment: null as null | { issueId: string },
}));
const honestRead = vi.hoisted(() => ({ fails: false }));

const mockAdapterExecute = vi.hoisted(() => vi.fn(async (ctx: { runId: string; authToken?: string; context?: Record<string, unknown> }) => {
  const auth = { authorization: `Bearer ${ctx.authToken}` };
  const issueId = typeof ctx.context?.issueId === "string" ? ctx.context.issueId : null;
  const { companyId, chatBoardId, boardXId } = seen.paths;
  const probe = await request(seen.app!).get("/api/probe").set(auth);
  const chatBoard = await request(seen.app!).get(`/api/companies/${companyId}/planning-canvases/${chatBoardId}`).set(auth);
  const boardX = await request(seen.app!).get(`/api/companies/${companyId}/planning-canvases/${boardXId}`).set(auth);
  const entry: Seen = { person: probe.status === 200 ? probe.body.onBehalfOfUserId : `status ${probe.status}`, chatBoard: chatBoard.status, boardX: boardX.status };
  if (seen.agentComment) {
    const target = seen.agentComment;
    seen.agentComment = null;
    const res = await request(seen.app!).post(`/api/issues/${target.issueId}/comments`).set({ ...auth, "x-paperclip-run-id": ctx.runId }).send({ body: "Agent progress note" });
    entry.ownComment = res.status;
  }
  seen.runs.set(ctx.runId, entry);
  // A well-behaved turn ends with a disposition, so no repair run follows it.
  if (issueId) {
    await request(seen.app!).patch(`/api/issues/${issueId}`).set({ ...auth, "x-paperclip-run-id": ctx.runId })
      .send({ status: "done", comment: "Answered on the board." });
  }
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Chat wake test run.", provider: "test", model: "test-model" };
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: true, execute: mockAdapterExecute })) };
});
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

describe("planning canvas chat wake database support", () => {
  it("embedded Postgres runs here", () => {
    expect(support.supported, JSON.stringify(support)).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("board chat runs work for the asker (PAR-14276 s.1, s.2)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const OWNER = `owner-${randomUUID()}`;
  const ASKER = `asker-${randomUUID()}`;
  const SECOND = `second-${randomUUID()}`;
  const DEFAULT = `default-${randomUUID()}`;
  let companyId = "";
  let agentId = "";
  let otherAgentId = "";
  let chatBoardId = "";

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "planning-canvas-chat-wakes");
    vi.stubEnv(PLANNING_CANVAS_CHAT_ENV, "on");
    seen.runs.clear();
    mockAdapterExecute.mockClear();
    honestRead.fails = false;
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-planning-canvas-chat-wakes-");
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
    api.use(memberRestrictionRouteGuard(db));
    api.get("/probe", (req, res) => {
      res.json({ type: req.actor.type, onBehalfOfUserId: req.actor.type === "agent" ? req.actor.onBehalfOfUserId ?? null : null });
    });
    api.use(planningCanvasRoutes(db));
    api.use(planningCanvasChatRoutes(db, { heartbeat }));
    api.use(issueRoutes(db, {} as never));
    app.use("/api", api);
    app.use(errorHandler);
    seen.app = app;

    companyId = randomUUID();
    // The company default person is someone else, so a fallback would fail the test.
    await db.insert(companies).values({ id: companyId, name: "Canvas chat wakes",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, defaultResponsibleUserId: DEFAULT });
    const now = new Date();
    const people = [OWNER, ASKER, SECOND, DEFAULT];
    await db.insert(authUsers).values(people.map((id) => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values(people.map((principalId) => ({
      companyId, principalType: "user" as const, principalId, status: "active", membershipRole: principalId === DEFAULT ? "owner" : "operator" })));
    await db.insert(principalPermissionGrants).values([OWNER, ASKER, SECOND].map((principalId) => ({
      companyId, principalType: "user" as const, principalId, permissionKey: "tasks:assign" })));
    const [agent, other] = await db.insert(agents).values([
      { companyId, name: "Planner", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} },
      { companyId, name: "Second agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} },
    ]).returning();
    agentId = agent!.id;
    otherAgentId = other!.id;
    // Board X: a project board in a private project the agents can read and the asker cannot.
    const [px] = await db.insert(projects).values({ companyId, name: "Private X", visibility: "private", privacyOwnerUserId: OWNER }).returning();
    await db.insert(projectAccessMembers).values([
      { companyId, projectId: px!.id, subjectType: "user", subjectId: OWNER },
      { companyId, projectId: px!.id, subjectType: "agent", subjectId: agentId },
      { companyId, projectId: px!.id, subjectType: "agent", subjectId: otherAgentId },
    ]);
    const [boardX] = await db.insert(planningCanvases)
      .values({ companyId, userId: OWNER, title: "Board X", scope: "project", projectId: px!.id, memberAccess: "edit" }).returning();
    const [chatBoard] = await db.insert(planningCanvases)
      .values({ companyId, userId: OWNER, title: "Chat board", scope: "company", memberAccess: "edit" }).returning();
    chatBoardId = chatBoard!.id;
    seen.paths = { companyId, chatBoardId, boardXId: boardX!.id };
    await planningCanvasOpsService(db).applyOps({ companyId, boardId: chatBoardId, actor: { type: "user", id: OWNER },
      batch: { ops: [{ op: "add", item: { itemType: "node", key: "n1", kind: "sticky", x: 0, y: 0, width: 100, height: 80, zIndex: 1, color: "yellow", title: "Plan", content: "" } }] } });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    runningProcesses.clear();
    if (heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  }, 60_000);

  const send = (userId: string, body: Record<string, unknown> = {}) =>
    request(seen.app!).post(`/api/companies/${companyId}/planning-canvases/${chatBoardId}/chat`)
      .set({ "x-test-session": userId, origin: "http://localhost" })
      .send({ agentId, body: "Build the plan", clientRequestId: randomUUID(), ...body });

  async function runsFor(issueId: string, started: Date) {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    return runs.filter((run) => run.createdAt >= started && (run.contextSnapshot as { issueId?: string } | null)?.issueId === issueId);
  }

  /** Runs woken by one chat message (its comment id in the wake context). */
  function messageRuns(runs: Array<typeof heartbeatRuns.$inferSelect>, commentId: string) {
    return runs.filter((run) => (run.contextSnapshot as { wakeCommentId?: string } | null)?.wakeCommentId === commentId);
  }

  /** Every executed run's acting person, read through the middleware with its own token. */
  function actingPersons(runs: Array<typeof heartbeatRuns.$inferSelect>) {
    const executed = runs.filter((run) => seen.runs.has(run.id));
    expect(executed.length).toBeGreaterThan(0);
    return executed.map((run) => seen.runs.get(run.id)!);
  }

  async function freshThread() {
    // Each case gets its own thread: archive (hide) earlier ones of this asker.
    await db.update(issues).set({ hiddenAt: new Date() })
      .where(and(eq(issues.companyId, companyId), eq(issues.originId, `${chatBoardId}:chat`)));
  }

  describe.each(["off", "report", "enforce"] as const)("rule H %s", (mode) => {
    it("s.1 + s.2 (i): one run for the first message; it works for the asker, refused on board X, allowed on the chat board", async () => {
      await db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, companyId));
      await freshThread();
      const started = new Date();
      const res = await send(ASKER);
      expect(res.status, res.text).toBe(201);
      expect(res.body.thread).toBe("created");
      const runs = await runsFor(res.body.threadIssueId, started);
      expect(messageRuns(runs, res.body.commentId)).toHaveLength(1);
      expect(actingPersons(runs)).toEqual(runs.filter((r) => seen.runs.has(r.id)).map(() => ({ person: ASKER, chatBoard: 200, boardX: 404 })));

      // A second message in the same thread: again the asker.
      const again = Date.now();
      const next = await send(ASKER, { body: "And the timeline" });
      expect(next.status, next.text).toBe(201);
      const nextRuns = await runsFor(res.body.threadIssueId, new Date(again));
      expect(actingPersons(nextRuns)).toEqual(nextRuns.filter((r) => seen.runs.has(r.id)).map(() => ({ person: ASKER, chatBoard: 200, boardX: 404 })));
    });
  });

  it("rule H read throwing: the message fails closed (non-2xx), nothing written, no run", async () => {
    await freshThread();
    const started = new Date();
    honestRead.fails = true;
    const res = await send(ASKER);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const threads = await db.select().from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originId, `${chatBoardId}:chat`), eq(issues.createdByUserId, ASKER)));
    expect(threads.filter((t) => t.hiddenAt === null)).toEqual([]);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs.filter((run) => run.createdAt >= started)).toEqual([]);
  });

  it("s.2 (ii): a second person's ordinary issue comment on the thread: the run works for that commenter", async () => {
    await db.update(companies).set({ memberRestrictionMode: "off" }).where(eq(companies.id, companyId));
    await freshThread();
    const first = await send(ASKER);
    expect(first.status, first.text).toBe(201);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // The agent's turn closed the thread; the case is a comment on an open thread.
    await db.update(issues).set({ status: "todo", completedAt: null }).where(eq(issues.id, first.body.threadIssueId));
    const started = new Date();
    const res = await request(seen.app!).post(`/api/issues/${first.body.threadIssueId}/comments`)
      .set({ "x-test-session": SECOND, origin: "http://localhost" }).send({ body: "Also add risks" });
    expect(res.status, res.text).toBe(201);
    // The comment route queues its wake without awaiting it.
    await vi.waitFor(async () => {
      const rows = await db.select().from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.requestedByActorId, SECOND)));
      expect(rows.length).toBeGreaterThan(0);
    }, { timeout: 10_000, interval: 100 });
    const runs = await runsFor(first.body.threadIssueId, started);
    expect(actingPersons(runs).map((s) => s.person)).toEqual(runs.filter((r) => seen.runs.has(r.id)).map(() => SECOND));
  });

  describe.each(["off", "enforce"] as const)("s.2 (iii) under rule H %s", (mode) => {
    it.each([
      ["reassigns the thread", (otherAgent: string) => ({ assigneeAgentId: otherAgent })],
      ["moves a done thread back to todo", () => ({ status: "todo" })],
    ] as const)("another person %s: the run's person", async (_label, patch) => {
      await db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, companyId));
      await freshThread();
      const first = await send(ASKER);
      expect(first.status, first.text).toBe(201);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const body = patch(otherAgentId);
      // The agent's turn ended the thread as done (see the adapter mock); a reassignment is of an open thread.
      if ("status" in body) expect((await db.select().from(issues).where(eq(issues.id, first.body.threadIssueId)))[0]!.status).toBe("done");
      else await db.update(issues).set({ status: "todo", completedAt: null }).where(eq(issues.id, first.body.threadIssueId));
      const started = new Date();
      const res = await request(seen.app!).patch(`/api/issues/${first.body.threadIssueId}`)
        .set({ "x-test-session": SECOND, origin: "http://localhost" }).send(body);
      expect(res.status, res.text).toBe(200);
      const runs = await runsFor(first.body.threadIssueId, started);
      // Rule s.2: the person whose action caused the wake (SECOND). The platform gives the thread's
      // responsible person (the asker) in both modes, though the wake carries SECOND's H1 stamp under
      // `enforce`. Same for every issue, not chat code: recorded in the PR's writer table and raised on
      // PAR-14270. This pins today's result so a platform fix shows up here.
      const expected = ASKER;
      expect(actingPersons(runs).map((s) => s.person)).toEqual(runs.filter((r) => seen.runs.has(r.id)).map(() => expected));
    });
  });

  it("s.2 (iv): the agent's own comment in its run does not wake it again", async () => {
    await db.update(companies).set({ memberRestrictionMode: "off" }).where(eq(companies.id, companyId));
    await freshThread();
    const res = await send(ASKER);
    expect(res.status, res.text).toBe(201);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const afterFirst = new Date();
    seen.agentComment = { issueId: res.body.threadIssueId };
    const second = await send(ASKER, { body: "Post a note", clientRequestId: randomUUID() });
    expect(second.status, second.text).toBe(201);
    const runs = await runsFor(res.body.threadIssueId, afterFirst);
    const executed = runs.filter((r) => seen.runs.has(r.id));
    expect(executed.map((r) => seen.runs.get(r.id)!.ownComment).filter(Boolean)).toEqual([201]);
    const agentComments = await db.select().from(issueComments)
      .where(and(eq(issueComments.issueId, res.body.threadIssueId), eq(issueComments.authorAgentId, agentId)));
    expect(agentComments.length).toBeGreaterThan(0);
    // Only the asker's message woke a run: no run was started by the agent's own comment.
    expect(executed).toHaveLength(1);
  });

  it.each(["done", "cancelled"] as const)("a %s thread: the next message reopens it and wakes exactly one run, for the asker", async (status) => {
    await db.update(companies).set({ memberRestrictionMode: "off" }).where(eq(companies.id, companyId));
    await freshThread();
    const first = await send(ASKER);
    expect(first.status, first.text).toBe(201);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.update(issues).set({ status, completedAt: null, cancelledAt: null }).where(eq(issues.id, first.body.threadIssueId));
    const started = new Date();
    const res = await send(ASKER, { body: "One more thing" });
    expect(res.status, res.text).toBe(201);
    expect(res.body.thread).toBe("reopened");
    const runs = await runsFor(first.body.threadIssueId, started);
    expect(messageRuns(runs, res.body.commentId)).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(actingPersons(runs)).toEqual([{ person: ASKER, chatBoard: 200, boardX: 404 }]);
  });
});
