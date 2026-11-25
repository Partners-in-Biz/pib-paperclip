import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, agentWakeupRequests, agents, approvals, authUsers, companies, companyMemberships,
  createDb, heartbeatRuns, issueApprovals, issueRelations, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { approvalRoutes } from "../routes/approvals.js";
import { issueRoutes } from "../routes/issues.js";
import { MEMBER_RESTRICTED_AGENT_NOT_LISTED } from "../services/heartbeat/member-agent-list.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

/**
 * AC-A7 (PAR-12608 4.7, C4c-2c): one test per wake source. R, restricted under
 * `enforce` with only X on his list, acts on his own task that the owner O
 * assigned to the unlisted agent Y; no run of Y starts. Where the source reaches
 * the wake queue, the queue's skip record proves the source fired and the list
 * check, not some other gate, stopped it: with the kill switch `off` each of
 * those tests fails, because Y's run then starts. The approval sites are driven
 * by R and by X's run that works for R. Release queues no wake at all; it is
 * kept so the list of sources the spec names stays complete.
 */

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Wake source test run.", provider: "test", model: "test-model",
})));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

type Actor = Express.Request["actor"];

const support = await getEmbeddedPostgresTestSupport();

describe("wake source database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("AC-A7: no wake source starts a run of an unlisted agent for R", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;
  let companyId = "";
  let agentX = "";
  let agentY = "";
  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;

  const as = (who: Actor) => {
    actor = who;
    return request(app);
  };
  const boardFor = async (userId: string): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return {
      type: "board", userId, source: "session", isInstanceAdmin: false, memberships,
      companyIds: memberships.map((row: { companyId: string }) => row.companyId),
    } as Actor;
  };
  /** X's run that works for R (H1), on R's task. */
  const runOfXForR = async (issueId: string): Promise<Actor> => {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agentX, status: "running", responsibleUserId: R,
      contextSnapshot: { issueId, taskId: issueId, taskKey: issueId },
    }).returning();
    return {
      type: "agent", companyId, agentId: agentX, runId: run!.id, source: "agent_jwt",
      onBehalfOfUserId: null, onBehalfOfMemberships: [],
    } as Actor;
  };
  /** R's own task, assigned by O to the unlisted Y. */
  const task = async (status = "todo", extra: Partial<typeof issues.$inferInsert> = {}) => {
    const [row] = await db.insert(issues).values({
      companyId, title: `R's task ${randomUUID().slice(0, 8)}`, status, assigneeAgentId: agentY,
      createdByUserId: R, responsibleUserId: R, ...extra,
    }).returning();
    return row!.id;
  };
  const runsOfY = () => db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentY));
  const listSkips = (issueId: string) => db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.agentId, agentY),
      eq(agentWakeupRequests.reason, MEMBER_RESTRICTED_AGENT_NOT_LISTED),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    ));
  /** Most routes queue the wake without awaiting it: wait for the queue's skip record. */
  const queueSkipped = async (issueId: string) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const rows = await listSkips(issueId);
      if (rows.length > 0) return rows;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return listSkips(issueId);
  };
  /** The source fired, the list check refused every wake of Y it sent, and no run of Y exists. */
  const expectSkippedAtQueue = async (issueId: string) => {
    const skips = await queueSkipped(issueId);
    expect(skips.length).toBeGreaterThan(0);
    expect(skips.every((row) => row.status === "skipped"), JSON.stringify(skips)).toBe(true);
    expect(await runsOfY()).toEqual([]);
  };
  /** Compaction and session goals exist only on a Paperclip Runner agent. */
  const withYOnRunner = async (body: () => Promise<void>) => {
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } })
      .where(eq(agents.id, agentY));
    try {
      await body();
    } finally {
      await db.update(agents).set({ adapterType: "codex_local", adapterConfig: {} }).where(eq(agents.id, agentY));
    }
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-restriction-wake-sources-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use("/api", approvalRoutes(db));
    app.use(errorHandler);

    const [company] = await db.insert(companies).values({
      name: "Wake sources", issuePrefix: `W${randomUUID().slice(0, 6).toUpperCase()}`,
      memberRestrictionMode: "enforce", requireBoardApprovalForNewAgents: false,
    }).returning();
    companyId = company!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    const [x, y] = await db.insert(agents).values(["X", "Y"].map((name) => ({
      companyId, name, role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    }))).returning();
    agentX = x!.id;
    agentY = y!.id;
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId, principalType: "user", principalId: R, status: "active", membershipRole: "operator",
        restricted: true, restrictedAgentIds: [agentX] },
    ]);
    for (const [principalId, membershipRole] of [[O, "owner"], [R, "operator"]] as const) {
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId, membershipRole, grantedByUserId: null });
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    // Any run of Y would be a failure already; clear the wake rows so each source starts clean.
    await db.delete(agentWakeupRequests);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  }, 60_000);

  it("task update: R moves his task out of backlog (issue_status_changed)", async () => {
    const issueId = await task("backlog");
    const res = await as(await boardFor(R)).patch(`/api/issues/${issueId}`).send({ status: "todo" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectSkippedAtQueue(issueId);
  });

  it("task update with a comment: R comments through PATCH (issue_commented)", async () => {
    const issueId = await task();
    const res = await as(await boardFor(R)).patch(`/api/issues/${issueId}`).send({ comment: "Please continue." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectSkippedAtQueue(issueId);
  });

  it("task update closing a child: R finishes a sub-task of his task (issue_children_completed)", async () => {
    const parentId = await task("in_progress");
    const childId = await task("in_progress", { parentId, assigneeAgentId: null });
    const res = await as(await boardFor(R)).patch(`/api/issues/${childId}`).send({ status: "done" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectSkippedAtQueue(parentId);
  });

  it("task update closing a blocker: R finishes the task that blocks his task (issue_blockers_resolved)", async () => {
    const dependentId = await task();
    const blockerId = await task("in_progress", { assigneeAgentId: null });
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: dependentId, type: "blocks" });
    const res = await as(await boardFor(R)).patch(`/api/issues/${blockerId}`).send({ status: "done" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectSkippedAtQueue(dependentId);
  });

  it("document update: R edits the plan Y asked him to confirm (expired confirmation, lost review path)", async () => {
    const issueId = await task("in_review");
    const first = await as(await boardFor(R)).put(`/api/issues/${issueId}/documents/plan`)
      .send({ format: "markdown", body: "# Plan\n\nFirst draft." });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    await issueThreadInteractionService(db).create({ id: issueId, companyId }, {
      kind: "request_confirmation", continuationPolicy: "wake_assignee", payload: {
        version: 1, prompt: "Approve the plan?",
        target: { type: "issue_document", key: "plan", revisionId: first.body.latestRevisionId },
      },
    }, { agentId: agentY });
    const res = await as(await boardFor(R)).put(`/api/issues/${issueId}/documents/plan`)
      .send({ format: "markdown", body: "# Plan\n\nSecond draft.", baseRevisionId: first.body.latestRevisionId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectSkippedAtQueue(issueId);
  });

  it("comment: R comments on his task (issue_commented)", async () => {
    const issueId = await task();
    const res = await as(await boardFor(R)).post(`/api/issues/${issueId}/comments`).send({ body: "Please continue." });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await expectSkippedAtQueue(issueId);
  });

  it("comment that reopens: R comments on his done task with reopen (issue_reopened_via_comment)", async () => {
    const issueId = await task("done");
    const res = await as(await boardFor(R)).post(`/api/issues/${issueId}/comments`)
      .send({ body: "Not done yet.", reopen: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await expectSkippedAtQueue(issueId);
  });

  it("comment by a run: X's run that works for R comments on R's task (issue_commented)", async () => {
    const issueId = await task("in_progress");
    const res = await as(await runOfXForR(issueId)).post(`/api/issues/${issueId}/comments`).send({ body: "Over to Y." });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await expectSkippedAtQueue(issueId);
  });

  it("answered question: R answers Y's question (continuation wake)", async () => {
    const issueId = await task("in_review");
    const ask = await issueThreadInteractionService(db).create({ id: issueId, companyId }, {
      kind: "ask_user_questions", continuationPolicy: "wake_assignee", payload: { version: 1, questions: [
        { id: "scope", prompt: "Scope?", required: true, selectionMode: "single", options: [{ id: "all", label: "All" }] },
      ] },
    }, { agentId: agentY });
    const res = await as(await boardFor(R)).post(`/api/issues/${issueId}/interactions/${ask.id}/respond`)
      .send({ answers: [{ questionId: "scope", optionIds: ["all"] }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectSkippedAtQueue(issueId);
  });

  it.each(["accept", "reject"] as const)("confirmation: R %ss Y's confirmation (continuation wake)", async (decision) => {
    const issueId = await task("in_review");
    const confirm = await issueThreadInteractionService(db).create({ id: issueId, companyId }, {
      kind: "request_confirmation", continuationPolicy: "wake_assignee", payload: { version: 1, prompt: "Ship it?" },
    }, { agentId: agentY });
    const res = await as(await boardFor(R)).post(`/api/issues/${issueId}/interactions/${confirm.id}/${decision}`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectSkippedAtQueue(issueId);
  });

  it("question addressed to Y: R asks Y on his task (interaction_pending)", async () => {
    const issueId = await task();
    const res = await as(await boardFor(R)).post(`/api/issues/${issueId}/interactions`).send({
      kind: "request_confirmation", addresseeAgentId: agentY, payload: { version: 1, prompt: "Can you take this?" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await expectSkippedAtQueue(issueId);
  });

  it("checkout: R checks his task out for its assignee Y (issue_checked_out)", async () => {
    const issueId = await task();
    const res = await as(await boardFor(R)).post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: agentY, expectedStatuses: ["todo"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await expectSkippedAtQueue(issueId);
  });

  it("release: R releases his checked-out task; the route queues no wake of Y", async () => {
    const issueId = await task("in_progress");
    const res = await as(await boardFor(R)).post(`/api/issues/${issueId}/release`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentY))).toEqual([]);
    expect(await runsOfY()).toEqual([]);
  });

  it("context compaction: R compacts Y's context on his task (context_compaction)", () => withYOnRunner(async () => {
    const issueId = await task("in_progress");
    const res = await as(await boardFor(R)).post(`/api/issues/${issueId}/context/compact`).send({});
    // The route awaits the wake: the queue's refusal comes back as "did not start".
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("wake_skipped");
    await expectSkippedAtQueue(issueId);
  }));

  it("session goal: R creates a goal for Y on his task (goal_control)", () => withYOnRunner(async () => {
    const issueId = await task("in_progress");
    const res = await as(await boardFor(R)).post(`/api/issues/${issueId}/runner-goal/actions`)
      .send({ agentId: agentY, requestId: randomUUID(), expectedRevision: 0, action: "create", objective: "Finish the task." });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("goal_control_wake_skipped");
    await expectSkippedAtQueue(issueId);
  }));

  describe.each(["approve", "reject"] as const)("approval %s (routes/approvals.ts)", (decision) => {
    /** An approval Y asked for, linked to R's task in review with no other review path. */
    const approval = async () => {
      const issueId = await task("in_review");
      const [row] = await db.insert(approvals).values({
        companyId, type: "request_board_approval", payload: { title: "Y's request" }, requestedByAgentId: agentY,
        status: "pending",
      }).returning();
      await db.insert(issueApprovals).values({ companyId, issueId, approvalId: row!.id });
      return { issueId, approvalId: row!.id };
    };
    const decisionOf = async (approvalId: string) => db.select({ status: approvals.status }).from(approvals)
      .where(eq(approvals.id, approvalId)).then((rows) => rows[0]!.status);

    // 4.6 closes this row to R in the route table, but no guard enforces the table yet; the
    // decision goes through today, and the wake it sends (approve: the requester; reject: the
    // lost review path) is stopped at the queue.
    it("R decides Y's approval on his task: the wake of Y is skipped at the queue", async () => {
      const { issueId, approvalId } = await approval();
      const res = await as(await boardFor(R)).post(`/api/approvals/${approvalId}/${decision}`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectSkippedAtQueue(issueId);
    });

    it("X's run that works for R is refused, the approval stays pending and no run of Y starts", async () => {
      const { issueId, approvalId } = await approval();
      const res = await as(await runOfXForR(issueId)).post(`/api/approvals/${approvalId}/${decision}`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(await decisionOf(approvalId)).toBe("pending");
      expect(await listSkips(issueId)).toEqual([]);
      expect(await runsOfY()).toEqual([]);
    });
  });
});
