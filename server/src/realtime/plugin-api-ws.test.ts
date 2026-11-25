import { createPublicKey, verify } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  PLUGIN_LOCAL_WS_SIGNATURE_HEADER,
  pluginLocalWsPublicKey,
  resolvePluginLocalWsTarget,
} from "../services/plugin-local-ws.js";
import { proxyPluginApiWebSocket, setupPluginApiWebSocketServer, type PluginApiWebSocketTarget } from "./plugin-api-ws.js";

/** PAR-14532 (PAR-14514 S1): the proxy's local unix-socket target and its signed header. */

const PLUGIN = "partnersinbiz.cockpit";
const person = { type: "board", source: "session", userId: "user-1" };

/** Verifies a header with the published key; returns the signed statement. */
function verifiedStatement(header: string, publicKeyPem = pluginLocalWsPublicKey().publicKey) {
  const [body, signature, extra] = header.split(".");
  expect(extra).toBeUndefined();
  expect(verify(null, Buffer.from(body!), createPublicKey(publicKeyPem), Buffer.from(signature!, "base64url"))).toBe(true);
  return JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("local plugin WebSocket target", () => {
  let dir = "";
  let socketPath = "";
  let upstream: Server;
  let upstreamWs: WebSocketServer;
  let seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  let proxy: Server;
  let proxyBase = "";
  let target: () => PluginApiWebSocketTarget | null = () => null;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pclws-"));
    socketPath = path.join(dir, "live.sock");
    seen = [];
    upstream = createServer();
    upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      seen.push({ url: req.url!, headers: req.headers });
      upstreamWs.handleUpgrade(req, socket, head, ws => ws.on("message", (bytes, binary) => ws.send(bytes, { binary })));
    });
    upstream.listen(socketPath);
    await once(upstream, "listening");

    const app = express();
    app.get("/api/plugins/p/api/live", (req, res) => {
      const resolved = target();
      if (!resolved) { res.status(502).json({ error: "Plugin connection unavailable" }); return; }
      proxyPluginApiWebSocket(req, res, resolved, () => true);
    });
    proxy = createServer(app);
    setupPluginApiWebSocketServer(proxy, app);
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    proxyBase = `ws://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    for (const client of upstreamWs.clients) client.terminate();
    upstreamWs.close();
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
    rmSync(dir, { recursive: true, force: true });
  });

  const env = () => ({ PAPERCLIP_PLUGIN_LOCAL_WS_TARGETS: `other.plugin=/run/x.sock, ${PLUGIN}=${socketPath}` });
  const resolve = (overrides: Record<string, unknown> = {}) => resolvePluginLocalWsTarget({
    pluginKey: PLUGIN, capabilities: ["api.routes.register", "websocket.local"], actor: person,
    websocket: { local: { socket: socketPath, path: "/stream?mode=view" } }, env: env(), ...overrides,
  });

  /** Opens the browser side; resolves 101 or the refusal status. */
  const connect = () => new Promise<{ status: number; ws?: WebSocket }>((done, fail) => {
    const ws = new WebSocket(`${proxyBase}/api/plugins/p/api/live`, {
      origin: "http://localhost:3100", headers: { Cookie: "session=browser", Authorization: "Bearer browser", "X-Forwarded-For": "1.2.3.4" },
    });
    ws.on("open", () => done({ status: 101, ws }));
    ws.on("unexpected-response", (_req, res) => { res.resume(); done({ status: res.statusCode! }); });
    ws.on("error", fail);
  });

  it("relays over the unix socket and adds exactly one signed header that verifies with the published key", async () => {
    const before = Date.now();
    target = () => resolve();
    const { status, ws } = await connect();
    expect(status).toBe(101);
    try {
      const payload = Buffer.from([0, 1, 255]);
      const reply = once(ws!, "message"); ws!.send(payload);
      expect((await reply)[0]).toEqual(payload);

      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe("/stream?mode=view");
      const headers = seen[0]!.headers;
      for (const name of ["cookie", "origin", "authorization", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded"]) {
        expect(headers[name], name).toBeUndefined();
      }
      // Only the WebSocket handshake, the default Host and the one signed header.
      expect(Object.keys(headers).sort()).toEqual([
        "connection", "host", PLUGIN_LOCAL_WS_SIGNATURE_HEADER, "sec-websocket-extensions", "sec-websocket-key", "sec-websocket-version", "upgrade",
      ].sort());
      const statement = verifiedStatement(String(headers[PLUGIN_LOCAL_WS_SIGNATURE_HEADER]));
      expect(statement).toMatchObject({ v: 1, pluginKey: PLUGIN, socket: socketPath, path: "/stream?mode=view", userId: "user-1" });
      expect(statement.ts).toBeGreaterThanOrEqual(before);
      expect(statement.ts).toBeLessThanOrEqual(Date.now());
      expect(statement.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    } finally { ws!.terminate(); }
  });

  it("signs a fresh random number on every upgrade; a changed statement no longer verifies", () => {
    const a = resolve()!; const b = resolve()!;
    if (!("local" in a) || !("local" in b)) throw new Error("expected local targets");
    const first = verifiedStatement(a.signature.value);
    expect(verifiedStatement(b.signature.value).nonce).not.toBe(first.nonce);
    const forged = Buffer.from(JSON.stringify({ ...first, userId: "someone-else" })).toString("base64url");
    const [, signature] = a.signature.value.split(".");
    expect(verify(null, Buffer.from(forged), createPublicKey(pluginLocalWsPublicKey().publicKey), Buffer.from(signature!, "base64url"))).toBe(false);
  });

  it.each([
    ["without websocket.local", { capabilities: ["api.routes.register", "http.outbound"] }],
    ["with the setting empty", { env: {} }],
    ["with the setting unset", { env: { PAPERCLIP_PLUGIN_LOCAL_WS_TARGETS: undefined } }],
    ["for another plugin's pair", { pluginKey: "other.plugin" }],
    ["for a socket that is only a prefix of the listed one", { websocket: { local: { socket: socketPath.slice(0, -1), path: "/s" } } }],
    ["with plugin-supplied headers", { websocket: { local: { socket: socketPath, path: "/s" }, headers: { Authorization: "x" } } }],
    ["mixed with a url", { websocket: { url: "wss://example.test", local: { socket: socketPath, path: "/s" } } }],
    ["with a full url as path", { websocket: { local: { socket: socketPath, path: "http://evil.test/s" } } }],
    ["with a host-relative path", { websocket: { local: { socket: socketPath, path: "//evil.test/s" } } }],
    ["with a relative path", { websocket: { local: { socket: socketPath, path: "stream" } } }],
    ["with a space in the path", { websocket: { local: { socket: socketPath, path: "/s x" } } }],
    ["with a relative socket", { websocket: { local: { socket: "live.sock", path: "/s" } } }],
    ["for a board key", { actor: { type: "board", source: "board_key", userId: "user-1" } }],
    ["for the local board", { actor: { type: "board", source: "local_implicit", userId: "local-board" } }],
    ["for a session with no user id", { actor: { type: "board", source: "session", userId: null } }],
    ["for an agent key", { actor: { type: "agent", source: "agent_key", userId: null } }],
    ["for a run token", { actor: { type: "agent", source: "agent_jwt" } }],
    ["for nobody", { actor: { type: "none", source: "none" } }],
  ])("refuses a local target %s: 502 and no upstream connection", async (_label, overrides) => {
    const resolved = resolve(overrides);
    expect(resolved).toBeNull();
    target = () => resolved;
    expect((await connect()).status).toBe(502);
    expect(seen).toHaveLength(0);
  });

  it("the proxy itself refuses a target path with a scheme or host, even when handed one directly", async () => {
    for (const bad of ["http://evil.test/s", "//evil.test/s", "s", "/s#frag"]) {
      target = () => ({ local: { socket: socketPath, path: bad }, signature: { name: PLUGIN_LOCAL_WS_SIGNATURE_HEADER, value: "x" } });
      expect((await connect()).status, bad).toBe(502);
    }
    expect(seen).toHaveLength(0);
  });

  it("answers 502 when nothing listens on the listed socket", async () => {
    target = () => resolve({ env: { PAPERCLIP_PLUGIN_LOCAL_WS_TARGETS: `${PLUGIN}=${path.join(dir, "gone.sock")}` }, websocket: { local: { socket: path.join(dir, "gone.sock"), path: "/s" } } });
    expect((await connect()).status).toBe(502);
  });
});
