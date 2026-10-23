import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { recoveryService } from "../services/recovery/service.js";

// PAR-1963 T2b: an agent that re-blocks on blockers that are all done must not
// wake itself through `issue.blockers_restored` every blocked cycle.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocker prune route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const PRUNE_FLAG = "PAPERCLIP_PRUNE_RESOLVED_BLOCKERS_ON_AGENT_REBLOCK";

describeEmbeddedPostgres("agent re-block prunes resolved blockers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blockers-prune-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    delete process.env[PRUNE_FLAG];
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "local_implicit",
    };
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  // Wake-on-demand is off, so every wake attempt is stored as a `skipped` row
  // that keeps its idempotency key and payload, and no heartbeat run starts.
  async function seed(input: {
    dependentStatus?: "in_progress" | "blocked";
    blockerStatuses?: Array<"done" | "todo">;
    unblockDescriptor?: { owner: { agentId: string } | "board"; action: string } | null;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const dependentId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const blockerStatuses = input.blockerStatuses ?? ["done"];
    const blockerIds = blockerStatuses.map(() => randomUUID());

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Developer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: false, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    // The assignee's live run owns the issue, as when an agent PATCHes mid-run.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId: dependentId },
    });
    await db.insert(issues).values([
      ...blockerIds.map((id, index) => ({
        id,
        companyId,
        title: `Blocker ${index + 1}`,
        status: blockerStatuses[index]!,
        priority: "medium",
        issueNumber: index + 2,
        identifier: `${issuePrefix}-${index + 2}`,
      })),
      {
        id: dependentId,
        companyId,
        title: "Waiting on blockers",
        status: input.dependentStatus ?? "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        executionLockedAt: new Date(),
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        unblockDescriptor: input.unblockDescriptor ?? null,
        blockedTransitionAt:
          input.dependentStatus === "blocked" ? new Date("2026-10-09T18:00:00.000Z") : null,
      },
    ]);
    if (blockerIds.length > 0) {
      await db.insert(issueRelations).values(
        blockerIds.map((blockerId) => ({
          companyId,
          issueId: blockerId,
          relatedIssueId: dependentId,
          type: "blocks" as const,
        })),
      );
    }
    return { companyId, agentId, dependentId, blockerIds, runId };
  }

  async function blockerIdsOf(issueId: string) {
    const rows = await db
      .select({ blockerId: issueRelations.issueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.relatedIssueId, issueId), eq(issueRelations.type, "blocks")));
    return rows.map((row) => row.blockerId).sort();
  }

  async function blockersResolvedWakes(agentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          like(agentWakeupRequests.idempotencyKey, "issue_blockers_resolved:%"),
        ),
      );
  }

  async function prunedActivities(issueId: string) {
    return db
      .select({ details: activityLog.details, actorType: activityLog.actorType })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.blockers_pruned_resolved")));
  }

  // The update route enqueues its wakes in a fire-and-forget block after the
  // response; give it time to land before asserting that nothing landed.
  async function settleRouteWakes() {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  it("prunes a done blocker listed in an agent's re-block and skips the restored-dependency wake", async () => {
    const { companyId, agentId, dependentId, blockerIds, runId } = await seed();
    const descriptor = { owner: { agentId }, action: "Waiting on the client's logo files" };

    const res = await request(createApp(agentActor(companyId, agentId, runId)))
      .patch(`/api/issues/${dependentId}`)
      .send({ status: "blocked", blockedByIssueIds: blockerIds, unblockDescriptor: descriptor });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("blocked");
    expect(res.body.blockedByIssueIds).toEqual([]);
    expect(res.body.unblockDescriptor).toEqual(descriptor);
    expect(await blockerIdsOf(dependentId)).toEqual([]);
    expect(await prunedActivities(dependentId)).toEqual([
      { actorType: "agent", details: expect.objectContaining({ removedBlockerIssueIds: blockerIds }) },
    ]);
    await settleRouteWakes();
    expect(await blockersResolvedWakes(agentId)).toEqual([]);
  });

  it("prunes the stored done blockers when the agent re-blocks without sending a list", async () => {
    const { companyId, agentId, dependentId, blockerIds, runId } = await seed({ blockerStatuses: ["done", "done"] });

    const res = await request(createApp(agentActor(companyId, agentId, runId)))
      .patch(`/api/issues/${dependentId}`)
      .send({ status: "blocked", unblockDescriptor: { owner: { agentId }, action: "Waiting on Peet" } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.blockedByIssueIds).toEqual([]);
    expect(res.body.unblockDescriptor).toMatchObject({ action: "Waiting on Peet" });
    expect(await blockerIdsOf(dependentId)).toEqual([]);
    const [activity] = await prunedActivities(dependentId);
    expect(activity?.details).toMatchObject({ removedBlockerIssueIds: [...blockerIds].sort() });
    await settleRouteWakes();
    expect(await blockersResolvedWakes(agentId)).toEqual([]);
  });

  it("keeps today's behaviour for a user re-block on a done blocker", async () => {
    const { companyId, agentId, dependentId, blockerIds } = await seed();

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${dependentId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: blockerIds,
        unblockDescriptor: { owner: "board", action: "Review the restored dependency" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.blockedByIssueIds).toEqual(blockerIds);
    expect(await blockerIdsOf(dependentId)).toEqual(blockerIds);
    expect(await prunedActivities(dependentId)).toEqual([]);
    await vi.waitFor(async () => {
      const wakes = await blockersResolvedWakes(agentId);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.payload).toMatchObject({
        issueId: dependentId,
        mutation: "blocked_dependency_restored",
      });
    });
  });

  it("keeps an agent's blocker list that still contains an open blocker", async () => {
    const { companyId, agentId, dependentId, blockerIds, runId } = await seed({ blockerStatuses: ["done", "todo"] });

    const res = await request(createApp(agentActor(companyId, agentId, runId)))
      .patch(`/api/issues/${dependentId}`)
      .send({ status: "blocked", blockedByIssueIds: blockerIds });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.blockedByIssueIds).toEqual([...blockerIds].sort());
    expect(await blockerIdsOf(dependentId)).toEqual([...blockerIds].sort());
    expect(await prunedActivities(dependentId)).toEqual([]);
    await settleRouteWakes();
    expect(await blockersResolvedWakes(agentId)).toEqual([]);
  });

  it("restores today's behaviour when the kill switch is 0", async () => {
    process.env[PRUNE_FLAG] = "0";
    const { companyId, agentId, dependentId, blockerIds, runId } = await seed();

    const res = await request(createApp(agentActor(companyId, agentId, runId)))
      .patch(`/api/issues/${dependentId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: blockerIds,
        unblockDescriptor: { owner: { agentId }, action: "Waiting on the client" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.blockedByIssueIds).toEqual(blockerIds);
    expect(await blockerIdsOf(dependentId)).toEqual(blockerIds);
    expect(await prunedActivities(dependentId)).toEqual([]);
    await vi.waitFor(async () => {
      expect(await blockersResolvedWakes(agentId)).toHaveLength(1);
    });
  });

  it("keeps a blocked issue with an empty blocker list quiet on the route and the backstop", async () => {
    // Blocked with [] before the deploy: no relations, a self-owned descriptor.
    const { companyId, agentId, dependentId } = await seed({
      dependentStatus: "blocked",
      blockerStatuses: [],
      unblockDescriptor: null,
    });
    await db
      .update(issues)
      .set({ unblockDescriptor: { owner: { agentId }, action: "Waiting on the client" } })
      .where(eq(issues.id, dependentId));

    // Route readiness: a user re-asserting an empty list on the assigned
    // blocked issue reaches the restored-dependency check and enqueues nothing.
    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${dependentId}`)
      .send({ blockedByIssueIds: [] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("blocked");
    await settleRouteWakes();
    expect(await blockersResolvedWakes(agentId)).toEqual([]);

    // Backstop: the periodic reconciliation counts [] as not ready.
    const enqueueWakeup = vi.fn(async () => null);
    const result = await recoveryService(db, { enqueueWakeup }).reconcileResolvedDependencyWakeBackstop({
      companyId,
    });
    expect(result.checked).toBe(1);
    expect(result.notReadySkipped).toBe(1);
    expect(result.healed).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("leaves a pruned issue quiet for the backstop", async () => {
    const { companyId, agentId, dependentId, blockerIds, runId } = await seed();

    const res = await request(createApp(agentActor(companyId, agentId, runId)))
      .patch(`/api/issues/${dependentId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: blockerIds,
        unblockDescriptor: { owner: { agentId }, action: "Waiting on the client" },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await blockerIdsOf(dependentId)).toEqual([]);

    const enqueueWakeup = vi.fn(async () => null);
    const result = await recoveryService(db, { enqueueWakeup }).reconcileResolvedDependencyWakeBackstop({
      companyId,
    });
    expect(result.healed).toBe(0);
    expect(result.notReadySkipped).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("adds remainingWait to the backstop's blockers-resolved wake context", async () => {
    const { companyId, agentId, dependentId, blockerIds, runId } = await seed({
      dependentStatus: "blocked",
      unblockDescriptor: { owner: "board", action: "Waiting on the signed contract" },
    });
    // No live run: the backstop only heals issues without an execution path.
    await db
      .update(issues)
      .set({ checkoutRunId: null, executionRunId: null, executionLockedAt: null })
      .where(eq(issues.id, dependentId));
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));

    const enqueueWakeup = vi.fn(async () => null);
    await recoveryService(db, { enqueueWakeup }).reconcileResolvedDependencyWakeBackstop({ companyId });

    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        reason: "issue_blockers_resolved",
        contextSnapshot: expect.objectContaining({
          issueId: dependentId,
          blockerIssueIds: blockerIds,
          remainingWait: "Waiting on the signed contract",
        }),
      }),
    );
  });

  it("does not wake the assignee for its own comment", async () => {
    const { companyId, agentId, dependentId, runId } = await seed({ blockerStatuses: [] });

    const res = await request(createApp(agentActor(companyId, agentId, runId)))
      .post(`/api/issues/${dependentId}/comments`)
      .send({ body: "Still waiting on the client; nothing new." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await settleRouteWakes();
    const wakes = await db
      .select({ reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toEqual([]);
  });
});
