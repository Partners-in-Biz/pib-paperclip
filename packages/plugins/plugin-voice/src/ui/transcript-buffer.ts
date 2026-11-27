import type { TurnRow } from "./turn-timing.js";
import { documentKey, type LogEntry } from "./transcript-report.js";

/**
 * A copy of the call in localStorage after every transcript update. An iOS screen lock can kill the
 * tab, and the whole-call log otherwise only exists in memory. Never throws: storage can be full,
 * blocked (private mode) or missing.
 */
const PREFIX = "pib-voice:transcript:";
const MAX_ENTRIES = 100;
const MAX_TURNS = 200;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export interface BufferedCall {
  startedAt: number;
  updatedAt: number;
  entries: LogEntry[];
  /** Per-turn timing rows and the stamp they were taken under (absent in buffers written before T1 of PAR-14996). */
  turns?: TurnRow[];
  timingStamp?: string;
}

export function bufferKey(startedAt: number): string {
  return `${PREFIX}${documentKey(startedAt)}`;
}

export function writeBuffer(startedAt: number, entries: LogEntry[], timing?: { turns: TurnRow[]; timingStamp: string }): boolean {
  try {
    const payload: BufferedCall = { startedAt, updatedAt: Date.now(), entries: entries.slice(-MAX_ENTRIES) };
    if (timing && timing.turns.length > 0) {
      payload.turns = timing.turns.slice(-MAX_TURNS);
      payload.timingStamp = timing.timingStamp;
    }
    window.localStorage.setItem(bufferKey(startedAt), JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function readBuffer(startedAt: number): BufferedCall | null {
  try {
    const raw = window.localStorage.getItem(bufferKey(startedAt));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BufferedCall;
    return Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

/** Drops buffers from calls older than a week, so storage does not fill up over time. */
export function pruneBuffers(now = Date.now()): void {
  try {
    const store = window.localStorage;
    for (let i = store.length - 1; i >= 0; i -= 1) {
      const key = store.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      let updatedAt = 0;
      try {
        updatedAt = (JSON.parse(store.getItem(key) ?? "{}") as { updatedAt?: number }).updatedAt ?? 0;
      } catch {
        // Unreadable: treat as stale.
      }
      if (now - updatedAt > KEEP_MS) store.removeItem(key);
    }
  } catch {
    // Storage unavailable.
  }
}
