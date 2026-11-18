import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13142 (C4c-2b): the route checks of PAR-12608 rev 3, 4.7, the early
 * answers on top of the wake-queue check. R is restricted in Y (`enforce`)
 * with agent X on his list; Z is not, and reports to X. AC-A1: R cannot wake
 * Z. AC-A2: R assigns to X, not to Z (task unchanged); a person or nobody
 * stays allowed. AC-A4: X's run working for R cannot wake Z or assign to Z,
 * and may assign to X or R. AC-A5: R's comment on his task assigned to Z
 * answers `wakeSkipped`; O's does not. AC-A8: Z as a stage participant is 422,
 * for R and for X's run working for him. Every new caller: kill switch `off`
 * gives today's answer (AC-F8), a failed read is 503 (AC-X1).
 */

const resolverFails = vi.hoisted(() => ({ on: false }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  const fail = () => Promise.reject(new actual.MemberRestrictionReadError("fixture: restriction unreadable"));
  return {
    ...actual,
    memberRestrictionFor: (...args: Parameters<typeof actual.memberRestrictionFor>) =>
      resolverFails.on ? fail() : actual.memberRestrictionFor(...args),
    memberRestrictionEnforcedCompanyIds: (...args: Parameters<typeof actual.memberRestrictionEnforcedCompanyIds>) =>
      resolverFails.on ? fail() : actual.memberRestrictionEnforcedCompanyIds(...args),
    memberRestrictionResolver: (db: Parameters<typeof actual.memberRestrictionResolver>[0]) =>
      (personId: string, companyId: string) => resolverFails.on ? fail() : actual.memberRestrictionFor(db, personId, companyId),
  };
});

const support = await getEmbeddedPostgresTestSupport();

afterEach(() => {
  vi.unstubAllEnvs();
  resolverFails.on = false;
});

describe("agent route checks database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];

const notListed = (res: request.Response, status = 403) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.details).toMatchObject({ reason: "deny_member_restricted", code: "agent_not_listed" });
};
const unavailable = (res: request.Response) => {
  expect(res.status, JSON.stringify(res.body)).toBe(503);
  expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
};
const passed = (res: request.Response, status: number) => expect(res.status, JSON.stringify(res.body)).toBe(status);

(support.supported ? describe : describe.skip)("route checks of 4.7: wake, assign, execution policy, comment answer", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;

  const O = `owner-${randomUUID()}`, R = `restricted-${randomUUID()}`;
  let Y = "", X = "", Z = "";

  const as = (who: Actor) => { actor = who; return request(app); };
  const board = async (userId: string): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return { type: "board", userId, source: "session", isInstanceAdmin: false, memberships,
      companyIds: memberships.map((row: { companyId: string }) => row.companyId) } as Actor;
  };
  const task = async (assigneeAgentId: string | null = null, executionPolicy: unknown = null) => {
    const [row] = await db.insert(issues).values({ companyId: Y, title: `Task ${randomUUID().slice(0, 8)}`, status: "todo",
      createdByUserId: R, responsibleUserId: R, assigneeAgentId, executionPolicy: executionPolicy as never }).returning();
    return row!.id;
  };
  /** X's run on R's task, working for R, and its actor as `auth.ts` builds it. */
  const runForR = async (): Promise<Actor> => {
    const issueId = await task(X);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: Y, agentId: X, issueId, scopeKind: "issue",
      status: "running", responsibleUserId: R }).returning();
    const onBehalfOfMemberships = await loadActorMemberships(db, { userId: R, companyId: Y, activeOnly: true });
    return { type: "agent", agentId: X, companyId: Y, runId: run!.id, source: "agent_jwt", onBehalfOfUserId: R,
      onBehalfOfMemberships } as Actor;
  };
  const today = async <T,>(send: () => Promise<T>): Promise<T> => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    try { return await send(); } finally { vi.unstubAllEnvs(); }
  };
  const failingRead = async <T,>(send: () => Promise<T>): Promise<T> => {
    resolverFails.on = true;
    try { return await send(); } finally { resolverFails.on = false; }
  };
  const denials = async (target: string, objectId: string) => (await db.select().from(activityLog)
    .where(and(eq(activityLog.companyId, Y), eq(activityLog.action, "member_restriction.denied"))))
    .filter((row) => {
      const details = row.details as { ruleId?: string; target?: string; objectId?: string } | null;
      return details?.ruleId === "R-agent" && details.target === target && details.objectId === objectId;
    });
  const reviewer = (agentId: string) => ({ stages: [{ type: "review", participants: [{ type: "agent", agentId }] }] });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-agent-route-checks-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);

    const [y] = await db.insert(companies).values({ name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`,
      memberRestrictionMode: "enforce", requireBoardApprovalForNewAgents: false }).returning();
    Y = y!.id;
    const agentRow = async (name: string, reportsTo: string | null) => (await db.insert(agents).values({ companyId: Y, name,
      role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, reportsTo,
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }).returning())[0]!.id;
    X = await agentRow("Listed", null);
    Z = await agentRow("Unlisted", X);
    const now = new Date();
    await db.insert(authUsers).values([O, R].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true,
        restrictedAgentIds: [X] },
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe("wake (assertBoardCanWakeAgent, agentMayWakeAgent)", () => {
    const wake = async (who: Actor, agentId: string) => as(who).post(`/api/agents/${agentId}/wakeup`).send({ reason: "test" });

    it("AC-A1: R waking Z is refused with one denial entry (one per person, rule and day); waking X is not refused", async () => {
      notListed(await wake(await board(R), Z));
      notListed(await wake(await board(R), Z));
      expect(await denials("agent:wake", Z)).toHaveLength(1);
      const listed = await wake(await board(R), X);
      expect(listed.status, JSON.stringify(listed.body)).toBe((await today(async () => wake(await board(R), X))).status);
      expect(listed.body.details?.reason).not.toBe("deny_member_restricted");
    });

    it("AC-A4: X's run working for R waking Z (reports to X) is refused; waking X itself is not", async () => {
      notListed(await wake(await runForR(), Z));
      const self = await wake(await runForR(), X);
      expect(self.status, JSON.stringify(self.body)).not.toBe(403);
    });

    it("AC-F8 and AC-X1: kill switch `off` gives today's answer; a failed read is 503", async () => {
      for (const who of [() => board(R), runForR]) {
        const now = await today(async () => wake(await who(), Z));
        expect(now.status, JSON.stringify(now.body)).not.toBe(403);
        unavailable(await failingRead(async () => wake(await who(), Z)));
      }
    });
  });

  describe("tasks:assign naming an agent", () => {
    const create = async (who: Actor, body: Record<string, unknown>) =>
      as(who).post(`/api/companies/${Y}/issues`).send({ title: `New ${randomUUID().slice(0, 8)}`, ...body });
    const assignee = async (issueId: string) =>
      (await db.select({ a: issues.assigneeAgentId }).from(issues).where(eq(issues.id, issueId)))[0]!.a;

    it("AC-A2: R assigns to X; assigning to Z is refused and the task is unchanged; a person or nobody stays allowed", async () => {
      passed(await create(await board(R), { assigneeAgentId: X }), 201);
      notListed(await create(await board(R), { assigneeAgentId: Z }));
      passed(await create(await board(R), { assigneeUserId: R }), 201);
      passed(await create(await board(R), {}), 201);
      const mine = await task();
      notListed(await as(await board(R)).patch(`/api/issues/${mine}`).send({ assigneeAgentId: Z }));
      expect(await assignee(mine)).toBeNull();
      passed(await as(await board(R)).patch(`/api/issues/${mine}`).send({ assigneeAgentId: X }), 200);
      expect(await assignee(mine)).toBe(X);
    });

    it("AC-A4: X's run working for R assigns a child to Z: refused; to X or to R: accepted", async () => {
      const parentId = await task(X);
      notListed(await create(await runForR(), { parentId, assigneeAgentId: Z }));
      passed(await create(await runForR(), { parentId, assigneeAgentId: X }), 201);
      passed(await create(await runForR(), { parentId, assigneeUserId: R }), 201);
    });

    it("AC-F8 and AC-X1: kill switch `off` lets R assign to Z; a failed read is 503 and nothing is written", async () => {
      passed(await today(async () => create(await board(R), { assigneeAgentId: Z })), 201);
      const mine = await task();
      unavailable(await failingRead(async () => as(await board(R)).patch(`/api/issues/${mine}`).send({ assigneeAgentId: Z })));
      expect(await assignee(mine)).toBeNull();
    });
  });

  describe("execution policy participants (AC-A8)", () => {
    const create = async (who: Actor, agentId: string) =>
      as(who).post(`/api/companies/${Y}/issues`).send({ title: `Reviewed ${randomUUID().slice(0, 8)}`, executionPolicy: reviewer(agentId) });
    const patch = async (who: Actor, issueId: string, agentId: string) =>
      as(who).patch(`/api/issues/${issueId}`).send({ executionPolicy: reviewer(agentId) });

    it("R naming Z as reviewer is 422 on create and on update; naming X is accepted", async () => {
      notListed(await create(await board(R), Z), 422);
      passed(await create(await board(R), X), 201);
      const mine = await task();
      notListed(await patch(await board(R), mine, Z), 422);
      expect((await db.select({ p: issues.executionPolicy }).from(issues).where(eq(issues.id, mine)))[0]!.p).toBeNull();
      passed(await patch(await board(R), mine, X), 200);
    });

    it("X's run working for R naming Z is 422", async () => {
      notListed(await patch(await runForR(), await task(X), Z), 422);
    });

    it("a reviewer the stored policy already names stays: R re-sending it is accepted", async () => {
      passed(await patch(await board(R), await task(null, reviewer(Z)), Z), 200);
    });

    it("AC-F8 and AC-X1: kill switch `off` accepts Z; a failed read is 503", async () => {
      passed(await today(async () => create(await board(R), Z)), 201);
      unavailable(await failingRead(async () => create(await board(R), Z)));
    });
  });

  describe("the comment answer (AC-A5)", () => {
    const comment = async (who: Actor, issueId: string) =>
      as(who).post(`/api/issues/${issueId}/comments`).send({ body: `note ${randomUUID().slice(0, 6)}` });

    it("R's comment on his task assigned to Z carries wakeSkipped; O's does not; with X assigned, none", async () => {
      const onZ = await task(Z);
      const mine = await comment(await board(R), onZ);
      passed(mine, 201);
      expect(mine.body.wakeSkipped).toBe("agent_not_listed");
      const owners = await comment(await board(O), onZ);
      passed(owners, 201);
      expect(owners.body).not.toHaveProperty("wakeSkipped");
      const onX = await comment(await board(R), await task(X));
      passed(onX, 201);
      expect(onX.body).not.toHaveProperty("wakeSkipped");
    });

    it("AC-F8 and AC-X1: kill switch `off`, no wakeSkipped; a failed read is 503 and no comment is saved", async () => {
      const onZ = await task(Z);
      const now = await today(async () => comment(await board(R), onZ));
      passed(now, 201);
      expect(now.body).not.toHaveProperty("wakeSkipped");
      const other = await task(Z);
      unavailable(await failingRead(async () => comment(await board(R), other)));
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, other))).toHaveLength(0);
    });
  });
});
