import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueAccessGrants,
  issueDocuments,
  issuePlanDecompositions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12965 (access C4k-4a, PAR-12608 4.3, 4.6 and AC-G3). GET
 * `/issues/:id/accepted-plan-decompositions` and POST
 * `/issues/:id/monitor/check-now` read the task first: a caller denied
 * `issue:read` gets 404 "Issue not found" and nothing is returned or written.
 * On a readable source, a child the caller cannot read is a locked stub.
 * check-now checks read before manage.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
if (process.env.CI && !embeddedPostgresSupport.supported) throw new Error("embedded Postgres required on CI");

(embeddedPostgresSupport.supported ? describe : describe.skip)("decompositions GET and check-now read the task first", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  // O (owner), U (member); X (assignee of P), Y (no grant), Z (grant on P, not the assignee).
  const O = `o-${randomUUID()}`, U = `u-${randomUUID()}`;
  const roles: Record<string, string> = { [O]: "owner", [U]: "member" };
  const prefix = `D${randomUUID().slice(0, 5).toUpperCase()}`;
  const K2_TITLE = "Private child about the acquisition";
  let companyId = "", X = "", Y = "", Z = "", runX = "", runXForU = "";
  let P = "", S = "", K1 = "", K2 = "", chatId = "";
  const nextCheckAt = new Date("2099-01-01T12:00:00.000Z");

  type RequestActor = Express.Request["actor"];
  const user = (userId: string): RequestActor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
    memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: false, restrictionMode: "off" }],
  });
  const localBoard = (): RequestActor => ({
    type: "board", userId: "local-board", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: false,
  });
  const agent = (agentId: string, runId?: string, onBehalfOfUserId?: string): RequestActor => ({
    type: "agent", agentId, companyId, runId, source: onBehalfOfUserId ? "agent_jwt" : "agent_key", onBehalfOfUserId,
    ...(onBehalfOfUserId ? { onBehalfOfMemberships: [{ companyId, membershipRole: roles[onBehalfOfUserId], status: "active", restricted: false, restrictionMode: "off" }] } : {}),
  });
  const appFor = (actor: RequestActor) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  };

  const monitorPolicy = () => ({
    executionPolicy: {
      mode: "normal", commentRequired: true, stages: [],
      monitor: { nextCheckAt: nextCheckAt.toISOString(), notes: "Check deploy", scheduledBy: "assignee" },
    },
    executionState: {
      status: "idle", currentStageId: null, currentStageIndex: null, currentStageType: null,
      currentParticipant: null, returnAssignee: null, completedStageIds: [], lastDecisionId: null,
      lastDecisionOutcome: null,
      monitor: {
        status: "scheduled", nextCheckAt: nextCheckAt.toISOString(), lastTriggeredAt: null, attemptCount: 0,
        notes: "Check deploy", scheduledBy: "assignee", serviceName: null, externalRef: null,
        timeoutAt: null, maxAttempts: null, recoveryPolicy: null, clearedAt: null, clearReason: null,
      },
    },
    monitorNextCheckAt: nextCheckAt, monitorAttemptCount: 0, monitorNotes: "Check deploy", monitorScheduledBy: "assignee",
  });

  async function seedDecomposition(sourceIssueId: string, childIssueIds: string[]) {
    const documentId = randomUUID(), revisionId = randomUUID(), interactionId = randomUUID();
    await db.insert(documents).values({
      id: documentId, companyId, title: "Plan", format: "markdown", latestBody: "Plan body",
      latestRevisionId: revisionId, latestRevisionNumber: 1, createdByUserId: O, updatedByUserId: O,
    });
    await db.insert(documentRevisions).values({
      id: revisionId, companyId, documentId, revisionNumber: 1, title: "Plan", format: "markdown", body: "Plan body", createdByUserId: O,
    });
    await db.insert(issueDocuments).values({ companyId, issueId: sourceIssueId, documentId, key: "plan" });
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId, issueId: sourceIssueId, kind: "request_confirmation", status: "accepted",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1, prompt: "Approve this plan?",
        target: { type: "issue_document", issueId: sourceIssueId, documentId, key: "plan", revisionId, revisionNumber: 1 },
      },
      result: { version: 1, outcome: "accepted" },
    });
    await db.insert(issuePlanDecompositions).values({
      companyId, sourceIssueId, acceptedPlanRevisionId: revisionId, acceptedInteractionId: interactionId,
      status: "completed", requestFingerprint: `fp:${sourceIssueId}`, requestedChildCount: childIssueIds.length,
      requestedChildren: childIssueIds.map((_, n) => ({ title: `child-${n}` })), childIssueIds,
      ownerUserId: O, completedAt: new Date(),
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decompositions-check-now-read-guard-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    const [company] = await db.insert(companies).values({ name: "Read guard", issuePrefix: prefix, requireBoardApprovalForNewAgents: false }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values(Object.keys(roles).map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole: membershipRole as "owner", grantedByUserId: null });
    }
    const noWake = { heartbeat: { enabled: false, wakeOnDemand: false } };
    const [x, y, z] = await db.insert(agents).values(["Writer", "Editor", "Reviewer"].map(name =>
      ({ companyId, name, role: "engineer", status: "idle", adapterType: "process", runtimeConfig: noWake }))).returning();
    X = x!.id; Y = y!.id; Z = z!.id;
    await db.insert(companyMemberships).values([X, Y, Z].map(principalId =>
      ({ companyId, principalType: "agent", principalId, status: "active", membershipRole: "member" })));

    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    [P, S, K1, K2] = ids;
    await db.insert(issues).values([
      { id: P, companyId, title: "O's private plan", status: "in_progress", issueNumber: 1, identifier: `${prefix}-1`,
        visibility: "private", privacyRootIssueId: P, assigneeAgentId: X, createdByUserId: O, responsibleUserId: O, ...monitorPolicy() },
      { id: S, companyId, title: "Open source task", status: "in_progress", issueNumber: 2, identifier: `${prefix}-2`,
        visibility: "open", createdByUserId: O, responsibleUserId: O },
      { id: K1, companyId, title: "Open child", status: "todo", issueNumber: 3, identifier: `${prefix}-3`,
        parentId: S, visibility: "open", createdByUserId: O, responsibleUserId: O },
      { id: K2, companyId, title: K2_TITLE, status: "todo", priority: "high", issueNumber: 4, identifier: `${prefix}-4`,
        parentId: S, visibility: "private", privacyRootIssueId: K2, assigneeAgentId: X, createdByUserId: O, responsibleUserId: O },
    ]);
    await db.insert(issueAccessGrants).values({ issueId: P, subjectType: "agent", subjectId: Z, source: "explicit" });
    await seedDecomposition(S, [K1, K2]);
    await seedDecomposition(P, [K1]);

    runX = randomUUID(); runXForU = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: runX, companyId, agentId: X, status: "running", contextSnapshot: { issueId: P } },
      { id: runXForU, companyId, agentId: X, status: "running", responsibleUserId: U, contextSnapshot: {} },
    ]);

    // O opens the chat with X through the real chat route.
    const chat = await request(appFor(user(O))).post(`/api/companies/${companyId}/chats/${X}`).send({});
    expect(chat.status, JSON.stringify(chat.body)).toBe(200);
    chatId = chat.body.id;
    await db.update(issues).set(monitorPolicy()).where(eq(issues.id, chatId));
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const writes = async () => ({
    wakeups: (await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).length,
    runs: (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).length,
    activity: (await db.select({ id: activityLog.id }).from(activityLog)).length,
  });
  const monitorOf = async (id: string) => {
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    return { executionState: row!.executionState, monitorNextCheckAt: row!.monitorNextCheckAt, monitorAttemptCount: row!.monitorAttemptCount };
  };

  /** Both routes answer 404 "Issue not found"; no decomposition data, no monitor change, no wake or activity row. */
  async function expectDenied(actor: RequestActor, issueId: string) {
    const app = appFor(actor);
    const before = await writes();
    const monitorBefore = await monitorOf(issueId);
    const list = await request(app).get(`/api/issues/${issueId}/accepted-plan-decompositions`);
    expect(list.status, JSON.stringify(list.body)).toBe(404);
    expect(list.body).toEqual({ error: "Issue not found" });
    const check = await request(app).post(`/api/issues/${issueId}/monitor/check-now`).send({});
    expect(check.status, JSON.stringify(check.body)).toBe(404);
    expect(check.body).toEqual({ error: "Issue not found" });
    expect(await monitorOf(issueId)).toEqual(monitorBefore);
    expect(await writes()).toEqual(before);
  }

  it("U on O's private task P: 404 on both routes and nothing is written", async () => {
    await expectDenied(user(U), P);
  });

  it("U on O's chat: 404 on both routes and nothing is written", async () => {
    await expectDenied(user(U), chatId);
  });

  it("Y (no grant) on P: 404 on both routes and nothing is written", async () => {
    await expectDenied(agent(Y), P);
  });

  it("X working for U (O not in the run) on O's chat: 404 on both routes and nothing is written", async () => {
    await expectDenied(agent(X, runXForU, U), chatId);
  });

  it("U on the open source S: K1 in full, the private K2 as a locked stub, childIssueIds lists both", async () => {
    const list = await request(appFor(user(U))).get(`/api/issues/${S}/accepted-plan-decompositions`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body).toHaveLength(1);
    const [decomposition] = list.body;
    expect(decomposition.childIssueIds).toEqual([K1, K2]);
    expect(decomposition.childIssues).toEqual([
      { id: K1, identifier: `${prefix}-3`, title: "Open child", status: "todo", priority: "medium", assigneeAgentId: null, assigneeUserId: null },
      { id: K2, identifier: `${prefix}-4`, locked: true },
    ]);
    expect(JSON.stringify(list.body)).not.toContain(K2_TITLE);
  });

  it("O on S: both children in full", async () => {
    const list = await request(appFor(user(O))).get(`/api/issues/${S}/accepted-plan-decompositions`);
    expect(list.status).toBe(200);
    expect(list.body[0].childIssues).toEqual([
      expect.objectContaining({ id: K1, title: "Open child" }),
      expect.objectContaining({ id: K2, title: K2_TITLE, status: "todo", priority: "high", assigneeAgentId: X }),
    ]);
  });

  it("O, the local board and X (assignee, own run) read P's decompositions", async () => {
    for (const actor of [user(O), localBoard(), agent(X, runX)]) {
      const list = await request(appFor(actor)).get(`/api/issues/${P}/accepted-plan-decompositions`);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ sourceIssueId: P, childIssueIds: [K1] });
    }
  });

  it("Z reads P but is not its assignee: check-now keeps today's 403 from the monitor manage check", async () => {
    const before = await writes();
    const list = await request(appFor(agent(Z))).get(`/api/issues/${P}/accepted-plan-decompositions`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const check = await request(appFor(agent(Z))).post(`/api/issues/${P}/monitor/check-now`).send({});
    expect(check.status, JSON.stringify(check.body)).toBe(403);
    expect(await writes()).toEqual(before);
  });

  // Today's answer: both checks pass and the check runs. X has wake-on-demand
  // off, so the dispatch is deferred (409) instead of starting a run.
  it("O and X on P: check-now passes the read and manage checks and runs the check", async () => {
    for (const actor of [agent(X, runX), user(O)]) {
      await db.update(issues).set(monitorPolicy()).where(eq(issues.id, P));
      const check = await request(appFor(actor)).post(`/api/issues/${P}/monitor/check-now`).send({});
      expect(check.status, JSON.stringify(check.body)).toBe(409);
      expect(check.body).toMatchObject({ code: "issue_monitor_check_deferred", details: { reason: "monitor_dispatch_deferred" } });
    }
  });
});
