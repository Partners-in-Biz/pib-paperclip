/**
 * Per-turn loopback bridge for a warm voice process (PAR-15073 plan, 5.4
 * "Identity"; PAR-15336).
 *
 * A warm `hermes acp` process lives across many voice turns, so it must never
 * hold a run token. It holds only this bridge's loopback URL and a random
 * bridge token. The voice session host binds one turn (run id + run token) at
 * a time; on every forwarded request the bridge drops whatever credentials the
 * process sent and sets the bound turn's token and run id header instead.
 *
 * - No turn bound: 403. Wrong or missing bridge token: 401 (checked first).
 * - Each bind gets a new generation; `unbind(generation)` only removes that
 *   binding and aborts every request still in flight under it.
 * - Loopback only, a body size limit, and a header allowlist. Paths are the
 *   same `/api` routes a local cold run reaches; anything else is refused.
 *
 * The server's own checks (run token bound to its run, writes of a cancelled
 * run refused) stay behind the bridge. This module is separate from
 * `@paperclipai/adapter-utils` `sandbox-callback-bridge.ts` on purpose: that
 * bridge serves one run with a fixed token and is not changed.
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  compareBridgeTokensConstantTime,
  DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES,
} from "@paperclipai/adapter-utils/sandbox-callback-bridge";

export interface VoiceTurnBinding {
  readonly runId: string;
  readonly generation: number;
}

export type VoiceTurnBridgeRefusal =
  | "voice_bridge_bad_token"
  | "voice_bridge_no_turn"
  | "voice_bridge_turn_ended"
  | "voice_bridge_route"
  | "voice_bridge_method"
  | "voice_bridge_body_too_large"
  | "voice_bridge_not_loopback"
  | "voice_bridge_upstream";

/** One line per request for the run log. Never carries a token, a body or a query string. */
export interface VoiceTurnBridgeEvent {
  method: string;
  path: string;
  status: number;
  runId: string | null;
  generation: number | null;
  code?: VoiceTurnBridgeRefusal;
}

export interface VoiceTurnBridge {
  /** Loopback origin, e.g. `http://127.0.0.1:41234`; the process uses `${url}/api` as its API URL. */
  readonly url: string;
  /** Bridge token the process presents as `Authorization: Bearer`. Useless at the server and at any other bridge. */
  readonly token: string;
  /** Bind a turn. Throws if a turn is already bound: the host must unbind first. */
  bind(turn: { runId: string; runToken: string }): VoiceTurnBinding;
  /** Remove the binding if it is still `generation`; aborts its requests in flight. */
  unbind(generation: number): boolean;
  current(): VoiceTurnBinding | null;
  close(): Promise<void>;
}

export interface StartVoiceTurnBridgeInput {
  /** The Paperclip server origin a local cold run calls (with or without a trailing `/api`). */
  upstreamUrl: string;
  maxBodyBytes?: number;
  /** Upper bound for one forwarded request, response included. */
  requestTimeoutMs?: number;
  onEvent?: (event: VoiceTurnBridgeEvent) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const FORWARDED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
// Request headers the process may set. Authorization, cookies, x-paperclip-*,
// host, forwarded-* and hop-by-hop headers are dropped; the bridge sets its own.
const REQUEST_HEADER_ALLOWLIST = ["accept", "content-type", "if-match", "if-none-match", "idempotency-key"] as const;
const RESPONSE_HEADER_ALLOWLIST = ["content-type", "content-disposition", "etag", "last-modified", "location", "retry-after", "cache-control"] as const;

/** The same `/api` routes as a local cold run: origin-form `/api` paths, no dot segments, no `//`, no backslash. */
export function isForwardableVoiceBridgePath(rawUrl: string): boolean {
  if (!/^\/api(?:[/?]|$)/.test(rawUrl)) return false;
  const path = rawUrl.split("?", 1)[0]!;
  if (path.includes("//") || path.includes("\\")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (decoded.includes("\\") || decoded.includes("//")) return false;
  return !decoded.split("/").some((segment) => segment === "." || segment === "..");
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function bearer(header: string | undefined): string {
  return header && /^Bearer /i.test(header) ? header.slice(7).trim() : "";
}

export async function startVoiceTurnBridge(input: StartVoiceTurnBridgeInput): Promise<VoiceTurnBridge> {
  const upstreamOrigin = new URL(input.upstreamUrl).origin;
  const maxBodyBytes = input.maxBodyBytes ?? DEFAULT_SANDBOX_CALLBACK_BRIDGE_MAX_BODY_BYTES;
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const emit = input.onEvent ?? (() => {});
  const token = randomBytes(32).toString("base64url");
  let generation = 0;
  let bound: { runId: string; runToken: string; generation: number; abort: AbortController } | null = null;

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const method = (req.method ?? "GET").toUpperCase();
    const rawUrl = req.url ?? "/";
    const path = rawUrl.split("?", 1)[0]!.slice(0, 200);
    const turn = bound;
    const refuse = (status: number, code: VoiceTurnBridgeRefusal, error: string) => {
      emit({ method, path, status, runId: turn?.runId ?? null, generation: turn?.generation ?? null, code });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(status, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error, code }));
      req.resume();
    };

    if (!isLoopbackAddress(req.socket.remoteAddress)) return refuse(403, "voice_bridge_not_loopback", "Loopback callers only");
    if (!compareBridgeTokensConstantTime(token, bearer(req.headers.authorization))) {
      return refuse(401, "voice_bridge_bad_token", "Bridge token not valid at this bridge");
    }
    if (!turn) return refuse(403, "voice_bridge_no_turn", "No voice turn is bound to this process");
    if (!FORWARDED_METHODS.has(method)) return refuse(405, "voice_bridge_method", `Method not forwarded: ${method}`);
    if (!isForwardableVoiceBridgePath(rawUrl)) return refuse(403, "voice_bridge_route", "Only /api routes are forwarded");
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      return refuse(413, "voice_bridge_body_too_large", "Request body too large");
    }

    const signal = AbortSignal.any([turn.abort.signal, AbortSignal.timeout(requestTimeoutMs)]);
    const ended = () => bound?.generation !== turn.generation || turn.abort.signal.aborted;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      // A body that is still arriving when the turn ends is cut off too. The
      // listener lives only while the body is read, so a later request on the
      // same keep-alive socket is never hit by it.
      const cutBody = () => req.destroy(new Error("voice turn ended"));
      signal.addEventListener("abort", cutBody, { once: true });
      try {
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > maxBodyBytes) return refuse(413, "voice_bridge_body_too_large", "Request body too large");
          chunks.push(chunk as Buffer);
        }
      } finally {
        signal.removeEventListener("abort", cutBody);
      }
      // The turn may have ended while the body was read.
      if (ended()) return refuse(403, "voice_bridge_turn_ended", "The voice turn ended");

      const headers = new Headers();
      for (const name of REQUEST_HEADER_ALLOWLIST) {
        const value = req.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      headers.set("authorization", `Bearer ${turn.runToken}`);
      headers.set("x-paperclip-run-id", turn.runId);
      const upstream = await fetch(`${upstreamOrigin}${rawUrl}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" || size === 0 ? undefined : Buffer.concat(chunks),
        signal,
        redirect: "manual",
      });
      const out: Record<string, string> = {};
      for (const name of RESPONSE_HEADER_ALLOWLIST) {
        const value = upstream.headers.get(name);
        if (value) out[name] = value;
      }
      res.writeHead(upstream.status, out);
      if (upstream.body && method !== "HEAD") {
        await pipeline(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream), res, { signal });
      } else {
        res.end();
      }
      emit({ method, path, status: upstream.status, runId: turn.runId, generation: turn.generation });
    } catch {
      if (ended()) return refuse(403, "voice_bridge_turn_ended", "The voice turn ended during the request");
      // Generic message: a fetch error never names a token, but say nothing more than needed.
      return refuse(502, "voice_bridge_upstream", "Upstream request failed");
    }
  };

  const server = http.createServer((req, res) => void handle(req, res));
  server.requestTimeout = requestTimeoutMs;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("voice turn bridge: no listen address");

  const dropBinding = () => {
    const turn = bound;
    bound = null;
    turn?.abort.abort();
  };

  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    bind({ runId, runToken }) {
      if (bound) throw new Error(`voice turn bridge is already bound (generation ${bound.generation})`);
      if (!runId.trim() || !runToken.trim()) throw new Error("voice turn bridge: runId and runToken are required");
      generation += 1;
      bound = { runId, runToken, generation, abort: new AbortController() };
      return { runId, generation };
    },
    unbind(target) {
      if (!bound || bound.generation !== target) return false;
      dropBinding();
      return true;
    },
    current: () => (bound ? { runId: bound.runId, generation: bound.generation } : null),
    async close() {
      dropBinding();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
