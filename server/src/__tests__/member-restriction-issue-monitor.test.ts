import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, instanceUserRoles, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { logger } from "../middleware/logger.js";
import { issueRoutes } from "../routes/issues.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12961: a run working for a restricted member may set a monitor on its
 * own task. `runtime:manage` stays denied on the action list (PAR-12608 rev 3,
 * 4.6); `assertCanManageIssueMonitor` goes on to the assignee check when the
 * action list alone refused it. Real database and real resolver, so the
 * `refusedOnlyByMemberRestriction` flag comes from `decide()` itself.
 */

const support = await getEmbeddedPostgresTestSupport();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("issue monitor restriction database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
type Mode = "off" | "report" | "enforce";

const ASSIGNEE_403 = "Only the assignee agent or a board user can manage issue monitors";
const NATIVE_403 = "Monitors require an in-progress or in-review task assigned to this agent";

(support.supported ? describe : describe.skip)("monitors for a run working for a restricted member", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;

  const O = `owner-${randomUUID()}`;
  const U = `operator-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const ADMIN = `instance-admin-${randomUUID()}`;
  /** Y: R is restricted. X: R is owner. */
  let Y = "";
  let X = "";
  const agent: Record<"y" | "yOther" | "x", string> = { y: "", yOther: "", x: "" };

  const nextCheckAt = () => new Date(Date.now() + 3_600_000).toISOString();
  const monitorPolicy = () => ({ monitor: { nextCheckAt: nextCheckAt(), notes: "Wait for the external check." } });
  const setMode = (mode: Mode, companyId = Y) =>
    db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, companyId));
  const killSwitch = () => vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");

  const boardFor = async (userId: string, isInstanceAdmin = false): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return {
      type: "board", userId, source: "session", isInstanceAdmin, memberships,
      companyIds: memberships.map((row: { companyId: string }) => row.companyId),
    } as Actor;
  };
  /** A live heartbeat run of `agentId` working for `userId` (writes are attributed to it). */
  const runFor = async (userId: string, companyId: string, agentId: string, contextSnapshot: Record<string, unknown> = {}): Promise<Actor> => {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "running", responsibleUserId: userId, contextSnapshot,
    }).returning();
    return {
      type: "agent", companyId, agentId, runId: run!.id, source: "agent_key", onBehalfOfUserId: userId,
      onBehalfOfMemberships: await loadActorMemberships(db, { userId, activeOnly: true }),
    } as Actor;
  };
  const as = (who: Actor) => {
    actor = who;
    return request(app);
  };
  /** A task the person created (so it is his own), assigned to `assigneeAgentId`. */
  const ownTask = async (companyId: string, person: string, assigneeAgentId: string, status = "in_review") => {
    const [task] = await db.insert(issues).values({
      companyId, title: `Monitor ${randomUUID().slice(0, 8)}`, status, assigneeAgentId,
      createdByUserId: person, responsibleUserId: person,
    }).returning();
    return task!.id;
  };
  const savedMonitor = async (issueId: string) =>
    (await db.select({ at: issues.monitorNextCheckAt }).from(issues).where(eq(issues.id, issueId)))[0]?.at ?? null;
  const monitorOf = (res: request.Response) =>
    (res.body?.executionPolicy as { monitor?: { nextCheckAt?: string } } | null)?.monitor?.nextCheckAt ?? null;

  /** The route cases (tests 1 to 4): each returns the status and whether a monitor was saved. */
  type Ctx = { companyId: string; person: string; agentId: string; otherAgentId: string };
  type Outcome = { status: number; error?: string; saved: boolean };
  const ROUTE_CASES: Record<string, (who: Actor, ctx: Ctx) => Promise<Outcome>> = {
    "PATCH own task": async (who, ctx) => {
      const issueId = await ownTask(ctx.companyId, ctx.person, ctx.agentId);
      const res = await as(who).patch(`/api/issues/${issueId}`).send({ executionPolicy: monitorPolicy() });
      return { status: res.status, error: res.body?.error, saved: (await savedMonitor(issueId)) !== null };
    },
    "POST create": async (who, ctx) => {
      const res = await as(who).post(`/api/companies/${ctx.companyId}/issues`)
        .send({ title: `Monitored ${randomUUID().slice(0, 8)}`, status: "in_review", assigneeAgentId: ctx.agentId, executionPolicy: monitorPolicy() });
      return { status: res.status, error: res.body?.error, saved: res.body?.id ? (await savedMonitor(res.body.id)) !== null || monitorOf(res) !== null : false };
    },
    "POST children": async (who, ctx) => {
      const parentId = await ownTask(ctx.companyId, ctx.person, ctx.agentId);
      const res = await as(who).post(`/api/issues/${parentId}/children`)
        .send({ title: `Monitored child ${randomUUID().slice(0, 8)}`, status: "in_review", assigneeAgentId: ctx.agentId, executionPolicy: monitorPolicy() });
      return { status: res.status, error: res.body?.error, saved: res.body?.id ? (await savedMonitor(res.body.id)) !== null || monitorOf(res) !== null : false };
    },
    "PATCH, not the assignee": async (who, ctx) => {
      const issueId = await ownTask(ctx.companyId, ctx.person, ctx.otherAgentId);
      const res = await as(who).patch(`/api/issues/${issueId}`).send({ executionPolicy: monitorPolicy() });
      return { status: res.status, error: res.body?.error, saved: (await savedMonitor(issueId)) !== null };
    },
  };
  /**
   * Test 4: a low-trust run whose boundary holds the task, so it may read and
   * change it but is refused `runtime:manage` by the low-trust step: a refusal
   * that is not the action list alone.
   */
  const lowTrustPatch = async (person: string, ctx: Ctx): Promise<Outcome> => {
    const issueId = await ownTask(ctx.companyId, ctx.person, ctx.agentId);
    const who = await runFor(person, ctx.companyId, ctx.agentId, { executionPolicy: {
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      authorizationPolicy: { trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, issueIds: [issueId] } },
    } });
    const res = await as(who).patch(`/api/issues/${issueId}`).send({ executionPolicy: monitorPolicy() });
    return { status: res.status, error: res.body?.error, saved: (await savedMonitor(issueId)) !== null };
  };
  const ctxY = (person: string): Ctx => ({ companyId: Y, person, agentId: agent.y, otherAgentId: agent.yOther });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-issue-monitor-");
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
    await db.insert(authUsers).values([O, U, R, ADMIN].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: U, status: "active", membershipRole: "operator" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
      { companyId: X, principalType: "user", principalId: R, status: "active", membershipRole: "owner" },
    ]);
    await db.insert(instanceUserRoles).values({ userId: ADMIN, role: "instance_admin" });
    const rows = await db.insert(agents).values([
      { companyId: Y, name: "Agent Y", role: "engineer", adapterType: "process", status: "active" },
      { companyId: Y, name: "Other agent Y", role: "engineer", adapterType: "process", status: "active" },
      { companyId: X, name: "Agent X", role: "engineer", adapterType: "process", status: "active" },
    ]).returning();
    [agent.y, agent.yOther, agent.x] = rows.map((row) => row.id);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe("enforce", () => {
    it("1: the run for R, as the assignee, sets a monitor with PATCH /api/issues/:id", async () => {
      expect(await ROUTE_CASES["PATCH own task"]!(await runFor(R, Y, agent.y), ctxY(R))).toEqual({ status: 200, error: undefined, saved: true });
    });

    it("2: the run for R sets a monitor in the policy of a new task and of a new child", async () => {
      const run = await runFor(R, Y, agent.y);
      expect(await ROUTE_CASES["POST create"]!(run, ctxY(R))).toMatchObject({ status: 201, saved: true });
      expect(await ROUTE_CASES["POST children"]!(run, ctxY(R))).toMatchObject({ status: 201, saved: true });
    });

    it("3: the run for R that is not the assignee gets the assignee 403", async () => {
      expect(await ROUTE_CASES["PATCH, not the assignee"]!(await runFor(R, Y, agent.y), ctxY(R)))
        .toEqual({ status: 403, error: ASSIGNEE_403, saved: false });
    });

    it("4: a low-trust run for R, refused for more than the restriction, gets 403 as today", async () => {
      const outcome = await lowTrustPatch(R, ctxY(R));
      expect(outcome).toMatchObject({ status: 403, saved: false });
      expect(outcome.error).not.toBe(ASSIGNEE_403);
      killSwitch();
      expect(await lowTrustPatch(R, ctxY(R))).toMatchObject({ status: 403, saved: false });
    });

    it("8: a board user returns early, as today", async () => {
      const board = await boardFor(O);
      expect(await ROUTE_CASES["PATCH own task"]!(board, ctxY(O))).toMatchObject({ status: 200, saved: true });
      expect(await ROUTE_CASES["PATCH, not the assignee"]!(board, ctxY(O))).toMatchObject({ status: 200, saved: true });
    });
  });

  describe("report", () => {
    it("5: cases 1 to 4 give today's answers and the runtime:manage would-refuse is logged once per call", async () => {
      const warn = vi.spyOn(logger, "warn");
      const runtimeDenials = () => warn.mock.calls.filter(([fields]) =>
        (fields as { memberRestriction?: { target?: string; mode?: string } } | undefined)?.memberRestriction?.target === "runtime:manage").length;
      await setMode("report");
      try {
        const run = await runFor(R, Y, agent.y);
        for (const [name, expected] of [
          ["PATCH own task", { status: 200, saved: true }],
          ["POST create", { status: 201, saved: true }],
          ["POST children", { status: 201, saved: true }],
        ] as const) {
          const before = runtimeDenials();
          const outcome = await ROUTE_CASES[name]!(run, ctxY(R));
          expect(outcome, `${name} ${JSON.stringify(outcome)}`).toMatchObject(expected);
          expect(runtimeDenials() - before, name).toBe(1);
        }
        expect(await ROUTE_CASES["PATCH, not the assignee"]!(run, ctxY(R))).toEqual({ status: 403, error: ASSIGNEE_403, saved: false });
        expect(await lowTrustPatch(R, ctxY(R))).toMatchObject({ status: 403, saved: false });
        const report = warn.mock.calls.map(([fields]) => (fields as { memberRestriction?: { target?: string; mode?: string } })?.memberRestriction)
          .filter((entry) => entry?.target === "runtime:manage");
        expect(report.every((entry) => entry?.mode === "report")).toBe(true);
      } finally {
        await setMode("enforce");
      }
    });
  });

  describe("off and the kill switch", () => {
    /**
     * Four caller types plus the run for R, each with today's answers for the
     * route cases. `null`: no fixed code (the non-member instance admin gets
     * the route's own company-access answer); the three variants must agree.
     */
    const ALL = ["PATCH own task", "POST create", "POST children", "PATCH, not the assignee"] as const;
    const CALLERS: Array<{ name: string; caller: () => Promise<Actor>; ctx: () => Ctx; expected: Partial<Record<(typeof ALL)[number], number | null>> }> = [
      { name: "run for an unrestricted person", caller: () => runFor(U, Y, agent.y), ctx: () => ctxY(U),
        expected: { "PATCH own task": 200, "POST create": 201, "POST children": 201, "PATCH, not the assignee": 403 } },
      { name: "board user", caller: () => boardFor(O), ctx: () => ctxY(O),
        expected: { "PATCH own task": 200, "POST create": 201, "POST children": 201, "PATCH, not the assignee": 200 } },
      { name: "instance admin who is not a member", caller: () => boardFor(ADMIN, true), ctx: () => ctxY(O),
        expected: Object.fromEntries(ALL.map((name) => [name, null])) },
      { name: "R as owner of X, acting in X", caller: () => runFor(R, X, agent.x),
        ctx: () => ({ companyId: X, person: R, agentId: agent.x, otherAgentId: agent.yOther }),
        expected: { "PATCH own task": 200, "POST create": 201, "POST children": 201 } },
      { name: "run for R", caller: () => runFor(R, Y, agent.y), ctx: () => ctxY(R),
        expected: { "PATCH own task": 200, "POST create": 201, "POST children": 201, "PATCH, not the assignee": 403 } },
    ];
    const VARIANTS = {
      "mode off": async () => { await setMode("off"); },
      "kill switch": async () => { killSwitch(); },
      enforce: async () => {},
    };

    it.each(CALLERS.map((entry) => [entry.name, entry] as const))("6: %s gets today's answers with mode off, the kill switch and enforce", async (_name, entry) => {
      const observed: Record<string, number> = {};
      for (const [variant, apply] of Object.entries(VARIANTS)) {
        await apply();
        try {
          for (const [name, status] of Object.entries(entry.expected)) {
            const outcome = await ROUTE_CASES[name]!(await entry.caller(), entry.ctx());
            const label = `${variant}, ${name}: ${JSON.stringify(outcome)}`;
            const today = status ?? observed[name] ?? outcome.status;
            expect(outcome.status, label).toBe(today);
            expect(outcome.saved, label).toBe(today < 300);
            if (status === 403) expect(outcome.error, label).toBe(ASSIGNEE_403);
            observed[name] = outcome.status;
          }
          // Case 4: a low-trust run is refused as today.
          if (entry.name.startsWith("run for")) {
            expect(await lowTrustPatch(entry.name === "run for R" ? R : U, ctxY(entry.name === "run for R" ? R : U)), variant)
              .toMatchObject({ status: 403, saved: false });
          }
        } finally {
          vi.unstubAllEnvs();
          await setMode("enforce");
        }
      }
    });
  });

  /** A malformed list makes the resolver throw for R in Y (as in member-restriction-action-list.test.ts). */
  const breakResolver = () => db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '"broken"'::jsonb
    where ${companyMemberships.companyId} = ${Y} and ${companyMemberships.principalId} = ${R}`);
  const repairResolver = () => db.execute(sql`update ${companyMemberships} set restricted_plugin_keys = '[]'::jsonb
    where ${companyMemberships.companyId} = ${Y} and ${companyMemberships.principalId} = ${R}`);

  describe("failing read", () => {

    it("7: a resolver read that throws while deciding answers 503 MEMBER_RESTRICTION_UNAVAILABLE and writes no monitor", async () => {
      const issueId = await ownTask(Y, R, agent.y);
      const run = await runFor(R, Y, agent.y);
      await breakResolver();
      try {
        const res = await as(run).patch(`/api/issues/${issueId}`).send({ executionPolicy: monitorPolicy() });
        expect(res.status, JSON.stringify(res.body)).toBe(503);
        expect(res.body.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
        expect(await savedMonitor(issueId)).toBeNull();
      } finally {
        await repairResolver();
      }
    });

  });

  describe("native tool set_task_monitor", () => {
    /** The native run's responsible person is R (`#privacyActor` sets onBehalfOfUserId from it). */
    /** `target` adds a second task the tool names with `taskId` (status and assignee as given). */
    const nativeRun = async (options: { target?: { status: string; assigneeAgentId?: string } } = {}) => {
      const [nativeAgent] = await db.insert(agents).values({ companyId: Y, name: `Native ${randomUUID().slice(0, 6)}`,
        role: "engineer", adapterType: "paperclip_runner", status: "active" }).returning();
      const agentId = nativeAgent!.id, issueId = randomUUID(), runId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId: Y, title: "Native monitor", status: "in_progress",
        assigneeAgentId: agentId, createdByUserId: R, responsibleUserId: R });
      const targetId = options.target ? randomUUID() : issueId;
      if (options.target) {
        await db.insert(issues).values({ id: targetId, companyId: Y, title: "Native target", status: options.target.status,
          assigneeAgentId: options.target.assigneeAgentId ?? agentId, createdByUserId: R, responsibleUserId: R });
      }
      await db.insert(heartbeatRuns).values({ id: runId, companyId: Y, agentId, nativeIssueId: issueId, runtimeMode: "native",
        status: "running", responsibleUserId: R, contextSnapshot: { issueId } });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      const authority = new PaperclipRunnerToolAuthority(db, { companyId: Y, agentId, issueId, runId });
      const call = (key: string) => authority.execute({ tool: "set_task_monitor", callId: randomUUID(),
        arguments: { idempotencyKey: key, ...(options.target ? { taskId: targetId } : {}),
          monitor: { nextCheckAt: nextCheckAt(), notes: "Native check." } } });
      const receipts = async () => {
        const [row] = await db.select({ receipts: sql<Record<string, unknown> | null>`${heartbeatRuns.resultJson}->'semanticToolReceipts'` })
          .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        return Object.keys(row?.receipts ?? {});
      };
      return { issueId: targetId, call, receipts };
    };

    it("9: enforce, the native run for R as assignee on an in-progress task sets the monitor", async () => {
      const value = await nativeRun();
      expect(await value.call("native-enforce")).toMatchObject({ taskId: value.issueId, replayed: false });
      expect(await savedMonitor(value.issueId)).not.toBeNull();
    });

    it.each(["mode off", "kill switch"] as const)("10: %s gives the same native answer as today", async (variant) => {
      if (variant === "mode off") await setMode("off");
      else killSwitch();
      try {
        const value = await nativeRun();
        expect(await value.call("native-off")).toMatchObject({ taskId: value.issueId, replayed: false });
        expect(await savedMonitor(value.issueId)).not.toBeNull();
        const todo = await nativeRun({ target: { status: "todo" } });
        await expect(todo.call("native-off-todo")).rejects.toThrow(NATIVE_403);
      } finally {
        await setMode("enforce");
      }
    });

    it("11: enforce, not the assignee or a task not in progress or in review, is refused as today", async () => {
      const other = await nativeRun({ target: { status: "in_progress", assigneeAgentId: agent.yOther } });
      await expect(other.call("native-other")).rejects.toThrow(ASSIGNEE_403);
      expect(await savedMonitor(other.issueId)).toBeNull();
      const todo = await nativeRun({ target: { status: "todo" } });
      await expect(todo.call("native-todo")).rejects.toThrow(NATIVE_403);
      expect(await savedMonitor(todo.issueId)).toBeNull();
    });

    it("12: a resolver read that throws inside authorizeTarget fails the tool and writes no monitor and no receipt", async () => {
      const value = await nativeRun();
      await breakResolver();
      try {
        await expect(value.call("native-broken")).rejects.toMatchObject({ status: 503 });
        expect(await savedMonitor(value.issueId)).toBeNull();
        expect(await value.receipts()).toEqual([]);
      } finally {
        await repairResolver();
      }
    });
  });
});
