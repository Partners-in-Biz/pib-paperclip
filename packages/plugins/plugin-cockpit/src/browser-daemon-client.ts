/**
 * The Cockpit worker's client for the pib-browser daemon's live socket (PAR-14514 design 3, F22): plain HTTP over the
 * unix socket with Node's `http.request({ socketPath })`, for the daemon's UNSIGNED calls only (`/status` now,
 * `/release` in S4). Streams never go through here: core opens and signs those (design 1).
 *
 * No plugin capability covers a unix socket and none is claimed. The gate is the socket's file permission (0660
 * `pib-browser:paperclip`); plugin workers run as `paperclip` and are not sandboxed (F9), the same way the Cockpit
 * already reads the browser status file with `node:fs`.
 */
import { request } from "node:http";

/** The daemon's live socket (PAR-14533). `PIB_BROWSER_LIVE_SOCKET` overrides it, as it does for the daemon. */
export const BROWSER_LIVE_SOCKET = "/run/pib-browser/live.sock";

export function browserLiveSocket(env: NodeJS.ProcessEnv = process.env): string {
  return env.PIB_BROWSER_LIVE_SOCKET?.trim() || BROWSER_LIVE_SOCKET;
}

/** The daemon answers in a few hundred bytes; anything bigger is not the daemon. */
const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 3_000;

export class BrowserDaemonError extends Error {
  constructor(
    message: string,
    readonly reason: "unreachable" | "timeout" | "bad_response" | "http_error",
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface DaemonCall {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  socketPath?: string;
  timeoutMs?: number;
}

/** One JSON call to the daemon. Throws `BrowserDaemonError` for a closed socket, a timeout, a non-2xx or a non-JSON answer. */
export function callBrowserDaemon<T = unknown>(call: DaemonCall): Promise<T> {
  const socketPath = call.socketPath ?? browserLiveSocket();
  const payload = call.body === undefined ? null : Buffer.from(JSON.stringify(call.body));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const fail = (error: BrowserDaemonError) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(error);
    };
    const req = request(
      {
        socketPath,
        method: call.method,
        path: call.path,
        headers: {
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) return fail(new BrowserDaemonError("The browser service answered too much", "bad_response"));
          chunks.push(chunk);
        });
        res.on("error", () => fail(new BrowserDaemonError("The browser service closed the connection", "unreachable")));
        res.on("end", () => {
          if (settled) return;
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) return fail(new BrowserDaemonError(`The browser service answered HTTP ${status}`, "http_error", status));
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
            settled = true;
            resolve(value);
          } catch {
            fail(new BrowserDaemonError("The browser service did not answer JSON", "bad_response", status));
          }
        });
      },
    );
    req.setTimeout(call.timeoutMs ?? TIMEOUT_MS, () => fail(new BrowserDaemonError("The browser service did not answer in time", "timeout")));
    req.on("error", () => fail(new BrowserDaemonError("The browser service is not running", "unreachable")));
    req.end(payload ?? undefined);
  });
}

/** The daemon's `/status`, as it sends it (viewers, agent sessions, lease, waiting list). */
export async function readBrowserDaemonStatus(socketPath?: string): Promise<Record<string, unknown>> {
  const value = await callBrowserDaemon({ method: "GET", path: "/status", socketPath });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BrowserDaemonError("The browser service sent an unreadable status", "bad_response");
  return value as Record<string, unknown>;
}
