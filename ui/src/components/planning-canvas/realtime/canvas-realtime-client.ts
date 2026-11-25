import { tryCreateWebSocket } from "@/lib/websocket";
import {
  CLOSE_REVOKED,
  PRESENCE_INTERVAL_MS,
  parseServerMessage,
  type LocalPresence,
  type ServerMessage,
} from "@/components/planning-canvas/realtime/realtime-protocol";

export type RealtimeStatus = "connecting" | "live" | "reconnecting" | "revoked" | "closed";

/** The slice of the browser `WebSocket` the client uses (tests pass a fake). */
export interface RealtimeSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface RealtimeClientOptions {
  url: string;
  onMessage: (message: ServerMessage) => void;
  onStatus?: (status: RealtimeStatus) => void;
  createSocket?: (url: string) => RealtimeSocket | null;
  now?: () => number;
  random?: () => number;
}

const OPEN = 1;
/** Presence frames stay well under the hub's 16 KB payload cap. */
const MAX_PRESENCE_BYTES = 12_000;
const MAX_SELECTION = 200;
const round = (value: number) => Math.round(value * 10) / 10;

/** Reconnect delay: 1 s doubling to 30 s, plus up to 0.5 s jitter so tabs do not reconnect in step. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random) {
  return Math.min(30_000, 1000 * 2 ** Math.min(Math.max(attempt - 1, 0), 5)) + Math.floor(random() * 500);
}

/** The presence frame for `presence`, with the selection trimmed to fit the payload cap. */
export function presenceFrame(presence: LocalPresence) {
  const cursor = presence.cursor ? { x: round(presence.cursor.x), y: round(presence.cursor.y) } : null;
  const viewport = presence.viewport
    ? { ...presence.viewport, x: round(presence.viewport.x), y: round(presence.viewport.y) }
    : null;
  let selection = presence.selection.filter((key) => key.length > 0 && key.length <= 100).slice(0, MAX_SELECTION);
  let frame = JSON.stringify({ type: "presence", cursor, selection, viewport });
  while (frame.length > MAX_PRESENCE_BYTES && selection.length > 0) {
    selection = selection.slice(0, Math.floor(selection.length / 2));
    frame = JSON.stringify({ type: "presence", cursor, selection, viewport });
  }
  return frame;
}

/**
 * One board socket (plan E): connects, reconnects with backoff, and sends this
 * tab's presence at most 20 times a second (latest value wins). It never
 * reconnects after `access.revoked`. Catching up after a reconnect is the
 * caller's job: it sees the status go back to `live`.
 */
export class CanvasRealtimeClient {
  private socket: RealtimeSocket | null = null;
  private status: RealtimeStatus = "connecting";
  private everOpened = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPresenceAt = Number.NEGATIVE_INFINITY;
  private presence: LocalPresence = { cursor: null, selection: [], viewport: null };
  private presenceDirty = false;
  private stopped = false;
  private readonly now: () => number;
  private readonly createSocket: (url: string) => RealtimeSocket | null;

  constructor(private readonly opts: RealtimeClientOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.createSocket = opts.createSocket ?? ((url) => tryCreateWebSocket(url) as RealtimeSocket | null);
  }

  getStatus() {
    return this.status;
  }

  start() {
    if (this.stopped || this.socket || this.reconnectTimer) return;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.dropSocket();
    if (this.status !== "revoked") this.setStatus("closed");
  }

  /** Merge into this tab's presence; it goes out on the next 50 ms slot. */
  setPresence(patch: Partial<LocalPresence>) {
    this.presence = { ...this.presence, ...patch };
    this.presenceDirty = true;
    this.schedulePresence();
  }

  /** The browser came back online: skip the rest of the backoff wait. */
  reconnectNow() {
    if (this.stopped || this.status === "revoked" || !this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    const socket = this.createSocket(this.opts.url);
    if (!socket) {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.everOpened = true;
      this.attempt = 0;
      this.setStatus("live");
      // The hub starts every socket with empty presence: send ours again.
      this.presenceDirty = true;
      this.schedulePresence();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      if (message.type === "access.revoked") this.revoke();
      this.opts.onMessage(message);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (event.code === CLOSE_REVOKED) this.revoke();
      else this.scheduleReconnect();
    };
    socket.onerror = () => undefined; // `onclose` follows and reconnects.
  }

  private revoke() {
    if (this.status === "revoked") return;
    this.clearTimers();
    this.dropSocket();
    this.setStatus("revoked");
  }

  private scheduleReconnect() {
    if (this.stopped || this.status === "revoked" || this.reconnectTimer) return;
    this.attempt += 1;
    this.setStatus(this.everOpened ? "reconnecting" : "connecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, reconnectDelayMs(this.attempt, this.opts.random));
  }

  private schedulePresence() {
    if (!this.presenceDirty || this.presenceTimer || this.socket?.readyState !== OPEN) return;
    const wait = this.lastPresenceAt + PRESENCE_INTERVAL_MS - this.now();
    if (wait <= 0) {
      this.sendPresence();
      return;
    }
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.sendPresence();
    }, wait);
  }

  private sendPresence() {
    const socket = this.socket;
    if (!this.presenceDirty || socket?.readyState !== OPEN) return;
    this.presenceDirty = false;
    this.lastPresenceAt = this.now();
    socket.send(presenceFrame(this.presence));
  }

  private dropSocket() {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close(1000, "closed");
    } catch {
      // Already closing.
    }
  }

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.reconnectTimer = null;
    this.presenceTimer = null;
  }

  private setStatus(status: RealtimeStatus) {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }
}
