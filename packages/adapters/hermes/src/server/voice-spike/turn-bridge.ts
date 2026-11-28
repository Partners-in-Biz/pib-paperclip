// SPIKE PAR-15293 (throwaway, never merged). A small loopback bridge for one
// long-lived Hermes process. The process holds only this bridge's URL and a
// random bridge token. The host binds one voice turn (run id + run token) at a
// time; every forwarded request carries the bound turn's credentials. With no
// turn bound the bridge answers 403 to everything.
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

export type TurnBinding = { runId: string; runToken: string; generation: number };

export interface VoiceTurnBridge {
  readonly url: string;
  readonly token: string;
  bind(runId: string, runToken: string): TurnBinding;
  /** Remove the binding (only if it is still `runId`); aborts its in-flight forwards. */
  unbind(runId: string): boolean;
  current(): TurnBinding | null;
  close(): Promise<void>;
  /** Counters for the spike report. */
  readonly stats: { forwarded: number; refusedToken: number; refusedNoTurn: number; abortedOnUnbind: number };
}

// Headers the process may set; everything else (authorization, cookie,
// x-paperclip-run-id, host, forwarded-*) is dropped and replaced.
const FORWARD_HEADERS = new Set(["accept", "content-type", "if-match", "if-none-match", "idempotency-key"]);

function sameToken(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function deny(res: http.ServerResponse, status: number, code: string, error: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error, code }));
}

export async function startVoiceTurnBridge(input: {
  upstreamUrl: string;
  maxBodyBytes?: number;
  log?: (line: string) => void;
}): Promise<VoiceTurnBridge> {
  const token = randomBytes(32).toString("base64url");
  const upstream = new URL(input.upstreamUrl);
  const maxBodyBytes = input.maxBodyBytes ?? 32 * 1024 * 1024;
  const log = input.log ?? (() => {});
  let binding: TurnBinding | null = null;
  let generation = 0;
  // In-flight forwards of the current binding, aborted on unbind.
  let inflight = new Set<AbortController>();
  const stats = { forwarded: 0, refusedToken: 0, refusedNoTurn: 0, abortedOnUnbind: 0 };

  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!sameToken(token, presented)) {
      stats.refusedToken += 1;
      deny(res, 401, "voice_bridge_bad_token", "Bridge token not valid at this bridge");
      req.resume();
      return;
    }
    const bound = binding;
    if (!bound) {
      stats.refusedNoTurn += 1;
      deny(res, 403, "voice_bridge_no_turn", "No voice turn is bound to this process");
      req.resume();
      return;
    }
    const target = new URL(req.url ?? "/", upstream);
    if (!target.pathname.startsWith("/api/") || target.origin !== upstream.origin) {
      deny(res, 403, "voice_bridge_route", "Only /api routes are forwarded");
      req.resume();
      return;
    }
    // Read the body (bounded).
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBodyBytes) {
        deny(res, 413, "voice_bridge_body_too_large", "Body too large");
        return;
      }
      chunks.push(chunk as Buffer);
    }
    // Re-check after the body: the turn may have ended while we read it.
    if (binding?.generation !== bound.generation) {
      stats.refusedNoTurn += 1;
      deny(res, 403, "voice_bridge_no_turn", "The voice turn ended");
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (!FORWARD_HEADERS.has(key.toLowerCase()) || typeof value !== "string") continue;
      headers.set(key, value);
    }
    headers.set("authorization", `Bearer ${bound.runToken}`);
    headers.set("x-paperclip-run-id", bound.runId);
    const controller = new AbortController();
    inflight.add(controller);
    const method = (req.method ?? "GET").toUpperCase();
    try {
      const upstreamRes = await fetch(target, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
        redirect: "manual",
      });
      stats.forwarded += 1;
      const body = Buffer.from(await upstreamRes.arrayBuffer());
      const out: Record<string, string> = {};
      for (const name of ["content-type", "etag", "location"]) {
        const v = upstreamRes.headers.get(name);
        if (v) out[name] = v;
      }
      res.writeHead(upstreamRes.status, out);
      res.end(body);
      log(`[voice-bridge] ${method} ${target.pathname} -> ${upstreamRes.status} (run ${bound.runId.slice(0, 8)})`);
    } catch (error) {
      if (controller.signal.aborted) {
        stats.abortedOnUnbind += 1;
        deny(res, 403, "voice_bridge_turn_ended", "The voice turn ended during the request");
      } else {
        deny(res, 502, "voice_bridge_upstream", error instanceof Error ? error.message : String(error));
      }
    } finally {
      inflight.delete(controller);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("voice bridge: no address");
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    token,
    stats,
    bind(runId, runToken) {
      if (binding) throw new Error(`voice bridge already bound to run ${binding.runId}`);
      generation += 1;
      binding = { runId, runToken, generation };
      inflight = new Set();
      return binding;
    },
    unbind(runId) {
      if (!binding || binding.runId !== runId) return false;
      binding = null;
      for (const controller of inflight) controller.abort();
      inflight = new Set();
      return true;
    },
    current: () => binding,
    async close() {
      binding = null;
      for (const controller of inflight) controller.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
