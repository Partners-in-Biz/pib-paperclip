import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, authUsers, companies, companyMemberships, createDb, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { setupPluginApiWebSocketServer } from "../realtime/plugin-api-ws.js";
import { pluginRoutes } from "../routes/plugins.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { MEMBER_RESTRICTION_DENIED_ACTION } from "../services/member-restriction/admin.js";
import { createPluginStreamBus } from "../services/plugin-stream-bus.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-12740 (C5-1): the core plugin gate at every plugin call point, spec
 * PAR-12608 rev 3, 4.8 (AC-K1, AC-K3, AC-K5, AC-K6) and the plugin socket
 * of 4.6a row 16. The gate is a new caller of the resolver: kill-switch and
 * failing-read tests below (AC-F8, AC-X1). The scan of AC-K7 is in
 * `openapi-routes.test.ts`.
 */

const failRead = vi.hoisted(() => ({ on: false }));
vi.mock("../services/member-restriction/resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/member-restriction/resolver.js")>();
  return {
    ...actual,
    memberRestrictionResolver: (db: Db) => {
      const real = actual.memberRestrictionResolver(db);
      return (personId: string, companyId: string) => {
        if (failRead.on) return Promise.reject(new Error("restriction store down"));
        return real(personId, companyId);
      };
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describe("plugin gate database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

const ORIGIN = "http://localhost:3100";

function manifest(key: string): PaperclipPluginManifestV1 {
  return {
    id: key, apiVersion: 1, version: "1.0.0", displayName: key, description: "gate fixture", author: "Paperclip",
    categories: ["automation"], capabilities: ["api.routes.register", "http.outbound", "webhooks.receive"],
    entrypoints: { worker: "dist/worker.js" },
    webhooks: [{ endpointKey: "inbound", displayName: "Inbound" }],
    apiRoutes: [
      { routeKey: "summary", method: "GET", path: "/summary", auth: "any", capability: "api.routes.register",
        companyResolution: { from: "query", key: "companyId" } },
      { routeKey: "channel", method: "GET", path: "/channel", transport: "websocket", auth: "board",
        capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    ],
  } as PaperclipPluginManifestV1;
}

describeDb("core plugin gate (PAR-12608 4.8)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  const O = `owner-${randomUUID()}`;
  const R = `restricted-${randomUUID()}`;
  const CRM = `partnersinbiz.crm-${randomUUID().slice(0, 8)}`;
  const WIKI = `paperclip.llm-wiki-${randomUUID().slice(0, 8)}`;
  const id: Record<string, string> = {};
  const workerManager = { isRunning: vi.fn(() => true), call: vi.fn() };
  const scheduler = { triggerJob: vi.fn(async (jobId: string) => ({ runId: "run-1", jobId })) };
  const jobStore = { getJobByIdForPlugin: vi.fn(async (_pluginId: string, jobId: string) => ({ id: jobId })) };
  const streamBus = createPluginStreamBus();
  let actor: Record<string, unknown> = { type: "none" };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor as never; next(); });
  const server: Server = createServer(app);
  setupPluginApiWebSocketServer(server, app);
  let base = "";

  const boardFor = async (userId: string) => {
    const memberships = await loadActorMemberships(db, { userId, activeOnly: true });
    return { type: "board", userId, source: "session", memberships, companyIds: memberships.map((row) => row.companyId) };
  };
  const setList = (pluginKeys: string[]) => db.update(companyMemberships).set({ restrictedPluginKeys: pluginKeys })
    .where(and(eq(companyMemberships.companyId, id.Y!), eq(companyMemberships.principalId, R)));
  const setMode = (mode: "off" | "report" | "enforce") =>
    db.update(companies).set({ memberRestrictionMode: mode }).where(eq(companies.id, id.Y!));
  const install = async (key: string) => {
    const [row] = await db.insert(plugins).values({
      pluginKey: key, packageName: key, version: "1.0.0", manifestJson: manifest(key), status: "ready",
    }).returning();
    return row!.id;
  };
  const denials = async () => (await db.select({ details: activityLog.details }).from(activityLog).where(and(
    eq(activityLog.companyId, id.Y!), eq(activityLog.action, MEMBER_RESTRICTION_DENIED_ACTION))))
    .map((row) => (row.details as { target?: string }).target);

  /** The plugin call points of C13, one request each. */
  const calls = (pluginId: string) => ({
    "bridge/data": () => request(app).post(`/api/plugins/${pluginId}/bridge/data`).send({ key: "k", companyId: id.Y }),
    "bridge/action": () => request(app).post(`/api/plugins/${pluginId}/bridge/action`).send({ key: "k", companyId: id.Y }),
    "data/:key": () => request(app).post(`/api/plugins/${pluginId}/data/k`).send({ companyId: id.Y }),
    "actions/:key": () => request(app).post(`/api/plugins/${pluginId}/actions/k`).send({ companyId: id.Y }),
    // An open stream answers 200 and stays open: read the status, then hang up.
    "bridge/stream": async () => {
      const hangUp = new AbortController();
      const res = await fetch(`${base}/api/plugins/${pluginId}/bridge/stream/ch?companyId=${id.Y}`, { signal: hangUp.signal });
      const body: unknown = res.status === 200 ? {} : await res.json();
      hangUp.abort();
      return { status: res.status, body };
    },
    api: () => request(app).get(`/api/plugins/${pluginId}/api/summary?companyId=${id.Y}`),
  });
  const callPoints = Object.keys(calls("x")) as Array<keyof ReturnType<typeof calls>>;

  const expectRefused = (res: { status: number; body: unknown }, what: string) => {
    expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(403);
    expect(res.body).toMatchObject({ error: "Not available for your access level", code: "MEMBER_RESTRICTED" });
    expect(res.body).not.toHaveProperty("ok");
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-restriction-plugin-gate-");
    db = createDb(tempDb.connectionString);
    const [y] = await db.insert(companies).values({
      name: "Y", issuePrefix: `Y${randomUUID().slice(0, 6).toUpperCase()}`, memberRestrictionMode: "enforce",
    }).returning();
    id.Y = y!.id;
    const now = new Date();
    await db.insert(authUsers).values([O, R].map((user) => ({
      id: user, name: user, email: `${user}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: id.Y, principalType: "user", principalId: O, membershipRole: "owner", status: "active" },
      { companyId: id.Y, principalType: "user", principalId: R, membershipRole: "operator", status: "active", restricted: true },
    ]);
    id.crm = await install(CRM);
    id.wiki = await install(WIKI);
    app.use("/api", pluginRoutes(db, {} as never, { scheduler, jobStore } as never, { workerManager } as never,
      undefined, { workerManager, streamBus } as never));
    app.use(errorHandler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    workerManager.call.mockResolvedValue({ status: 200, body: { ok: true } });
    failRead.on = false;
    await setList([]);
    await setMode("enforce");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("AC-K1: with an empty list every call point of the CRM and the wiki is refused; listing the CRM opens only the CRM", async () => {
    actor = await boardFor(R);
    for (const pluginId of [id.crm!, id.wiki!]) {
      for (const point of callPoints) expectRefused(await calls(pluginId)[point](), `${pluginId} ${point}`);
    }
    expect(workerManager.call).not.toHaveBeenCalled();
    expect(await denials()).toContain(`plugin:${CRM}:bridge/data`);

    await setList([CRM]);
    actor = await boardFor(R);
    for (const point of callPoints) {
      expect((await calls(id.crm!)[point]()).status, `CRM ${point}`).toBe(200);
      expectRefused(await calls(id.wiki!)[point](), `wiki ${point}`);
    }
    expect(workerManager.call.mock.calls.every(([pluginId]) => pluginId === id.crm)).toBe(true);
  });

  it("AC-K1: an agent working for R is refused on the plugin API; the owner and the agent working for him pass", async () => {
    const agentFor = async (userId: string) => ({
      type: "agent", agentId: randomUUID(), companyId: id.Y, source: "agent_key",
      onBehalfOfUserId: userId, onBehalfOfMemberships: await loadActorMemberships(db, { userId, activeOnly: true }),
    });
    actor = await agentFor(R);
    expectRefused(await calls(id.crm!).api(), "agent for R");
    actor = await agentFor(O);
    expect((await calls(id.crm!).api()).status).toBe(200);
    actor = await boardFor(O);
    for (const point of callPoints) expect((await calls(id.wiki!)[point]()).status, `O ${point}`).toBe(200);
  });

  it("AC-K3: a plugin installed after the list was saved is closed for R with no further step", async () => {
    await setList([CRM, WIKI]);
    const later = await install(`paperclip.later-${randomUUID().slice(0, 8)}`);
    actor = await boardFor(R);
    for (const point of callPoints) expectRefused(await calls(later)[point](), `later ${point}`);
    expect((await calls(id.wiki!)["actions/:key"]()).status).toBe(200);
  });

  it("AC-K5: the webhook of a closed plugin, and a job of it, still run (control)", async () => {
    actor = { type: "none" };
    const webhook = await request(app).post(`/api/plugins/${id.wiki}/webhooks/inbound`).send({ hello: "world" });
    expect(webhook.status, JSON.stringify(webhook.body)).toBeLessThan(300);
    expect(workerManager.call).toHaveBeenCalledWith(id.wiki, "handleWebhook", expect.anything());
    actor = { type: "board", userId: O, source: "session", isInstanceAdmin: true };
    expect((await request(app).post(`/api/plugins/${id.wiki}/jobs/job-1/trigger`)).status).toBe(200);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("job-1", "manual");
  });

  it("AC-K6, 4.6a row 16: the plugin socket of a closed plugin is refused at upgrade for R", async () => {
    actor = await boardFor(R);
    const upgrade = (pluginId: string) => new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${base}/api/plugins/${pluginId}/api/channel?companyId=${id.Y}`, { origin: ORIGIN });
      ws.on("unexpected-response", (_req, res) => { res.resume(); resolve(res.statusCode!); });
      ws.on("open", () => { ws.terminate(); resolve(101); });
      ws.on("error", reject);
    });
    expect(await upgrade(id.crm!)).toBe(403);
    expect(workerManager.call).not.toHaveBeenCalled();
    // Control: listed, the upgrade gets past the gate to the worker (which offers no socket here: 502).
    await setList([CRM]);
    actor = await boardFor(R);
    workerManager.call.mockResolvedValue({ status: 502 });
    expect(await upgrade(id.crm!)).toBe(502);
    expect(workerManager.call).toHaveBeenCalledWith(id.crm, "handleApiRequest", expect.objectContaining({ routeKey: "channel" }));
  });

  it("report mode records a would-refuse and lets the call through", async () => {
    await setMode("report");
    // A denial is recorded once per person, rule and day: start from none.
    await db.delete(activityLog).where(eq(activityLog.action, MEMBER_RESTRICTION_DENIED_ACTION));
    actor = await boardFor(R);
    expect((await calls(id.wiki!)["actions/:key"]()).status).toBe(200);
    expect(workerManager.call).toHaveBeenCalled();
    expect(await denials()).toContain(`plugin:${WIKI}:actions`);
  });

  it("kill switch (AC-F8): variable `off` with the column on `enforce` behaves as mode `off`", async () => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", "off");
    actor = await boardFor(R);
    for (const point of callPoints) expect((await calls(id.wiki!)[point]()).status, point).toBe(200);
  });

  it.each(["false", "OFF "])("kill switch set to %j leaves the gate on", async (value) => {
    vi.stubEnv("PAPERCLIP_MEMBER_RESTRICTION", value);
    actor = await boardFor(R);
    expectRefused(await calls(id.wiki!)["bridge/data"](), value);
  });

  it("failing read (AC-X1): every call point answers 503 MEMBER_RESTRICTION_UNAVAILABLE and the plugin is not called", async () => {
    actor = await boardFor(R);
    failRead.on = true;
    for (const point of callPoints) {
      const res = await calls(id.crm!)[point]();
      expect(res.status, point).toBe(503);
      expect(res.body, point).toMatchObject({ code: "MEMBER_RESTRICTION_UNAVAILABLE" });
      expect(res.body, point).not.toHaveProperty("data");
    }
    expect(workerManager.call).not.toHaveBeenCalled();
  });
});
