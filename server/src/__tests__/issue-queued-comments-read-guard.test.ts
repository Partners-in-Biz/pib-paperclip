import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, like } from "drizzle-orm";
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
  issues,
  runIdentityContexts,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12957 (access C4k-2, AC-G3): the five queued-comment writes (edit,
 * reorder, interrupt, steer, board delete) read the task first. A caller who
 * may not read the task gets 404 "Issue not found" and the queue stays as it
 * was; a caller who may read it gets today's answer.
 *
 * O (owner, a board session that is not the local board) has a private chat
 * with X, opened through the real chat route, and a private task P. U is a
 * member of the same company. L is the local board.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
if (process.env.CI && !embeddedPostgresSupport.supported) throw new Error("embedded Postgres required on CI");

(embeddedPostgresSupport.supported ? describe : describe.skip)("queued-comment writes read the task first", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  const O = `o-${randomUUID()}`, U = `u-${randomUUID()}`;
  const roles: Record<string, string> = { [O]: "owner", [U]: "operator" };
  const prefix = `G${randomUUID().slice(0, 5).toUpperCase()}`;
  let companyId = "", X = "";
  type Queue = { issueId: string; runId: string; wakeId: string; commentIds: string[] };
  const chat: Queue = { issueId: "", runId: "", wakeId: "", commentIds: [] };
  const task: Queue = { issueId: "", runId: "", wakeId: "", commentIds: [] };

  type RequestActor = Express.Request["actor"];
  const user = (userId: string): RequestActor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
    memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: false, restrictionMode: "off" }],
  });
  const localBoard = (): RequestActor => ({
    type: "board", userId: "local-board", userName: "Local Board", userEmail: null,
    isInstanceAdmin: true, source: "local_implicit",
  });
  const appFor = (actor: RequestActor) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  };

  async function seedQueue(target: Queue, issueId: string, runStatus: "running" | "succeeded") {
    target.issueId = issueId;
    target.runId = randomUUID();
    target.wakeId = randomUUID();
    target.commentIds = [randomUUID(), randomUUID()];
    await db.insert(heartbeatRuns).values({
      id: target.runId, companyId, agentId: X, invocationSource: "assignment", triggerDetail: "read guard test",
      status: runStatus, runtimeMode: "legacy", startedAt: new Date("2026-08-22T15:00:00.000Z"),
      ...(runStatus === "succeeded" ? { finishedAt: new Date("2026-08-22T15:03:00.000Z") } : {}),
      contextSnapshot: { issueId },
    });
    await db.update(issues).set({ executionRunId: runStatus === "running" ? target.runId : null })
      .where(eq(issues.id, issueId));
    await db.insert(issueComments).values(target.commentIds.map((id, index) => ({
      id, companyId, issueId, authorType: "user" as const, authorUserId: O,
      body: index === 0 ? "First queued message" : "Second queued message",
      createdAt: new Date(`2026-08-22T15:0${index + 1}:00.000Z`),
      updatedAt: new Date(`2026-08-22T15:0${index + 1}:00.000Z`),
    })));
    await db.insert(agentWakeupRequests).values({
      id: target.wakeId, companyId, agentId: X, source: "issue_comment",
      reason: "Follow-up comments arrived during the active run", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: O,
      payload: {
        issueId, commentId: target.commentIds[1],
        _paperclipWakeContext: { commentId: target.commentIds[1], wakeCommentId: target.commentIds[1], wakeCommentIds: target.commentIds },
      },
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-queued-comment-read-guard-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({ name: "Queue read guard", issuePrefix: prefix, requireBoardApprovalForNewAgents: false }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values(Object.keys(roles).map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole: membershipRole as "owner", grantedByUserId: null });
    }
    // One run at a time: the chat's running run holds the successor of P's
    // interrupt in the queue, so no provider ever starts.
    const [x] = await db.insert(agents).values({
      companyId, name: "Writer", role: "engineer", status: "idle", adapterType: "claude_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {},
    }).returning();
    X = x!.id;
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: X, status: "active", membershipRole: "member" });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });

    const opened = await request(appFor(user(O))).post(`/api/companies/${companyId}/chats/${X}`).send({});
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body).toMatchObject({ visibility: "private", conversationUserId: O, conversationAgentId: X });
    const plan = await issueService(db).create(companyId, {
      title: "O's private plan", visibility: "private", status: "in_progress",
      createdByUserId: O, responsibleUserId: O, assigneeAgentId: X,
    });
    expect(plan).toMatchObject({ visibility: "private", conversationAgentId: null });
    await seedQueue(chat, opened.body.id as string, "running");
    await seedQueue(task, plan.id, "succeeded");
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const readQueue = async (target: Queue, actor = user(O)) => {
    const res = await request(appFor(actor)).get(`/api/issues/${target.issueId}/queued-comments`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { queueId: string; revision: string; entries: { comment: { id: string; body: string } }[] };
  };
  const queueState = async (target: Queue) => {
    const queue = await readQueue(target);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, target.wakeId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, target.runId));
    return {
      queueId: queue.queueId,
      revision: queue.revision,
      entries: queue.entries.map(entry => ({ id: entry.comment.id, body: entry.comment.body })),
      wake: { status: wake!.status, payload: wake!.payload },
      runStatus: run!.status,
      comments: await db.select({ id: issueComments.id, body: issueComments.body }).from(issueComments)
        .where(eq(issueComments.issueId, target.issueId)).orderBy(issueComments.createdAt),
      queueActivity: await db.select({ id: activityLog.id }).from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), like(activityLog.action, "issue.queued_comment%"))),
      identities: await db.select({ id: runIdentityContexts.id }).from(runIdentityContexts)
        .where(eq(runIdentityContexts.companyId, companyId)),
    };
  };

  type Mutation = "edit" | "reorder" | "interrupt" | "steer" | "delete";
  const send = (actor: RequestActor, mutation: Mutation, target: Queue, queue: { queueId: string; revision: string }) => {
    const client = request(appFor(actor));
    const base = `/api/issues/${target.issueId}/queued-comments`;
    const [first, second] = target.commentIds;
    const body = { queueId: queue.queueId, revision: queue.revision };
    switch (mutation) {
      case "edit": return client.patch(`${base}/${first}`).send({ ...body, body: "Rewritten by someone else" });
      case "reorder": return client.put(`${base}/order`).send({ ...body, orderedCommentIds: [second, first] });
      case "interrupt": return client.post(`${base}/interrupt`).send({ ...body, targetRunId: target.runId });
      case "steer": return client.post(`${base}/${first}/steer`).send({ ...body, targetRunId: target.runId });
      case "delete": return client.delete(`${base}/${first}`).send(body);
    }
  };

  const mutations: Mutation[] = ["edit", "reorder", "interrupt", "steer", "delete"];
  const denialCases = (["chat", "task"] as const).flatMap(on => mutations.map(mutation => ({ on, mutation })));

  it("O reads both queues: two entries each, under the seeded wake", async () => {
    for (const target of [chat, task]) {
      const queue = await readQueue(target);
      expect(queue.queueId).toBe(target.wakeId);
      expect(queue.entries.map(entry => entry.comment.id)).toEqual(target.commentIds);
    }
  });

  it.each(denialCases)("AC-G3: U's $mutation on O's $on answers 404 and changes nothing", async ({ on, mutation }) => {
    const target = on === "chat" ? chat : task;
    const before = await queueState(target);
    const res = await send(user(U), mutation, target, before);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
    // Entries, order, bodies, revision, wake, run, activity rows and steering
    // identities are all part of the state, so one comparison covers them.
    expect(await queueState(target)).toEqual(before);
  });

  it("after every U case: no queued-comment activity, no interrupt intent, no steering identity", async () => {
    for (const target of [chat, task]) {
      const state = await queueState(target);
      expect(state.queueActivity).toEqual([]);
      expect(state.identities).toEqual([]);
      expect((state.wake.payload as Record<string, unknown>).queuedCommentInterrupt).toBeUndefined();
      expect(state.entries.map(entry => entry.id)).toEqual(target.commentIds);
    }
  });

  it("L (local board) reorders P and gets today's answer", async () => {
    const queue = await readQueue(task, localBoard());
    const res = await send(localBoard(), "reorder", task, queue);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.entries.map((entry: { comment: { id: string } }) => entry.comment.id))
      .toEqual([...task.commentIds].reverse());
  });

  it("O edits, reorders, discards and interrupts on own P and gets today's answers", async () => {
    const [first, second] = task.commentIds;
    let queue = await readQueue(task);
    const edited = await send(user(O), "edit", task, queue);
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.entries.find((entry: { comment: { id: string } }) => entry.comment.id === first).comment.body)
      .toBe("Rewritten by someone else");
    queue = edited.body;
    const reordered = await send(user(O), "reorder", task, queue);
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    expect(reordered.body.entries.map((entry: { comment: { id: string } }) => entry.comment.id)).toEqual([second, first]);
    queue = reordered.body;
    const discarded = await send(user(O), "delete", task, queue);
    expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
    expect(discarded.body.entries.map((entry: { comment: { id: string } }) => entry.comment.id)).toEqual([second]);
    queue = discarded.body;
    const interrupted = await request(appFor(user(O))).post(`/api/issues/${task.issueId}/queued-comments/interrupt`)
      .send({ queueId: queue.queueId, revision: queue.revision, targetRunId: null });
    expect(interrupted.status, JSON.stringify(interrupted.body)).toBe(200);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, task.wakeId));
    expect(wake!.status).toBe("coalesced");
    const actions = await db.select({ action: activityLog.action }).from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), like(activityLog.action, "issue.queued_comment%")));
    expect(actions.map(row => row.action).sort()).toEqual([
      "issue.queued_comment_discarded", "issue.queued_comment_edited",
      "issue.queued_comments_interrupted", "issue.queued_comments_reordered", "issue.queued_comments_reordered",
    ]);
  });
});
