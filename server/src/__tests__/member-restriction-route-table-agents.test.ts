import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentApiKeys, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentChatMessageRoutes } from "../routes/agent-chat-messages.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { MEMBER_RESTRICTION_ROUTE_TABLE, createRouteClassifier } from "../services/member-restriction/route-table.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12736 (C4c-1): the agent, run, chat and agent key rows of the route
 * table. Spec PAR-12608 rev 3, 4.6 and 4.7. AC-G3: R (restricted in Y) asking
 * through each `open` row for an object that is not his gets "not found" or a
 * list without it; with the kill switch `off`, today's answer (AC-F8). AC-G4:
 * the agent list holds exactly his listed agents with five fields. AC-G5: a
 * run on his task is his only when it works for him. AC-G1 and AC-H4: the key,
 * configuration and company-wide run routes classify as closed. Scope callers
 * (section 8): R as owner of X, and an instance admin who is no member of Y,
 * get today's answer. AC-X1: a failed restriction read answers 503, no data.
 * PAR-13135 (C4c-3b): the `run` rows: a run working for R reads its own
 * identity as six fields (AC-A2) and opens a chat only as an agent on his list.
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
const THIS_FILE = "server/src/__tests__/member-restriction-route-table-agents.test.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  resolverFails.on = false;
});

describe("agent route rows database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
/** In one company: an agent not on R's list, and a run on R's task that works for O. */
type Ids = { companyId: string; agentId: string; runId: string };
type Case = {
  row: string;
  send: (client: request.SuperTest<request.Test>, ids: Ids) => request.Test;
  refused: (res: request.Response, ids: Ids) => void;
  reached: (res: request.Response, ids: Ids) => void;
};

const ok = (res: request.Response) => expect(res.status, JSON.stringify(res.body)).toBe(200);
const notFound = (error: string) => (res: request.Response) => {
  expect(res.status, JSON.stringify(res.body)).toBe(404);
  expect(res.body).toEqual({ error });
};
const agentIds = (res: request.Response) => res.body.map((row: { id: string }) => row.id);
const isAgent = (res: request.Response, { agentId }: Ids) => { ok(res); expect(res.body.id).toBe(agentId); };
const isRun = (res: request.Response) => ok(res);
/** The fixture run has no stored log: past both run checks the log store answers "Run log not found". */
const isRunLog = (res: request.Response) => notFound("Run log not found")(res);
const runNotFound = notFound("Heartbeat run not found");
const agentNotFound = notFound("Agent not found");

const CASES: Case[] = [
  { row: "GET /api/companies/:companyId/agents", send: (c, { companyId }) => c.get(`/api/companies/${companyId}/agents`),
    refused: (res, { agentId }) => { ok(res); expect(agentIds(res)).not.toContain(agentId); },
    reached: (res, { agentId }) => { ok(res); expect(agentIds(res)).toContain(agentId); } },
  { row: "GET /api/agents/:id", send: (c, { agentId }) => c.get(`/api/agents/${agentId}`), refused: agentNotFound, reached: isAgent },
  { row: "GET /api/heartbeat-runs/:runId", send: (c, { runId }) => c.get(`/api/heartbeat-runs/${runId}`), refused: runNotFound, reached: isRun },
  { row: "GET /api/heartbeat-runs/:runId/events", send: (c, { runId }) => c.get(`/api/heartbeat-runs/${runId}/events`), refused: runNotFound, reached: isRun },
  { row: "GET /api/heartbeat-runs/:runId/log", send: (c, { runId }) => c.get(`/api/heartbeat-runs/${runId}/log`), refused: runNotFound, reached: isRunLog },
  // A chat is its person's alone (PAR-12774), today too: O's chat with the agent is never in R's list.
  { row: "GET /api/companies/:companyId/chats", send: (c, { companyId }) => c.get(`/api/companies/${companyId}/chats`),
    refused: (res, { agentId }) => { ok(res); expect(res.body.map((row: { assigneeAgentId: string }) => row.assigneeAgentId)).not.toContain(agentId); },
    reached: ok },
  { row: "GET /api/companies/:companyId/chats/:agentRef", send: (c, { companyId, agentId }) => c.get(`/api/companies/${companyId}/chats/${agentId}`),
    refused: agentNotFound, reached: ok },
  { row: "POST /api/companies/:companyId/chats/:agentRef", send: (c, { companyId, agentId }) => c.post(`/api/companies/${companyId}/chats/${agentId}`),
    refused: agentNotFound, reached: (res) => { ok(res); expect(res.body.conversationAgentId).toBeTruthy(); } },
];

/** The `run` rows of this file, each with its own describe block below. */
const RUN_ROWS = ["GET /api/agents/me", "POST /api/agents/me/chat/messages"];

/** The closed rows of this area (AC-G1: the key routes, an agent's secrets and connector credentials; AC-G4: configuration and instructions; AC-H4). */
const CLOSED_ROWS = [
  "POST /api/agents/me/secret-proposals",
  "GET /api/agents/me/secret-proposals",
  "DELETE /api/agents/me/secret-proposals/:id",
  "GET /api/agents/me/secrets",
  "POST /api/agents/me/secrets/:key/value",
  "POST /api/agents/me/connections/:connectionId/start-authorization",
  "POST /api/agents/me/connections/:connectionId/token",
  "GET /api/agents/:id/keys",
  "POST /api/agents/:id/keys",
  "DELETE /api/agents/:id/keys/:keyId",
  "GET /api/agents/:id/configuration",
  "GET /api/agents/:id/instructions-bundle",
  "POST /api/agents/:id/pause",
  "GET /api/companies/:companyId/org",
  "GET /api/companies/:companyId/heartbeat-runs",
  "GET /api/companies/:companyId/live-runs",
];

it("every open and run row of this file has exactly one case, and each case is a row of its class", () => {
  const rows = MEMBER_RESTRICTION_ROUTE_TABLE.filter((entry) => entry.test === THIS_FILE).map((entry) => `${entry.method} ${entry.path}`);
  expect([...CASES.map((entry) => entry.row), ...RUN_ROWS].sort()).toEqual([...rows].sort());
  const classOf = (row: string) => MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => `${item.method} ${item.path}` === row)!.class;
  for (const entry of CASES) expect(classOf(entry.row), entry.row).toBe("open");
  for (const row of RUN_ROWS) expect(classOf(row), row).toBe("run");
});

it("AC-G1: GET /api/agents/me is its own run row; an agent by id stays the open /api/agents/:id row", async () => {
  const classify = createRouteClassifier();
  expect(await classify("GET", "/api/agents/me")).toMatchObject({ kind: "matched", entry: { path: "/api/agents/me", class: "run" } });
  expect(await classify("GET", `/api/agents/${randomUUID()}`)).toMatchObject({ kind: "matched", entry: { path: "/api/agents/:id", class: "open" } });
});

it("AC-G1, AC-G4 and AC-H4: keys, configuration, instructions, pausing, the org chart and the run lists classify as closed", async () => {
  const classify = createRouteClassifier();
  for (const row of CLOSED_ROWS) {
    const entry = MEMBER_RESTRICTION_ROUTE_TABLE.find((item) => `${item.method} ${item.path}` === row);
    expect(entry?.class, row).toBe("closed");
    const sample = entry!.path.replace(/:[A-Za-z]+/g, () => randomUUID());
    const result = await classify(entry!.method, sample);
    expect(result.kind === "matched" ? result.entry.class : result.kind, `${entry!.method} ${sample}`).toBe("closed");
  }
});

(support.supported ? describe : describe.skip)("agent, run and chat rows of the route table (PAR-12608 4.6, AC-G3, AC-G4, AC-G5)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;

  const O = `owner-${randomUUID()}`, R = `restricted-${randomUUID()}`, U = `operator-${randomUUID()}`;
  const ADMIN = `instance-admin-${randomUUID()}`;
  let Y = "", X = "", listedAgent = "";

  const as = (who: Actor) => { actor = who; return request(app); };
  const boardFor = async (userId: string, isInstanceAdmin = false): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return { type: "board", userId, source: "session", isInstanceAdmin, memberships,
      companyIds: memberships.map((row: { companyId: string }) => row.companyId) } as Actor;
  };
  const agent = async (companyId: string, name = `Agent ${randomUUID().slice(0, 6)}`) => {
    const [row] = await db.insert(agents).values({ companyId, name, title: "Writer", icon: "pen", role: "engineer",
      status: "idle", adapterType: "process", adapterConfig: { command: "secret-host-command" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }).returning();
    return row!.id;
  };
  const task = async (companyId: string, owner: string) => {
    const [row] = await db.insert(issues).values({ companyId, title: `Task ${randomUUID().slice(0, 8)}`, status: "todo",
      createdByUserId: owner, responsibleUserId: owner }).returning();
    return row!.id;
  };
  const run = async (companyId: string, agentId: string, issueId: string, worksFor: string) => {
    const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, scopeKind: "issue",
      status: "succeeded", responsibleUserId: worksFor }).returning();
    return row!.id;
  };
  /** An agent off R's list, and a run on R's task in that company that works for O. */
  const ids = async (companyId: string): Promise<Ids> => {
    const agentId = await agent(companyId);
    return { companyId, agentId, runId: await run(companyId, agentId, await task(companyId, R), O) };
  };
  const today = async <T,>(send: () => Promise<T>): Promise<T> => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    try { return await send(); } finally { vi.unstubAllEnvs(); }
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-route-table-agents-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use("/api", agentRoutes(db));
    app.use("/api", agentChatMessageRoutes(db));
    app.use(errorHandler);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });

    const [y, x] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce", requireBoardApprovalForNewAgents: false },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce", requireBoardApprovalForNewAgents: false },
    ]).returning();
    Y = y!.id; X = x!.id;
    listedAgent = await agent(Y, "Listed");
    const now = new Date();
    await db.insert(authUsers).values([O, R, U, ADMIN].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: U, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true,
        restrictedAgentIds: [listedAgent] },
      { companyId: X, principalType: "user", principalId: R, status: "active", membershipRole: "owner" },
    ]);
    await ensureHumanRoleDefaultGrants(db, { companyId: Y, principalId: U, membershipRole: "owner", grantedByUserId: null });
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  describe.each(CASES)("$row", (entry) => {
    it("AC-G3 and AC-F8: R (restricted in Y) does not get the object that is not his; with the kill switch `off`, today's answer", async () => {
      const target = await ids(Y);
      const send = async () => entry.send(as(await boardFor(R)), target);
      entry.refused(await send(), target);
      entry.reached(await today(send), target);
    });

    it("scope callers: R as owner of X, and an instance admin who is no member of Y, get today's answer", async () => {
      const inX = await ids(X);
      const ownX = async () => entry.send(as(await boardFor(R)), inX);
      const ownXNow = await ownX();
      entry.reached(ownXNow, inX);
      expect(ownXNow.status).toBe((await today(ownX)).status);
      const inY = await ids(Y);
      const admin = async () => entry.send(as(await boardFor(ADMIN, true)), inY);
      const adminNow = await admin();
      const adminToday = await today(admin);
      expect(adminNow.status, JSON.stringify(adminNow.body)).toBe(adminToday.status);
      if (adminToday.body?.error) expect(adminNow.body).toEqual(adminToday.body);
    });

    it("AC-X1: answers 503 MEMBER_RESTRICTION_UNAVAILABLE and no data when the restriction cannot be read", async () => {
      const target = await ids(Y);
      const caller = await boardFor(R);
      resolverFails.on = true;
      const res = await entry.send(as(caller), target);
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
      expect(JSON.stringify(res.body)).not.toContain(target.agentId);
    });
  });

  it("AC-G4: the list holds exactly his listed agent with the five fields; the listed agent by id has the same five", async () => {
    await agent(Y);
    const list = await as(await boardFor(R)).get(`/api/companies/${Y}/agents`);
    ok(list);
    const five = { id: listedAgent, name: "Listed", title: "Writer", icon: "pen", status: "idle" };
    expect(list.body).toEqual([five]);
    const detail = await as(await boardFor(R)).get(`/api/agents/${listedAgent}`);
    ok(detail);
    expect(detail.body).toEqual(five);
  });

  it("AC-G5: a run on his task is readable when it works for him and \"not found\" when it works for O; a run working for him on O's task is \"not found\"", async () => {
    const mine = await task(Y, R);
    const forR = await run(Y, listedAgent, mine, R);
    const forO = await run(Y, listedAgent, mine, O);
    const onOwnersTask = await run(Y, listedAgent, await task(Y, O), R);
    for (const suffix of ["", "/events", "/log"]) {
      const get = async (runId: string) => as(await boardFor(R)).get(`/api/heartbeat-runs/${runId}${suffix}`);
      (suffix === "/log" ? isRunLog : ok)(await get(forR));
      runNotFound(await get(forO));
      runNotFound(await get(onOwnersTask));
    }
  });

  it("chat: R opens the chat with his listed agent", async () => {
    const res = await as(await boardFor(R)).post(`/api/companies/${Y}/chats/${listedAgent}`);
    ok(res);
    expect(res.body.conversationAgentId).toBe(listedAgent);
  });

  /** A run's actor as `auth.ts` builds it: the person it works for, his memberships, and the authorizer. */
  const runFor = async (people: { onBehalfOf?: string; authorizing?: string },
    agentId = listedAgent, companyId = Y, runId = randomUUID()): Promise<Actor> => {
    const onBehalfOfUserId = people.onBehalfOf ?? null;
    const onBehalfOfMemberships = onBehalfOfUserId
      ? await loadActorMemberships(db, { userId: onBehalfOfUserId, companyId, activeOnly: true }) : [];
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt", onBehalfOfUserId,
      ...(people.authorizing ? { authorizingUserId: people.authorizing } : {}), onBehalfOfMemberships } as Actor;
  };

  describe.each([
    { name: "a run working for R", people: { onBehalfOf: R } },
    { name: "a run authorized by R with no person", people: { authorizing: R } },
    { name: "a run working for O and authorized by R", people: { onBehalfOf: O, authorizing: R } },
  ])("the open rows as $name: the same answers as R", ({ people }) => {
    it("AC-G4: the list holds his listed agent with five fields; an agent off his list is \"not found\"", async () => {
      const { agentId } = await ids(Y);
      const list = await as(await runFor(people)).get(`/api/companies/${Y}/agents`);
      ok(list);
      expect(list.body).toEqual([{ id: listedAgent, name: "Listed", title: "Writer", icon: "pen", status: "idle" }]);
      agentNotFound(await as(await runFor(people)).get(`/api/agents/${agentId}`));
    });

    it("AC-G5: a run on R's task working for O is \"not found\"; one working for R is readable", async () => {
      const { runId } = await ids(Y);
      runNotFound(await as(await runFor(people)).get(`/api/heartbeat-runs/${runId}`));
      ok(await as(await runFor(people)).get(`/api/heartbeat-runs/${await run(Y, listedAgent, await task(Y, R), R)}`));
    });
  });

  it("H1 control: a run that carries no person gets today's answer", async () => {
    const target = await ids(Y);
    for (const [path, check] of [
      [`/api/companies/${Y}/agents`, (res: request.Response) => { ok(res); expect(agentIds(res)).toContain(target.agentId); }],
      [`/api/agents/${target.agentId}`, (res: request.Response) => isAgent(res, target)],
      [`/api/heartbeat-runs/${target.runId}`, isRun],
    ] as const) {
      const now = await as(await runFor({})).get(path);
      check(now);
      expect(now.body).toEqual((await today(async () => as(await runFor({})).get(path))).body);
    }
  });

  describe("GET /api/agents/me (run row, AC-A2)", () => {
    const SIX = ["companyId", "id", "name", "role", "status", "title"];
    const me = async (who: Actor) => as(who).get("/api/agents/me");
    const sixKeys = (res: request.Response) => { ok(res); expect(Object.keys(res.body).sort()).toEqual(SIX); };
    const fullView = (res: request.Response, agentId = listedAgent) => {
      ok(res);
      expect(res.body).toMatchObject({ id: agentId });
      expect(res.body).toHaveProperty("adapterConfig");
      expect(res.body).toHaveProperty("runtimeConfig");
    };

    it("a run for R reads exactly six fields; for O, and with the kill switch `off` (AC-F8), today's full view", async () => {
      const mine = await me(await runFor({ onBehalfOf: R }));
      sixKeys(mine);
      for (const key of ["adapterConfig", "runtimeConfig", "keyScope", "permissions"]) expect(mine.body).not.toHaveProperty(key);
      fullView(await me(await runFor({ onBehalfOf: O })));
      fullView(await today(async () => me(await runFor({ onBehalfOf: R }))));
    });

    it("kept as today: R's browser session 401, the task_bridge view, the trust preset `denied` 403", async () => {
      expect((await me(await boardFor(R))).body).toEqual({ error: "Agent authentication required" });
      const bridge = { ...(await runFor({ onBehalfOf: R })), keyScope: { kind: "task_bridge" } } as Actor;
      const bridged = await me(bridge);
      ok(bridged);
      expect(bridged.body.keyScope).toEqual({ kind: "task_bridge" });
      const [denied] = await db.insert(agents).values({ companyId: Y, name: "Denied", adapterType: "process",
        permissions: { trustPreset: "no-such-preset" } }).returning();
      const res = await me(await runFor({ onBehalfOf: R }, denied!.id));
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toEqual((await today(async () => me(await runFor({ onBehalfOf: R }, denied!.id)))).body);
    });

    it("AC-X1: a run for R gets 503 and no agent field; a run for O and a run with no person are answered with no read", async () => {
      const [forR, forO, nobody] = [await runFor({ onBehalfOf: R }), await runFor({ onBehalfOf: O }), await runFor({})];
      resolverFails.on = true;
      const res = await me(forR);
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
      expect(res.body).not.toHaveProperty("id");
      fullView(await me(forO));
      fullView(await me(nobody));
    });

    it("scope callers (AC-G12): a run for R of an agent in X, and a run for an instance admin, get today's answer", async () => {
      const inX = await agent(X);
      fullView(await me(await runFor({ onBehalfOf: R }, inX, X)), inX);
      const admin = async () => me(await runFor({ onBehalfOf: ADMIN }));
      expect((await admin()).body).toEqual((await today(admin)).body);
    });

    it("real auth: R's agent key and R's run token read six fields; O's key reads the full view", async () => {
      const server = express();
      server.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
      server.use("/api", agentRoutes(db));
      server.use(errorHandler);
      const keyFor = async (userId: string) => {
        const token = `pcp_${randomUUID()}`;
        await db.insert(agentApiKeys).values({ companyId: Y, agentId: listedAgent, responsibleUserId: userId, name: "me",
          keyHash: createHash("sha256").update(token).digest("hex") });
        return token;
      };
      const bearer = async (token: string) => request(server).get("/api/agents/me").set("authorization", `Bearer ${token}`);
      sixKeys(await bearer(await keyFor(R)));
      vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "member-restriction-route-table-agents");
      sixKeys(await bearer(createLocalAgentJwt(listedAgent, Y, "process", randomUUID(), R)));
      fullView(await bearer(await keyFor(O)));
    });
  });

  describe("POST /api/agents/me/chat/messages (run row: a chat opens only with an agent on his list)", () => {
    /** A `running` run of `agentId` on `issueId` working for `worksFor`, holding the task (agent-chat-messages.test.ts). */
    const runningRun = async (companyId: string, agentId: string, issueId: string, worksFor: string) => {
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, scopeKind: "issue",
        status: "running", responsibleUserId: worksFor }).returning();
      await db.update(issues).set({ assigneeAgentId: agentId, executionRunId: row!.id,
        identifier: `CH-${randomUUID().slice(0, 8)}` }).where(eq(issues.id, issueId));
      return runFor({ onBehalfOf: worksFor }, agentId, companyId, row!.id);
    };
    const post = (who: Actor) => as(who).post("/api/agents/me/chat/messages").send({ body: "Done", idempotencyKey: randomUUID() });
    const chatsOf = (agentId: string) => db.select().from(issues).where(eq(issues.conversationAgentId, agentId));
    const commentsOf = (agentId: string) => db.select().from(issueComments).where(eq(issueComments.authorAgentId, agentId));
    const created = (res: request.Response) => expect(res.status, JSON.stringify(res.body)).toBe(201);

    it("the listed agent's run for R on R's task opens R's chat with that agent", async () => {
      const res = await post(await runningRun(Y, listedAgent, await task(Y, R), R));
      created(res);
      const [chat] = await db.select().from(issues).where(eq(issues.id, res.body.conversationId));
      expect(chat).toMatchObject({ conversationUserId: R, conversationAgentId: listedAgent });
    });

    it("an agent off R's list is refused with no chat and no comment; with the kill switch `off`, 201", async () => {
      const unlisted = await agent(Y);
      const res = await post(await runningRun(Y, unlisted, await task(Y, R), R));
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toEqual({ error: "Agent chat is limited to the agents on the person's list" });
      expect(await chatsOf(unlisted)).toEqual([]);
      expect(await commentsOf(unlisted)).toEqual([]);
      created(await today(async () => post(await runningRun(Y, unlisted, await task(Y, R), R))));
    });

    it("a run for R on O's task is refused by the task read; a failed read is 503; neither writes a comment", async () => {
      const [before, chatsBefore] = [(await commentsOf(listedAgent)).length, (await chatsOf(listedAgent)).length];
      const refused = await post(await runningRun(Y, listedAgent, await task(Y, O), R));
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(refused.body.error).toEqual(expect.any(String));
      expect(refused.body.error).not.toBe("Agent chat is limited to the agents on the person's list");
      const caller = await runningRun(Y, listedAgent, await task(Y, R), R);
      resolverFails.on = true;
      const failed = await post(caller);
      expect(failed.status, JSON.stringify(failed.body)).toBe(503);
      resolverFails.on = false;
      expect((await commentsOf(listedAgent)).length).toBe(before);
      expect((await chatsOf(listedAgent)).length).toBe(chatsBefore);
    });

    it("R's browser session is refused; a run for R of an agent in X (R is owner there) posts with the switch on and off", async () => {
      const res = await post(await boardFor(R));
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "An authenticated task run is required" });
      const inX = await agent(X);
      const caller = await runningRun(X, inX, await task(X, R), R);
      created(await post(caller));
      created(await today(async () => post(caller)));
    });
  });

  it("AC-H4: an unflagged owner's new key carries him, never another person", async () => {
    const res = await as(await boardFor(U)).post(`/api/agents/${listedAgent}/keys`).send({ name: "u-key", responsibleUserId: O });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.responsibleUserId).toBe(U);
  });
});
