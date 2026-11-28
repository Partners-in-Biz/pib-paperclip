import http from "node:http";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isForwardableVoiceBridgePath,
  startVoiceTurnBridge,
  type VoiceTurnBridge,
  type VoiceTurnBridgeEvent,
} from "./turn-bridge.js";

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string; aborted: boolean };

/** Fake Paperclip server: records what reaches it; `/api/slow` holds the response until released. */
async function startUpstream() {
  const seen: Seen[] = [];
  const held: Array<() => void> = [];
  const server = http.createServer((req, res) => {
    const record: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: "", aborted: false };
    seen.push(record);
    req.on("data", (chunk) => (record.body += chunk));
    res.on("close", () => {
      if (!res.writableFinished) record.aborted = true;
    });
    req.on("end", () => {
      const reply = () => {
        res.writeHead(201, { "content-type": "application/json", "set-cookie": "s=1", etag: '"e1"' });
        res.end(JSON.stringify({ runId: req.headers["x-paperclip-run-id"] }));
      };
      if (req.url?.startsWith("/api/slow")) held.push(reply);
      else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    held,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function call(bridge: VoiceTurnBridge, path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${init.token ?? bridge.token}`);
  return fetch(`${bridge.url}${path}`, { ...init, headers });
}

/** Sends a raw request line, for request targets `fetch` would normalise. */
function raw(bridge: VoiceTurnBridge, requestLine: string): Promise<string> {
  const { port } = new URL(bridge.url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), "127.0.0.1", () => {
      socket.write(`${requestLine}\r\nHost: x\r\nAuthorization: Bearer ${bridge.token}\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => resolve(data.split("\r\n", 1)[0]!));
    socket.on("error", reject);
  });
}

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe("voice turn bridge", () => {
  let upstream: Awaited<ReturnType<typeof startUpstream>>;
  let bridge: VoiceTurnBridge;
  let events: VoiceTurnBridgeEvent[];

  beforeEach(async () => {
    upstream = await startUpstream();
    events = [];
    bridge = await startVoiceTurnBridge({ upstreamUrl: `${upstream.url}/api`, maxBodyBytes: 1024, onEvent: (e) => events.push(e) });
  });
  afterEach(async () => {
    await bridge.close();
    await upstream.close();
  });

  it("listens on loopback with a random token", () => {
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(bridge.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses with 403 before the first turn and between turns", async () => {
    const before = await call(bridge, "/api/agents/me");
    expect(before.status).toBe(403);
    expect((await before.json()).code).toBe("voice_bridge_no_turn");
    const turn = bridge.bind({ runId: "run-1", runToken: "tok-1" });
    expect((await call(bridge, "/api/agents/me")).status).toBe(201);
    expect(bridge.unbind(turn.generation)).toBe(true);
    const between = await call(bridge, "/api/issues/x/comments", { method: "POST", body: "{}" });
    expect(between.status).toBe(403);
    expect((await between.json()).code).toBe("voice_bridge_no_turn");
    expect(upstream.seen).toHaveLength(1);
  });

  it("refuses a wrong or missing bridge token with 401, also while a turn is bound", async () => {
    bridge.bind({ runId: "run-1", runToken: "tok-1" });
    for (const token of ["", "tok-1", `${bridge.token}x`, bridge.token.slice(1)]) {
      const res = await call(bridge, "/api/agents/me", { token });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe("voice_bridge_bad_token");
    }
    expect(upstream.seen).toHaveLength(0);
  });

  it("refuses another bridge's token with 401", async () => {
    const other = await startVoiceTurnBridge({ upstreamUrl: upstream.url });
    try {
      other.bind({ runId: "run-other", runToken: "tok-other" });
      const res = await call(other, "/api/agents/me", { token: bridge.token });
      expect(res.status).toBe(401);
      expect(upstream.seen).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it("sends each turn's own token and run id, never the process's", async () => {
    const t1 = bridge.bind({ runId: "run-1", runToken: "tok-1" });
    await call(bridge, "/api/issues/a/comments", { method: "POST", body: '{"n":1}', headers: { "content-type": "application/json" } });
    bridge.unbind(t1.generation);
    const t2 = bridge.bind({ runId: "run-2", runToken: "tok-2" });
    expect(t2.generation).toBe(t1.generation + 1);
    const res = await call(bridge, "/api/issues/a/comments?x=1", {
      method: "POST",
      body: '{"n":2}',
      headers: { "content-type": "application/json", "x-paperclip-run-id": "run-1", cookie: "c=1", "x-forwarded-for": "1.2.3.4", "idempotency-key": "k2" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ runId: "run-2" });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("etag")).toBe('"e1"');
    const [first, second] = upstream.seen;
    expect(first!.headers.authorization).toBe("Bearer tok-1");
    expect(first!.headers["x-paperclip-run-id"]).toBe("run-1");
    expect(second!.headers.authorization).toBe("Bearer tok-2");
    expect(second!.headers["x-paperclip-run-id"]).toBe("run-2");
    expect(second!.headers.cookie).toBeUndefined();
    expect(second!.headers["x-forwarded-for"]).toBeUndefined();
    expect(second!.headers["idempotency-key"]).toBe("k2");
    expect(second!).toMatchObject({ url: "/api/issues/a/comments?x=1", body: '{"n":2}' });
    expect(JSON.stringify(events)).not.toContain("tok-");
    expect(JSON.stringify(events)).not.toContain(bridge.token);
  });

  it("unbinds only the named generation and refuses a second bind", () => {
    const t1 = bridge.bind({ runId: "run-1", runToken: "tok-1" });
    expect(() => bridge.bind({ runId: "run-2", runToken: "tok-2" })).toThrow(/already bound/);
    bridge.unbind(t1.generation);
    const t2 = bridge.bind({ runId: "run-2", runToken: "tok-2" });
    expect(bridge.unbind(t1.generation)).toBe(false);
    expect(bridge.current()).toEqual({ runId: "run-2", generation: t2.generation });
    expect(bridge.current()).not.toHaveProperty("runToken");
  });

  it("aborts a request in flight when the turn is cancelled, and refuses during the cancelled turn", async () => {
    const turn = bridge.bind({ runId: "run-1", runToken: "tok-1" });
    const pending = call(bridge, "/api/slow", { method: "POST", body: "{}" });
    await waitFor(() => upstream.held.length === 1);
    bridge.unbind(turn.generation);
    const res = await pending;
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("voice_bridge_turn_ended");
    await waitFor(() => upstream.seen[0]!.aborted);
    upstream.held[0]!(); // the late reply goes nowhere
    expect((await call(bridge, "/api/issues/a", { method: "PATCH", body: "{}" })).status).toBe(403);
  });

  it("cuts off a body still arriving when the turn ends", async () => {
    const turn = bridge.bind({ runId: "run-1", runToken: "tok-1" });
    const { port } = new URL(bridge.url);
    const result = new Promise<string>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/issues/a/comments",
        headers: { authorization: `Bearer ${bridge.token}`, "transfer-encoding": "chunked" } });
      req.on("response", (res) => resolve(String(res.statusCode)));
      req.on("error", () => resolve("reset"));
      req.write("{");
    });
    await new Promise((r) => setTimeout(r, 30));
    bridge.unbind(turn.generation);
    expect(["403", "reset"]).toContain(await result);
    expect(upstream.seen).toHaveLength(0);
  });

  it("forwards only /api routes in origin form", async () => {
    bridge.bind({ runId: "run-1", runToken: "tok-1" });
    for (const path of ["/", "/mcp/gateways/x", "/runtime-tools/github/credentials", "/apix"]) {
      const res = await call(bridge, path);
      expect(res.status, path).toBe(403);
      expect((await res.json()).code, path).toBe("voice_bridge_route");
    }
    // `fetch` would normalise these targets, so they go over a raw socket.
    for (const target of ["http://evil.example/api/agents/me", "//evil.example/api/agents/me", "/api/../health",
      "/api/%2e%2e/health", "/api/a/%2E%2E/b"]) {
      expect(await raw(bridge, `GET ${target} HTTP/1.1`), target).toContain("403");
    }
    expect((await call(bridge, "/api/a", { method: "OPTIONS" })).status).toBe(405);
    expect(upstream.seen).toHaveLength(0);
    expect((await call(bridge, "/api")).status).toBe(201);
  });

  it("refuses a body over the limit, declared or streamed", async () => {
    bridge.bind({ runId: "run-1", runToken: "tok-1" });
    const big = "x".repeat(2048);
    expect((await call(bridge, "/api/a", { method: "POST", body: big })).status).toBe(413);
    const streamed = await new Promise<number>((resolve) => {
      const { port } = new URL(bridge.url);
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/a",
        headers: { authorization: `Bearer ${bridge.token}`, "transfer-encoding": "chunked" } });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("error", () => resolve(-1));
      req.write(big);
      req.end();
    });
    expect([413, -1]).toContain(streamed);
    expect(upstream.seen).toHaveLength(0);
  });

  it("close() drops the binding and aborts requests in flight", async () => {
    bridge.bind({ runId: "run-1", runToken: "tok-1" });
    const pending = call(bridge, "/api/slow").then((r) => r.status, () => "reset");
    await waitFor(() => upstream.held.length === 1);
    await bridge.close();
    expect([403, "reset"]).toContain(await pending);
    expect(bridge.current()).toBeNull();
  });
});

describe("isForwardableVoiceBridgePath", () => {
  it.each([
    ["/api", true], ["/api/", true], ["/api/issues/PAR-1?x=..", true], ["/api/a%20b", true],
    ["/apix", false], ["api/x", false], ["/api//x", false], ["/api/a\\b", false], ["/api/a%5Cb", false],
    ["/api/./x", false], ["/api/%2e/x", false], ["/api/%zz", false], ["http://h/api", false],
  ])("%s -> %s", (path, ok) => expect(isForwardableVoiceBridgePath(path)).toBe(ok));
});
