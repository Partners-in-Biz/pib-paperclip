import { ServerResponse, request as httpRequest, type ClientRequest, type IncomingMessage, type RequestListener, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { isPluginLocalWsPath, isPluginLocalWsSocketPath } from "../services/plugin-local-ws.js";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { validateHeaderName, validateHeaderValue } from "node:http";
import type { Request, Response } from "express";

export const pluginApiUpgrade = Symbol("pluginApiUpgrade");
type UpgradeRequest = IncomingMessage & {
  paperclipWebSocketHandled?: boolean;
  [pluginApiUpgrade]?: { socket: Socket; head: Buffer };
};

/** Reuse the full HTTP authentication/company pipeline for plugin upgrades. */
export function setupPluginApiWebSocketServer(server: Server, handler: RequestListener) {
  server.on("upgrade", (request: UpgradeRequest, socket: Socket, head: Buffer) => {
    if (request.paperclipWebSocketHandled || !/^\/api\/plugins\/[^/]+\/api\//.test(request.url ?? "")) return;
    request.paperclipWebSocketHandled = true;
    socket.on("error", () => socket.destroy());
    if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket"
      || request.headers["content-length"] || request.headers["transfer-encoding"]) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    request[pluginApiUpgrade] = { socket, head };
    const response = new ServerResponse(request);
    response.assignSocket(socket);
    response.setHeader("Connection", "close");
    response.once("finish", () => socket.end());
    handler(request, response);
  });
}

/** A remote WSS target, or a core-checked local unix socket with its one signed header. */
export type PluginApiWebSocketTarget =
  | { url: string; headers?: Record<string, string> }
  | { local: { socket: string; path: string }; signature: { name: string; value: string } };

/** Only worker-selected targets and credentials reach the upstream. Neither a local path nor its signature is logged. */
export function proxyPluginApiWebSocket(
  req: Request,
  res: Response,
  target: PluginApiWebSocketTarget,
  available: () => boolean,
) {
  const upgrade = (req as UpgradeRequest)[pluginApiUpgrade];
  if (!upgrade || upgrade.socket.destroyed) return;
  const { socket, head } = upgrade;
  const headers: Record<string, string | string[]> = {};
  let open: () => ClientRequest;
  try {
    if ("local" in target) {
      const { socket: socketPath, path } = target.local;
      if (!isPluginLocalWsSocketPath(socketPath) || !isPluginLocalWsPath(path)) throw new Error();
      validateHeaderName(target.signature.name); validateHeaderValue(target.signature.name, target.signature.value);
      // No plugin headers, cookie, origin, authorization or forwarding: only the signed statement.
      headers[target.signature.name] = target.signature.value;
      open = () => httpRequest({ socketPath, path, method: "GET", headers, timeout: 15_000 });
    } else {
      const url = new URL(target.url);
      if (url.protocol !== "wss:" || url.username || url.password || url.hash) throw new Error();
      for (const [name, value] of Object.entries(target.headers ?? {})) { validateHeaderName(name); validateHeaderValue(name, value); }
      // A plugin may supply upstream authorization, never browser cookies/origin.
      if (Object.keys(target.headers ?? {}).some(key => /^(cookie|origin|host|connection|upgrade|sec-websocket-|x-forwarded-)/i.test(key))) throw new Error();
      url.protocol = "https:";
      Object.assign(headers, target.headers);
      open = () => httpsRequest(url, { method: "GET", headers, timeout: 15_000 });
    }
  } catch {
    res.status(502).json({ error: "Plugin connection unavailable" });
    return;
  }
  Object.assign(headers, { Connection: "Upgrade", Upgrade: "websocket" });
  for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
    if (req.headers[name]) headers[name] = req.headers[name]!;
  }
  let connected = false;
  let upstream: Duplex | undefined;
  const fail = () => {
    if (!connected && !socket.destroyed && !res.headersSent) res.status(502).json({ error: "Plugin connection unavailable" });
    else socket.destroy();
  };
  let connection: ClientRequest;
  try { connection = open(); }
  catch { fail(); return; }
  const cleanup = () => { clearInterval(watch); clearTimeout(lifetime); connection.destroy(); upstream?.destroy(); };
  // Periodic reconnect reauthorizes the browser through HTTP; it also bounds
  // how long a removed membership or changed plugin binding can retain access.
  const lifetime = setTimeout(() => socket.destroy(), 5 * 60_000);
  const watch = setInterval(() => { if (!available()) socket.destroy(); }, 5_000);
  lifetime.unref();
  watch.unref();
  socket.once("close", cleanup);
  connection.on("timeout", () => { connection.destroy(); fail(); });
  connection.on("error", fail);
  connection.on("response", response => { response.destroy(); fail(); });
  connection.on("upgrade", (response, remote, remoteHead) => {
    upstream = remote;
    if (socket.destroyed || !available() || response.statusCode !== 101) { remote.destroy(); fail(); return; }
    connected = true;
    connection.setTimeout(0);
    socket.setTimeout(0);
    res.detachSocket(socket);
    // Express request accounting must observe the lifetime of the upgraded stream.
    socket.once("close", () => res.emit("close"));
    let handshake = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n";
    for (const name of ["sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"]) {
      const value = response.headers[name];
      if (typeof value === "string") handshake += `${name}: ${value}\r\n`;
    }
    socket.write(handshake + "\r\n");
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    remote.on("error", () => socket.destroy());
    remote.once("close", () => socket.destroy());
    socket.pipe(remote).pipe(socket);
  });
  connection.end();
}
