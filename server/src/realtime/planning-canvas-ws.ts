import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import { agentApiKeys, agents, authUsers, planningCanvases, type Db } from "@paperclipai/db";
import type { LiveEvent, PlanningCanvasAccessLevel } from "@paperclipai/shared";
import { z } from "zod";
import { logger } from "../middleware/logger.js";
import type { AuthorizationActor } from "../services/authorization.js";
import { subscribeAllCompanyLiveEvents } from "../services/live-events.js";
import { loadActorMemberships } from "../services/member-restriction/actor-memberships.js";
import { planningCanvasAccessAtLeast, planningCanvasAccessResolver } from "../services/planning-canvas-access.js";
import {
  subscribeAllPlanningCanvasEvents,
  subscribePlanningCanvasBoard,
  type PlanningCanvasEvent,
  type PlanningCanvasEventActor,
} from "../services/planning-canvas-events.js";

/**
 * Planning Canvas realtime hub (plan PAR-13925 section E, ticket C11).
 *
 * ASSUMES ONE API PROCESS (plan Q13, Marcus). Board events come from the
 * in-process bus in `planning-canvas-events.ts` and member changes from the
 * in-process `live-events.ts`; a second API process would neither see nor fan
 * out the other's events. A multi-process bridge is a follow-up, not part of
 * this module.
 *
 * Route: `GET /api/companies/:companyId/planning-canvases/:boardId/ws`. The
 * upgrade goes through the `live-events-ws.ts` dispatch and `authorizeUpgrade`
 * (it hands the result to `admit`), then the canvas resolver must answer at
 * least `view`. Every denial (no caller, another company, unknown or malformed
 * id, `none`) writes the same raw bytes: `PLANNING_CANVAS_WS_DENIED`.
 *
 * Client to server (16 KB max, above 30 messages per second per socket the
 * rest of that second is dropped): `presence { cursor | null, selection,
 * viewport }` and `ping`. Server to client: `presence.snapshot`,
 * `presence.update`, `presence.leave`, `ops.applied` (above 32 KB as
 * `{ revision, keys, truncated: true }`), `resync { revision }`, `pong`,
 * `access.revoked` (then close). Edits never go over the socket.
 *
 * Revocation: every socket is re-resolved (a) at once on a board
 * `access.changed` event and on an issue reaching done or cancelled (grant
 * sockets), (b) on `activity.logged` with a `company_member.*` action, and (c)
 * by a timer once its last check is older than `recheckAfterMs`. A socket
 * whose last good check is older than `staleAfterMs` gets no fan-out until a
 * re-check passes; then it gets `resync`. Below `view`: `access.revoked`, close.
 */

export const PLANNING_CANVAS_WS_MAX_PAYLOAD = 16 * 1024;
export const PLANNING_CANVAS_WS_OPS_INLINE_MAX = 32 * 1024;
export const PLANNING_CANVAS_WS_MAX_MESSAGES_PER_SECOND = 30;
export const PLANNING_CANVAS_WS_CLOSE_REVOKED = 4403;
/** The raw answer to every refused canvas upgrade: the REST unknown-id body as a 404. */
export const PLANNING_CANVAS_WS_DENIED =
  "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nPlanning canvas board not found";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH = /^\/api\/companies\/([^/]+)\/planning-canvases\/([^/]+)\/ws$/;
const CLOSED_ISSUE_STATUSES = new Set(["done", "cancelled"]);
/** A client this far behind on reads is cut off; it reconnects and catches up with `?since`. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

interface WsSocket {
  readyState: number;
  bufferedAmount?: number;
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "pong" | "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  close(): void;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: WsSocket) => void): void;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (opts: { noServer: boolean; maxPayload: number }) => WsServer;
};

export interface PlanningCanvasWsTarget {
  companyId: string;
  boardId: string;
}

/** The canvas socket path, or null. Decoding errors are a match with an id that resolves to nothing. */
export function parsePlanningCanvasWsPath(pathname: string): PlanningCanvasWsTarget | null {
  const match = pathname.match(PATH);
  if (!match) return null;
  const decode = (raw: string) => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return "";
    }
  };
  return { companyId: decode(match[1] ?? ""), boardId: decode(match[2] ?? "") };
}

const finite = z.number().finite();
const presenceMessageSchema = z.object({
  type: z.literal("presence"),
  cursor: z.object({ x: finite, y: finite }).nullable(),
  selection: z.array(z.string().min(1).max(100)).max(500),
  viewport: z.object({ x: finite, y: finite, zoom: finite, width: finite.optional(), height: finite.optional() }).nullable(),
});
const clientMessageSchema = z.discriminatedUnion("type", [presenceMessageSchema, z.object({ type: z.literal("ping") })]);
type Presence = Omit<z.infer<typeof presenceMessageSchema>, "type">;

type BoardRow = typeof planningCanvases.$inferSelect;

interface Client {
  id: string;
  ws: WsSocket;
  companyId: string;
  boardId: string;
  /** The actor `authorizeUpgrade` produced; memberships are re-read on every check. */
  baseActor: AuthorizationActor;
  apiKeyId: string | null;
  who: PlanningCanvasEventActor;
  /** True for an agent on a personal board: it holds the board through a grant row. */
  viaGrant: boolean;
  level: PlanningCanvasAccessLevel;
  checkedAt: number;
  checking: Promise<void> | null;
  recheckQueued: boolean;
  /** Set when a fan-out skipped this socket as stale; it gets `resync` after the next good check. */
  missedRevision: number | null;
  presence: Presence;
  windowStart: number;
  windowCount: number;
  alive: boolean;
  closed: boolean;
}

export interface PlanningCanvasHubOptions {
  /** Re-check a socket once its last check is this old (plan E (c)). */
  recheckAfterMs?: number;
  /** Skip a socket on fan-out once its last good check is this old. */
  staleAfterMs?: number;
  /** Timer period for re-checks and keep-alive pings. */
  tickMs?: number;
  now?: () => number;
}

export interface PlanningCanvasAdmission {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  target: PlanningCanvasWsTarget;
  /** What `authorizeUpgrade` returned; null when it refused. */
  context: { actor: AuthorizationActor; apiKeyId?: string } | null;
  /** Drops the dispatcher's raw-socket listeners; runs only when the upgrade goes ahead. */
  beforeUpgrade?: () => void;
}

function writeDenied(socket: Duplex) {
  const state = socket as Duplex & { writable?: boolean; writableEnded?: boolean };
  if (socket.destroyed || state.writable === false || state.writableEnded) {
    socket.destroy();
    return;
  }
  try {
    socket.once("finish", () => socket.destroy());
    socket.end(PLANNING_CANVAS_WS_DENIED);
  } catch (err) {
    logger.warn({ err }, "failed to refuse planning canvas websocket upgrade");
    socket.destroy();
  }
}

/** The actor with the memberships the canvas resolver reads, loaded fresh (they change on revocation (b)). */
async function withMemberships(db: Db, actor: AuthorizationActor, companyId: string): Promise<AuthorizationActor> {
  if (actor.type === "board") {
    if (!actor.userId || actor.source === "local_implicit") return actor;
    const memberships = await loadActorMemberships(db, { userId: actor.userId, activeOnly: true });
    return { ...actor, memberships, companyIds: memberships.map((m) => m.companyId) };
  }
  if (actor.type !== "agent") return actor;
  const personId = actor.onBehalfOfUserId?.trim() || null;
  if (!personId) return { ...actor, onBehalfOfMemberships: [] };
  const [user, memberships] = await Promise.all([
    db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, personId)).then((rows) => rows[0] ?? null),
    loadActorMemberships(db, { userId: personId, companyId, activeOnly: true }),
  ]);
  return { ...actor, onBehalfOfMemberships: user ? memberships : [] };
}

export function createPlanningCanvasHub(db: Db, opts: PlanningCanvasHubOptions = {}) {
  const recheckAfterMs = opts.recheckAfterMs ?? 45_000;
  const staleAfterMs = opts.staleAfterMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const wss = new WebSocketServer({ noServer: true, maxPayload: PLANNING_CANVAS_WS_MAX_PAYLOAD });
  const boards = new Map<string, { clients: Set<Client>; unsubscribe: () => void }>();
  /**
   * Bumped on every access-relevant event. A socket admitted while it moved
   * is re-checked at once: the event may have fired after the admission read
   * and before the socket joined its board (the admission race).
   */
  let accessEpoch = 0;

  function send(client: Client, message: unknown) {
    if (client.closed || client.ws.readyState !== WebSocket.OPEN) return;
    if ((client.ws.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) {
      client.ws.terminate();
      return;
    }
    client.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  function fresh(client: Client) {
    return now() - client.checkedAt <= staleAfterMs;
  }

  /** Every live socket of the board the reader may get board data on right now. */
  function readers(boardId: string, except?: Client) {
    const out: Client[] = [];
    for (const client of boards.get(boardId)?.clients ?? []) {
      if (client === except || client.closed) continue;
      if (fresh(client)) out.push(client);
      else void recheck(client);
    }
    return out;
  }

  async function loadBoard(companyId: string, boardId: string): Promise<BoardRow | null> {
    if (!UUID.test(companyId) || !UUID.test(boardId)) return null;
    const [board] = await db
      .select()
      .from(planningCanvases)
      .where(and(eq(planningCanvases.id, boardId), eq(planningCanvases.companyId, companyId)))
      .limit(1);
    return board ?? null;
  }

  /**
   * An agent key holds a socket only on the terms the REST `actorMiddleware`
   * sets for it: not revoked, a responsible user, and an agent that may
   * authenticate (`authorizeUpgrade` checks only the first).
   */
  async function agentKeyUsable(actor: AuthorizationActor, apiKeyId: string | null) {
    if (actor.type !== "agent") return true;
    if (!apiKeyId || !actor.agentId) return false;
    const [row] = await db
      .select({ responsibleUserId: agentApiKeys.responsibleUserId, status: agents.status, holds: agents.lifecycleHolds, agentCompanyId: agents.companyId })
      .from(agentApiKeys)
      .innerJoin(agents, eq(agents.id, agentApiKeys.agentId))
      .where(and(eq(agentApiKeys.id, apiKeyId), isNull(agentApiKeys.revokedAt)))
      .limit(1);
    if (!row || row.agentCompanyId !== actor.companyId || !row.responsibleUserId?.trim()) return false;
    return !row.holds?.includes("setup") && row.status !== "terminated" && row.status !== "pending_approval";
  }

  /** The caller's level on the board; `none` for every kind of refusal. */
  async function resolveLevel(actor: AuthorizationActor, apiKeyId: string | null, target: PlanningCanvasWsTarget) {
    const board = await loadBoard(target.companyId, target.boardId);
    if (!board || !(await agentKeyUsable(actor, apiKeyId))) return { board, level: "none" as const };
    const full = await withMemberships(db, actor, board.companyId);
    return { board, level: await planningCanvasAccessResolver(db, full)(board) };
  }

  function revoke(client: Client) {
    if (client.closed) return;
    send(client, { type: "access.revoked", boardId: client.boardId });
    client.ws.close(PLANNING_CANVAS_WS_CLOSE_REVOKED, "access revoked");
    detach(client);
  }

  /**
   * Re-resolves one socket. A request that lands while a check is in flight
   * queues one more check: the event that asked for it may have committed
   * after the in-flight read (the race this guards). A failed read leaves
   * `checkedAt` alone, so the socket goes stale and gets no fan-out (fails closed).
   */
  function recheck(client: Client): Promise<void> {
    if (client.closed) return Promise.resolve();
    if (client.checking) {
      client.recheckQueued = true;
      return client.checking;
    }
    const startedAt = now();
    client.checking = resolveLevel(client.baseActor, client.apiKeyId, client)
      .then(({ board, level }) => {
        if (client.closed) return;
        if (!board || !planningCanvasAccessAtLeast(level, "view")) {
          revoke(client);
          return;
        }
        client.level = level;
        client.checkedAt = startedAt;
        if (client.missedRevision !== null) {
          client.missedRevision = null;
          send(client, { type: "resync", revision: board.revision });
        }
      })
      .catch((err) => {
        logger.warn({ err, boardId: client.boardId }, "planning canvas socket access re-check failed");
      })
      .finally(() => {
        client.checking = null;
        if (client.recheckQueued && !client.closed) {
          client.recheckQueued = false;
          void recheck(client);
        }
      });
    return client.checking;
  }

  function presenceOf(client: Client) {
    return { clientId: client.id, actor: client.who, ...client.presence };
  }

  function opsMessage(event: Extract<PlanningCanvasEvent, { type: "ops.applied" }>) {
    const full = JSON.stringify({
      type: "ops.applied",
      revision: event.revision,
      actor: event.actor,
      purgedThroughRevision: event.purgedThroughRevision,
      items: event.items,
    });
    if (Buffer.byteLength(full) <= PLANNING_CANVAS_WS_OPS_INLINE_MAX) return full;
    return JSON.stringify({
      type: "ops.applied",
      revision: event.revision,
      actor: event.actor,
      purgedThroughRevision: event.purgedThroughRevision,
      keys: event.items.map((item) => item.key),
      truncated: true,
    });
  }

  function onBoardEvent(boardId: string, event: PlanningCanvasEvent) {
    const entry = boards.get(boardId);
    if (!entry) return;
    if (event.type === "access.changed") {
      for (const client of [...entry.clients]) void recheck(client);
      return;
    }
    const message = opsMessage(event);
    for (const client of entry.clients) {
      if (client.closed) continue;
      if (fresh(client)) {
        send(client, message);
      } else {
        client.missedRevision = Math.max(client.missedRevision ?? 0, event.revision);
        void recheck(client);
      }
    }
  }

  function attach(client: Client) {
    let entry = boards.get(client.boardId);
    if (!entry) {
      const boardId = client.boardId;
      entry = { clients: new Set(), unsubscribe: subscribePlanningCanvasBoard(boardId, (event) => onBoardEvent(boardId, event)) };
      boards.set(boardId, entry);
    }
    entry.clients.add(client);
  }

  function detach(client: Client) {
    if (client.closed) return;
    client.closed = true;
    const entry = boards.get(client.boardId);
    if (!entry) return;
    entry.clients.delete(client);
    if (entry.clients.size === 0) {
      entry.unsubscribe();
      boards.delete(client.boardId);
      return;
    }
    for (const peer of readers(client.boardId)) send(peer, { type: "presence.leave", clientId: client.id });
  }

  function onMessage(client: Client, data: Buffer, isBinary: boolean) {
    const at = now();
    if (at - client.windowStart >= 1000) {
      client.windowStart = at;
      client.windowCount = 0;
    }
    client.windowCount += 1;
    if (client.windowCount > PLANNING_CANVAS_WS_MAX_MESSAGES_PER_SECOND || isBinary) return;
    let parsed: z.infer<typeof clientMessageSchema>;
    try {
      const result = clientMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!result.success) return;
      parsed = result.data;
    } catch {
      return;
    }
    if (parsed.type === "ping") {
      send(client, { type: "pong" });
      return;
    }
    if (!fresh(client)) {
      void recheck(client);
      return;
    }
    client.presence = { cursor: parsed.cursor, selection: parsed.selection, viewport: parsed.viewport };
    const update = JSON.stringify({ type: "presence.update", ...presenceOf(client) });
    for (const peer of readers(client.boardId, client)) send(peer, update);
  }

  function connect(ws: WsSocket, client: Omit<Client, "ws">) {
    const full = client as Client;
    full.ws = ws;
    attach(full);
    ws.on("message", (data, isBinary) => onMessage(full, data, isBinary));
    ws.on("pong", () => {
      full.alive = true;
    });
    ws.on("close", () => detach(full));
    ws.on("error", (err) => logger.warn({ err, boardId: full.boardId }, "planning canvas websocket client error"));
    const peers = readers(full.boardId, full);
    send(full, { type: "presence.snapshot", clientId: full.id, level: full.level, peers: peers.map(presenceOf) });
    const joined = JSON.stringify({ type: "presence.update", ...presenceOf(full) });
    for (const peer of peers) send(peer, joined);
    return full;
  }

  /** Called by the live-events upgrade dispatch after `authorizeUpgrade`. */
  async function admit({ req, socket, head, target, context, beforeUpgrade }: PlanningCanvasAdmission) {
    if (!context) {
      writeDenied(socket);
      return;
    }
    const apiKeyId = context.apiKeyId ?? null;
    let startedAt = now();
    let epochAtStart = accessEpoch;
    let { board, level } = await resolveLevel(context.actor, apiKeyId, target);
    // An access event during the read may have come after it: read again (bounded).
    for (let retry = 0; retry < 3 && accessEpoch !== epochAtStart; retry += 1) {
      startedAt = now();
      epochAtStart = accessEpoch;
      ({ board, level } = await resolveLevel(context.actor, apiKeyId, target));
    }
    if (!board || !planningCanvasAccessAtLeast(level, "view")) {
      writeDenied(socket);
      return;
    }
    const state = socket as Duplex & { writable?: boolean };
    if (socket.destroyed || state.writable === false) return;
    const boardScope = board.scope;
    const actor = context.actor;
    const who: PlanningCanvasEventActor = actor.type === "agent" && actor.agentId
      ? { type: "agent", id: actor.agentId }
      : { type: "user", id: actor.userId ?? "board" };
    beforeUpgrade?.();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = connect(ws, {
        id: randomUUID(),
        companyId: target.companyId,
        boardId: target.boardId,
        baseActor: actor,
        apiKeyId,
        who,
        viaGrant: who.type === "agent" && boardScope === "personal",
        level,
        checkedAt: startedAt,
        checking: null,
        recheckQueued: false,
        missedRevision: null,
        presence: { cursor: null, selection: [], viewport: null },
        windowStart: now(),
        windowCount: 0,
        alive: true,
        closed: false,
      });
      if (accessEpoch !== epochAtStart) void recheck(client);
    });
  }

  function* allClients() {
    for (const entry of boards.values()) yield* entry.clients;
  }

  /** Revocation (b) and the grant part of (a): member changes and issues reaching done or cancelled. */
  const unsubscribeActivity = subscribeAllCompanyLiveEvents((event: LiveEvent) => {
    if (event.type !== "activity.logged") return;
    const action = typeof event.payload.action === "string" ? event.payload.action : "";
    const details = event.payload.details as Record<string, unknown> | null | undefined;
    const memberChange = action.startsWith("company_member.");
    const grantIssueClosed = event.payload.entityType === "issue"
      && (CLOSED_ISSUE_STATUSES.has(String(details?.status ?? "")) || /\.(deleted|hidden)$/.test(action));
    if (!memberChange && !grantIssueClosed) return;
    accessEpoch += 1;
    for (const client of [...allClients()]) {
      if (client.companyId !== event.companyId) continue;
      if (memberChange || client.viaGrant) void recheck(client);
    }
  });

  const unsubscribeCanvas = subscribeAllPlanningCanvasEvents((event) => {
    if (event.type === "access.changed") accessEpoch += 1;
  });

  /** Revocation (c) and keep-alive. */
  function tick() {
    const at = now();
    const checks: Promise<void>[] = [];
    for (const client of [...allClients()]) {
      if (!client.alive) {
        client.ws.terminate();
        detach(client);
        continue;
      }
      client.alive = false;
      client.ws.ping();
      if (at - client.checkedAt >= recheckAfterMs) checks.push(recheck(client));
    }
    return Promise.all(checks).then(() => undefined);
  }
  const timer = setInterval(() => void tick(), opts.tickMs ?? 15_000);
  timer.unref?.();

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    unsubscribeActivity();
    unsubscribeCanvas();
    for (const client of [...allClients()]) {
      client.ws.close(1012, "Server restarting");
      detach(client);
    }
    wss.close();
  }

  return {
    admit,
    close,
    tick,
    /** Test and diagnostics view: live sockets per board. */
    socketCount(boardId: string) {
      return boards.get(boardId)?.clients.size ?? 0;
    },
  };
}

export type PlanningCanvasHub = ReturnType<typeof createPlanningCanvasHub>;
