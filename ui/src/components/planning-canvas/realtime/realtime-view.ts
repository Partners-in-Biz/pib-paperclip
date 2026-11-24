import type { PresencePeer, RealtimeActor, ServerMessage } from "@/components/planning-canvas/realtime/realtime-protocol";

/** How long an agent's edit stays highlighted (plan E). */
export const FLASH_MS = 2000;

export interface NodeFlash {
  actor: RealtimeActor;
  until: number;
}

export interface RealtimeViewSnapshot {
  peers: PresencePeer[];
  /** Node key to the agent that just changed it. */
  flashes: ReadonlyMap<string, NodeFlash>;
}

/**
 * Peers and flashes, outside React state: presence changes up to 20 times a
 * second per peer, so only the overlay and the avatar row subscribe to it,
 * never the whole canvas controller.
 */
export class RealtimeView {
  private peers = new Map<string, PresencePeer>();
  private flashes = new Map<string, NodeFlash>();
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: RealtimeViewSnapshot = { peers: [], flashes: new Map() };
  private listeners = new Set<() => void>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  /** Presence frames; everything else is ignored here. */
  applyPresence(message: ServerMessage) {
    if (message.type === "presence.snapshot") {
      this.peers = new Map(message.peers.filter((peer) => peer.clientId !== message.clientId).map((peer) => [peer.clientId, peer]));
    } else if (message.type === "presence.update") {
      const { type: _type, ...peer } = message;
      this.peers.set(peer.clientId, peer);
    } else if (message.type === "presence.leave") {
      if (!this.peers.delete(message.clientId)) return;
    } else {
      return;
    }
    this.emit();
  }

  /** The socket dropped: the hub forgets our peers, so do we (the next snapshot brings them back). */
  clearPeers() {
    if (this.peers.size === 0) return;
    this.peers.clear();
    this.emit();
  }

  flash(keys: string[], actor: RealtimeActor) {
    if (keys.length === 0) return;
    const until = this.now() + FLASH_MS;
    for (const key of keys) this.flashes.set(key, { actor, until });
    this.emit();
    this.scheduleExpiry();
  }

  dispose() {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = null;
  }

  private scheduleExpiry() {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = null;
    if (this.flashes.size === 0) return;
    const next = Math.min(...[...this.flashes.values()].map((flash) => flash.until));
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      const at = this.now();
      let changed = false;
      for (const [key, flash] of this.flashes) {
        if (flash.until <= at) changed = this.flashes.delete(key) || changed;
      }
      if (changed) this.emit();
      this.scheduleExpiry();
    }, Math.max(0, next - this.now()));
  }

  private emit() {
    this.snapshot = { peers: [...this.peers.values()], flashes: new Map(this.flashes) };
    for (const listener of this.listeners) listener();
  }
}

/** Literal class sets so Tailwind keeps them; one per person, stable across their tabs. */
export const PEER_COLORS = [
  { solid: "bg-sky-500", ring: "ring-sky-500", text: "text-sky-500" },
  { solid: "bg-violet-500", ring: "ring-violet-500", text: "text-violet-500" },
  { solid: "bg-emerald-500", ring: "ring-emerald-500", text: "text-emerald-500" },
  { solid: "bg-amber-500", ring: "ring-amber-500", text: "text-amber-500" },
  { solid: "bg-rose-500", ring: "ring-rose-500", text: "text-rose-500" },
  { solid: "bg-teal-500", ring: "ring-teal-500", text: "text-teal-500" },
  { solid: "bg-fuchsia-500", ring: "ring-fuchsia-500", text: "text-fuchsia-500" },
  { solid: "bg-orange-500", ring: "ring-orange-500", text: "text-orange-500" },
] as const;

export type PeerColor = (typeof PEER_COLORS)[number];

export function peerColor(actor: RealtimeActor): PeerColor {
  let hash = 0;
  for (const char of `${actor.type}:${actor.id}`) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PEER_COLORS[Math.abs(hash) % PEER_COLORS.length]!;
}

/** One entry per person (or agent), however many tabs they have open. */
export function uniqueActors(peers: PresencePeer[]): RealtimeActor[] {
  const seen = new Map<string, RealtimeActor>();
  for (const peer of peers) seen.set(`${peer.actor.type}:${peer.actor.id}`, peer.actor);
  return [...seen.values()];
}

export function initialsOf(label: string) {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const letters = parts.length === 1 ? parts[0]!.slice(0, 2) : `${parts[0]![0]}${parts[parts.length - 1]![0]}`;
  return letters.toUpperCase();
}
