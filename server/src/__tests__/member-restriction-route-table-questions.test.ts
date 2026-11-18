import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issueThreadInteractions, issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import {
  MEMBER_RESTRICTION_ROUTE_TABLE,
  createRouteClassifier,
} from "../services/member-restriction/route-table.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13025 (C4d-2): the question and interaction rows of the route table.
 * Spec PAR-12608 rev 3, 4.6 and S11. AC-G3: for every `open` and `run` row, R
 * (restricted in Y) asks for O's task through that route and gets "Issue not
 * found"; a control call with the kill switch on reaches the task, so the
 * answer is the restriction. Scope callers (section 8): R as owner of X, and
 * an instance admin who is not a member of Y, get today's answer. S11: R
 * answers a question an agent put on his own task (200). This area has no
 * `closed` and no `by-company` rows, and adds no resolver caller: every
 * handler decides through `issue:read`, whose kill-switch and failing-read
 * tests are the base decision's (AC-F8, AC-X1).
 */

const support = await getEmbeddedPostgresTestSupport();
const THIS_FILE = "server/src/__tests__/member-restriction-route-table-questions.test.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("question and interaction route rows database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
type Res = request.Response;
type Ids = {
  companyId: string; agentId: string; runId: string; issueId: string; chatId: string; commentId: string;
  confirmId: string; askId: string; verdictsId: string;
};

/** One request per row. `run` rows are called by an agent run working for the person. */
type Case = {
  row: string;
  caller: "board" | "run";
  send: (client: request.SuperTest<request.Test>, ids: Ids) => request.Test;
};

const at = ({ issueId }: Ids, interactionId: string, verb: string) =>
  `/api/issues/${issueId}/interactions/${interactionId}/${verb}`;
const ANSWERS = { answers: [{ questionId: "scope", optionIds: ["all"] }] };

const CASES: Case[] = [
  { row: "GET /api/issues/:id/pending-questions", caller: "board",
    send: (c, { chatId }) => c.get(`/api/issues/${chatId}/pending-questions`) },
  { row: "GET /api/issues/:id/interactions", caller: "board", send: (c, { issueId }) => c.get(`/api/issues/${issueId}/interactions`) },
  { row: "POST /api/issues/:id/interactions", caller: "board",
    send: (c, { issueId }) => c.post(`/api/issues/${issueId}/interactions`)
      .send({ kind: "request_confirmation", continuationPolicy: "none", payload: { version: 1, prompt: "Ship it?" } }) },
  { row: "POST /api/issues/:id/interactions/:interactionId/accept", caller: "board",
    send: (c, ids) => c.post(at(ids, ids.confirmId, "accept")).send({}) },
  { row: "POST /api/issues/:id/interactions/:interactionId/reject", caller: "board",
    send: (c, ids) => c.post(at(ids, ids.confirmId, "reject")).send({ reason: "No" }) },
  { row: "POST /api/issues/:id/interactions/:interactionId/respond", caller: "board",
    send: (c, ids) => c.post(at(ids, ids.askId, "respond")).send(ANSWERS) },
  { row: "POST /api/issues/:id/interactions/:interactionId/verdicts", caller: "board",
    send: (c, ids) => c.post(at(ids, ids.verdictsId, "verdicts")).send({ verdicts: [{ id: "one", verdict: "approve" }] }) },
  { row: "POST /api/issues/:id/interactions/:interactionId/withdraw", caller: "board",
    send: (c, ids) => c.post(at(ids, ids.confirmId, "withdraw")).send({}) },
  { row: "POST /api/issues/:id/interactions/:interactionId/dismiss", caller: "board",
    send: (c, ids) => c.post(at(ids, ids.askId, "dismiss")).send({}) },
  { row: "POST /api/issues/:id/interactions/:interactionId/skip", caller: "board",
    send: (c, ids) => c.post(at(ids, ids.askId, "skip")).send({}) },
  { row: "POST /api/issues/:id/interactions/:interactionId/cancel", caller: "board",
    send: (c, ids) => c.post(at(ids, ids.askId, "cancel")).send({}) },
  { row: "POST /api/issues/:id/interactions/:interactionId/resolve-from-comment", caller: "run",
    send: (c, ids) => c.post(at(ids, ids.confirmId, "resolve-from-comment")).send({ commentId: ids.commentId, decision: "accept" }) },
];

const issueNotFound = (res: Res) => res.status === 404 && res.body?.error === "Issue not found";

it("every row of this file has exactly one case, and each case's caller matches its class", async () => {
  const rows = MEMBER_RESTRICTION_ROUTE_TABLE.filter((entry) => entry.test === THIS_FILE);
  expect(CASES.map((entry) => entry.row).sort()).toEqual(rows.map((entry) => `${entry.method} ${entry.path}`).sort());
  const classify = createRouteClassifier();
  for (const entry of CASES) {
    const row = rows.find((item) => `${item.method} ${item.path}` === entry.row)!;
    expect(row.class, entry.row).toBe(entry.caller === "run" ? "run" : "open");
    // The real path classifies as this row, not as a neighbour.
    const result = await classify(row.method, row.path.replace(/:[A-Za-z]+/g, () => randomUUID()));
    expect(result.kind === "matched" ? `${result.entry.method} ${result.entry.path}` : result.kind, entry.row).toBe(entry.row);
  }
});

(support.supported ? describe : describe.skip)("question and interaction rows of the route table (PAR-12608 4.6, AC-G3, S11)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;

  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const ADMIN = `instance-admin-${randomUUID()}`;
  let Y = "";
  let X = "";

  const as = (who: Actor) => {
    actor = who;
    return request(app);
  };
  const boardFor = async (userId: string, isInstanceAdmin = false): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return {
      type: "board", userId, source: "session", isInstanceAdmin, memberships,
      companyIds: memberships.map((row: { companyId: string }) => row.companyId),
    } as Actor;
  };
  /** An agent run working for `userId`, as the run that read the reply. */
  const runFor = async (userId: string, ids: Ids): Promise<Actor> => ({
    type: "agent", agentId: ids.agentId, companyId: ids.companyId, runId: ids.runId, source: "agent_jwt",
    onBehalfOfUserId: userId, onBehalfOfMemberships: await loadActorMemberships(db, { userId, activeOnly: true }),
  }) as Actor;
  const callerFor = (entry: Case, userId: string, ids: Ids, isInstanceAdmin = false) =>
    entry.caller === "run" ? runFor(userId, ids) : boardFor(userId, isInstanceAdmin);

  /**
   * Fresh objects per request, so a write that goes through cannot change the
   * next case: `owner`'s task, assigned to an agent whose run (working for R)
   * holds it, with the agent's confirmation, question and item review on it,
   * R's reply after them, and a
   * chat of R's (pending questions is the conversation owner's) whose task is
   * `owner`'s.
   */
  const ids = async (companyId: string, owner: string): Promise<Ids> => {
    const [agent, chatAgent] = await db.insert(agents).values([
      { companyId, name: `Agent ${randomUUID().slice(0, 6)}`, role: "engineer", adapterType: "process", status: "idle",
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } },
      { companyId, name: `Chat ${randomUUID().slice(0, 6)}`, role: "engineer", adapterType: "process", status: "idle",
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } },
    ]).returning();
    const [task, chat] = await db.insert(issues).values([
      { companyId, title: `Task ${randomUUID().slice(0, 8)}`, status: "in_progress", assigneeAgentId: agent!.id,
        createdByUserId: owner, responsibleUserId: owner },
      { companyId, title: "Chat", status: "todo", assigneeAgentId: chatAgent!.id, conversationAgentId: chatAgent!.id,
        conversationUserId: R, conversationState: "active", createdByUserId: owner, responsibleUserId: owner },
    ]).returning();
    const issueId = task!.id;
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent!.id, status: "running", responsibleUserId: R, contextSnapshot: { issueId, taskId: issueId },
    }).returning();
    await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, issueId));
    const interactions = issueThreadInteractionService(db);
    const by = { agentId: agent!.id };
    const confirm = await interactions.create({ id: issueId, companyId },
      { kind: "request_confirmation", continuationPolicy: "none", payload: { version: 1, prompt: "Ship it?" } }, by);
    const ask = await interactions.create({ id: issueId, companyId },
      { kind: "ask_user_questions", continuationPolicy: "none", payload: { version: 1, questions: [
        { id: "scope", prompt: "Scope?", required: true, selectionMode: "single", options: [{ id: "all", label: "All" }] },
      ] } }, by);
    const verdicts = await interactions.create({ id: issueId, companyId },
      { kind: "request_item_verdicts", continuationPolicy: "none", payload: { version: 1, prompt: "Review items", items: [{ id: "one", label: "One" }] } }, by);
    // R's reply after the card: `resolve-from-comment` takes only the run's own person.
    const [comment] = await db.insert(issueComments).values({
      companyId, issueId, authorType: "user", authorUserId: R, body: "Yes, ship it", createdAt: new Date(new Date(confirm.createdAt).getTime() + 1000),
    }).returning();
    return {
      companyId, agentId: agent!.id, runId: run!.id, issueId, chatId: chat!.id, commentId: comment!.id,
      confirmId: confirm.id, askId: ask.id, verdictsId: verdicts.id,
    };
  };
  /** The same request with the kill switch on: today's answer. */
  const today = async <T,>(send: () => Promise<T>): Promise<T> => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    try {
      return await send();
    } finally {
      vi.unstubAllEnvs();
    }
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-route-table-questions-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);

    const [y, x] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
    ]).returning();
    Y = y!.id;
    X = x!.id;
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
    it("AC-G3: R (restricted in Y) asking for O's task gets \"Issue not found\" and nothing changes", async () => {
      const send = async () => {
        const target = await ids(Y, O);
        return { target, res: await entry.send(as(await callerFor(entry, R, target)), target) };
      };
      const enforced = await send();
      expect(issueNotFound(enforced.res), JSON.stringify(enforced.res.body)).toBe(true);
      const statuses = await db.select({ status: issueThreadInteractions.status, dismissedAt: issueThreadInteractions.dismissedAt })
        .from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, enforced.target.issueId));
      expect(statuses).toEqual([0, 1, 2].map(() => ({ status: "pending", dismissedAt: null })));
      // Control: with the kill switch on the same call reaches O's task, so
      // the answer above is the restriction and not a broken request.
      const open = await today(send);
      expect(open.res.status, JSON.stringify(open.res.body)).toBeLessThan(300);
    });

    it("scope callers: R as owner of X, and an instance admin who is no member of Y, get today's answer", async () => {
      // Set-up first, then the caller sets the actor.
      const callAs = async (userId: string, target: Promise<Ids>, isInstanceAdmin = false) => {
        const ready = await target;
        return entry.send(as(await callerFor(entry, userId, ready, isInstanceAdmin)), ready);
      };
      const ownX = () => callAs(R, ids(X, R));
      const ownXNow = await ownX();
      expect(ownXNow.status, JSON.stringify(ownXNow.body)).toBe((await today(ownX)).status);
      expect(ownXNow.status, JSON.stringify(ownXNow.body)).toBeLessThan(300);

      const admin = () => callAs(ADMIN, ids(Y, O), true);
      const adminNow = await admin();
      expect(adminNow.status, JSON.stringify(adminNow.body)).toBe((await today(admin)).status);
    });
  });

  // The handler fixes: these routes used to read the task for board callers
  // only, so a run working for R learned the task and the card exist (403).
  it.each(["accept", "withdraw", "skip", "cancel"])("a run working for R gets \"Issue not found\" on %s of O's card", async (verb) => {
    const target = await ids(Y, O);
    const res = await as(await runFor(R, target)).post(at(target, target.confirmId, verb)).send({});
    expect(issueNotFound(res), JSON.stringify(res.body)).toBe(true);
  });

  it("S11: R answers a question an agent put on his own task in Y (200)", async () => {
    const own = await ids(Y, R);
    const res = await as(await boardFor(R)).post(at(own, own.askId, "respond")).send(ANSWERS);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, own.askId));
    expect(row!.status).toBe("answered");
  });
});
