import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog, agentApiKeys, agentMemberships, agents, announcementDismissals, authUsers, companies, companyMemberships, createDb,
  userCompanyPreferences,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { announcementRoutes } from "../routes/announcements.js";
import { healthRoutes } from "../routes/health.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import { primaryAgentRoutes } from "../routes/primary-agent.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { memberRestrictionRouteGuard } from "../services/member-restriction/route-middleware.js";
import { MEMBER_RESTRICTION_ROUTE_TABLE } from "../services/member-restriction/route-table.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-13263 (C4g-3), decision PAR-13261 rev 1 sections 1 to 3 "T1": the rows
 * the app shell needs to start for a restricted member R (health, the two
 * settings reads, announcements, his primary agent). R at `enforce` gets the
 * anonymous health body and `{ censorUsernameInLogs }` of the general
 * settings; a primary agent off his list is null on read and "not found" on
 * write. Every other caller gets today's answer. Tests 1 to 8 of the decision.
 */

const resolverFails = vi.hoisted(() => ({ on: false }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  const fail = () => Promise.reject(new actual.MemberRestrictionReadError("fixture: restriction unreadable"));
  return {
    ...actual,
    memberRestrictionResolver: (db: Parameters<typeof actual.memberRestrictionResolver>[0]) =>
      (personId: string, companyId: string) => resolverFails.on ? fail() : actual.memberRestrictionFor(db, personId, companyId),
  };
});

const support = await getEmbeddedPostgresTestSupport();
const THIS_FILE = "server/src/__tests__/member-restriction-route-table-instance.test.ts";
const OPEN_ROWS = [
  "GET /api/health", "GET /api/instance/settings/experimental", "GET /api/instance/settings/general",
  "GET /api/announcements/current", "GET /api/announcements/:id/image", "GET /api/announcements/:id/animation",
  "POST /api/announcements/:id/dismiss", "GET /api/companies/:companyId/primary-agent/me", "PUT /api/companies/:companyId/primary-agent/me",
];
/** Keys of the health body an anonymous caller gets; R at `enforce` gets exactly these. */
const FULL_ONLY = ["version", "serverInfo", "startupRecovery", "nativeRecovery", "features", "authReady", "memberRestriction"];

afterEach(() => {
  vi.unstubAllEnvs();
  resolverFails.on = false;
});

it("the rows of this file are exactly the nine open shell rows", () => {
  const rows = MEMBER_RESTRICTION_ROUTE_TABLE.filter((entry) => entry.test === THIS_FILE);
  expect(rows.map((entry) => `${entry.method} ${entry.path}`).sort()).toEqual([...OPEN_ROWS].sort());
  for (const entry of rows) expect(entry.class).toBe("open");
});

describe("instance route rows database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

type Actor = Express.Request["actor"];
type Res = request.Response;
const keys = (res: Res) => Object.keys(res.body).sort();
const PNG = Buffer.from("announcement-poster");
const HTML = "<div>Team</div>";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const ITEM = { id: "c4g3-news", eyebrow: "New", title: "Shell", description: "d", primaryAction: { kind: "route", label: "Open", path: "/projects" },
  image: { path: `assets/${sha(PNG)}.png`, alt: "Poster" }, animation: { path: `assets/${sha(HTML)}.html`, alt: "Team" } };
const feedFetch = async (url: URL) => url.pathname.endsWith(".png") ? new Response(PNG, { headers: { "Content-Type": "image/png" } })
  : url.pathname.endsWith(".html") ? new Response(HTML, { headers: { "Content-Type": "text/html" } })
    : new Response(JSON.stringify({ schemaVersion: 1, announcement: ITEM }), { headers: { "Content-Type": "application/json" } });

(support.supported ? describe : describe.skip)("health, instance settings, announcements and primary agent rows (PAR-12608 4.6, PAR-13261)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let guarded: express.Express;
  let bare: express.Express;
  let actor: Actor;
  const R = `restricted-${randomUUID()}`, O = `owner-${randomUUID()}`, ADMIN = `admin-${randomUUID()}`;
  let Y = "", X = "", listed = "", offList = "", inX = "";

  const mount = (withGuard: boolean, auth?: express.RequestHandler) => {
    const app = express();
    app.use(express.json());
    app.use(auth ?? ((req, _res, next) => { req.actor = actor; next(); }));
    const api = express.Router();
    if (withGuard) api.use(memberRestrictionRouteGuard(db));
    api.use("/health", healthRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "private", authReady: true, companyDeletionEnabled: true }));
    api.use(announcementRoutes(db, { version: "2026.913.0", fetch: feedFetch }));
    api.use(primaryAgentRoutes(db));
    api.use(instanceSettingsRoutes(db));
    app.use("/api", api);
    app.use(errorHandler);
    return app;
  };
  const as = (who: Actor, app = guarded) => { actor = who; return request(app); };
  const boardFor = async (userId: string, extra: Partial<Actor> = {}): Promise<Actor> => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return { type: "board", userId, source: "session", isInstanceAdmin: false, memberships,
      companyIds: memberships.map((row) => row.companyId), ...extra } as Actor;
  };
  const runFor = async (personId: string, agentId = listed): Promise<Actor> => ({
    type: "agent", agentId, companyId: Y, runId: randomUUID(), source: "agent_jwt", onBehalfOfUserId: personId,
    onBehalfOfMemberships: await loadActorMemberships(db, { userId: personId, companyId: Y, activeOnly: true }),
  } as Actor);
  const setMode = (mode: "off" | "report" | "enforce") => db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, Y));
  const writes = async () => ({
    prefs: await db.select().from(userCompanyPreferences).where(eq(userCompanyPreferences.userId, R)),
    joined: await db.select().from(agentMemberships).where(eq(agentMemberships.userId, R)),
    activity: (await db.select().from(activityLog)).length,
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-route-table-instance-");
    db = createDb(tempDb.connectionString);
    guarded = mount(true);
    bare = mount(false);
    const [y, x] = await db.insert(companies).values([
      { name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
      { name: "X", issuePrefix: `X${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce" },
    ]).returning();
    Y = y!.id; X = x!.id;
    const agent = async (companyId: string, name: string) => (await db.insert(agents).values({ companyId, name, adapterType: "process",
      status: "idle" }).returning())[0]!.id;
    listed = await agent(Y, "Listed"); offList = await agent(Y, "Off list"); inX = await agent(X, "In X");
    const now = new Date();
    await db.insert(authUsers).values([R, O, ADMIN].map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true,
      createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values([
      { companyId: Y, principalType: "user", principalId: O, status: "active", membershipRole: "owner" },
      { companyId: Y, principalType: "user", principalId: R, status: "active", membershipRole: "operator", restricted: true, restrictedAgentIds: [listed] },
      { companyId: X, principalType: "user", principalId: R, status: "active", membershipRole: "owner" },
    ]);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("test 1 (handler switch): every caller x mode gets today's answer, except a caller marked restricted at enforce", async () => {
    const anonymous = keys(await as({ type: "none", source: "none" } as Actor, bare).get("/api/health"));
    const callers: Array<[string, () => Promise<Actor>, boolean]> = [
      ["R (owner in X, restricted in Y: S14)", () => boardFor(R), true],
      ["a run working for R", () => runFor(R), true],
      ["owner", () => boardFor(O), false],
      ["instance admin not a member", () => boardFor(ADMIN, { isInstanceAdmin: true, companyIds: [], memberships: [] }), false],
      ["local_implicit", () => boardFor(O, { source: "local_implicit" }), false],
      ["agent not working for R", () => runFor(O), false],
    ];
    for (const [name, make, bound] of callers) {
      for (const mode of ["off", "report", "enforce", "kill switch"] as const) {
        if (mode === "kill switch") vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
        const marked = bound && mode === "enforce";
        // What the route guard puts on the actor in this cell.
        const caller = { ...(await make()), ...(marked ? { memberRestrictedCompanyIds: [Y] } : {}) } as Actor;
        const label = `${name} at ${mode}`;
        for (const path of ["/api/health", "/api/instance/settings/general"]) {
          const now = await as(caller, bare).get(path);
          const today = await as(await make(), bare).get(path);
          if (!marked || today.status !== 200) expect({ status: now.status, body: now.body }, `${label} ${path}`).toEqual({ status: today.status, body: today.body });
          else if (path === "/api/health") expect(keys(now), label).toEqual(anonymous);
          else expect(now.body, label).toEqual({ censorUsernameInLogs: today.body.censorUsernameInLogs });
        }
        vi.unstubAllEnvs();
      }
    }
  });

  it("test 1 (real resolver): R at enforce reduced, the owner at enforce and R at report today's", async () => {
    const anonymous = keys(await as({ type: "none", source: "none" } as Actor).get("/api/health"));
    const health = await as(await boardFor(R)).get("/api/health");
    expect(health.status).toBe(200);
    expect(keys(health)).toEqual(anonymous);
    for (const key of FULL_ONLY) expect(health.body).not.toHaveProperty(key);
    expect((await as(await boardFor(R)).get("/api/instance/settings/general")).body).toEqual({ censorUsernameInLogs: false });
    const owner = await as(await boardFor(O)).get("/api/health");
    expect(owner.body).toHaveProperty("version");
    expect(keys(await as(await boardFor(O)).get("/api/instance/settings/general"))).toEqual(
      Object.keys(await instanceSettingsService(db).getGeneral()).sort());
    await setMode("report");
    try {
      expect((await as(await boardFor(R)).get("/api/health")).body).toHaveProperty("version");
      expect(keys(await as(await boardFor(R)).get("/api/instance/settings/general")).length).toBeGreaterThan(1);
    } finally { await setMode("enforce"); }
  });

  it("test 2: the other health and instance-settings routes are refused MEMBER_RESTRICTED, nothing written", async () => {
    const before = await instanceSettingsService(db).get();
    for (const [method, path, body] of [["post", "/api/health/dev-server/restart", {}], ["get", "/api/instance/settings", undefined],
      ["patch", "/api/instance/settings/experimental", { enableAgentChat: true }],
      ["patch", "/api/instance/settings/general", { censorUsernameInLogs: true }]] as const) {
      const call = as(await boardFor(R))[method](path);
      const res = await (body ? call.send(body) : call);
      expect({ status: res.status, body: res.body }, path).toEqual({ status: 403,
        body: { error: "Not available for your access level", code: "MEMBER_RESTRICTED" } });
    }
    expect(await instanceSettingsService(db).get()).toEqual(before);
  });

  it("test 3: experimental settings answer 200, every value a boolean except managedKeys and the two worktree activation fields", async () => {
    const res = await as(await boardFor(R)).get("/api/instance/settings/experimental");
    expect(res.status).toBe(200);
    expect(res.body).toEqual((await as(await boardFor(O)).get("/api/instance/settings/experimental")).body);
    // Found by this test, outside the decision's list: the worktree activation time and instance id (null or a
    // string). Raised on PAR-13263 for Noor; this pins today's set so a new field fails here.
    const others = Object.entries(res.body).filter(([key, value]) => key !== "managedKeys" && typeof value !== "boolean");
    expect(others.map(([key]) => key).sort()).toEqual(["worktreeRunExecutionActivatedAt", "worktreeRunExecutionActivationInstanceId"]);
    for (const [key, value] of others) expect(value === null || typeof value === "string", key).toBe(true);
  });

  it("test 4: general settings answer 200 with exactly { censorUsernameInLogs }", async () => {
    const res = await as(await boardFor(R)).get("/api/instance/settings/general");
    expect(res.status).toBe(200);
    expect(keys(res)).toEqual(["censorUsernameInLogs"]);
  });

  it("test 5: announcements answer as for an owner; the dismissal is stored for R only", async () => {
    for (const path of ["/api/announcements/current", `/api/announcements/${ITEM.id}/image`, `/api/announcements/${ITEM.id}/animation`]) {
      const [mine, owner] = [await as(await boardFor(R)).get(path), await as(await boardFor(O)).get(path)];
      expect(mine.status, path).toBe(200);
      expect({ type: mine.type, body: mine.body, text: mine.text }, path).toEqual({ type: owner.type, body: owner.body, text: owner.text });
    }
    const dismiss = await as(await boardFor(R)).post(`/api/announcements/${ITEM.id}/dismiss`).send({ companyId: Y });
    expect(dismiss.status).toBe(204);
    expect((await db.select().from(announcementDismissals)).map((row) => row.userId)).toEqual([R]);
    expect((await as(await boardFor(R)).get("/api/announcements/current")).body).toBeNull();
    expect((await as(await boardFor(O)).get("/api/announcements/current")).body.id).toBe(ITEM.id);
  });

  it("test 6: a primary agent off his list is null on read and 'not found' on write; on his list and for the owner it works", async () => {
    const url = (companyId = Y) => `/api/companies/${companyId}/primary-agent/me`;
    await db.insert(userCompanyPreferences).values({ companyId: Y, userId: R, primaryAgentId: offList, primaryAgentInitialized: true });
    const read = await as(await boardFor(R)).get(url());
    expect(read.status).toBe(200);
    expect(read.body.primaryAgentId).toBeNull();

    const before = await writes();
    const off = await as(await boardFor(R)).put(url()).send({ primaryAgentId: offList });
    const unknown = await as(await boardFor(R)).put(url()).send({ primaryAgentId: randomUUID() });
    expect({ status: off.status, body: off.body }).toEqual({ status: 404, body: { error: "Agent not found" } });
    expect({ status: off.status, body: off.body }).toEqual({ status: unknown.status, body: unknown.body });
    expect(await writes()).toEqual(before);

    const mine = await as(await boardFor(R)).put(url()).send({ primaryAgentId: listed });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.primaryAgentId).toBe(listed);
    expect((await as(await boardFor(R)).get(url())).body.primaryAgentId).toBe(listed);
    // S14: in X, where R is owner, today's answer.
    expect((await as(await boardFor(R)).put(url(X)).send({ primaryAgentId: inX })).body.primaryAgentId).toBe(inX);
    const owner = await as(await boardFor(O)).put(url()).send({ primaryAgentId: offList });
    expect(owner.status).toBe(200);
    const [stored] = await db.select().from(userCompanyPreferences)
      .where(and(eq(userCompanyPreferences.companyId, Y), eq(userCompanyPreferences.userId, O)));
    expect(stored?.primaryAgentId).toBe(offList);
  });

  it("test 7: real agent-key auth: a run for R gets the redacted health body and the handlers' own 403, as an owner's agent does", async () => {
    const real = mount(true, actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    const keyFor = async (userId: string) => {
      const token = `pcp_${randomUUID()}`;
      await db.insert(agentApiKeys).values({ companyId: Y, agentId: listed, responsibleUserId: userId, name: "key", keyHash: sha(token) });
      return token;
    };
    const [forR, forO] = [await keyFor(R), await keyFor(O)];
    const get = (token: string, path: string) => request(real).get(path).set("authorization", `Bearer ${token}`);
    const anonymous = keys(await request(real).get("/api/health"));
    const health = await get(forR, "/api/health");
    expect(health.status).toBe(200);
    expect(keys(health)).toEqual(anonymous);
    expect((await get(forO, "/api/health")).body).toHaveProperty("version");
    for (const path of ["/api/instance/settings/general", "/api/instance/settings/experimental", "/api/announcements/current", `/api/companies/${Y}/primary-agent/me`]) {
      const [mine, owners] = [await get(forR, path), await get(forO, path)];
      expect({ status: mine.status, body: mine.body }, path).toEqual({ status: 403, body: { error: "Board access required" } });
      expect(mine.body, path).toEqual(owners.body);
    }
  });

  it.each(["/api/health", "/api/instance/settings/general"])("test 7: %s answers 503 MEMBER_RESTRICTION_UNAVAILABLE, no data, when the restriction cannot be read", async (path) => {
    // Memberships without the restriction fields make the guard read through the resolver.
    const caller = await boardFor(R);
    const unknown = { ...caller, memberships: caller.memberships!.map(({ companyId, membershipRole, status }) => ({ companyId, membershipRole, status })) } as Actor;
    resolverFails.on = true;
    const res = await as(unknown).get(path);
    expect(res.status).toBe(503);
    expect(res.body.code ?? res.body.details?.code).toBe("MEMBER_RESTRICTION_UNAVAILABLE");
    for (const key of ["status", "censorUsernameInLogs", "deploymentMode", "commit"]) expect(res.body).not.toHaveProperty(key);
  });
});
