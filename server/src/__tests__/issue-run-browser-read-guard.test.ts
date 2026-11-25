import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  applyPendingMigrations,
  authUsers,
  browserUseBrowsers,
  browserUseSessions,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { browserUseRoutes } from "../routes/browser-use.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13042 (access C4k-9, PAR-12608 spec 4.6, AC-G3): the task's live-runs,
 * execution, active-run and browsers routes read the task first. A caller who
 * cannot read it gets the body of an unknown task and no run or browser data.
 * Readers keep today's answers, including the failed run id on /execution.
 *
 * O (owner, a board session that is not the local board) has a private task P
 * with a running run of X and a later failed run, and a browser session. Q is
 * an open task with a running run of X and a browser session. U is an operator,
 * R a restricted operator (company mode "off"), I an instance admin who is a
 * plain operator of C, L the local board.
 */

// Failing-read switch (PAR-12718): makes the issue:read decision throw for one user.
const failRead = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    accessService: (db: Parameters<typeof actual.accessService>[0]) => {
      const svc = actual.accessService(db);
      return {
        ...svc,
        decide: async (input: Parameters<typeof svc.decide>[0]) => {
          const actor = input.actor as { userId?: string };
          if (input.action === "issue:read" && failRead.userId && actor.userId === failRead.userId)
            throw new Error("access decision store unavailable");
          return svc.decide(input);
        },
      };
    },
  };
});

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ISSUE_RUN_BROWSER_READ_GUARD_TEST_DATABASE_URL");
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
// No silent skip: on CI this file must fail, not skip, without embedded Postgres.
if (process.env.CI && !support.supported) throw new Error("embedded Postgres required on CI");

(support.supported ? describe : describe.skip)("task run and browser routes read the task first", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  const O = `o-${randomUUID()}`, U = `u-${randomUUID()}`, R = `r-${randomUUID()}`, I = `i-${randomUUID()}`;
  const roles: Record<string, string> = { [O]: "owner", [U]: "operator", [R]: "operator", [I]: "operator" };
  const prefix = `B${randomUUID().slice(0, 5).toUpperCase()}`;
  let companyId = "", X = "", Y = "";
  const P = { id: "", identifier: `${prefix}-101` };
  const Q = { id: "", identifier: `${prefix}-102` };
  const run = { p: "", pFailed: "", q: "" };
  const browser = { pSession: "", p: "", qSession: "", q: "" };

  type RequestActor = Express.Request["actor"];
  const user = (userId: string): RequestActor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
    memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: userId === R, restrictionMode: "off" }],
  });
  const instanceAdmin = (): RequestActor => ({ ...user(I), isInstanceAdmin: true } as RequestActor);
  const localBoard = (): RequestActor => ({ type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true });
  const agent = (agentId: string): RequestActor => ({ type: "agent", agentId, companyId, source: "agent_key" });
  const appFor = (actor: RequestActor) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", agentRoutes(db));
    app.use("/api", browserUseRoutes(db));
    app.use(errorHandler);
    return app;
  };

  type Route = "live-runs" | "execution" | "active-run" | "browsers";
  const routes: Route[] = ["live-runs", "execution", "active-run", "browsers"];
  const get = (actor: RequestActor, route: Route, ref: string) =>
    request(appFor(actor)).get(`/api/issues/${ref}/${route}`);

  async function insertRun(values: Partial<typeof heartbeatRuns.$inferInsert>) {
    const [row] = await db.insert(heartbeatRuns).values({
      companyId, agentId: X, invocationSource: "assignment", triggerDetail: "read guard test", status: "running",
      startedAt: new Date(), contextSnapshot: {}, ...values,
    }).returning();
    return row!.id;
  }
  async function insertBrowser(issueId: string, grantId: string, connectionId: string) {
    const [session] = await db.insert(browserUseSessions).values({
      companyId, issueId, agentId: X, connectionId, grantId, providerSessionId: randomUUID(), status: "running",
    }).returning();
    const [row] = await db.insert(browserUseBrowsers).values({
      companyId, sessionId: session!.id, providerBrowserId: randomUUID(), status: "active",
    }).returning();
    return { session: session!.id, browser: row!.id };
  }
  const browserRows = async () => ({
    sessions: await db.select().from(browserUseSessions).where(eq(browserUseSessions.companyId, companyId)),
    browsers: await db.select().from(browserUseBrowsers).where(eq(browserUseBrowsers.companyId, companyId)),
  });
  const runRows = () => db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, [run.p, run.pFailed, run.q]));

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      await applyPendingMigrations(externalTestDatabaseUrl);
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-run-browser-read-guard-");
      db = createDb(tempDb.connectionString);
    }
    const [company] = await db.insert(companies).values({ name: "Run and browser read guard", issuePrefix: prefix }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, U, R, I].map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({
        companyId, principalType: "user", principalId, status: "active", membershipRole, restricted: principalId === R,
      });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole: membershipRole as "owner", grantedByUserId: null });
    }
    const [x, y] = await db.insert(agents).values([
      { companyId, name: "Writer", role: "engineer", status: "running", adapterType: "process", adapterConfig: {}, permissions: {} },
      { companyId, name: "Bystander", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, permissions: {} },
    ]).returning();
    X = x!.id; Y = y!.id;
    await db.insert(companyMemberships).values([X, Y].map(principalId => ({ companyId, principalType: "agent", principalId, status: "active", membershipRole: "member" })));

    const [p] = await db.insert(issues).values({
      companyId, title: "O's private task", status: "in_progress", priority: "medium", visibility: "private",
      createdByUserId: O, responsibleUserId: O, assigneeAgentId: X, issueNumber: 101, identifier: P.identifier,
    }).returning();
    P.id = p!.id;
    const [q] = await db.insert(issues).values({
      companyId, title: "Open task", status: "in_progress", priority: "medium",
      createdByUserId: O, assigneeAgentId: X, issueNumber: 102, identifier: Q.identifier,
    }).returning();
    Q.id = q!.id;

    // P: the running run carries the task column only, so /execution's
    // context-snapshot lookup returns the later failed run (C4k-7's retry input).
    run.p = await insertRun({ issueId: P.id });
    run.pFailed = await insertRun({
      issueId: P.id, status: "failed", contextSnapshot: { issueId: P.id }, finishedAt: new Date(now.getTime() + 2_000),
      createdAt: new Date(now.getTime() + 1_000), startedAt: new Date(now.getTime() + 1_000),
    });
    run.q = await insertRun({ issueId: Q.id, contextSnapshot: { issueId: Q.id }, startedAt: new Date(now.getTime() - 60_000) });
    await db.update(issues).set({ executionRunId: run.p, executionLockedAt: now }).where(eq(issues.id, P.id));
    await db.update(issues).set({ executionRunId: run.q, executionLockedAt: now }).where(eq(issues.id, Q.id));

    // One organization grant, shared with every active member (browserUseService.list).
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Browser Use", type: "rest_api" }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: application!.id, name: "Browser Use", uid: `bu-${randomUUID()}`, transport: "rest_api",
    }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId: connection!.id, kind: "organization" }).returning();
    const pBrowser = await insertBrowser(P.id, grant!.id, connection!.id);
    const qBrowser = await insertBrowser(Q.id, grant!.id, connection!.id);
    browser.pSession = pBrowser.session; browser.p = pBrowser.browser;
    browser.qSession = qBrowser.session; browser.q = qBrowser.browser;
  }, 120_000);

  afterEach(() => {
    failRead.userId = null;
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const notFoundBody = (route: Route) => ({ error: route === "browsers" ? "Task not found" : "Issue not found" });
  const pSecrets = () => [run.p, run.pFailed, browser.pSession, browser.p];

  // /execution loads by id only; the others accept an identifier too.
  const denialCases = routes.flatMap(route => [
    { route, by: "id" as const },
    ...(route === "execution" || route === "browsers" ? [] : [{ route, by: "identifier" as const }]),
  ]);

  it.each(denialCases)("AC-G3: U's $route on O's private task (by $by) answers like an unknown task", async ({ route, by }) => {
    const res = await get(user(U), route, by === "id" ? P.id : P.identifier);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual(notFoundBody(route));
    const unknown = await get(user(U), route, by === "id" ? randomUUID() : `${prefix}-999`);
    expect(res.status).toBe(unknown.status);
    expect(res.body).toEqual(unknown.body);
  });

  it("AC-G3: U's browser viewer, presence, viewport and control on P answer 404 and write nothing", async () => {
    const before = { browsers: await browserRows(), runs: await runRows() };
    const base = `/api/issues/${P.id}/browsers/${browser.p}`;
    const app = appFor(user(U));
    const responses = [
      await request(app).get(`${base}/viewer`),
      await request(app).post(`${base}/presence`).send({}),
      await request(app).post(`${base}/viewport`).send({ preset: "phone" }),
      await request(app).post(`${base}/viewport/release`).send({ viewerId: randomUUID() }),
      await request(app).post(`${base}/control`).send({ action: "stop" }),
    ];
    for (const res of responses) {
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body).toEqual({ error: "Task not found" });
    }
    expect({ browsers: await browserRows(), runs: await runRows() }).toEqual(before);
  });

  it("no run id or browser id of P leaks to U on any of the four routes", async () => {
    const bodies: string[] = [];
    for (const route of routes) bodies.push(JSON.stringify((await get(user(U), route, P.id)).body));
    bodies.push(JSON.stringify((await request(appFor(user(U))).get(`/api/issues/${P.id}/browsers/${browser.p}/viewer`)).body));
    for (const body of bodies) for (const secret of pSecrets()) expect(body).not.toContain(secret);
  });

  async function expectReaderAnswers(actor: RequestActor, task: { id: string; identifier: string }, ids: {
    live: string; execution: string; browserIds: string[];
  }) {
    const live = await get(actor, "live-runs", task.identifier);
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect((live.body as Array<{ id: string }>).map(row => row.id)).toEqual([ids.live]);
    const execution = await get(actor, "execution", task.id);
    expect(execution.status, JSON.stringify(execution.body)).toBe(200);
    expect(execution.body).toMatchObject({ runId: ids.execution, agentId: X });
    const active = await get(actor, "active-run", task.id);
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    expect(active.body).toMatchObject({ id: ids.live, agentId: X, agentName: "Writer" });
    const browsers = await get(actor, "browsers", task.id);
    expect(browsers.status, JSON.stringify(browsers.body)).toBe(200);
    expect((browsers.body as Array<{ id: string }>).map(row => row.id)).toEqual(ids.browserIds);
  }

  it("O (owner) on P gets today's answers, with the failed run id on /execution", async () => {
    await expectReaderAnswers(user(O), P, { live: run.p, execution: run.pFailed, browserIds: [browser.p] });
    const viewer = await request(appFor(user(O))).get(`/api/issues/${P.id}/browsers/${browser.p}/viewer`);
    expect(viewer.status).not.toBe(404);
  });

  it("L (local board) on P gets today's answers; the browser list keeps the service's grant rule", async () => {
    // Pinned: browserUseService.list skips a session whose grant the caller
    // cannot use, and "local-board" holds no membership, so the list is empty.
    await expectReaderAnswers(localBoard(), P, { live: run.p, execution: run.pFailed, browserIds: [] });
  });

  it("I (instance admin, plain operator of C) on P: pinned observed answer", async () => {
    // Pinned: the issue-privacy rule lets an instance admin read every task.
    await expectReaderAnswers(instanceAdmin(), P, { live: run.p, execution: run.pFailed, browserIds: [browser.p] });
  });

  it("U on the open task Q gets today's answers", async () => {
    await expectReaderAnswers(user(U), Q, { live: run.q, execution: run.q, browserIds: [browser.q] });
  });

  it("agent X (assignee of P) keeps today's 200 on the three run routes", async () => {
    const live = await get(agent(X), "live-runs", P.id);
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect((live.body as Array<{ id: string }>).map(row => row.id)).toEqual([run.p]);
    const execution = await get(agent(X), "execution", P.id);
    expect(execution.status, JSON.stringify(execution.body)).toBe(200);
    expect(execution.body).toMatchObject({ runId: run.pFailed });
    const active = await get(agent(X), "active-run", P.id);
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    expect(active.body).toMatchObject({ id: run.p });
  });

  it.each(["live-runs", "execution", "active-run"] as const)("agent Y (cannot read P) gets 404 on %s", async (route) => {
    const res = await get(agent(Y), route, P.id);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
    for (const secret of pSecrets()) expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it.each(routes)("failing read: a throwing issue:read decision for U on %s answers non-2xx with no run data", async (route) => {
    failRead.userId = U;
    const res = await get(user(U), route, P.id);
    expect(res.status).toBeGreaterThanOrEqual(400);
    for (const secret of pSecrets()) expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it("kill switch PAPERCLIP_ISSUE_PRIVACY_MODE=off: U on P gets today's answers", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
    await expectReaderAnswers(user(U), P, { live: run.p, execution: run.pFailed, browserIds: [browser.p] });
  });

  it("member restriction at off: restricted member R on the open task Q gets today's answers", async () => {
    await expectReaderAnswers(user(R), Q, { live: run.q, execution: run.q, browserIds: [browser.q] });
  });
});
