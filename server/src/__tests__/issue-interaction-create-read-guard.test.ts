import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, count, eq, inArray, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  authUsers,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12985 (access C4k-5, PAR-12608 spec 4.6, AC-G3): interaction create and
 * resolve-from-comment read the task first for board callers. A board caller
 * who cannot read the task gets 404 "Issue not found" and nothing is written
 * (no interaction, no activity, no wake, no chat publication). Readers get
 * today's answers, including the 403 on resolve-from-comment. The agent path
 * is unchanged.
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

const support = await getEmbeddedPostgresTestSupport();
// No silent skip: on CI this file must fail, not skip, without embedded Postgres.
if (process.env.CI && !support.supported) throw new Error("embedded Postgres required on CI");

(support.supported ? describe : describe.skip)("interaction create and resolve-from-comment read the task first", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  // O owner (chat with X, private task P), U operator, A instance admin (no
  // membership), R restricted member at restrictionMode "off".
  const O = `o-${randomUUID()}`, U = `u-${randomUUID()}`, A = `a-${randomUUID()}`, R = `r-${randomUUID()}`;
  const roles: Record<string, string> = { [O]: "owner", [U]: "operator", [R]: "operator" };
  const prefix = `K${randomUUID().slice(0, 5).toUpperCase()}`;
  let companyId = "", X = "", Y = "", Z = "", chatId = "", taskId = "", openTaskId = "";

  type RequestActor = Express.Request["actor"];
  const user = (userId: string): RequestActor => ({
    type: "board", userId, source: "session", companyIds: [companyId], isInstanceAdmin: false,
    memberships: [{ companyId, membershipRole: roles[userId], status: "active", restricted: userId === R, restrictionMode: "off" }],
  });
  const instanceAdmin = (): RequestActor => ({ type: "board", userId: A, source: "session", companyIds: [companyId], isInstanceAdmin: true, memberships: [] });
  const boardKey = (userId: string): RequestActor => ({ ...user(userId), source: "board_key" });
  const localBoard: RequestActor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
  const agent = (agentId: string, runId: string, onBehalfOfUserId: string): RequestActor => ({
    type: "agent", agentId, companyId, runId, source: "agent_jwt", onBehalfOfUserId,
    onBehalfOfMemberships: [{ companyId, membershipRole: roles[onBehalfOfUserId], status: "active", restricted: false, restrictionMode: "off" }],
  });
  const appFor = (actor: RequestActor) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  };

  const card = (addresseeAgentId?: string) => ({
    kind: "request_confirmation", continuationPolicy: "none",
    payload: { version: 1, prompt: "Ship it?" },
    ...(addresseeAgentId ? { addresseeAgentId } : {}),
  });
  const createCard = (actor: RequestActor, issueId: string, addresseeAgentId?: string) =>
    request(appFor(actor)).post(`/api/issues/${issueId}/interactions`).send(card(addresseeAgentId));
  const status = (interactionId: string) => db.select({ status: issueThreadInteractions.status })
    .from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId)).then(rows => rows[0]!.status);
  /** Y's interaction wakes: the same filter for the denial zero and the positive control. */
  const yPendingWakes = () => db.select({ key: agentWakeupRequests.idempotencyKey, reason: agentWakeupRequests.reason })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, Y), like(agentWakeupRequests.idempotencyKey, "interaction-pending:%")));
  const total = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
  /** Everything a denied create must not write. */
  const writes = async () => ({
    interactions: await total(db.select({ n: count() }).from(issueThreadInteractions)
      .where(inArray(issueThreadInteractions.issueId, [chatId, taskId]))),
    activity: await total(db.select({ n: count() }).from(activityLog).where(and(
      inArray(activityLog.entityId, [chatId, taskId]), eq(activityLog.action, "issue.thread_interaction_created"),
    ))),
    wakes: (await yPendingWakes()).length,
    chatPublications: await total(db.select({ n: count() }).from(chatPublications)),
    chatComments: await total(db.select({ n: count() }).from(issueComments).where(eq(issueComments.issueId, chatId))),
  });
  const flush = () => new Promise(resolve => setTimeout(resolve, 300));
  const waitForWake = async (interactionId: string) => {
    for (let i = 0; i < 20; i += 1) {
      const row = (await yPendingWakes()).find(w => w.key === `interaction-pending:${interactionId}`);
      if (row) return row;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return undefined;
  };
  const pendingConfirmation = (issueId: string) => issueThreadInteractionService(db).create(
    { id: issueId, companyId },
    { kind: "request_confirmation", continuationPolicy: "wake_assignee", payload: { version: 1, prompt: "Ship it?" } },
    { agentId: X },
  );
  const resolveFromComment = async (actor: RequestActor, issueId: string) => {
    const confirm = await pendingConfirmation(taskId);
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: taskId, authorUserId: O, body: "Yes" }).returning();
    const res = await request(appFor(actor)).post(`/api/issues/${issueId}/interactions/${confirm.id}/resolve-from-comment`)
      .send({ commentId: comment!.id, decision: "accept" });
    return { res, confirm };
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-interaction-create-read-guard-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({ name: "Create guard", issuePrefix: prefix, requireBoardApprovalForNewAgents: false }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values([...Object.keys(roles), A].map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    for (const [principalId, membershipRole] of Object.entries(roles)) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active", membershipRole, restricted: principalId === R });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole, grantedByUserId: null });
    }
    const makeAgent = async (name: string, wakeOnDemand: boolean) => {
      const [row] = await db.insert(agents).values({ companyId, name, role: "engineer", status: "idle", adapterType: "process",
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand } } }).returning();
      await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: row!.id, status: "active", membershipRole: "member" });
      return row!.id;
    };
    X = await makeAgent("Writer", false);
    // Y is invokable and wakes on demand, so the interaction wake writes a queued row with reason interaction_pending.
    Y = await makeAgent("Reviewer", true);
    Z = await makeAgent("Outsider", false);
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
    const open = await issueService(db).create(companyId, {
      title: "Open task", status: "todo", assigneeAgentId: X, createdByUserId: O, responsibleUserId: O,
    });
    openTaskId = open.id;
  }, 120_000);

  afterEach(() => {
    failRead.userId = null;
    vi.unstubAllEnvs();
  });

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

  it("U's create on P and on O's chat answers 404 Issue not found, with and without an addressee, and nothing is written", async () => {
    const before = await writes();
    for (const issueId of [taskId, chatId]) {
      for (const addressee of [undefined, Y]) {
        const res = await createCard(user(U), issueId, addressee);
        const label = `${issueId === chatId ? "chat" : "P"}${addressee ? " addressed to Y" : ""}`;
        expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(404);
        expect(res.body).toEqual({ error: "Issue not found" });
      }
    }
    expect(await writes()).toEqual(before);
    // The wake is fire-and-forget: check again after a flush.
    await flush();
    expect(await writes()).toEqual(before);
  });

  it("a bad body answers 400 before the read check, on P and on an unknown id", async () => {
    for (const issueId of [taskId, randomUUID()]) {
      const res = await request(appFor(user(U))).post(`/api/issues/${issueId}/interactions`).send({ kind: "request_confirmation" });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    }
  });

  it("fails closed when the read decision throws: U's create on P is non-2xx and nothing is written", async () => {
    failRead.userId = U;
    const before = await writes();
    const res = await createCard(user(U), taskId, Y);
    expect(res.status, JSON.stringify(res.body)).toBe(500);
    await flush();
    expect(await writes()).toEqual(before);
  });

  it("with PAPERCLIP_ISSUE_PRIVACY_MODE=off U's create on P keeps today's 201 (kill switch)", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
    const res = await createCard(user(U), taskId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("O creates on P and on his chat as today; the addressed card on P wakes Y", async () => {
    for (const issueId of [taskId, chatId]) {
      const before = await writes();
      const plain = await createCard(user(O), issueId);
      expect(plain.status, JSON.stringify(plain.body)).toBe(201);
      const addressed = await createCard(user(O), issueId, Y);
      expect(addressed.status, JSON.stringify(addressed.body)).toBe(201);
      const after = await writes();
      expect(after.interactions).toBe(before.interactions + 2);
      expect(after.activity).toBe(before.activity + 2);
      // Y is woken on P. On O's private chat Y is not woken today; that is outside this ticket.
      if (issueId !== taskId) continue;
      const wake = await waitForWake(addressed.body.id);
      expect(wake, `wake for ${addressed.body.id}`).toBeDefined();
      expect(wake!.reason).toBe("interaction_pending");
    }
  });

  it("the local board creates on P as today (201)", async () => {
    const res = await createCard(localBoard, taskId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("a session instance admin (not the local board, no membership) on P: decide() allows, 201", async () => {
    const res = await createCard(instanceAdmin(), taskId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("U through a board key on P: the same decide() denial, 404 and nothing written", async () => {
    const before = await writes();
    const res = await createCard(boardKey(U), taskId, Y);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
    await flush();
    expect(await writes()).toEqual(before);
  });

  it("a restricted member at restrictionMode off creates on an open task as today (201)", async () => {
    const res = await createCard(user(R), openTaskId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("agent X on P (assignee, own run) gets today's 201: the agent path is unchanged", async () => {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: X, status: "running", responsibleUserId: O,
      contextSnapshot: { issueId: taskId, taskId, taskKey: taskId } }).returning();
    const res = await createCard(agent(X, run!.id, O), taskId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("agent Z on P (not assignee, cannot read) gets today's 404 from the agent branch", async () => {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: Z, status: "running", responsibleUserId: U,
      contextSnapshot: { issueId: openTaskId, taskId: openTaskId, taskKey: openTaskId } }).returning();
    const before = await writes();
    const res = await createCard(agent(Z, run!.id, U), taskId);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(await writes()).toEqual(before);
  });

  it("resolve-from-comment: U on P answers 404 Issue not found and the interaction stays pending", async () => {
    const { res, confirm } = await resolveFromComment(user(U), taskId);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
    expect(await status(confirm.id)).toBe("pending");
  });

  it("resolve-from-comment: O on P keeps today's 403 (new route baseline)", async () => {
    const { res, confirm } = await resolveFromComment(user(O), taskId);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Conversational resolution requires the responding agent run");
    expect(await status(confirm.id)).toBe("pending");
  });

  it("resolve-from-comment: an unknown task id answers 404 as today", async () => {
    const { res } = await resolveFromComment(user(O), randomUUID());
    expect(res.status, JSON.stringify(res.body)).toBe(404);
  });

  it("resolve-from-comment fails closed when the read decision throws for U", async () => {
    failRead.userId = U;
    const { res, confirm } = await resolveFromComment(user(U), taskId);
    expect(res.status, JSON.stringify(res.body)).toBe(500);
    expect(await status(confirm.id)).toBe("pending");
  });

  it("resolve-from-comment with PAPERCLIP_ISSUE_PRIVACY_MODE=off: U keeps today's 403 (kill switch)", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "off");
    const { res, confirm } = await resolveFromComment(user(U), taskId);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await status(confirm.id)).toBe("pending");
  });
});
