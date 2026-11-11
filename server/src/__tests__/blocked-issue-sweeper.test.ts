import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  BLOCKED_ISSUE_SWEEP_MAX_PER_TICK,
  BLOCKED_ISSUE_SWEEP_MIN_AGE_MS,
  BLOCKED_OWNER_RENOTIFIED_ACTION,
  blockedIssueSweeper,
} from "../services/blocked-issue-sweeper.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../services/issue-dependency-wakeups.js";

// Runs between the scan and the re-read, so a test can change the issue in that gap.
const betweenScanAndAct = vi.hoisted(() => ({ hook: null as null | ((issueId: string) => Promise<void>) }));
vi.mock("../services/recovery/disposition-repair.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/recovery/disposition-repair.js")>();
  return {
    ...actual,
    readDispositionRepairDurableWaitingState: async (
      ...args: Parameters<typeof actual.readDispositionRepairDurableWaitingState>
    ) => {
      const result = await actual.readDispositionRepairDurableWaitingState(...args);
      await betweenScanAndAct.hook?.(args[1].issue.id);
      return result;
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("blocked issue sweeper", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  // Real clock: the loop guard compares against DB-generated activity timestamps.
  const now = new Date();
  const blockedLongAgo = new Date(now.getTime() - 45 * 60 * 1000);
  const blockedJustNow = new Date(now.getTime() - 5 * 60 * 1000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-issue-sweeper-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    betweenScanAndAct.hook = null;
    await db.delete(activityLog);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function makeSweeper() {
    const wakeup = vi.fn(async () => null);
    return { wakeup, sweeper: blockedIssueSweeper(db, { wakeup }) };
  }

  async function seedCompany(agentStatus = "idle") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `BS${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Sweeper Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: agentStatus,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId, prefix, counter: { n: 0 } };
  }

  async function seedIssue(
    ctx: Awaited<ReturnType<typeof seedCompany>>,
    overrides: Partial<typeof issues.$inferInsert> = {},
  ) {
    const id = randomUUID();
    ctx.counter.n += 1;
    await db.insert(issues).values({
      id,
      companyId: ctx.companyId,
      title: `Issue ${ctx.counter.n}`,
      status: "blocked",
      priority: "medium",
      assigneeAgentId: ctx.agentId,
      issueNumber: ctx.counter.n,
      identifier: `${ctx.prefix}-${ctx.counter.n}`,
      blockedTransitionAt: blockedLongAgo,
      ...overrides,
    });
    return id;
  }

  async function blockedBy(ctx: Awaited<ReturnType<typeof seedCompany>>, blockedId: string, blockerStatus: string) {
    const blockerId = await seedIssue(ctx, { status: blockerStatus, blockedTransitionAt: null });
    await db.insert(issueRelations).values({
      companyId: ctx.companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });
    return blockerId;
  }

  async function statusOf(id: string) {
    const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, id));
    return row!.status;
  }

  it("moves a blocked issue to todo when every blocker is done, logs activity and wakes the assignee", async () => {
    const ctx = await seedCompany();
    const issueId = await seedIssue(ctx);
    await blockedBy(ctx, issueId, "done");
    const { sweeper, wakeup } = makeSweeper();

    const result = await sweeper.sweep(now);

    expect(result.moved).toBe(1);
    expect(await statusOf(issueId)).toBe("todo");
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(
      ctx.agentId,
      expect.objectContaining({ reason: "issue_blockers_resolved" }),
    );
    const [entry] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.blocked_swept_to_todo")));
    expect(entry?.actorType).toBe("system");
    expect(entry?.details).toMatchObject({ reason: "blockers_done", previousStatus: "blocked", status: "todo" });
  });

  it("sends the same wake source and state key as the blockers-resolved route, and logs issue.updated", async () => {
    const ctx = await seedCompany();
    const issueId = await seedIssue(ctx);
    const blockerId = await blockedBy(ctx, issueId, "done");
    const { sweeper, wakeup } = makeSweeper();

    await sweeper.sweep(now);

    expect(wakeup).toHaveBeenCalledWith(
      ctx.agentId,
      expect.objectContaining({
        source: "automation",
        reason: "issue_blockers_resolved",
        idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: issueId,
          blockerIssueIds: [blockerId],
          blockedTransitionAt: blockedLongAgo,
        }),
      }),
    );
    const updated = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.updated")));
    expect(updated).toHaveLength(1);
    expect(updated[0]?.details).toMatchObject({ status: "todo", changes: { status: { from: "blocked", to: "todo" } } });
  });

  it("sweeps an issue that is re-blocked only once inside 24 hours, and again after the window", async () => {
    const ctx = await seedCompany();
    const issueId = await seedIssue(ctx);
    const { sweeper, wakeup } = makeSweeper();

    expect((await sweeper.sweep(now)).moved).toBe(1);
    expect(await statusOf(issueId)).toBe("todo");

    // The agent re-blocks the issue; 45 minutes later it is eligible by age again.
    const later = new Date(now.getTime() + 60 * 60 * 1000);
    await db
      .update(issues)
      .set({ status: "blocked", blockedTransitionAt: new Date(later.getTime() - 45 * 60 * 1000) })
      .where(eq(issues.id, issueId));
    const second = await sweeper.sweep(later);
    expect(second.moved).toBe(0);
    expect(await statusOf(issueId)).toBe("blocked");
    expect(wakeup).toHaveBeenCalledTimes(1);

    const nextDay = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    await db
      .update(issues)
      .set({ blockedTransitionAt: new Date(nextDay.getTime() - 45 * 60 * 1000) })
      .where(eq(issues.id, issueId));
    expect((await sweeper.sweep(nextDay)).moved).toBe(1);
    expect(wakeup).toHaveBeenCalledTimes(2);
  });

  it("moves an issue with no blockers to todo when its assignee is idle", async () => {
    const ctx = await seedCompany("idle");
    const issueId = await seedIssue(ctx);
    const { sweeper, wakeup } = makeSweeper();

    await sweeper.sweep(now);

    expect(await statusOf(issueId)).toBe("todo");
    expect(wakeup).toHaveBeenCalledWith(
      ctx.agentId,
      expect.objectContaining({ reason: "issue_status_changed" }),
    );
    const [entry] = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(entry?.details).toMatchObject({ reason: "owner_agent_idle" });
  });

  it("leaves an issue alone while a future monitor already holds it (PAR-8900)", async () => {
    const ctx = await seedCompany("idle");
    const issueId = await seedIssue(ctx, {
      monitorNextCheckAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
    const { sweeper, wakeup } = makeSweeper();

    await sweeper.sweep(now);

    expect(await statusOf(issueId)).toBe("blocked");
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("uses the agent named in the unblock descriptor as the owner to check", async () => {
    const ctx = await seedCompany("idle");
    const pausedOwnerId = randomUUID();
    await db.insert(agents).values({
      id: pausedOwnerId,
      companyId: ctx.companyId,
      name: "Paused owner",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = await seedIssue(ctx, {
      unblockDescriptor: { owner: { agentId: pausedOwnerId }, action: "Provide the credentials" },
    });
    const { sweeper, wakeup } = makeSweeper();

    await sweeper.sweep(now);

    expect(await statusOf(issueId)).toBe("blocked");
    expect(wakeup).not.toHaveBeenCalled();
  });

  it.each(["paused", "error", "running", "terminated"])(
    "leaves a blocked issue alone when the assignee is %s",
    async (agentStatus) => {
      const ctx = await seedCompany(agentStatus);
      const issueId = await seedIssue(ctx);
      const { sweeper, wakeup } = makeSweeper();

      const result = await sweeper.sweep(now);

      expect(result.moved).toBe(0);
      expect(await statusOf(issueId)).toBe("blocked");
      expect(wakeup).not.toHaveBeenCalled();
    },
  );

  it("leaves an issue alone while a blocker is still open", async () => {
    const ctx = await seedCompany();
    const issueId = await seedIssue(ctx);
    await blockedBy(ctx, issueId, "done");
    await blockedBy(ctx, issueId, "in_progress");
    const { sweeper } = makeSweeper();

    await sweeper.sweep(now);

    expect(await statusOf(issueId)).toBe("blocked");
  });

  it("leaves issues owned by the board or a user alone", async () => {
    const ctx = await seedCompany();
    const boardIssue = await seedIssue(ctx, {
      unblockDescriptor: { owner: "board", action: "Approve the spend" },
    });
    const userIssue = await seedIssue(ctx, {
      unblockDescriptor: { owner: { userId: "user-1" }, action: "Sign the contract" },
    });
    const { sweeper } = makeSweeper();

    await sweeper.sweep(now);

    expect(await statusOf(boardIssue)).toBe("blocked");
    expect(await statusOf(userIssue)).toBe("blocked");
  });

  it("leaves issues blocked for less than 30 minutes alone", async () => {
    const ctx = await seedCompany();
    const issueId = await seedIssue(ctx, { blockedTransitionAt: blockedJustNow });
    const { sweeper } = makeSweeper();

    await sweeper.sweep(now);

    expect(await statusOf(issueId)).toBe("blocked");
  });

  it("leaves an issue alone while a run for it is queued or running", async () => {
    const ctx = await seedCompany();
    const issueId = await seedIssue(ctx);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      invocationSource: "manual",
      status: "queued",
      contextSnapshot: { issueId },
    });
    const { sweeper } = makeSweeper();

    await sweeper.sweep(now);

    expect(await statusOf(issueId)).toBe("blocked");
  });

  it("moves at most 50 issues per tick and picks up the rest on the next one", async () => {
    const ctx = await seedCompany();
    const ids: string[] = [];
    for (let i = 0; i < BLOCKED_ISSUE_SWEEP_MAX_PER_TICK + 5; i += 1) ids.push(await seedIssue(ctx));
    const { sweeper } = makeSweeper();

    const first = await sweeper.sweep(now);
    expect(first.moved).toBe(BLOCKED_ISSUE_SWEEP_MAX_PER_TICK);

    const second = await sweeper.sweep(now);
    expect(second.moved).toBe(5);
    for (const id of ids) expect(await statusOf(id)).toBe("todo");
  }, 60_000);

  it("does not let issues that must stay blocked starve the ones behind them", async () => {
    const ctx = await seedCompany();
    for (let i = 0; i < 60; i += 1) {
      await seedIssue(ctx, {
        blockedTransitionAt: new Date(blockedLongAgo.getTime() - 60_000 * (i + 1)),
        unblockDescriptor: { owner: "board", action: "Decide" },
      });
    }
    const readyId = await seedIssue(ctx);
    const { sweeper } = makeSweeper();

    await sweeper.sweep(now);

    expect(await statusOf(readyId)).toBe("todo");
  }, 60_000);
  it("schedules itself from the oldest blocked issue and sleeps while nothing is blocked", async () => {
    const { sweeper } = makeSweeper();
    expect(await sweeper.nextDueAt(now)).toBeNull();
    const ctx = await seedCompany();
    await seedIssue(ctx, { blockedTransitionAt: blockedJustNow });
    expect(await sweeper.nextDueAt(now)).toBe(blockedJustNow.getTime() + BLOCKED_ISSUE_SWEEP_MIN_AGE_MS);
    await seedIssue(ctx, { blockedTransitionAt: blockedLongAgo });
    expect(await sweeper.nextDueAt(now, 12345)).toBe(12345);
    await db.update(issues).set({ status: "todo" }).where(eq(issues.companyId, ctx.companyId));
    expect(await sweeper.nextDueAt(now)).toBeNull();
  });
  describe("another agent named as unblock owner (PAR-9398)", () => {
    const HOUR = 60 * 60 * 1000;
    const blockedAt = new Date(now.getTime() - 30 * HOUR);
    const at = (hours: number) => new Date(blockedAt.getTime() + hours * HOUR);

    async function seedOwner(ctx: Awaited<ReturnType<typeof seedCompany>>, status = "idle") {
      const ownerId = randomUUID();
      await db.insert(agents).values({
        id: ownerId,
        companyId: ctx.companyId,
        name: "Owner",
        role: "engineer",
        status,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      return ownerId;
    }

    async function seedOwned(ownerStatus = "idle", assigneeStatus = "idle") {
      const ctx = await seedCompany(assigneeStatus);
      const ownerId = await seedOwner(ctx, ownerStatus);
      const issueId = await seedIssue(ctx, {
        blockedTransitionAt: blockedAt,
        unblockDescriptor: { owner: { agentId: ownerId }, action: "Grant the deploy key" },
      });
      return { ctx, ownerId, issueId };
    }

    async function renotices(issueId: string) {
      return db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, BLOCKED_OWNER_RENOTIFIED_ACTION)));
    }

    it("moves the issue as before when the descriptor names the assignee itself", async () => {
      const ctx = await seedCompany();
      const issueId = await seedIssue(ctx, {
        blockedTransitionAt: blockedAt,
        unblockDescriptor: { owner: { agentId: ctx.agentId }, action: "Re-check CI" },
      });
      const { sweeper, wakeup } = makeSweeper();

      await sweeper.sweep(at(1));

      expect(await statusOf(issueId)).toBe("todo");
      expect(wakeup).toHaveBeenCalledWith(ctx.agentId, expect.objectContaining({ reason: "issue_status_changed" }));
      expect(await renotices(issueId)).toHaveLength(0);
    });

    it("does nothing before 24 hours have passed since the block", async () => {
      const { issueId } = await seedOwned();
      const { sweeper, wakeup } = makeSweeper();

      const result = await sweeper.sweep(at(23.9));

      expect(result).toMatchObject({ moved: 0, renotified: 0 });
      expect(await statusOf(issueId)).toBe("blocked");
      expect(wakeup).not.toHaveBeenCalled();
      expect(await renotices(issueId)).toHaveLength(0);
    });

    it("re-notices the owner at 24 hours with a numbered key, as the system sweeper, and does not move", async () => {
      const { ctx, ownerId, issueId } = await seedOwned();
      const { sweeper, wakeup } = makeSweeper();

      const result = await sweeper.sweep(at(24));

      expect(result).toMatchObject({ moved: 0, renotified: 1 });
      expect(await statusOf(issueId)).toBe("blocked");
      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(wakeup).toHaveBeenCalledWith(ownerId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_unblock_requested",
        idempotencyKey: `issue-unblock:${issueId}:${blockedAt.toISOString()}:n1`,
        requestedByActorType: "system",
        requestedByActorId: "blocked_issue_sweeper",
        payload: { issueId, action: "Grant the deploy key" },
        contextSnapshot: { wakeReason: "issue_unblock_requested", issueId, taskId: issueId },
      });
      expect(wakeup).not.toHaveBeenCalledWith(ctx.agentId, expect.anything());
      const rows = await renotices(issueId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actorType).toBe("system");
      expect(rows[0]?.details).toMatchObject({ blockedTransitionAt: blockedAt.toISOString(), count: 1 });
    });

    it("keeps the re-notice apart from the notice sent at block time", async () => {
      const { ownerId, issueId } = await seedOwned();
      // The queue returns the request it stored; a coalesced or skipped one would be marked.
      const wakeup = vi.fn(async () => ({ id: randomUUID(), status: "queued" }));
      const sweeper = blockedIssueSweeper(db, { wakeup });

      await sweeper.sweep(at(24));

      const opts = (wakeup.mock.calls[0] as unknown as [string, { idempotencyKey: string }])[1];
      const blockTimeKey = `issue-unblock:${issueId}:${blockedAt.toISOString()}`;
      expect(wakeup.mock.calls[0]?.[0]).toBe(ownerId);
      expect(opts.idempotencyKey).not.toBe(blockTimeKey);
      expect(opts.idempotencyKey.startsWith(`${blockTimeKey}:n`)).toBe(true);
      const [row] = await renotices(issueId);
      expect(row?.details).not.toHaveProperty("wakeFailed");
    });

    it("sends the second re-notice 24 hours after the first, then moves to todo 24 hours later", async () => {
      const { ctx, ownerId, issueId } = await seedOwned();
      const { sweeper, wakeup } = makeSweeper();

      expect((await sweeper.sweep(at(24))).renotified).toBe(1);
      expect((await sweeper.sweep(at(47.9))).renotified).toBe(0);
      expect((await sweeper.sweep(at(48))).renotified).toBe(1);
      expect(wakeup).toHaveBeenLastCalledWith(
        ownerId,
        expect.objectContaining({ idempotencyKey: `issue-unblock:${issueId}:${blockedAt.toISOString()}:n2` }),
      );
      expect(await statusOf(issueId)).toBe("blocked");
      expect((await renotices(issueId)).map((r) => (r.details as { count: number }).count).sort()).toEqual([1, 2]);

      const before72 = await sweeper.sweep(at(71.9));
      expect(before72).toMatchObject({ moved: 0, renotified: 0 });
      expect(await statusOf(issueId)).toBe("blocked");
      expect(wakeup).toHaveBeenCalledTimes(2);

      const fallback = await sweeper.sweep(at(72));
      expect(fallback).toMatchObject({ moved: 1, renotified: 0 });
      expect(await statusOf(issueId)).toBe("todo");
      expect(wakeup).toHaveBeenCalledTimes(3);
      expect(wakeup).toHaveBeenLastCalledWith(
        ctx.agentId,
        expect.objectContaining({
          reason: "issue_status_changed",
          contextSnapshot: expect.objectContaining({ source: "blocked_issue_sweeper" }),
        }),
      );
      const [swept] = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.blocked_swept_to_todo")));
      expect(swept?.details).toMatchObject({ reason: "owner_did_not_act", status: "todo" });
      expect(await renotices(issueId)).toHaveLength(2);
    });

    it.each([
      ["the owner", "paused", "idle"],
      ["the assignee", "idle", "paused"],
    ])("leaves the issue alone when %s is unhealthy", async (_who, ownerStatus, assigneeStatus) => {
      const { issueId } = await seedOwned(ownerStatus, assigneeStatus);
      const { sweeper, wakeup } = makeSweeper();

      await sweeper.sweep(at(24));
      await sweeper.sweep(at(80));

      expect(await statusOf(issueId)).toBe("blocked");
      expect(wakeup).not.toHaveBeenCalled();
      expect(await renotices(issueId)).toHaveLength(0);
    });

    it("treats an owner that is itself blocked as one that ignored the notice", async () => {
      const { ctx, ownerId, issueId } = await seedOwned();
      // The owner's own work is blocked too (recently, so it is not swept here).
      await seedIssue(ctx, { assigneeAgentId: ownerId, blockedTransitionAt: new Date(at(72).getTime() - 60_000) });
      const { sweeper, wakeup } = makeSweeper();

      await sweeper.sweep(at(24));
      await sweeper.sweep(at(48));
      expect(wakeup).toHaveBeenCalledTimes(2);
      expect(await statusOf(issueId)).toBe("blocked");

      await sweeper.sweep(at(72));
      expect(await statusOf(issueId)).toBe("todo");
      expect(wakeup).toHaveBeenLastCalledWith(ctx.agentId, expect.objectContaining({ reason: "issue_status_changed" }));
    });

    it("starts a new count when the issue is blocked again", async () => {
      const { ownerId, issueId } = await seedOwned();
      const { sweeper, wakeup } = makeSweeper();
      await sweeper.sweep(at(24));
      await sweeper.sweep(at(48));

      const reblockedAt = at(50);
      await db.update(issues).set({ blockedTransitionAt: reblockedAt }).where(eq(issues.id, issueId));
      const reblockAt = (hours: number) => new Date(reblockedAt.getTime() + hours * HOUR);

      expect((await sweeper.sweep(reblockAt(23))).renotified).toBe(0);
      expect((await sweeper.sweep(reblockAt(24))).renotified).toBe(1);
      expect(wakeup).toHaveBeenLastCalledWith(
        ownerId,
        expect.objectContaining({ idempotencyKey: `issue-unblock:${issueId}:${reblockedAt.toISOString()}:n1` }),
      );
      expect(await statusOf(issueId)).toBe("blocked");
      const counts = (await renotices(issueId)).map((r) => r.details as { blockedTransitionAt: string; count: number });
      expect(counts.filter((d) => d.blockedTransitionAt === reblockedAt.toISOString()).map((d) => d.count)).toEqual([1]);
    });

    it.each([
      ["reassigned", (ctxAgent: string, owner: string) => ({ assigneeAgentId: owner }) as Partial<typeof issues.$inferInsert>],
      ["unblocked", () => ({ status: "todo" }) as Partial<typeof issues.$inferInsert>],
    ])("skips an issue %s between the scan and the re-notice", async (_label, change) => {
      const { ctx, ownerId, issueId } = await seedOwned();
      betweenScanAndAct.hook = async (id) => {
        if (id === issueId) await db.update(issues).set(change(ctx.agentId, ownerId)).where(eq(issues.id, issueId));
      };
      const { sweeper, wakeup } = makeSweeper();

      const result = await sweeper.sweep(at(24));

      expect(result).toMatchObject({ moved: 0, renotified: 0, skipped: 1 });
      expect(wakeup).not.toHaveBeenCalled();
      expect(await renotices(issueId)).toHaveLength(0);
    });
  });
});
