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
  blockedIssueSweeper,
} from "../services/blocked-issue-sweeper.js";
import { buildIssueBlockersResolvedWakeStateKey } from "../services/issue-dependency-wakeups.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("blocked issue sweeper", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const now = new Date("2026-10-28T12:00:00.000Z");
  const blockedLongAgo = new Date(now.getTime() - 45 * 60 * 1000);
  const blockedJustNow = new Date(now.getTime() - 5 * 60 * 1000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-issue-sweeper-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
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
});
