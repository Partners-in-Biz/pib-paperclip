import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { activityRoutes } from "../routes/activity.js";
import { agentRoutes } from "../routes/agents.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { MEMBER_RESTRICTION_ROUTE_TABLE, createRouteClassifier } from "../services/member-restriction/route-table.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-14342 (C4g-2b gap): the task-history rows of the route table. Spec
 * PAR-12608 rev 3, 4.6 ("task activity" and "One run's detail"). AC-G3: R
 * (restricted in Y) asking for O's task gets "not found"; with the kill switch
 * `off`, today's answer (AC-F8). AC-G5 for the two run lists of one task: on
 * his own task they hold only the runs that work for him. Scope callers: R as
 * owner of X, and an instance admin who is no member of Y, get today's answer.
 * AC-X1: a failed restriction read answers 503, no data. The context reading,
 * task browsers and the email thread classify as closed.
 */

const resolverFails = vi.hoisted(() => ({ on: false }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  const fail = () => Promise.reject(new actual.MemberRestrictionReadError("fixture: restriction unreadable"));
  return {
    ...actual,
    memberRestrictionFor: (...args: Parameters<typeof actual.memberRestrictionFor>) =>
      resolverFails.on ? fail() : actual.memberRestrictionFor(...args),
    memberRestrictionEnforcedCompanyIds: (...args: Parameters<typeof actual.memberRestrictionEnforcedCompanyIds>) =>
      resolverFails.on ? fail() : actual.memberRestrictionEnforcedCompanyIds(...args),
    memberRestrictionResolver: (db: Parameters<typeof actual.memberRestrictionResolver>[0]) =>
      (personId: string, companyId: string) => resolverFails.on ? fail() : actual.memberRestrictionFor(db, personId, companyId),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const THIS_FILE = "server/src/__tests__/member-restriction-route-table-task-history.test.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  resolverFails.on = false;
});

describe("task history route rows database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
type Case = { row: string; path: (issueId: string) => string; runIds?: (res: request.Response) => string[] };

const runIdsOf = (res: request.Response) => res.body.map((row: { runId: string }) => row.runId);
const liveIdsOf = (res: request.Response) => res.body.map((row: { id: string }) => row.id);

const CASES: Case[] = [
  { row: "GET /api/issues/:id/activity", path: (id) => `/api/issues/${id}/activity` },
  { row: "GET /api/issues/:id/runs", path: (id) => `/api/issues/${id}/runs`, runIds: runIdsOf },
  { row: "GET /api/issues/:issueId/live-runs", path: (id) => `/api/issues/${id}/live-runs`, runIds: liveIdsOf },
];

const CLOSED_ROWS = [
  "GET /api/issues/:id/context-usage",
  "GET /api/issues/:issueId/browsers",
  "GET /api/issues/:issueId/chat-binding",
  "GET /api/issues/:issueId/file-resources/list",
  "GET /api/companies/:companyId/email/tasks/:issueId",
  "GET /api/issues/:id/runner-goal",
];

/** PAR-15227 (C6 F2): one run at a time, so it has its own cases below. */
const ACTIVE_RUN_ROW = "GET /api/issues/:issueId/active-run";

it("every row of this file has exactly one case, and each is open", () => {
  const rows = MEMBER_RESTRICTION_ROUTE_TABLE.filter((entry) => entry.test === THIS_FILE);
  expect([...CASES.map((entry) => entry.row), ACTIVE_RUN_ROW].sort())
    .toEqual(rows.map((entry) => `${entry.method} ${entry.path}`).sort());
  for (const entry of rows) expect(entry.class, entry.path).toBe("open");
});

it("the context reading, task browsers and the email thread are closed; the runner goal stays a run row", async () => {
  const classify = createRouteClassifier();
  for (const row of CLOSED_ROWS) {
    const entry = MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => `${item.method} ${item.path}` === row);
    expect(entry?.class, row).toBe(row.endsWith("/runner-goal") ? "run" : "closed");
    const sample = entry!.path.replace(/:[A-Za-z]+/g, () => randomUUID());
    const result = await classify(entry!.method, sample);
    expect(result.kind === "matched" ? result.entry.class : result.kind, sample).toBe(entry!.class);
  }
});

(support.supported ? describe : describe.skip)("task history rows of the route table (PAR-12608 4.6, AC-G3, AC-G5)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;

  const O = `owner-${randomUUID()}`, R = `restricted-${randomUUID()}`;
  const ADMIN = `instance-admin-${randomUUID()}`;
  let Y = "", X = "";

  const as = (who: Actor) => { actor = who; return request(app); };
  const boardFor = async (userId: string, isInstanceAdmin = false): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return { type: "board", userId, source: "session", isInstanceAdmin, memberships,
      companyIds: memberships.map((row: { companyId: string }) => row.companyId) } as Actor;
  };
  const runFor = async (personId: string, agentId: string, companyId: string): Promise<Actor> => ({
    type: "agent", agentId, companyId, runId: randomUUID(), source: "agent_jwt", onBehalfOfUserId: personId,
    onBehalfOfMemberships: await loadActorMemberships(db, { userId: personId, companyId, activeOnly: true }),
  } as Actor);
  const agent = async (companyId: string) => {
    const [row] = await db.insert(agents).values({ companyId, name: `Agent ${randomUUID().slice(0, 6)}`, role: "engineer",
      status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }).returning();
    return row!.id;
  };
  /** A task of `owner` with one running run of an agent that works for R and one that works for O. */
  const taskWithRuns = async (companyId: string, owner: string) => {
    const agentId = await agent(companyId);
    const [task] = await db.insert(issues).values({ companyId, title: `Task ${randomUUID().slice(0, 8)}`, status: "todo",
      createdByUserId: owner, responsibleUserId: owner }).returning();
    const [forR, forO] = await db.insert(heartbeatRuns).values([R, O].map((worksFor) => ({
      companyId, agentId, issueId: task!.id, scopeKind: "issue", status: "running", responsibleUserId: worksFor,
    }))).returning();
    return { issueId: task!.id, agentId, forR: forR!.id, forO: forO!.id };
  };
  const today = async <T,>(send: () => Promise<T>): Promise<T> => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    try { return await send(); } finally { vi.unstubAllEnvs(); }
  };
  const ok = (res: request.Response) => expect(res.status, JSON.stringify(res.body)).toBe(200);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-route-table-task-history-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", activityRoutes(db));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);

    const [y, x] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
    ]).returning();
    Y = y!.id; X = x!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R, ADMIN].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
      { companyId: X, principalType: "user", principalId: R, status: "active", membershipRole: "owner" },
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe.each(CASES)("$row", (entry) => {
    it("AC-G3 and AC-F8: R gets \"not found\" for O's task; with the kill switch `off`, today's answer", async () => {
      const { issueId, forO } = await taskWithRuns(Y, O);
      const send = async () => as(await boardFor(R)).get(entry.path(issueId));
      const refused = await send();
      expect(refused.status, JSON.stringify(refused.body)).toBe(404);
      expect(refused.body).toEqual({ error: "Issue not found" });
      const reached = await today(send);
      ok(reached);
      if (entry.runIds) expect(entry.runIds(reached)).toContain(forO);
    });

    it("his own task: 200; a run list holds the run working for him and not the one working for O (AC-G5)", async () => {
      const { issueId, agentId, forR, forO } = await taskWithRuns(Y, R);
      for (const caller of [await boardFor(R), await runFor(R, agentId, Y)]) {
        const res = await as(caller).get(entry.path(issueId));
        ok(res);
        if (!entry.runIds) continue;
        expect(entry.runIds(res)).toContain(forR);
        expect(entry.runIds(res)).not.toContain(forO);
      }
      const unfiltered = await today(async () => as(await boardFor(R)).get(entry.path(issueId)));
      ok(unfiltered);
      if (entry.runIds) expect(entry.runIds(unfiltered)).toEqual(expect.arrayContaining([forR, forO]));
    });

    it("scope callers: R as owner of X, and an instance admin who is no member of Y, get today's answer", async () => {
      const inX = await taskWithRuns(X, R);
      const ownX = await as(await boardFor(R)).get(entry.path(inX.issueId));
      ok(ownX);
      if (entry.runIds) expect(entry.runIds(ownX)).toEqual(expect.arrayContaining([inX.forR, inX.forO]));
      const inY = await taskWithRuns(Y, O);
      const admin = async () => as(await boardFor(ADMIN, true)).get(entry.path(inY.issueId));
      const adminNow = await admin();
      const adminToday = await today(admin);
      expect(adminNow.status, JSON.stringify(adminNow.body)).toBe(adminToday.status);
      if (entry.runIds && adminNow.status === 200) expect(entry.runIds(adminNow).sort()).toEqual(entry.runIds(adminToday).sort());
    });

    it("AC-X1: answers 503 MEMBER_RESTRICTION_UNAVAILABLE and no data when the restriction cannot be read", async () => {
      const { issueId, forR } = await taskWithRuns(Y, R);
      const caller = await boardFor(R);
      resolverFails.on = true;
      const res = await as(caller).get(entry.path(issueId));
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
      expect(JSON.stringify(res.body)).not.toContain(forR);
    });
  });

  describe(ACTIVE_RUN_ROW, () => {
    const path = (issueId: string) => `/api/issues/${issueId}/active-run`;
    /** A task of `owner` whose execution run works for `worksFor`. */
    const taskRunningFor = async (companyId: string, owner: string, worksFor: string) => {
      const task = await taskWithRuns(companyId, owner);
      const runId = worksFor === R ? task.forR : task.forO;
      await db.update(issues).set({ executionRunId: runId, status: "in_progress", assigneeAgentId: task.agentId })
        .where(eq(issues.id, task.issueId));
      return { ...task, runId };
    };
    const activeRunId = (res: request.Response) => (res.body as { id?: string } | null)?.id ?? null;

    it("AC-G3 and AC-F8: R gets \"not found\" for O's task; with the kill switch `off`, today's answer", async () => {
      const { issueId, runId } = await taskRunningFor(Y, O, O);
      const send = async () => as(await boardFor(R)).get(path(issueId));
      const refused = await send();
      expect(refused.status, JSON.stringify(refused.body)).toBe(404);
      expect(refused.body).toEqual({ error: "Issue not found" });
      const reached = await today(send);
      ok(reached);
      expect(activeRunId(reached)).toBe(runId);
    });

    it("his own task: the run working for him is shown; one working for O is null (AC-G5)", async () => {
      const mine = await taskRunningFor(Y, R, R);
      const theirs = await taskRunningFor(Y, R, O);
      for (const caller of [await boardFor(R), await runFor(R, mine.agentId, Y)]) {
        const shown = await as(caller).get(path(mine.issueId));
        ok(shown);
        expect(activeRunId(shown)).toBe(mine.runId);
        const hidden = await as(caller).get(path(theirs.issueId));
        ok(hidden);
        expect(hidden.body).toBeNull();
      }
      const unfiltered = await today(async () => as(await boardFor(R)).get(path(theirs.issueId)));
      ok(unfiltered);
      expect(activeRunId(unfiltered)).toBe(theirs.runId);
    });

    it("scope callers: R as owner of X, and an instance admin who is no member of Y, get today's answer", async () => {
      const inX = await taskRunningFor(X, R, O);
      const ownX = await as(await boardFor(R)).get(path(inX.issueId));
      ok(ownX);
      expect(activeRunId(ownX)).toBe(inX.runId);
      const inY = await taskRunningFor(Y, O, O);
      const admin = async () => as(await boardFor(ADMIN, true)).get(path(inY.issueId));
      const adminNow = await admin();
      const adminToday = await today(admin);
      expect(adminNow.status, JSON.stringify(adminNow.body)).toBe(adminToday.status);
      expect(activeRunId(adminNow)).toBe(activeRunId(adminToday));
    });

    it("AC-X1: answers 503 MEMBER_RESTRICTION_UNAVAILABLE and no data when the restriction cannot be read", async () => {
      const { issueId, runId } = await taskRunningFor(Y, R, R);
      const caller = await boardFor(R);
      resolverFails.on = true;
      const res = await as(caller).get(path(issueId));
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
      expect(JSON.stringify(res.body)).not.toContain(runId);
    });
  });
});
