import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentSessionGoalActions,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12967 (access C4k-4b, AC-G3): retry-now, stalled-review-decision,
 * admin force-release and the board path of runner-goal actions read the task
 * first. A caller who may not read it gets 404 "Issue not found" and nothing
 * is written; a caller who may read it gets today's answer.
 *
 * O (owner, a board session that is not the local board) has a private chat
 * with X, opened through the real chat route, and private tasks P (one per
 * route, seeded directly as rows). U is an operator of the same company. I is
 * an instance admin who is not the local board. L is the local board.
 * Force-release has no break-glass (PAR-12966 decision (a)).
 */

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_OPERATOR_READ_GUARD_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
if (process.env.CI && !embeddedPostgresSupport.supported) throw new Error("embedded Postgres required on CI");

(embeddedPostgresSupport.supported ? describe : describe.skip)("operator board routes read the task first", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  const enqueueWakeup = vi.fn(async () => null);

  const O = `o-${randomUUID()}`, U = `u-${randomUUID()}`, I = `i-${randomUUID()}`;
  const roles: Record<string, string> = { [O]: "owner", [U]: "operator" };
  const prefix = `H${randomUUID().slice(0, 5).toUpperCase()}`;
  let companyId = "", X = "", Y = "", xRunId = "", yRunId = "", chatId = "";
  const P = { retry: "", review: "", lock: "", goal: "" };
  let retryRunId = "", lockRunId = "", goalSessionId = "";
  const seededGoalRequest = () => ({ requestId: "seeded-pause", agentId: X, expectedRevision: 2, action: "pause" as const });

  type RequestActor = Express.Request["actor"];
  const user = (userId: string): RequestActor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
    memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: false, restrictionMode: "off" }],
  });
  const instanceAdmin = (): RequestActor => ({
    type: "board", userId: I, source: "session", companyIds: [companyId], isInstanceAdmin: true,
    memberships: [{ companyId, membershipRole: "operator", status: "active", restricted: false, restrictionMode: "off" }],
  });
  const localBoard = (): RequestActor => ({
    type: "board", userId: "local-board", userName: "Local Board", userEmail: null,
    isInstanceAdmin: true, source: "local_implicit",
  });
  const agent = (agentId: string, runId: string): RequestActor => ({
    type: "agent", agentId, companyId, runId, source: "agent_jwt",
  });
  const appFor = (actor: RequestActor) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never, { stalledReviewDecisionEnqueueWakeup: enqueueWakeup as never }));
    app.use(errorHandler);
    return app;
  };

  let issueNumber = 0;
  async function insertPrivateTask(title: string, values: Partial<typeof issues.$inferInsert> = {}) {
    issueNumber += 1;
    const [row] = await db.insert(issues).values({
      companyId, title, status: "in_progress", priority: "medium", visibility: "private",
      createdByUserId: O, responsibleUserId: O, assigneeAgentId: X,
      issueNumber: 100 + issueNumber, identifier: `${prefix}-${100 + issueNumber}`, ...values,
    }).returning();
    return row!.id;
  }
  async function insertRun(agentId: string, values: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "assignment", triggerDetail: "read guard test", status: "running",
      startedAt: new Date(), ...values,
    }).returning();
    return run!.id;
  }
  const relock = (issueId: string) => db.update(issues)
    .set({ checkoutRunId: lockRunId, executionRunId: lockRunId, executionLockedAt: new Date() })
    .where(eq(issues.id, issueId));

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      await applyPendingMigrations(externalTestDatabaseUrl);
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-operator-read-guard-");
      db = createDb(tempDb.connectionString);
    }
    const [company] = await db.insert(companies).values({ name: "Operator read guard", issuePrefix: prefix, requireBoardApprovalForNewAgents: false }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, U, I].map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole: membershipRole as "owner", grantedByUserId: null });
    }
    const [x, y] = await db.insert(agents).values([
      { companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "paperclip_runner",
        adapterConfig: { provider: "codex" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} },
      { companyId, name: "Bystander", role: "engineer", status: "idle", adapterType: "paperclip_runner",
        adapterConfig: { provider: "codex" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} },
    ]).returning();
    X = x!.id; Y = y!.id;
    await db.insert(companyMemberships).values([X, Y].map(principalId => ({ companyId, principalType: "agent", principalId, status: "active", membershipRole: "member" })));
    // I is an instance admin who is also a plain operator of C (a real session
    // only lists companies it is a member of; hasCompanyAccess keeps that gate).
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: I, status: "active", membershipRole: "operator" });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });

    const opened = await request(appFor(user(O))).post(`/api/companies/${companyId}/chats/${X}`).send({});
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body).toMatchObject({ visibility: "private", conversationUserId: O, conversationAgentId: X });
    chatId = opened.body.id as string;

    // Scheduled retry: a failed source run, its wakeup and the scheduled_retry run.
    P.retry = await insertPrivateTask("O's private retry");
    const sourceRunId = await insertRun(X, { status: "failed", finishedAt: now, contextSnapshot: { issueId: P.retry } });
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId, agentId: X, source: "automation", triggerDetail: "system", reason: "bounded_transient_heartbeat_retry",
      payload: { issueId: P.retry, retryOfRunId: sourceRunId }, status: "queued",
    }).returning();
    retryRunId = await insertRun(X, {
      status: "scheduled_retry", invocationSource: "automation", wakeupRequestId: wake!.id, retryOfRunId: sourceRunId,
      scheduledRetryAt: new Date(now.getTime() + 3_600_000), scheduledRetryAttempt: 2, scheduledRetryReason: "transient_failure",
      startedAt: null, contextSnapshot: { issueId: P.retry, wakeReason: "bounded_transient_heartbeat_retry", retryOfRunId: sourceRunId },
    });
    await db.update(agentWakeupRequests).set({ runId: retryRunId }).where(eq(agentWakeupRequests.id, wake!.id));
    await db.update(issues).set({ executionRunId: retryRunId, executionAgentNameKey: "writer", executionLockedAt: now })
      .where(eq(issues.id, P.retry));

    // Stalled review: in_review with no open interaction.
    P.review = await insertPrivateTask("O's private review", { status: "in_review" });

    // Checkout lock held by a running run.
    lockRunId = await insertRun(X, { invocationSource: "manual" });
    P.lock = await insertPrivateTask("O's private lock", { executionAgentNameKey: "writer" });
    await relock(P.lock);

    // Runner goal: X's session on P with a goal at revision 3 and one finished action.
    P.goal = await insertPrivateTask("O's private goal");
    const [session] = await db.insert(agentTaskSessions).values({
      companyId, agentId: X, adapterType: "paperclip_runner", taskKey: P.goal, goalRevision: 3,
      goalJson: { objective: "Ship the plan", status: "active" },
    }).returning();
    goalSessionId = session!.id;
    await db.insert(agentSessionGoalActions).values({
      companyId, sessionId: goalSessionId, requestId: "seeded-pause", action: "pause",
      payloadJson: seededGoalRequest(), status: "completed",
    });
    xRunId = await insertRun(X, { contextSnapshot: { issueId: P.goal } });
    yRunId = await insertRun(Y, { contextSnapshot: { issueId: chatId } });
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  type Route = "retry-now" | "stalled-review-decision" | "force-release" | "runner-goal";
  const send = (actor: RequestActor, route: Route, issueId: string, goalRequest: Record<string, unknown> = seededGoalRequest()) => {
    const client = request(appFor(actor));
    switch (route) {
      case "retry-now": return client.post(`/api/issues/${issueId}/scheduled-retry/retry-now`).send({});
      case "stalled-review-decision": return client.post(`/api/issues/${issueId}/stalled-review-decision`).send({ action: "approve" });
      case "force-release": return client.post(`/api/issues/${issueId}/admin/force-release?clearAssignee=true`).send();
      case "runner-goal": return client.post(`/api/issues/${issueId}/runner-goal/actions`).send(goalRequest);
    }
  };
  const targetFor = (route: Route) => ({
    "retry-now": P.retry, "stalled-review-decision": P.review, "force-release": P.lock, "runner-goal": P.goal,
  })[route];

  const state = async (issueId: string) => ({
    issue: await db.select({
      status: issues.status, assigneeAgentId: issues.assigneeAgentId, checkoutRunId: issues.checkoutRunId,
      executionRunId: issues.executionRunId, executionLockedAt: issues.executionLockedAt, updatedAt: issues.updatedAt,
    }).from(issues).where(eq(issues.id, issueId)),
    retry: await db.select({ status: heartbeatRuns.status, scheduledRetryAt: heartbeatRuns.scheduledRetryAt })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, retryRunId)),
    goal: await db.select({ revision: agentTaskSessions.goalRevision, desired: agentTaskSessions.goalDesiredState })
      .from(agentTaskSessions).where(eq(agentTaskSessions.id, goalSessionId)),
    goalActions: await db.select({ requestId: agentSessionGoalActions.requestId, status: agentSessionGoalActions.status })
      .from(agentSessionGoalActions).where(eq(agentSessionGoalActions.sessionId, goalSessionId)),
    wakes: await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
  });
  const activityBy = (actorId: string) => db.select({ action: activityLog.action }).from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.actorId, actorId)));

  const routes: Route[] = ["retry-now", "stalled-review-decision", "force-release", "runner-goal"];
  const denialCases = (["task", "chat"] as const).flatMap(on => routes.map(route => ({ on, route })));

  it.each(denialCases)("AC-G3: U's $route on O's $on answers 404 and changes nothing", async ({ on, route }) => {
    const issueId = on === "chat" ? chatId : targetFor(route);
    const before = await state(issueId);
    const res = await send(user(U), route, issueId, { ...seededGoalRequest(), requestId: `u-${route}`, expectedRevision: 3 });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
    // The task row, retry run, goal session, goal actions and wakes are all in
    // the state, so one comparison covers retry, review, lock and goal.
    expect(await state(issueId)).toEqual(before);
    expect(await activityBy(U)).toEqual([]);
  });

  it("after every U case: no wake for the stalled review and no activity row for U", async () => {
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await activityBy(U)).toEqual([]);
  });

  it("runner-goal agent path: X (assignee, own run) replays its action and gets 202", async () => {
    const res = await send(agent(X, xRunId), "runner-goal", P.goal);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ requestId: "seeded-pause", status: "completed" });
  });

  it("runner-goal agent path: Y (not the assignee, no grant) gets today's answer, not the new 404", async () => {
    // Pinned at development a1e1d2af4: the privacy step covers issue:read
    // only, so assertIssueWriteInfluenceAllowed's issue:mutate decision lets Y
    // through and the goal service refuses Y as not assigned.
    const before = await state(P.goal);
    const res = await send(agent(Y, yRunId), "runner-goal", P.goal, { ...seededGoalRequest(), requestId: "y-pause", agentId: Y });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toEqual({ error: "The selected agent is not assigned to this issue.", code: "agent_not_assigned" });
    expect(await state(P.goal)).toEqual(before);
  });

  it("runner-goal agent path: Y naming X's goal keeps today's own-goal 403", async () => {
    const res = await send(agent(Y, yRunId), "runner-goal", P.goal);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toEqual({ error: "Agent can only control its own assigned session goal" });
  });

  it("O on own P: each route gives today's answer", async () => {
    const retry = await send(user(O), "retry-now", P.retry);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).toMatchObject({ scheduledRetry: { runId: retryRunId } });
    expect(["promoted", "gate_suppressed"]).toContain(retry.body.outcome);

    const review = await send(user(O), "stalled-review-decision", P.review);
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    expect(review.body).toMatchObject({ action: "approve" });

    const released = await send(user(O), "force-release", P.lock);
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body).toMatchObject({ issue: { id: P.lock, checkoutRunId: null, executionRunId: null }, previous: { checkoutRunId: lockRunId } });

    const goal = await send(user(O), "runner-goal", P.goal);
    expect(goal.status, JSON.stringify(goal.body)).toBe(202);
    expect(goal.body).toMatchObject({ requestId: "seeded-pause", status: "completed" });

    const actions = await activityBy(O);
    expect(actions.map(row => row.action)).toEqual(expect.arrayContaining([
      "issue.scheduled_retry_retry_now", "issue.admin_force_release",
    ]));
  });

  it("control: I's session without the instance-admin flag is an ordinary operator and gets 404", async () => {
    await relock(P.lock);
    const before = await state(P.lock);
    const res = await send({ ...instanceAdmin(), isInstanceAdmin: false } as RequestActor, "force-release", P.lock);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
    expect(await state(P.lock)).toEqual(before);
  });

  it.each([
    { who: "L (local board)", actor: localBoard },
    { who: "I (instance admin, not the local board)", actor: instanceAdmin },
  ])("$who force-releases P and gets today's answer", async ({ actor }) => {
    await relock(P.lock);
    const res = await send(actor(), "force-release", P.lock);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ issue: { id: P.lock, checkoutRunId: null, executionRunId: null }, previous: { checkoutRunId: lockRunId } });
    const audits = await db.select({ actorId: activityLog.actorId }).from(activityLog)
      .where(and(eq(activityLog.entityId, P.lock), inArray(activityLog.action, ["issue.admin_force_release"])));
    expect(audits.map(row => row.actorId)).toContain(actor().userId);
  });
});
