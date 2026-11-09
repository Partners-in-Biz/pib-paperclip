// Egress proxy for the preview service's /render Chromium (PAR-8798, plan PAR-8787 r3).
//
// /render loads a client URL in Chromium with scripts on. Checking only that URL is not enough: the page can load
// iframes, images and fetch() from anywhere, including 127.0.0.1:3031 and the cloud metadata address. So Chromium runs
// with --proxy-server pointing here (renderArgs in sweep.mjs) and every connection it makes is checked:
// - CONNECT host:port (https, wss) and plain-HTTP absolute-URI requests only; port 80 or 443 only.
// - The host is resolved once; if ANY address is not public the request is refused (403, connection closed).
// - The proxy then connects to the checked address itself, so a second DNS answer (rebinding) cannot change it.
// - A tunnel or request idle for 15 s is closed.
// Listens on 127.0.0.1 only, on an ephemeral port.
import http from "node:http";
import net from "node:net";
import { ALLOWED_PORTS, isPublicAddress, lookupAll, publicAddresses } from "./sweep.mjs";

export const EGRESS_IDLE_MS = 15_000;

const HOP_BY_HOP = ["connection", "proxy-connection", "proxy-authorization", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"];

/** host and port of a CONNECT authority (`example.com:443`, `[2001:db8::1]:443`), or null. */
function parseAuthority(authority) {
  if (typeof authority !== "string" || !/^[^/?#@\s]+:\d+$/.test(authority)) return null;
  try {
    const u = new URL(`http://${authority}`);
    const port = Number(authority.slice(authority.lastIndexOf(":") + 1));
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

function refuseSocket(socket, status, reason) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${reason}\n`);
}

/**
 * The proxy server (not listening yet). Options exist for tests: `resolve(host) -> Promise<string[]>`, `isPublic(ip)`,
 * `ports` (allowed destination ports) and `idleMs`. Production uses the defaults.
 */
export function createEgressProxy({ resolve = lookupAll, isPublic = isPublicAddress, ports = ALLOWED_PORTS, idleMs = EGRESS_IDLE_MS, log = () => {} } = {}) {
  async function check(host, port) {
    if (!ports.includes(port)) throw new Error(`refused: port ${port}`);
    return publicAddresses(host, resolve, isPublic);
  }

  const server = http.createServer(async (req, res) => {
    res.on("error", () => undefined);
    let target;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400, { "content-type": "text/plain", connection: "close" }).end("absolute http:// URL required\n");
      return;
    }
    if (target.protocol !== "http:" || target.username || target.password) {
      res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end("refused\n");
      return;
    }
    const port = target.port ? Number(target.port) : 80;
    let addresses;
    try {
      addresses = await check(target.hostname, port);
    } catch (err) {
      log(`egress ${req.method} ${target.host}: ${err.message}`);
      res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end(`${err.message}\n`);
      return;
    }
    const headers = { ...req.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    headers.host = target.host;
    headers.connection = "close";
    const upstream = http.request({ host: addresses[0], port, method: req.method, path: `${target.pathname}${target.search}`, headers, setHost: false, agent: false });
    upstream.setTimeout(idleMs, () => upstream.destroy(new Error("idle")));
    upstream.on("response", (up) => {
      const out = { ...up.headers };
      for (const name of HOP_BY_HOP) delete out[name];
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain", connection: "close" }).end("upstream failed\n");
      else res.destroy();
    });
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on("connect", async (req, client, head) => {
    client.on("error", () => undefined);
    const target = parseAuthority(req.url);
    if (!target) return refuseSocket(client, "400 Bad Request", "host:port required");
    let addresses;
    try {
      addresses = await check(target.host, target.port);
    } catch (err) {
      log(`egress CONNECT ${req.url}: ${err.message}`);
      return refuseSocket(client, "403 Forbidden", err.message);
    }
    if (client.destroyed) return;
    const upstream = net.connect({ host: addresses[0], port: target.port });
    const closeBoth = () => {
      upstream.destroy();
      client.destroy();
    };
    let open = false;
    upstream.on("error", () => (open ? client.destroy() : refuseSocket(client, "502 Bad Gateway", "upstream failed")));
    upstream.once("connect", () => {
      open = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    for (const s of [client, upstream]) {
      s.setTimeout(idleMs, closeBoth);
      s.on("close", closeBoth);
    }
  });

  // A WebSocket upgrade sent as a plain request (not through CONNECT) is never forwarded.
  server.on("upgrade", (_req, socket) => {
    socket.on("error", () => undefined);
    refuseSocket(socket, "403 Forbidden", "refused: upgrade");
  });
  server.on("clientError", (_err, socket) => refuseSocket(socket, "400 Bad Request", "bad request"));
  return server;
}

/** Start the proxy on 127.0.0.1 and an ephemeral port. Returns `{ port, close }`. */
export async function startEgressProxy(options) {
  const server = createEgressProxy(options);
  // CONNECT tunnels are detached from the HTTP server, so track raw sockets to close them all on shutdown.
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      done();
    });
  });
  return {
    port: server.address().port,
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
