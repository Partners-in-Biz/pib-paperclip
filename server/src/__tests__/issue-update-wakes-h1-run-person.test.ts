import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  issueRelations,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.ts";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { WAKE_CAUSING_ACTOR_CONTEXT_KEY } from "../services/heartbeat/causing-actor.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-14378, H1 (PAR-12608 4.10) on the update wakes of `PATCH /issues/:id`:
 * a bound member U changes O's task; the run woken by that change works for U
 * under `enforce`, for O under `off` and `report` (`report` records "would
 * differ"). The task has an earlier run for O, so the new run would inherit
 * O's identity context: the case PAR-14375 found. The run's person is read as
 * its acting person through the real `actorMiddleware` with the run's own JWT.
 * A failed rule H read answers 503 with nothing written and no run.
 */

const seen = vi.hoisted(() => ({
  app: null as null | express.Express,
  runs: new Map<string, string | null>(),
}));
const restrictionRead = vi.hoisted(() => ({ fails: false }));

const mockAdapterExecute = vi.hoisted(() => vi.fn(async (ctx: { runId: string; authToken?: string; context?: Record<string, unknown> }) => {
  const auth = { authorization: `Bearer ${ctx.authToken}` };
  const probe = await request(seen.app!).get("/api/probe").set(auth);
  seen.runs.set(ctx.runId, probe.status === 200 ? probe.body.onBehalfOfUserId : `status ${probe.status}`);
  // A well-behaved turn ends with a disposition, so no repair run follows it.
  const issueId = typeof ctx.context?.issueId === "string" ? ctx.context.issueId : null;
  if (issueId) {
    await request(seen.app!).patch(`/api/issues/${issueId}`).set({ ...auth, "x-paperclip-run-id": ctx.runId })
      .send({ status: "done", comment: "Done." });
  }
  return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "H1 update wake run.", provider: "test", model: "test-model" };
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: true, execute: mockAdapterExecute })) };
});
vi.mock("../services/member-restriction/honest-person.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/honest-person.js")>();
  return {
    ...actual,
    honestPersonRuleFor: async (...args: Parameters<typeof actual.honestPersonRuleFor>) => {
      if (restrictionRead.fails) throw (await import("../services/member-restriction/resolver.js")).memberRestrictionUnavailable(new Error("fixture: rule H read failed"));
      return actual.honestPersonRuleFor(...args);
    },
  };
});
vi.mock("../services/member-restriction/rule-group-h.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/rule-group-h.js")>();
  return {
    ...actual,
    ruleGroupHBinding: async (...args: Parameters<typeof actual.ruleGroupHBinding>) => {
      if (restrictionRead.fails) throw (await import("../services/member-restriction/resolver.js")).memberRestrictionUnavailable(new Error("fixture: rule H read failed"));
      return actual.ruleGroupHBinding(...args);
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();

describe("H1 update wake database support", () => {
  it("embedded Postgres runs here", () => {
    if (!support.supported) console.warn(`Skipping H1 update wake tests: ${support.reason ?? "unsupported environment"}`);
    expect(typeof support.supported).toBe("boolean");
  });
});

(support.supported ? describe : describe.skip)("H1: update wakes of PATCH /issues/:id work for the person who caused them (PAR-14378)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const OWNER = `owner-${randomUUID()}`;
  const O = `o-${randomUUID()}`;
  const U = `u-${randomUUID()}`;
  let companyId = "";
  let agentX = "";
  let agentY = "";

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "issue-update-wakes-h1");
    seen.runs.clear();
    mockAdapterExecute.mockClear();
    restrictionRead.fails = false;
  });

  afterEach(async () => {
    restrictionRead.fails = false;
    vi.unstubAllEnvs();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-update-wakes-h1-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async (req) => {
        const userId = req.header("x-test-session");
        return userId ? ({ session: { id: `s-${userId}`, userId }, user: { id: userId, name: userId, email: null } } as never) : null;
      },
    }));
    const api = express.Router();
    api.use(memberRestrictionRouteGuard(db));
    api.get("/probe", (req, res) => {
      res.json({ onBehalfOfUserId: req.actor.type === "agent" ? req.actor.onBehalfOfUserId ?? null : null });
    });
    api.use(issueRoutes(db, {} as never));
    app.use("/api", api);
    app.use(errorHandler);
    seen.app = app;

    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "H1 update wakes",
      issuePrefix: `U${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, defaultResponsibleUserId: OWNER });
    const now = new Date();
    await db.insert(authUsers).values([OWNER, O, U].map((id) => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values([OWNER, O, U].map((principalId) => ({
      companyId, principalType: "user" as const, principalId, status: "active", membershipRole: principalId === OWNER ? "owner" : "operator" })));
    await db.insert(principalPermissionGrants).values([O, U].map((principalId) => ({
      companyId, principalType: "user" as const, principalId, permissionKey: "tasks:assign" })));
    const [x, y] = await db.insert(agents).values(["X", "Y"].map((name) => ({
      companyId, name, role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    }))).returning();
    agentX = x!.id;
    agentY = y!.id;
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    runningProcesses.clear();
    if (heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  }, 60_000);

  /** A fresh bound member (operator with tasks:assign): H1 records one entry per person, rule and day. */
  async function boundMember() {
    const id = `u-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: id, status: "active", membershipRole: "operator" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: id, permissionKey: "tasks:assign" });
    return id;
  }

  async function setMode(mode: "off" | "report" | "enforce") {
    await db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, companyId));
  }

  /** O's task T for agent X, with one finished run for O (T's continuation identity is O's). */
  async function primedTask() {
    const [task] = await db.insert(issues).values({ companyId, title: "O's task", status: "todo",
      assigneeAgentId: agentX, responsibleUserId: O, createdByUserId: O }).returning();
    await heartbeat.wakeup(agentX, {
      causingActor: { type: "user", userId: O }, requestedByActorType: "user", requestedByActorId: O,
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: task!.id }, contextSnapshot: { issueId: task!.id, wakeReason: "issue_assigned" },
    });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [primed] = await db.select().from(issues).where(eq(issues.id, task!.id));
    expect(primed!.continuationIdentityContextId).toBeTruthy();
    expect(primed!.status).toBe("done");
    return primed!;
  }

  type Site = {
    /** Prepares the case and returns the PATCH target, body and the issue whose wake is checked. */
    prepare: () => Promise<{ target: string; body: Record<string, unknown>; woken: string }>;
  };
  const sites: Record<string, Site> = {
    "reassigns O's task (issue_assigned)": {
      prepare: async () => {
        const task = await primedTask();
        await db.update(issues).set({ status: "todo", completedAt: null }).where(eq(issues.id, task.id));
        return { target: task.id, body: { assigneeAgentId: agentY }, woken: task.id };
      },
    },
    "moves O's done task back to todo (issue_status_changed)": {
      prepare: async () => {
        const task = await primedTask();
        return { target: task.id, body: { status: "todo" }, woken: task.id };
      },
    },
    "closes the last child of O's task (issue_children_completed)": {
      prepare: async () => {
        const task = await primedTask();
        await db.update(issues).set({ status: "in_progress", completedAt: null }).where(eq(issues.id, task.id));
        const [child] = await db.insert(issues).values({ companyId, title: "Child", status: "todo", parentId: task.id,
          responsibleUserId: O, createdByUserId: O }).returning();
        return { target: child!.id, body: { status: "done" }, woken: task.id };
      },
    },
    "closes the blocker of O's task (issue_blockers_resolved)": {
      prepare: async () => {
        const task = await primedTask();
        const [blocker] = await db.insert(issues).values({ companyId, title: "Blocker", status: "todo",
          responsibleUserId: O, createdByUserId: O }).returning();
        await db.update(issues).set({ status: "blocked", completedAt: null, blockedTransitionAt: new Date() }).where(eq(issues.id, task.id));
        await db.insert(issueRelations).values({ companyId, issueId: blocker!.id, relatedIssueId: task.id, type: "blocks", createdByUserId: O });
        return { target: blocker!.id, body: { status: "done" }, woken: task.id };
      },
    },
  };

  async function patchAs(userId: string, target: string, body: Record<string, unknown>) {
    return request(seen.app!).patch(`/api/issues/${target}`).set({ "x-test-session": userId, origin: "http://localhost" }).send(body);
  }

  /** The executed runs on the woken task since `started`, as (person the run's JWT acts for). */
  async function wokenPersons(woken: string, started: Date) {
    await vi.waitFor(async () => {
      const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), gte(heartbeatRuns.createdAt, started),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${woken}`));
      expect(rows.length).toBeGreaterThan(0);
    }, { timeout: 10_000, interval: 100 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
      gte(heartbeatRuns.createdAt, started), sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${woken}`));
    const executed = runs.filter((run) => seen.runs.has(run.id));
    expect(executed.length).toBeGreaterThan(0);
    return { runs: executed, persons: executed.map((run) => seen.runs.get(run.id)) };
  }

  async function h1Entries(since: Date) {
    return db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), gte(activityLog.createdAt, since),
      eq(activityLog.action, "member_restriction.denied"), sql`${activityLog.details} ->> 'ruleId' = 'H1'`));
  }

  describe.each(Object.keys(sites))("U %s", (site) => {
    it.each([["off", "O"], ["report", "O"], ["enforce", "U"]] as const)("rule H %s: the run works for %s", async (mode, who) => {
      await setMode(mode);
      const member = await boundMember();
      const expected = who === "O" ? O : member;
      const { target, body, woken } = await sites[site]!.prepare();
      const started = new Date();
      const res = await patchAs(member, target, body);
      expect(res.status, res.text).toBe(200);
      const { runs, persons } = await wokenPersons(woken, started);
      expect(persons).toEqual(runs.map(() => expected));
      for (const run of runs) expect(run.responsibleUserId).toBe(expected);
      const entries = await h1Entries(started);
      if (mode === "report") {
        expect(entries.length).toBeGreaterThan(0);
        expect(entries[0]!.details).toMatchObject({ personId: member, ruleId: "H1", mode: "report", target: "heartbeat.run_person" });
      } else {
        expect(entries).toEqual([]);
      }
      if (mode === "off") for (const run of runs) expect(run.contextSnapshot).not.toHaveProperty(WAKE_CAUSING_ACTOR_CONTEXT_KEY);
    });

    it("rule H read throwing: 503 MEMBER_RESTRICTION_UNAVAILABLE, nothing written, no run", async () => {
      await setMode("enforce");
      const { target, body, woken } = await sites[site]!.prepare();
      const [before] = await db.select().from(issues).where(eq(issues.id, target));
      const started = new Date();
      restrictionRead.fails = true;
      const res = await patchAs(U, target, body);
      expect(res.status, res.text).toBe(503);
      expect(res.body).toMatchObject({ code: "MEMBER_RESTRICTION_UNAVAILABLE" });
      restrictionRead.fails = false;
      const [after] = await db.select().from(issues).where(eq(issues.id, target));
      expect({ status: after!.status, assigneeAgentId: after!.assigneeAgentId, updatedAt: after!.updatedAt })
        .toEqual({ status: before!.status, assigneeAgentId: before!.assigneeAgentId, updatedAt: before!.updatedAt });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        gte(heartbeatRuns.createdAt, started), sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${woken}`));
      expect(runs).toEqual([]);
    });
  });

  it("kill switch under enforce: U reassigns O's task, the run keeps O and the context is today's", async () => {
    await setMode("enforce");
    const { target, body, woken } = await sites["reassigns O's task (issue_assigned)"]!.prepare();
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    const started = new Date();
    const res = await patchAs(U, target, body);
    expect(res.status, res.text).toBe(200);
    const { runs, persons } = await wokenPersons(woken, started);
    expect(persons).toEqual(runs.map(() => O));
    for (const run of runs) expect(run.contextSnapshot).not.toHaveProperty(WAKE_CAUSING_ACTOR_CONTEXT_KEY);
    expect(await h1Entries(started)).toEqual([]);
  });

  it.each(Object.keys(sites))("positive control under enforce: the owner %s, the run keeps O", async (site) => {
    await setMode("enforce");
    const { target, body, woken } = await sites[site]!.prepare();
    const started = new Date();
    const res = await patchAs(OWNER, target, body);
    expect(res.status, res.text).toBe(200);
    const { runs, persons } = await wokenPersons(woken, started);
    expect(persons).toEqual(runs.map(() => O));
    for (const run of runs) expect(run.contextSnapshot).not.toHaveProperty(WAKE_CAUSING_ACTOR_CONTEXT_KEY);
  });
});
