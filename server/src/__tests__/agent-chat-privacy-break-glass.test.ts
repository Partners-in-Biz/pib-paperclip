import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueReadStates,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12842 (chat privacy CP-3c): audited break-glass on a chat's message
 * list (PAR-12774 plan 4.6, AC-P7) and no chat title in a monitor recovery
 * task (plan 4.5, breakdown F9).
 */

const support = await getEmbeddedPostgresTestSupport();

describe("agent chat break-glass database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("agent chat break-glass and monitor recovery", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  // A (operator, has the chat), B (operator), O (owner).
  const A = `a-${randomUUID()}`, B = `b-${randomUUID()}`, O = `o-${randomUUID()}`;
  const roles: Record<string, string> = { [A]: "operator", [B]: "operator", [O]: "owner" };
  const prefix = `G${randomUUID().slice(0, 5).toUpperCase()}`;
  const chatTitle = "Chat with Writer about the secret merger";
  const chatText = "Please keep the merger numbers to yourself";
  const readAt = new Date("2026-11-01T10:00:00.000Z");
  let companyId = "";
  let X = "";
  let chatId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-chat-break-glass-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({ name: "Chat break-glass", issuePrefix: prefix, requireBoardApprovalForNewAgents: false }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values(Object.keys(roles).map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole: membershipRole as "owner", grantedByUserId: null });
    }
    const [x] = await db.insert(agents).values({
      companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "process",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    }).returning();
    X = x!.id;
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: X, status: "active", membershipRole: "member" });
    const [chat] = await db.insert(issues).values({
      companyId, title: chatTitle, status: "in_progress", issueNumber: 1, identifier: `${prefix}-1`,
      conversationAgentId: X, conversationUserId: A, conversationState: "waiting", assigneeAgentId: X,
      createdByUserId: A, responsibleUserId: A,
    }).returning();
    chatId = chat!.id;
    await db.insert(issueComments).values({ companyId, issueId: chatId, authorUserId: A, body: chatText });
    await db.insert(issueReadStates).values({ companyId, issueId: chatId, userId: A, lastReadAt: readAt });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  type RequestActor = Express.Request["actor"];
  const user = (userId: string): RequestActor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
    memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: false, restrictionMode: "off" }],
  });
  const appFor = (actor: RequestActor) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  };
  const notices = () => db.select().from(issueComments)
    .where(and(eq(issueComments.issueId, chatId), eq(issueComments.authorType, "system")));
  const breakGlassAudits = () => db.select().from(activityLog)
    .where(and(eq(activityLog.entityId, chatId), eq(activityLog.action, "issue.break_glass_read")));
  const queuedWork = async () => ({
    wakeups: (await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).length,
    runs: (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).length,
  });
  const chatState = async () => ({
    conversationState: (await db.select().from(issues).where(eq(issues.id, chatId)))[0]!.conversationState,
    readStates: await db.select({ userId: issueReadStates.userId, lastReadAt: issueReadStates.lastReadAt })
      .from(issueReadStates).where(eq(issueReadStates.issueId, chatId)),
  });

  it("AC-P7: without the parameter O gets not found for the chat and its messages", async () => {
    const app = appFor(user(O));
    expect((await request(app).get(`/api/issues/${chatId}`)).status).toBe(404);
    expect((await request(app).get(`/api/issues/${chatId}/comments`)).status).toBe(404);
    expect(await notices()).toHaveLength(0);
    expect(await breakGlassAudits()).toHaveLength(0);
  });

  it("AC-P7: B's break-glass call on the chat and its messages is not found and leaves no trace", async () => {
    const app = appFor(user(B));
    expect((await request(app).get(`/api/issues/${chatId}?breakGlass=true`)).status).toBe(404);
    expect((await request(app).get(`/api/issues/${chatId}/comments?breakGlass=true`)).status).toBe(404);
    expect(await notices()).toHaveLength(0);
    expect(await breakGlassAudits()).toHaveLength(0);
  });

  it("AC-P7: break-glass only applies to the routes that opt in", async () => {
    const app = appFor(user(O));
    expect((await request(app).get(`/api/issues/${chatId}/documents?breakGlass=true`)).status).toBe(404);
    expect(await notices()).toHaveLength(0);
  });

  it("AC-P7: O reads the chat and its messages with breakGlass=true, audited, with a notice, no run and no state change", async () => {
    const app = appFor(user(O));
    const workBefore = await queuedWork();
    const stateBefore = await chatState();

    const read = await request(app).get(`/api/issues/${chatId}?breakGlass=true`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ id: chatId, title: chatTitle });

    const thread = await request(app).get(`/api/issues/${chatId}/comments?breakGlass=true`);
    expect(thread.status, JSON.stringify(thread.body)).toBe(200);
    const bodies = (Array.isArray(thread.body) ? thread.body : thread.body.comments).map((c: { body: string }) => c.body);
    expect(bodies).toContain(chatText);

    // One notice and one audit entry per break-glass read.
    const posted = await notices();
    expect(posted).toHaveLength(2);
    for (const notice of posted) {
      expect(notice.body).toContain("audited break-glass access");
      expect(notice.authorUserId).toBeNull();
    }
    const audits = await breakGlassAudits();
    expect(audits).toHaveLength(2);
    for (const audit of audits) expect(audit).toMatchObject({ actorType: "user", actorId: O, companyId });

    expect(await queuedWork()).toEqual(workBefore);
    expect(await chatState()).toEqual(stateBefore);
    expect(stateBefore).toMatchObject({ conversationState: "waiting", readStates: [{ userId: A, lastReadAt: readAt }] });
  });

  it("AC-P7: A reads her own chat messages without a break-glass notice", async () => {
    const before = (await notices()).length;
    const thread = await request(appFor(user(A))).get(`/api/issues/${chatId}/comments?breakGlass=true`);
    expect(thread.status).toBe(200);
    expect(await notices()).toHaveLength(before);
  });

  it("F9: a monitor recovery for a chat names the chat by its identifier only", async () => {
    const nextCheckAt = new Date("2026-04-11T12:30:00.000Z");
    const monitor = {
      nextCheckAt: nextCheckAt.toISOString(), notes: "Check deploy", scheduledBy: "assignee",
      timeoutAt: "2026-04-11T12:00:00.000Z", recoveryPolicy: "create_recovery_issue",
    };
    await db.update(issues).set({
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor },
      executionState: {
        status: "idle", currentStageId: null, currentStageIndex: null, currentStageType: null,
        currentParticipant: null, returnAssignee: null, completedStageIds: [], lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled", nextCheckAt: monitor.nextCheckAt, lastTriggeredAt: null, attemptCount: 0,
          notes: "Check deploy", scheduledBy: "assignee", serviceName: null, externalRef: null,
          timeoutAt: monitor.timeoutAt, maxAttempts: null, recoveryPolicy: "create_recovery_issue",
          clearedAt: null, clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt, monitorAttemptCount: 0, monitorNotes: "Check deploy", monitorScheduledBy: "assignee",
    }).where(eq(issues.id, chatId));

    await heartbeatService(db).tickIssueMonitors(new Date("2026-04-11T12:31:00.000Z"));

    const recovery = await db.select().from(issues)
      .where(and(eq(issues.originId, chatId), eq(issues.originKind, "stranded_issue_recovery")))
      .then(rows => rows[0] ?? null);
    expect(recovery).not.toBeNull();
    // An open task, not a subtask of the chat (a chat takes no subtasks).
    expect(recovery).toMatchObject({ parentId: null, visibility: "open", assigneeAgentId: X, priority: "high" });
    expect(recovery!.title).toBe(`Recover external-service monitor for ${prefix}-1`);
    for (const text of [recovery!.title, recovery!.description ?? ""]) {
      expect(text).not.toContain(chatTitle);
      expect(text).not.toContain("merger");
      expect(text).not.toContain(chatText);
    }
    expect(recovery!.description).toContain(`${prefix}-1`);
  });
});
