import type { PlanningCanvasAccessLevel, PlanningCanvasItem } from "@paperclipai/shared";

/**
 * Wire shapes of the board socket (plan PAR-13925 section E; server in
 * `server/src/realtime/planning-canvas-ws.ts`, C11). Edits never go over the
 * socket: it carries presence one way and "the board changed" the other.
 */

export type RealtimeActor = { type: "user" | "agent"; id: string };
export interface PresenceCursor { x: number; y: number }
export interface PresenceViewport { x: number; y: number; zoom: number; width?: number; height?: number }

/** What this tab tells the others. Cursor and viewport are in world coordinates. */
export interface LocalPresence {
  cursor: PresenceCursor | null;
  selection: string[];
  viewport: PresenceViewport | null;
}

export interface PresencePeer extends LocalPresence {
  clientId: string;
  actor: RealtimeActor;
}

export type ServerMessage =
  | { type: "presence.snapshot"; clientId: string; level: PlanningCanvasAccessLevel; peers: PresencePeer[] }
  | ({ type: "presence.update" } & PresencePeer)
  | { type: "presence.leave"; clientId: string }
  | { type: "ops.applied"; revision: number; actor: RealtimeActor; items: PlanningCanvasItem[]; truncated?: false }
  | { type: "ops.applied"; revision: number; actor: RealtimeActor; keys: string[]; truncated: true }
  | { type: "resync"; revision: number }
  | { type: "access.revoked"; boardId: string }
  | { type: "pong" };

/** Close code the hub uses after `access.revoked`. */
export const CLOSE_REVOKED = 4403;
/** At most 20 presence messages per second (the hub drops above 30). */
export const PRESENCE_INTERVAL_MS = 50;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isActor = (value: unknown): value is RealtimeActor =>
  isObject(value) && (value.type === "user" || value.type === "agent") && typeof value.id === "string";
const isPeer = (value: unknown): value is PresencePeer =>
  isObject(value) && typeof value.clientId === "string" && isActor(value.actor) && Array.isArray(value.selection);

/** Parses one frame; anything malformed is dropped (the socket is a hint, REST is the truth). */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "presence.snapshot":
      return typeof value.clientId === "string" && Array.isArray(value.peers)
        ? ({ ...value, peers: value.peers.filter(isPeer) } as ServerMessage)
        : null;
    case "presence.update":
      return isPeer(value) ? (value as unknown as ServerMessage) : null;
    case "presence.leave":
      return typeof value.clientId === "string" ? (value as ServerMessage) : null;
    case "ops.applied":
      if (typeof value.revision !== "number" || !isActor(value.actor)) return null;
      if (value.truncated === true) return Array.isArray(value.keys) ? (value as ServerMessage) : null;
      return Array.isArray(value.items) ? (value as ServerMessage) : null;
    case "resync":
      return typeof value.revision === "number" ? (value as ServerMessage) : null;
    case "access.revoked":
    case "pong":
      return value as ServerMessage;
    default:
      return null;
  }
}

/** Keys an `ops.applied` touched, whether it came inline or truncated. */
export function changedKeys(message: Extract<ServerMessage, { type: "ops.applied" }>): string[] {
  return message.truncated ? message.keys : message.items.map((item) => item.key);
}
