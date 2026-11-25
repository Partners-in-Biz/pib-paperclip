import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, authUsers, boardApiKeys, companies, companyMemberships, createDb, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { setupPluginApiWebSocketServer } from "../realtime/plugin-api-ws.js";
import { pluginRoutes } from "../routes/plugins.js";
import { pluginLocalWsPublicKey, PLUGIN_LOCAL_WS_SIGNATURE_HEADER } from "../services/plugin-local-ws.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import cockpitManifest from "../../../packages/plugins/plugin-cockpit/src/manifest.js";
import cockpit from "../../../packages/plugins/plugin-cockpit/src/worker.js";

/**
 * PAR-14534 (PAR-14514 S3, Verification S3): Watch live through the real core action route, the real plugin
 * WebSocket route and the real auth middleware (no hand-set actor), with the real Cockpit worker handlers behind the
 * worker bridge. Three actors (signed-in person, agent key, run token) plus a board key and the local board, for
 * `browser.live.ticket`, `browser.live.status` and `GET /browser/live`. A fake pib-browser daemon listens on a temp
 * unix socket for `/status` and the signed stream.
 */

const support = await getEmbeddedPostgresTestSupport();

describe("cockpit watch-live database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

const ORIGIN = "http://localhost:3100";
const PLUGIN_KEY = cockpitManifest.id;

(support.supported ? describe : describe.skip)("Cockpit watch live through the real routes and auth middleware", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  let harness: TestHarness;
  const id: Record<string, string> = {};
  const owner = `owner-${randomUUID()}`;
  const admin = `admin-${randomUUID()}`;
  const member = `member-${randomUUID()}`;
  const otherOwner = `other-owner-${randomUUID()}`;
  const dir = mkdtempSync(path.join(tmpdir(), "cockpit-live-"));
  const socketPath = path.join(dir, "live.sock");
  const daemon = createServer();
  const daemonWs = new WebSocketServer({ noServer: true });
  const DAEMON_STATUS = { viewers: 0, agentSessions: ["pib:meta"], lease: null, waiting: [] };
  let streams: IncomingHttpHeaders[] = [];
  let statusCalls = 0;
  const servers: Record<"authenticated" | "local_trusted", { server: Server; base: string }> = {} as never;

  /** The worker bridge: each RPC goes to the real Cockpit worker, set up on the sdk harness. */
  const workerManager = {
    isRunning: () => true,
    call: vi.fn(async (_pluginId: string, method: string, params: Record<string, unknown>) => {
      if (method === "performAction") {
        const { key, params: actionParams, actorContext } = params as { key: string; params: Record<string, unknown>; actorContext: { companyId: string | null } };
        return harness.performAction(key, actionParams, { actor: actorContext as never, companyId: actorContext.companyId });
      }
      if (method === "handleApiRequest") return cockpit.definition.onApiRequest!(params as never);
      throw new Error(`unexpected worker method ${method}`);
    }),
  };

  function app(deploymentMode: "authenticated" | "local_trusted") {
    const server = express();
    server.use(express.json());
    // The session store is the only stand-in: a `session=<userId>` cookie is that user's Better Auth session.
    server.use(actorMiddleware(db, {
      deploymentMode,
      resolveSession: async (req) => {
        const userId = /(?:^|;\s*)session=([^;]+)/.exec(req.header("cookie") ?? "")?.[1];
        return userId ? { session: { id: `session-${userId}`, userId }, user: { id: userId, name: userId, email: null } } as never : null;
      },
    }));
    server.use("/api", pluginRoutes(db, {} as never, undefined, { workerManager } as never, undefined, { workerManager } as never));
    server.use(errorHandler);
    return server;
  }

  async function listen(server: Server) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function bearer(table: "board" | "agent", userId: string) {
    const token = `pcp_${randomUUID()}`;
    const keyHash = createHash("sha256").update(token).digest("hex");
    if (table === "board") await db.insert(boardApiKeys).values({ userId, name: "test", keyHash });
    else await db.insert(agentApiKeys).values({ companyId: id.owner!, agentId: id.agent!, responsibleUserId: userId, name: "test", keyHash });
    return `Bearer ${token}`;
  }

  type Auth = { headers?: Record<string, string>; mode?: "authenticated" | "local_trusted" };
  const session = (userId: string): Auth => ({ headers: { Cookie: `session=${userId}` } });

  /** POST /api/plugins/:id/actions/:key, as the board UI and agents call it. */
  async function action(key: string, auth: Auth, params: Record<string, unknown> = {}, companyId = id.owner!) {
    const res = await fetch(`${servers[auth.mode ?? "authenticated"].base}/api/plugins/${id.plugin}/actions/${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(auth.headers ?? {}) },
      body: JSON.stringify({ companyId, params }),
    });
    return { status: res.status, body: await res.json() as { data?: Record<string, unknown>; message?: string; error?: string } };
  }

  async function ticketFor(auth: Auth) {
    const res = await action("browser.live.ticket", auth, { mode: "view" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return String(res.body.data!.ticket);
  }

  /** One upgrade of GET /browser/live; resolves 101 or the refusal's status, content type and raw body. */
  function upgrade(input: Auth & { ticket?: string; companyId?: string }) {
    const { base } = servers[input.mode ?? "authenticated"];
    const query = new URLSearchParams({ companyId: input.companyId ?? id.owner! });
    if (input.ticket !== undefined) query.set("ticket", input.ticket);
    return new Promise<{ status: number; type?: string; text?: string }>((resolve, reject) => {
      const ws = new WebSocket(`${base.replace("http:", "ws:")}/api/plugins/${id.plugin}/api/browser/live?${query}`, { origin: ORIGIN, headers: input.headers ?? {} });
      ws.on("open", () => { ws.terminate(); resolve({ status: 101 }); });
      ws.on("unexpected-response", (_req, res) => {
        let text = "";
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, type: res.headers["content-type"], text }));
      });
      ws.on("error", reject);
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cockpit-browser-live-");
    db = createDb(tempDb.connectionString);
    const [ownerCo, otherCo] = await db.insert(companies).values([
      { name: "Partners in Biz", issuePrefix: "PAR" },
      { name: "Client", issuePrefix: `C${randomUUID().slice(0, 6).toUpperCase()}` },
    ]).returning();
    id.owner = ownerCo!.id; id.other = otherCo!.id;
    const now = new Date();
    await db.insert(authUsers).values([owner, admin, member, otherOwner].map((user) => ({
      id: user, name: user, email: `${user}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    const memberships = [
      { companyId: id.owner, principalId: owner, membershipRole: "owner" },
      { companyId: id.owner, principalId: admin, membershipRole: "admin" },
      { companyId: id.owner, principalId: member, membershipRole: "member" },
      { companyId: id.other, principalId: otherOwner, membershipRole: "owner" },
    ];
    await db.insert(companyMemberships).values(memberships.map((m) => ({ ...m, principalType: "user", status: "active" })));
    const [agent] = await db.insert(agents).values({ companyId: id.owner, name: "Worker" }).returning();
    id.agent = agent!.id;
    const [plugin] = await db.insert(plugins).values({
      pluginKey: PLUGIN_KEY, packageName: "@partnersinbiz/plugin-cockpit", version: cockpitManifest.version,
      manifestJson: cockpitManifest as PaperclipPluginManifestV1, status: "ready",
    }).returning();
    id.plugin = plugin!.id;

    // The worker sees the same companies and members through its host client.
    harness = createTestHarness({ manifest: cockpitManifest, config: { browserLive: "view" } });
    harness.seed({
      companies: [{ id: id.owner, name: "Partners in Biz", issuePrefix: "PAR" } as never, { id: id.other, name: "Client", issuePrefix: "CLI" } as never],
      accessMembers: memberships.map((m) => ({
        id: `m-${m.principalId}`, companyId: m.companyId!, principalType: "user" as const, principalId: m.principalId, status: "active" as const,
        membershipRole: m.membershipRole, grants: [], createdAt: now, updatedAt: now,
      })),
    });
    await cockpit.definition.setup(harness.ctx);

    // The fake pib-browser daemon: /status over HTTP, /stream over WebSocket.
    daemon.on("request", (req, res) => {
      if (req.method === "GET" && req.url === "/status") {
        statusCalls += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(DAEMON_STATUS));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    daemon.on("upgrade", (req, socket, head) => {
      streams.push(req.headers);
      daemonWs.handleUpgrade(req, socket, head, () => undefined);
    });
    daemon.listen(socketPath);
    await once(daemon, "listening");
    for (const mode of ["authenticated", "local_trusted"] as const) {
      const handler = app(mode);
      const server = createServer(handler);
      setupPluginApiWebSocketServer(server, handler);
      servers[mode] = { server, base: await listen(server) };
    }
  }, 120_000);

  afterAll(async () => {
    for (const client of daemonWs.clients) client.terminate();
    daemonWs.close();
    for (const { server } of Object.values(servers)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    daemon.closeAllConnections();
    await new Promise((resolve) => daemon.close(resolve));
    rmSync(dir, { recursive: true, force: true });
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    streams = [];
    statusCalls = 0;
    harness.setConfig({ browserLive: "view" });
    vi.stubEnv("PAPERCLIP_PLUGIN_LOCAL_WS_TARGETS", `${PLUGIN_KEY}=${socketPath}`);
    vi.stubEnv("PIB_BROWSER_LIVE_SOCKET", socketPath);
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "cockpit-browser-live-routes");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const runToken = () => `Bearer ${createLocalAgentJwt(id.agent!, id.owner!, "process", randomUUID(), owner)}`;

  describe("browser.live.ticket (POST /api/plugins/:id/actions/browser.live.ticket)", () => {
    it("issues a ticket to a signed-in owner and admin of the owner company, without contacting the daemon", async () => {
      for (const user of [owner, admin]) {
        const res = await action("browser.live.ticket", session(user), { mode: "view" });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ mode: "view", ticket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
      }
      expect(statusCalls).toBe(0);
      expect(streams).toHaveLength(0);
    });

    it("refuses a member, another company's owner, an agent key and a run token acting for the owner, and the local board", async () => {
      const cases: Array<[string, Auth, string?]> = [
        ["a member who is not admin", session(member)],
        ["another company's owner, in that company", session(otherOwner), id.other],
        ["an agent key acting for the owner", { headers: { Authorization: await bearer("agent", owner) } }],
        ["a run token acting for the owner", { headers: { Authorization: runToken() } }],
        ["the local board (no person)", { mode: "local_trusted" }],
      ];
      for (const [label, auth, companyId] of cases) {
        const res = await action("browser.live.ticket", auth, { mode: "view" }, companyId);
        expect(res.status, label).toBe(502);
        expect(res.body.data, label).toBeUndefined();
        expect(JSON.stringify(res.body), label).not.toMatch(/"ticket"/);
      }
    });

    it("another company's owner asking for the owner company is stopped by core before the worker", async () => {
      workerManager.call.mockClear();
      expect((await action("browser.live.ticket", session(otherOwner), { mode: "view" })).status).toBe(403);
      expect(workerManager.call).not.toHaveBeenCalled();
    });

    it("refuses at off and when the setting read throws", async () => {
      harness.setConfig({ browserLive: "off" });
      expect((await action("browser.live.ticket", session(owner), { mode: "view" })).status).toBe(502);
      harness.setConfig({ browserLive: "view" });
      vi.spyOn(harness.ctx.config, "get").mockRejectedValue(new Error("host down"));
      expect((await action("browser.live.ticket", session(owner), { mode: "view" })).status).toBe(502);
    });
  });

  describe("browser.live.status", () => {
    it("passes the daemon's /status through for a signed-in owner or admin, at every setting", async () => {
      for (const setting of ["off", "view", "takeover"]) {
        harness.setConfig({ browserLive: setting });
        for (const user of [owner, admin]) {
          const res = await action("browser.live.status", session(user));
          expect(res.status).toBe(200);
          expect(res.body.data).toEqual({ reachable: true, status: DAEMON_STATUS });
        }
      }
      expect(statusCalls).toBe(6);
    });

    it("refuses a member, another company's owner, an agent key, a run token and the local board, and never reads the daemon", async () => {
      const cases: Array<[string, Auth, string?]> = [
        ["a member who is not admin", session(member)],
        ["another company's owner, in that company", session(otherOwner), id.other],
        ["an agent key acting for the owner", { headers: { Authorization: await bearer("agent", owner) } }],
        ["a run token acting for the owner", { headers: { Authorization: runToken() } }],
        ["the local board (no person)", { mode: "local_trusted" }],
      ];
      for (const [label, auth, companyId] of cases) {
        expect((await action("browser.live.status", auth, {}, companyId)).status, label).toBe(502);
      }
      expect(statusCalls).toBe(0);
    });
  });

  describe("GET /browser/live (WebSocket)", () => {
    it("a signed-in owner redeems a ticket once: the daemon gets one signed view stream for that person", async () => {
      const ticket = await ticketFor(session(owner));
      expect(await upgrade({ ...session(owner), ticket })).toEqual({ status: 101 });
      expect(streams).toHaveLength(1);
      expect(streams[0]!.cookie).toBeUndefined();
      const [body, signature] = String(streams[0]![PLUGIN_LOCAL_WS_SIGNATURE_HEADER]).split(".");
      expect(verify(null, Buffer.from(body!), createPublicKey(pluginLocalWsPublicKey().publicKey), Buffer.from(signature!, "base64url"))).toBe(true);
      expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toMatchObject({ pluginKey: PLUGIN_KEY, socket: socketPath, path: "/stream?mode=view", userId: owner });
      const activity = harness.dbExecutes.filter((q) => q.sql.includes(".activity") && JSON.stringify(q.params).includes("browser_live"));
      expect(activity.at(-1)!.params).toEqual(expect.arrayContaining([id.owner, "browser_live", `Watch live started by user ${owner}`]));
      expect(JSON.stringify(harness.dbExecutes)).not.toContain(ticket);
      // Used.
      const again = await upgrade({ ...session(owner), ticket });
      expect(again.status).toBe(403);
      expect(streams).toHaveLength(1);
    });

    it("every refusal that reaches the worker is byte-equal to the unknown-ticket answer, and opens no stream", async () => {
      const unknown = await upgrade({ ...session(owner), ticket: "x".repeat(43) });
      expect(unknown).toEqual({ status: 403, type: expect.stringContaining("application/json"), text: JSON.stringify({ error: "Plugin connection unavailable" }) });
      const cases: Array<[string, () => Promise<Parameters<typeof upgrade>[0]>]> = [
        ["no ticket", async () => session(owner)],
        ["a used ticket", async () => {
          const ticket = await ticketFor(session(owner));
          expect((await upgrade({ ...session(owner), ticket })).status).toBe(101);
          return { ...session(owner), ticket };
        }],
        ["another user's ticket", async () => ({ ...session(owner), ticket: await ticketFor(session(admin)) })],
        ["a member who is not admin, with the owner's ticket", async () => ({ ...session(member), ticket: await ticketFor(session(owner)) })],
        ["another company's owner, in that company", async () => ({ ...session(otherOwner), companyId: id.other, ticket: await ticketFor(session(owner)) })],
        ["the local board (no person)", async () => ({ mode: "local_trusted", ticket: await ticketFor(session(owner)) })],
        ["setting off", async () => {
          const ticket = await ticketFor(session(owner));
          harness.setConfig({ browserLive: "off" });
          return { ...session(owner), ticket };
        }],
        ["setting read throws", async () => {
          const ticket = await ticketFor(session(owner));
          vi.spyOn(harness.ctx.config, "get").mockRejectedValue(new Error("host down"));
          return { ...session(owner), ticket };
        }],
        ["an expired ticket", async () => {
          const ticket = await ticketFor(session(owner));
          vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31_000 });
          return { ...session(owner), ticket };
        }],
      ];
      for (const [label, make] of cases) {
        harness.setConfig({ browserLive: "view" });
        const input = await make();
        const before = streams.length;
        expect(await upgrade(input), label).toEqual(unknown);
        expect(streams.length, label).toBe(before);
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    });

    it("an agent key and a run token never reach the worker (core: board route)", async () => {
      const ticket = await ticketFor(session(owner));
      workerManager.call.mockClear();
      for (const [label, authorization] of [["agent key", await bearer("agent", owner)], ["run token", runToken()]] as const) {
        expect((await upgrade({ headers: { Authorization: authorization }, ticket })).status, label).toBe(403);
      }
      expect(workerManager.call).not.toHaveBeenCalled();
      expect(streams).toHaveLength(0);
    });

    it("a board key gets no stream: its ticket passes the worker but core refuses a local target without a session (S1)", async () => {
      const auth = { headers: { Authorization: await bearer("board", owner) } };
      const ticket = await ticketFor(auth);
      expect(await upgrade({ ...auth, ticket })).toEqual({ status: 502, type: expect.stringContaining("application/json"), text: JSON.stringify({ error: "Plugin connection unavailable" }) });
      expect(streams).toHaveLength(0);
    });
  });
});
