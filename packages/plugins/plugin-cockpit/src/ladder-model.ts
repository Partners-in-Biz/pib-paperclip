/**
 * Ladder: escalating blocked issues through levels 1–4 when unblock attempts fail.
 * Pure model (no I/O, no Date.now, `now` is passed in). Decides what to do next
 * for a stuck issue as blockers pile up or Unblock issues stall.
 */

import { parseMarker } from "@partnersinbiz/pib-plugin-kit";

export const BLOCKED_ESCALATE_HOURS = 24; // stuck issue blocked this long with no open blocker -> level 1
export const LEVEL_DEADLINE_HOURS = 24; // an open Unblock level may sit this long
export const TRANSIENT_RETRY_WINDOW_HOURS = 6;

export type Level = 1 | 2 | 3 | 4; // 4 = owner, end of ladder

export interface StuckInput {
  id: string;
  identifier: string;
  status: string;
  blockedSince: string; // ISO
  openBlockers: number;
  closedBlockers: number;
}

export interface UnblockInput {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status: string; // todo|in_progress|blocked|in_review|done|cancelled|...
  createdAt: string; // ISO
  blockedNoPath: boolean;
  inStorm: boolean;
}

export type LadderAction =
  | { type: "none"; reason: "not_stuck_yet" | "level_open" | "owner_level" | "ladder_end" | "nothing_to_do" }
  | { type: "resolved" } // stuck issue no longer blocked; caller writes ledger row `outcome: resolved` once
  | { type: "create"; level: Level; replaceClosedBlockerIds?: string[] }
  | {
      type: "advance";
      level: Level;
      cancelIds: string[];
      reason: "deadline_passed" | "unblock_stuck" | "closed" | "duplicate_lower";
      swapBlockerFrom?: string;
      replaceClosedBlockerIds?: string[];
    } // create `level` (cancel superseded ones with comment "superseded by level n+1")
  | { type: "cancel_lower"; cancelIds: string[] };

/** Parses Unblock marker. Returns ordinary if missing or level not 1-4. */
export function classifyUnblock(i: UnblockInput): { kind: "unblock"; level: Level; deadline: string; issueId: string } | { kind: "ordinary" } {
  const marker = parseMarker(i.description);
  if (!marker || !Number.isInteger(marker.level) || marker.level < 1 || marker.level > 4) {
    return { kind: "ordinary" };
  }
  return {
    kind: "unblock",
    level: marker.level as Level,
    deadline: marker.deadline,
    issueId: marker.issue,
  };
}

/** Decides next action: create/advance to next level, cancel lower, or stay. See tests for state semantics. */
export function nextAction(stuck: StuckInput, unblocks: UnblockInput[], now: Date): LadderAction {
  if (stuck.status !== "blocked") return { type: "resolved" };

  const classified = unblocks.map((u) => ({ input: u, classified: classifyUnblock(u) }));
  const linked = classified.filter((item) => item.classified.kind === "unblock" && item.classified.issueId === stuck.id);

  if (linked.length === 0) {
    if (stuck.openBlockers > 0) return { type: "none", reason: "not_stuck_yet" };
    const hoursSinceBlocked = (now.getTime() - new Date(stuck.blockedSince).getTime()) / (1000 * 60 * 60);
    return hoursSinceBlocked >= BLOCKED_ESCALATE_HOURS ? { type: "create", level: 1 } : { type: "none", reason: "not_stuck_yet" };
  }

  const isOpen = (s: string) => !["done", "cancelled"].includes(s);
  const openLinked = linked.filter((item) => isOpen(item.input.status));
  const closedLinked = linked.filter((item) => !isOpen(item.input.status));

  if (openLinked.length > 0) {
    const openClassified = openLinked.map((item) => ({
      input: item.input,
      classified: item.classified as ReturnType<typeof classifyUnblock> & { kind: "unblock" },
    }));

    const top = openClassified.reduce((p, c) => (c.classified.level > p.classified.level ? c : p));
    const lowerIds = openClassified.filter((item) => item.classified.level < top.classified.level).map((item) => item.input.id);

    if (top.classified.level === 4) {
      return lowerIds.length ? { type: "cancel_lower", cancelIds: lowerIds } : { type: "none", reason: "owner_level" };
    }

    if (top.input.blockedNoPath || top.input.inStorm) {
      return {
        type: "advance",
        level: (top.classified.level + 1) as Level,
        cancelIds: [top.input.id, ...lowerIds],
        reason: "unblock_stuck",
        swapBlockerFrom: top.input.id,
      };
    }

    if (now > new Date(top.classified.deadline)) {
      return {
        type: "advance",
        level: (top.classified.level + 1) as Level,
        cancelIds: [top.input.id, ...lowerIds],
        reason: "deadline_passed",
        swapBlockerFrom: top.input.id,
      };
    }

    return lowerIds.length ? { type: "cancel_lower", cancelIds: lowerIds } : { type: "none", reason: "level_open" };
  }

  if (closedLinked.length > 0 && stuck.openBlockers === 0 && stuck.closedBlockers > 0) {
    const closedClassified = closedLinked.map((item) => ({
      input: item.input,
      classified: item.classified as ReturnType<typeof classifyUnblock> & { kind: "unblock" },
    }));
    const highest = closedClassified.reduce((p, c) => (c.classified.level > p.classified.level ? c : p));
    const n = highest.classified.level;

    if (n === 4) return { type: "none", reason: "ladder_end" };

    return {
      type: "advance",
      level: (n + 1) as Level,
      cancelIds: [],
      reason: "closed",
      replaceClosedBlockerIds: closedClassified.map((item) => item.input.id),
    };
  }

  return { type: "none", reason: "not_stuck_yet" };
}

/** Detects Mac-build-host SSH error (both parts case-insensitive). */
export function isTransientSetupError(message: string): boolean {
  const lower = message.toLowerCase();
  return /failed to provision workspace/.test(lower) && /does not support command execution/.test(lower);
}

export type TransientDecision = "resume" | "escalate" | "not_transient";

/** Resume first time, escalate if recent occurrence within 6h. */
export function transientSetupDecision(message: string, earlierOccurrencesIso: string[], now: Date): TransientDecision {
  if (!isTransientSetupError(message)) return "not_transient";

  const sixHoursMs = TRANSIENT_RETRY_WINDOW_HOURS * 60 * 60 * 1000;
  const hasRecent = earlierOccurrencesIso.some((isoStr) => {
    try {
      const ageMs = now.getTime() - new Date(isoStr).getTime();
      return ageMs >= 0 && ageMs < sixHoursMs;
    } catch {
      return false;
    }
  });

  return hasRecent ? "escalate" : "resume";
}
