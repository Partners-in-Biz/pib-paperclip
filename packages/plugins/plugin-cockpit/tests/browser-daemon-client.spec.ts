/**
 * The worker-to-daemon client (PAR-14514 S3, design 3): plain node:http over a unix socket, tested against a fake
 * daemon on a temp socket.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_LIVE_SOCKET, BrowserDaemonError, browserLiveSocket, callBrowserDaemon, readBrowserDaemonStatus } from "../src/browser-daemon-client.js";

const dir = mkdtempSync(join(tmpdir(), "cockpit-daemon-"));
const socketPath = join(dir, "live.sock");
let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void = () => undefined;
const seen: Array<{ method?: string; url?: string; body: string }> = [];
let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      handler(req, res, body);
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
});
afterEach(() => { seen.length = 0; });
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const STATUS = { viewers: 1, agentSessions: ["pib:meta"], lease: null, waiting: [] };
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};

describe("browser daemon client", () => {
  it("defaults to the daemon's live socket and honours PIB_BROWSER_LIVE_SOCKET", () => {
    expect(BROWSER_LIVE_SOCKET).toBe("/run/pib-browser/live.sock");
    expect(browserLiveSocket({})).toBe("/run/pib-browser/live.sock");
    expect(browserLiveSocket({ PIB_BROWSER_LIVE_SOCKET: "/tmp/x.sock" })).toBe("/tmp/x.sock");
  });

  it("reads /status over the unix socket and passes it through unchanged", async () => {
    handler = (_req, res) => json(res, 200, STATUS);
    expect(await readBrowserDaemonStatus(socketPath)).toEqual(STATUS);
    expect(seen).toEqual([{ method: "GET", url: "/status", body: "" }]);
  });

  it("sends a JSON body on POST (the /release call S4 uses)", async () => {
    handler = (_req, res, body) => json(res, 200, { ok: true, echo: JSON.parse(body) });
    expect(await callBrowserDaemon({ method: "POST", path: "/release", body: { identity: "pib:meta" }, socketPath })).toEqual({ ok: true, echo: { identity: "pib:meta" } });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/release" });
  });

  it.each([
    ["a non-2xx answer", (_req: IncomingMessage, res: ServerResponse) => json(res, 500, { error: "x" }), "http_error"],
    ["a non-JSON answer", (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200); res.end("not json"); }, "bad_response"],
    ["a JSON array", (_req: IncomingMessage, res: ServerResponse) => json(res, 200, []), "bad_response"],
    ["an answer over 64 KB", (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200); res.end("x".repeat(70 * 1024)); }, "bad_response"],
  ] as const)("refuses %s", async (_label, respond, reason) => {
    handler = respond;
    await expect(readBrowserDaemonStatus(socketPath)).rejects.toMatchObject({ reason });
  });

  it("fails with unreachable when nothing listens on the socket", async () => {
    const error = await readBrowserDaemonStatus(join(dir, "missing.sock")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrowserDaemonError);
    expect(error).toMatchObject({ reason: "unreachable" });
  });

  it("times out when the daemon never answers", async () => {
    handler = () => undefined;
    await expect(callBrowserDaemon({ method: "GET", path: "/status", socketPath, timeoutMs: 100 })).rejects.toMatchObject({ reason: "timeout" });
  });
});
