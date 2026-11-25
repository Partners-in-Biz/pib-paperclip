import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, issues, plugins } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { companyRoutes } from "../routes/companies.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { issueTreeControlRoutes } from "../routes/issue-tree-control.js";
import { issueRoutes } from "../routes/issues.js";
import { pluginRoutes } from "../routes/plugins.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { withoutHostKeys } from "../services/member-restriction/response-strip.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { MEMBER_RESTRICTION_ROUTE_TABLE } from "../services/member-restriction/route-table.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12744 (C-sweep-2): the scope callers. AC-G9: R is owner in X and
 * restricted in Y, both on `enforce`. AC-G12: one route of each class `open`,
 * `run`, `plugin` and `closed`; an instance admin who is not a member gets
 * today's answer (the answer with the kill switch `off`), R gets the AC-G9
 * answers. Also the three tree-control reads C4i-a closed (PAR-12934): R on his
 * own root 403, the owner today's answer. And Vera's PAR-12718 item: R exports
 * X, not Y. Real routes, the real route-table middleware and the real resolver.
 */

const support = await getEmbeddedPostgresTestSupport();
const REFUSED = { status: 403, body: expect.objectContaining({ error: "Not available for your access level", code: "MEMBER_RESTRICTED" }) };
type Actor = Express.Request["actor"];
type Answer = { status: number; body: unknown };
const DATE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;
const answer = (res: request.Response): Answer =>
  ({ status: res.status, body: JSON.parse(JSON.stringify(res.body ?? null).replace(DATE, "<time>")) });

describe("scope callers database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => expect(support.supported).toBe(true));
});

it("no route is `by-company` yet: the first such row needs the routes/authz.ts half (AC-G9)", () => {
  // `assertCompanyAccess`, `hasCompanyAccess` and `getAccessibleResource` do not
  // read `memberRestrictedCompanyIds` yet, so a `by-company` row would pass R
  // into Y's objects. Today the company-less object routes are `open` with a
  // per-object check (the agent leg of AC-G9 is asserted on `GET /api/agents/:id`).
  expect(MEMBER_RESTRICTION_ROUTE_TABLE.filter((entry) => entry.class === "by-company")).toEqual([]);
});

(support.supported ? describe : describe.skip)("scope callers: owner in X, restricted in Y (AC-G9, AC-G12)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  let actor: Actor;
  const [O, R, ADMIN] = ["owner", "restricted", "instance-admin"].map((name) => `${name}-${randomUUID()}`);
  const id: Record<string, string> = {};
  const workerManager = { isRunning: () => true, call: vi.fn(async () => ({ status: 200, body: { ok: true } })) };

  const board = async (userId: string): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return { type: "board", userId, source: "session", isInstanceAdmin: false, memberships,
      companyIds: memberships.map((row) => row.companyId) } as Actor;
  };
  const admin = (): Actor => ({ type: "board", userId: ADMIN, source: "session", isInstanceAdmin: true, memberships: [],
    companyIds: [] }) as Actor;
  const runFor = async (person: string, agentId: string, companyId: string): Promise<Actor> => ({
    type: "agent", agentId, companyId, runId: randomUUID(), source: "agent_jwt", onBehalfOfUserId: person,
    onBehalfOfMemberships: await loadActorMemberships(db, { userId: person, companyId, activeOnly: true }) }) as Actor;
  const call = async (who: Actor, send: (r: ReturnType<typeof request>) => request.Test) => { actor = who; return answer(await send(request(app))); };
  /** The same call with the kill switch `off`: today's answer. */
  const today = async (who: Actor, send: (r: ReturnType<typeof request>) => request.Test) => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    try { return await call(who, send); } finally { vi.unstubAllEnvs(); }
  };
  const ok = (got: Answer, what: string) => expect(got.status, `${what}: ${JSON.stringify(got.body).slice(0, 300)}`).toBeLessThan(300);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-scope-callers-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values([O, R, ADMIN].map((user) => ({ id: user, name: user, email: `${user}@example.test`,
      emailVerified: true, createdAt: now, updatedAt: now })));
    for (const name of ["X", "Y"]) {
      id[name] = (await db.insert(companies).values({ name, issuePrefix: `${name}${randomUUID().slice(0, 5).toUpperCase()}`,
        memberRestrictionMode: "enforce" }).returning())[0]!.id;
      id[`agent${name}`] = (await db.insert(agents).values({ companyId: id[name]!, name: `Agent of ${name}`, role: "engineer",
        adapterType: "process", status: "active", runtimeConfig: { heartbeat: { enabled: false } } }).returning())[0]!.id;
    }
    await db.insert(companyMemberships).values([
      { companyId: id.X!, principalType: "user", principalId: R, status: "active", membershipRole: "owner" },
      { companyId: id.Y!, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: id.Y!, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true },
    ]);
    const task = async (companyId: string, owner: string) => (await db.insert(issues).values({ companyId, title: "Task",
      status: "todo", createdByUserId: owner, responsibleUserId: owner }).returning())[0]!.id;
    id.taskX = await task(id.X!, R);
    id.taskYofO = await task(id.Y!, O);
    id.taskYofR = await task(id.Y!, R);
    id.plugin = (await db.insert(plugins).values({ pluginKey: "scope.plugin", packageName: "scope.plugin", version: "1.0.0",
      status: "ready", manifestJson: { id: "scope.plugin", apiVersion: 1, version: "1.0.0", displayName: "Scope",
        description: "scope", author: "Paperclip", categories: ["automation"], capabilities: [],
        entrypoints: { worker: "dist/worker.js" } } } as typeof plugins.$inferInsert).returning())[0]!.id;

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    const api = Router();
    api.use(memberRestrictionRouteGuard(db));
    api.use("/companies", companyRoutes(db, {} as never));
    api.use(issueRoutes(db, {} as never));
    api.use(issueTreeControlRoutes(db, {}));
    api.use(agentRoutes(db));
    api.use(dashboardRoutes(db));
    api.use(pluginRoutes(db, {} as never, { scheduler: {}, jobStore: {} } as never, { workerManager } as never,
      undefined, { workerManager } as never));
    app.use("/api", api);
    app.use(errorHandler);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });
  afterEach(() => vi.unstubAllEnvs());

  const EXPORT = { include: { company: true, agents: true, projects: true, issues: true } };
  /** One route of each class, for company X and company Y. */
  const ROUTES = {
    "open, company in path: task list": (c: string) => (r: ReturnType<typeof request>) => r.get(`/api/companies/${id[c]}/issues`),
    "open, no company: a task by id": (c: string) => (r: ReturnType<typeof request>) =>
      r.get(`/api/issues/${c === "X" ? id.taskX : id.taskYofO}`),
    "open, no company: an agent by id": (c: string) => (r: ReturnType<typeof request>) => r.get(`/api/agents/${id[`agent${c}`]}`),
    "plugin: an action": (c: string) => (r: ReturnType<typeof request>) =>
      r.post(`/api/plugins/${id.plugin}/actions/k`).send({ companyId: id[c] }),
    "closed: dashboard": (c: string) => (r: ReturnType<typeof request>) => r.get(`/api/companies/${id[c]}/dashboard`),
    "closed: company export": (c: string) => (r: ReturnType<typeof request>) => r.post(`/api/companies/${id[c]}/export`).send(EXPORT),
  };

  it("AC-G9: R gets X's answers as today and Y's open rows filtered, Y's closed rows refused", async () => {
    for (const [name, route] of Object.entries(ROUTES)) {
      const inX = await call(await board(R), route("X"));
      const was = await today(await board(R), route("X"));
      ok(inX, `${name} X`);
      // A path with no company cannot tell X from Y before the handler runs, so
      // the C4i-c strip applies to it as for Y (fail closed); a path naming X does not strip.
      expect(inX, `${name} X`).toEqual(name.startsWith("open, no company") || name.startsWith("plugin")
        ? { status: was.status, body: withoutHostKeys(was.body) } : was);
    }
    const inY = async (name: keyof typeof ROUTES) => call(await board(R), ROUTES[name]("Y"));
    const list = await inY("open, company in path: task list");
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string }>).map((row) => row.id)).toEqual([id.taskYofR]);
    expect((await inY("open, no company: a task by id")).status).toBe(404);
    // Not on his agent list: "not found" (4.6 agents row, AC-G4).
    expect((await inY("open, no company: an agent by id")).status).toBe(404);
    expect(await inY("plugin: an action")).toEqual(REFUSED);
    expect(await inY("closed: dashboard")).toEqual(REFUSED);
    expect(await inY("closed: company export")).toEqual(REFUSED);
    // An unlisted route with no company in its path: refused, X's owner or not (S14).
    expect(await call(await board(R), (r) => r.get("/api/plugins"))).toEqual(REFUSED);
    expect((await today(await board(R), (r) => r.get("/api/plugins"))).status).toBe(200);
  });

  it("AC-G12 `run`: a run for R of X's agent gets today's answer; R's own session is refused", async () => {
    const me = (r: ReturnType<typeof request>) => r.get("/api/agents/me");
    const run = await runFor(R, id.agentX!, id.X!);
    ok(await call(run, me), "run for R in X");
    expect(await call(run, me)).toEqual(await today(run, me));
    expect(await call(await board(R), me)).toEqual(REFUSED);
    expect(await call(admin(), me)).toEqual(await today(admin(), me));
  });

  it("AC-G12: an instance admin who is not a member gets today's answer on every class, in X and Y", async () => {
    for (const [name, route] of Object.entries(ROUTES)) {
      for (const c of ["X", "Y"]) expect(await call(admin(), route(c)), `${name} ${c}`).toEqual(await today(admin(), route(c)));
    }
    expect(await call(admin(), (r) => r.get("/api/plugins"))).toEqual(await today(admin(), (r) => r.get("/api/plugins")));
  });

  it("C4i-a tree-control reads: R on his own root 403; the owner and the admin get today's answer", async () => {
    const reads = {
      "preview": (r: ReturnType<typeof request>) => r.post(`/api/issues/${id.taskYofR}/tree-control/preview`).send({ mode: "pause" }),
      "holds": (r: ReturnType<typeof request>) => r.get(`/api/issues/${id.taskYofR}/tree-holds`),
      "one hold": (r: ReturnType<typeof request>) => r.get(`/api/issues/${id.taskYofR}/tree-holds/${randomUUID()}`),
    };
    for (const [name, send] of Object.entries(reads)) {
      expect(await call(await board(R), send), name).toEqual(REFUSED);
      expect(await call(await board(O), send), name).toEqual(await today(await board(O), send));
      expect(await call(admin(), send), name).toEqual(await today(admin(), send));
    }
    ok(await call(await board(O), reads.preview), "owner preview");
    ok(await call(await board(O), reads.holds), "owner holds");
  });
});
