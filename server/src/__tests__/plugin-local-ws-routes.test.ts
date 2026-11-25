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
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { setupPluginApiWebSocketServer } from "../realtime/plugin-api-ws.js";
import { pluginRoutes } from "../routes/plugins.js";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";
import { PLUGIN_LOCAL_WS_SIGNATURE_HEADER } from "../services/plugin-local-ws.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

/**
 * PAR-14532 (PAR-14514 S1, Verification S1): a local plugin WebSocket target
 * through the real auth middleware, no hand-set actor. Every refusal answers
 * its documented error and the fake socket server sees zero connections.
 */

const support = await getEmbeddedPostgresTestSupport();

describe("plugin local WebSocket database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

const ORIGIN = "http://localhost:3100";

describe("the WebSocket capability rule in the server's manifest check (F26)", () => {
  it.each([
    [["api.routes.register"], ["http.outbound"]],
    [["api.routes.register", "http.outbound"], []],
    [["api.routes.register", "websocket.local"], []],
  ] as const)("%j is missing %j", (capabilities, missing) => {
    const result = pluginCapabilityValidator().validateManifestCapabilities(manifest("paperclip.ws-rule", [...capabilities]));
    expect(result.missing).toEqual(missing);
  });
});

function manifest(key: string, capabilities: PaperclipPluginManifestV1["capabilities"]): PaperclipPluginManifestV1 {
  return {
    id: key, apiVersion: 1, version: "1.0.0", displayName: key, description: "local ws fixture", author: "Paperclip",
    categories: ["automation"], capabilities, entrypoints: { worker: "dist/worker.js" },
    apiRoutes: [{ routeKey: "live", method: "GET", path: "/live", transport: "websocket", auth: "board",
      capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } }],
  } as PaperclipPluginManifestV1;
}

(support.supported ? describe : describe.skip)("local plugin WebSocket target through the real auth middleware", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  const LOCAL = `paperclip.local-ws-${randomUUID().slice(0, 8)}`;
  const OUTBOUND = `paperclip.outbound-ws-${randomUUID().slice(0, 8)}`;
  const NEITHER = `paperclip.no-upstream-ws-${randomUUID().slice(0, 8)}`;
  const ownerA = `owner-a-${randomUUID()}`;
  const ownerB = `owner-b-${randomUUID()}`;
  const id: Record<string, string> = {};
  const workerManager = { isRunning: vi.fn(() => true), call: vi.fn() };
  const dir = mkdtempSync(path.join(tmpdir(), "pclws-route-"));
  const socketPath = path.join(dir, "live.sock");
  const upstream = createServer();
  const upstreamWs = new WebSocketServer({ noServer: true });
  let seen: IncomingHttpHeaders[] = [];
  const servers: Record<"authenticated" | "local_trusted", { server: Server; base: string }> = {} as never;

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
    else await db.insert(agentApiKeys).values({ companyId: id.A!, agentId: id.agent!, responsibleUserId: userId, name: "test", keyHash });
    return `Bearer ${token}`;
  }

  /** One upgrade; resolves 101 or the refusal's status and body. */
  function upgrade(input: { pluginId?: string; headers?: Record<string, string>; origin?: string | null; mode?: "authenticated" | "local_trusted" }) {
    const { base } = servers[input.mode ?? "authenticated"];
    const origin = input.origin === undefined ? ORIGIN : input.origin;
    return new Promise<{ status: number; body?: unknown }>((resolve, reject) => {
      const ws = new WebSocket(`${base.replace("http:", "ws:")}/api/plugins/${input.pluginId ?? id.local}/api/live?companyId=${id.A}`,
        { ...(origin ? { origin } : {}), headers: input.headers ?? {} });
      ws.on("open", () => { ws.terminate(); resolve({ status: 101 }); });
      ws.on("unexpected-response", (_req, res) => {
        let text = "";
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : undefined }));
      });
      ws.on("error", reject);
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-local-ws-");
    db = createDb(tempDb.connectionString);
    const [a, b] = await db.insert(companies).values([
      { name: "A", issuePrefix: `A${randomUUID().slice(0, 6).toUpperCase()}` },
      { name: "B", issuePrefix: `B${randomUUID().slice(0, 6).toUpperCase()}` },
    ]).returning();
    id.A = a!.id; id.B = b!.id;
    const now = new Date();
    await db.insert(authUsers).values([ownerA, ownerB].map((user) => ({
      id: user, name: user, email: `${user}@example.test`, emailVerified: true, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([
      { companyId: id.A, principalType: "user", principalId: ownerA, membershipRole: "owner", status: "active" },
      { companyId: id.B, principalType: "user", principalId: ownerB, membershipRole: "owner", status: "active" },
    ]);
    const [agent] = await db.insert(agents).values({ companyId: id.A, name: "Worker" }).returning();
    id.agent = agent!.id;
    for (const [name, key, caps] of [
      ["local", LOCAL, ["api.routes.register", "websocket.local"]],
      ["outbound", OUTBOUND, ["api.routes.register", "http.outbound"]],
      // Stored directly: the manifest check would refuse it; the route must too.
      ["neither", NEITHER, ["api.routes.register"]],
    ] as const) {
      const [row] = await db.insert(plugins).values({
        pluginKey: key, packageName: key, version: "1.0.0", manifestJson: manifest(key, [...caps]), status: "ready",
      }).returning();
      id[name] = row!.id;
    }

    upstream.on("upgrade", (req, socket, head) => {
      seen.push(req.headers);
      upstreamWs.handleUpgrade(req, socket, head, () => undefined);
    });
    upstream.listen(socketPath);
    await once(upstream, "listening");
    for (const mode of ["authenticated", "local_trusted"] as const) {
      const handler = app(mode);
      const server = createServer(handler);
      setupPluginApiWebSocketServer(server, handler);
      servers[mode] = { server, base: await listen(server) };
    }
  }, 120_000);

  afterAll(async () => {
    for (const client of upstreamWs.clients) client.terminate();
    upstreamWs.close();
    for (const { server } of Object.values(servers)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(dir, { recursive: true, force: true });
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    seen = [];
    workerManager.call.mockResolvedValue({ websocket: { local: { socket: socketPath, path: "/stream?mode=view" } } });
    vi.stubEnv("PAPERCLIP_PLUGIN_LOCAL_WS_TARGETS", `${LOCAL}=${socketPath}`);
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "plugin-local-ws-routes");
  });
  afterEach(() => vi.unstubAllEnvs());

  const unavailable = { status: 502, body: { error: "Plugin connection unavailable" } };

  it("a signed-in owner gets the stream; its one signed header verifies with the key from the public route", async () => {
    const keyResponse = await fetch(`${servers.authenticated.base}/api/plugins/local-ws-key`);
    expect(keyResponse.status).toBe(200);
    expect(keyResponse.headers.get("cache-control")).toBe("no-store");
    const key = await keyResponse.json() as { algorithm: string; header: string; publicKey: string };
    expect(key).toMatchObject({ algorithm: "Ed25519", header: PLUGIN_LOCAL_WS_SIGNATURE_HEADER });
    expect(key.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);

    expect(await upgrade({ headers: { Cookie: `session=${ownerA}` } })).toEqual({ status: 101 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cookie).toBeUndefined();
    expect(seen[0]!.origin).toBeUndefined();
    const [body, signature] = String(seen[0]![PLUGIN_LOCAL_WS_SIGNATURE_HEADER]).split(".");
    expect(verify(null, Buffer.from(body!), createPublicKey(key.publicKey), Buffer.from(signature!, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toMatchObject({
      pluginKey: LOCAL, socket: socketPath, path: "/stream?mode=view", userId: ownerA,
    });
    expect(workerManager.call).toHaveBeenCalledWith(id.local, "handleApiRequest", expect.objectContaining({ routeKey: "live", companyId: id.A }));
  });

  it("refuses, before the worker, no session, another company's session, an agent key, a run token and a wrong Origin", async () => {
    const runToken = createLocalAgentJwt(id.agent!, id.A!, "process", randomUUID(), ownerA);
    const cases: Array<[string, Parameters<typeof upgrade>[0], number]> = [
      ["no session", {}, 403],
      ["another company's session", { headers: { Cookie: `session=${ownerB}` } }, 403],
      ["an agent key", { headers: { Authorization: await bearer("agent", ownerA) } }, 403],
      ["a run token", { headers: { Authorization: `Bearer ${runToken}` } }, 403],
      ["no Origin", { headers: { Cookie: `session=${ownerA}` }, origin: null }, 403],
      ["a wrong Origin", { headers: { Cookie: `session=${ownerA}` }, origin: "https://attacker.test" }, 403],
    ];
    for (const [label, input, status] of cases) {
      expect((await upgrade(input)).status, label).toBe(status);
    }
    expect(workerManager.call).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it("refuses a board key and the local board with today's 502 body: no person, no local target (design 1c)", async () => {
    expect(await upgrade({ headers: { Authorization: await bearer("board", ownerA) } })).toEqual(unavailable);
    expect(await upgrade({ mode: "local_trusted" })).toEqual(unavailable);
    expect(workerManager.call).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(0);
  });

  it("refuses a pair not on the operator list, and a plugin without websocket.local, with today's 502 body", async () => {
    const session = { Cookie: `session=${ownerA}` };
    vi.stubEnv("PAPERCLIP_PLUGIN_LOCAL_WS_TARGETS", "");
    expect(await upgrade({ headers: session })).toEqual(unavailable);
    vi.stubEnv("PAPERCLIP_PLUGIN_LOCAL_WS_TARGETS", `${LOCAL}=${socketPath}.other ${OUTBOUND}=${socketPath}`);
    expect(await upgrade({ headers: session })).toEqual(unavailable);
    // http.outbound alone still opens the route (wss: targets), never a local one.
    expect(await upgrade({ pluginId: id.outbound, headers: session })).toEqual(unavailable);
    expect(workerManager.call).toHaveBeenCalledTimes(3);
    expect(seen).toHaveLength(0);
  });

  it("the route opens with http.outbound or websocket.local and refuses a plugin with neither (426, F26)", async () => {
    expect((await upgrade({ pluginId: id.neither, headers: { Cookie: `session=${ownerA}` } })).status).toBe(426);
    expect(workerManager.call).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it("a plugin with websocket.local alone may not use a wss: target", async () => {
    workerManager.call.mockResolvedValue({ websocket: { url: "wss://example.test/live" } });
    expect(await upgrade({ headers: { Cookie: `session=${ownerA}` } })).toEqual(unavailable);
  });
});
