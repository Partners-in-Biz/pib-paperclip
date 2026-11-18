import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12956 (access C4k-1, PAR-12608 spec 4.6, AC-G3): the interaction write
 * routes read the task first. A board caller who cannot read the task gets
 * 404 "Issue not found" on accept, reject, respond, verdicts, withdraw, skip
 * and cancel, and nothing is written. resolve-from-comment keeps its 403 for
 * board callers; agents and readers get today's answers.
 */

const support = await getEmbeddedPostgresTestSupport();
// No silent skip: on CI this file must fail, not skip, without embedded Postgres.
if (process.env.CI && !support.supported) throw new Error("embedded Postgres required on CI");

(support.supported ? describe : describe.skip)("interaction routes read the task first", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  // O (owner, has the chat and the private task P), U (operator), X (agent).
  const O = `o-${randomUUID()}`, U = `u-${randomUUID()}`;
  const roles: Record<string, string> = { [O]: "owner", [U]: "operator" };
  const prefix = `G${randomUUID().slice(0, 5).toUpperCase()}`;
  let companyId = "", X = "", chatId = "", taskId = "", taskRunId = "";

  type RequestActor = Express.Request["actor"];
  const user = (userId: string): RequestActor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
    memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: false, restrictionMode: "off" }],
  });
  const localBoard: RequestActor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
  const agentX = (runId: string): RequestActor => ({
    type: "agent", agentId: X, companyId, runId, source: "agent_jwt", onBehalfOfUserId: O,
    onBehalfOfMemberships: [{ companyId, membershipRole: "owner", status: "active", restricted: false, restrictionMode: "off" }],
  });
  const appFor = (actor: RequestActor) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  };

  const confirmation = (issueId: string) => issueThreadInteractionService(db).create(
    { id: issueId, companyId },
    { kind: "request_confirmation", continuationPolicy: "wake_assignee", payload: { version: 1, prompt: "Ship it?" } },
    { agentId: X },
  );
  const questions = (issueId: string) => issueThreadInteractionService(db).create(
    { id: issueId, companyId },
    { kind: "ask_user_questions", continuationPolicy: "wake_assignee", payload: { version: 1, questions: [
      { id: "scope", prompt: "Scope?", required: true, selectionMode: "single", options: [{ id: "all", label: "All" }] },
    ] } },
    { agentId: X },
  );
  const status = (interactionId: string) => db.select({ status: issueThreadInteractions.status })
    .from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId)).then(rows => rows[0]!.status);
  /** Everything a denied call must not write: activity rows and wakes. */
  const writes = async () => ({
    activity: (await db.select({ id: activityLog.id }).from(activityLog).where(and(
      inArray(activityLog.entityId, [chatId, taskId]), like(activityLog.action, "issue.thread_interaction_%"),
    ))).length,
    wakes: (await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId))).length,
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-interaction-read-guard-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({ name: "Interaction guard", issuePrefix: prefix, requireBoardApprovalForNewAgents: false }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values(Object.keys(roles).map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole, grantedByUserId: null });
    }
    const [x] = await db.insert(agents).values({ companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "process",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }).returning();
    X = x!.id;
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: X, status: "active", membershipRole: "member" });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    // O's chat with X, through the real chat route, so it is private.
    const chat = await request(appFor(user(O))).post(`/api/companies/${companyId}/chats/${X}`).send({});
    expect(chat.status, JSON.stringify(chat.body)).toBe(200);
    chatId = chat.body.id;
    const task = await issueService(db).create(companyId, {
      title: "Private plan", visibility: "private", status: "in_progress", assigneeAgentId: X,
      createdByUserId: O, responsibleUserId: O,
    });
    taskId = task.id;
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: X, status: "running", responsibleUserId: O,
      contextSnapshot: { issueId: taskId, taskId, taskKey: taskId } }).returning();
    taskRunId = run!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  it("the fixtures hold: U cannot read O's chat or P, O can", async () => {
    for (const id of [chatId, taskId]) {
      expect((await request(appFor(user(U))).get(`/api/issues/${id}`)).status).toBe(404);
      expect((await request(appFor(user(O))).get(`/api/issues/${id}`)).status).toBe(200);
    }
  });

  it("U gets 404 Issue not found on accept, reject, withdraw, skip, cancel and respond on O's chat and P, and nothing is written", async () => {
    const app = appFor(user(U));
    const before = await writes();
    for (const issueId of [chatId, taskId]) {
      const confirm = await confirmation(issueId);
      const ask = await questions(issueId);
      const calls: [string, string, object][] = [
        ["accept", confirm.id, {}],
        ["reject", confirm.id, { reason: "No" }],
        ["withdraw", confirm.id, {}],
        ["skip", ask.id, {}],
        ["cancel", ask.id, {}],
        ["respond", ask.id, { answers: [{ questionId: "scope", optionIds: ["all"] }] }],
      ];
      for (const [verb, interactionId, body] of calls) {
        const res = await request(app).post(`/api/issues/${issueId}/interactions/${interactionId}/${verb}`).send(body);
        expect(res.status, `${verb} on ${issueId === chatId ? "chat" : "P"}: ${JSON.stringify(res.body)}`).toBe(404);
        expect(res.body).toEqual({ error: "Issue not found" });
      }
      expect(await status(confirm.id)).toBe("pending");
      expect(await status(ask.id)).toBe("pending");
    }
    expect(await writes()).toEqual(before);
  });

  it("U gets 404 Issue not found on verdicts on P, and nothing is written", async () => {
    const confirm = await confirmation(taskId);
    const before = await writes();
    const res = await request(appFor(user(U))).post(`/api/issues/${taskId}/interactions/${confirm.id}/verdicts`)
      .send({ verdicts: [{ id: "item-1", verdict: "approve" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
    expect(await status(confirm.id)).toBe("pending");
    expect(await writes()).toEqual(before);
  });

  it("U (board) on P keeps today's 403 on resolve-from-comment, and nothing is written", async () => {
    const confirm = await confirmation(taskId);
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: taskId, authorUserId: O, body: "Yes" }).returning();
    const before = await writes();
    const res = await request(appFor(user(U))).post(`/api/issues/${taskId}/interactions/${confirm.id}/resolve-from-comment`)
      .send({ commentId: comment!.id, decision: "accept" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Conversational resolution requires the responding agent run");
    expect(await status(confirm.id)).toBe("pending");
    expect(await writes()).toEqual(before);
  });

  it("O accepts and skips on his own chat and on P as today", async () => {
    const app = appFor(user(O));
    for (const issueId of [chatId, taskId]) {
      const confirm = await confirmation(issueId);
      const accepted = await request(app).post(`/api/issues/${issueId}/interactions/${confirm.id}/accept`).send({});
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(await status(confirm.id)).toBe("accepted");
      const ask = await questions(issueId);
      const skipped = await request(app).post(`/api/issues/${issueId}/interactions/${ask.id}/skip`).send({});
      expect(skipped.status, JSON.stringify(skipped.body)).toBe(200);
    }
  });

  it("the local board accepts on P as today", async () => {
    const confirm = await confirmation(taskId);
    const res = await request(appFor(localBoard)).post(`/api/issues/${taskId}/interactions/${confirm.id}/accept`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await status(confirm.id)).toBe("accepted");
  });

  it("agent X on P (assignee, own run) gets today's answer on accept: the agent path is unchanged", async () => {
    const confirm = await confirmation(taskId);
    const res = await request(appFor(agentX(taskRunId))).post(`/api/issues/${taskId}/interactions/${confirm.id}/accept`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await status(confirm.id)).toBe("accepted");
  });
});
