import { describe, expect, it } from "vitest";
import {
  classifyUnblock,
  nextAction,
  isTransientSetupError,
  transientSetupDecision,
  LEVEL_DEADLINE_HOURS,
  type Level,
  type StuckInput,
  type UnblockInput,
} from "../src/ladder-model.js";
import { escalationMarker } from "@partnersinbiz/pib-plugin-kit";

const LIVE_MAC_ERROR = 'Failed to provision workspace for environment \'Mac build host\' (ssh): Environment driver "ssh" does not support command execution.';
const now = new Date("2026-10-19T12:00:00Z");

function stuck(overrides?: Partial<StuckInput>): StuckInput {
  return {
    id: "issue-stuck",
    identifier: "PAR-123",
    status: "blocked",
    blockedSince: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
    openBlockers: 0,
    closedBlockers: 0,
    ...overrides,
  };
}

function unblock(level: Level, overrides?: Partial<UnblockInput>): UnblockInput {
  const deadline = new Date(now.getTime() + LEVEL_DEADLINE_HOURS * 60 * 60 * 1000).toISOString();
  const marker = escalationMarker({ issue: "issue-stuck", level, deadline });
  return {
    id: `unblock-level-${level}`,
    identifier: `PAR-200-L${level}`,
    title: `Unblock: PAR-123 Test Issue`,
    description: `Text\n\n${marker}`,
    status: "in_progress",
    createdAt: now.toISOString(),
    blockedNoPath: false,
    inStorm: false,
    ...overrides,
  };
}

describe("classifyUnblock", () => {
  it("parses valid marker", () => {
    expect(classifyUnblock(unblock(2))).toEqual({
      kind: "unblock",
      level: 2,
      deadline: expect.any(String),
      issueId: "issue-stuck",
    });
  });

  it("returns ordinary for missing or invalid marker", () => {
    const u1 = unblock(1);
    u1.description = "No marker";
    expect(classifyUnblock(u1)).toEqual({ kind: "ordinary" });

    const u2 = unblock(1);
    u2.description = `Text\n\n${escalationMarker({ issue: "issue-stuck", level: 5 as any, deadline: now.toISOString() })}`;
    expect(classifyUnblock(u2)).toEqual({ kind: "ordinary" });
  });
});

describe("nextAction", () => {
  it("state 1: creates level 1 when stuck >24h with no blockers", () => {
    expect(nextAction(stuck({ openBlockers: 0 }), [], now)).toEqual({ type: "create", level: 1 });
  });

  it("state 1: returns none when stuck <24h", () => {
    const s = stuck({
      blockedSince: new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString(),
      openBlockers: 0,
    });
    expect(nextAction(s, [], now)).toEqual({ type: "none", reason: "not_stuck_yet" });
  });

  it("state 2: level open before deadline -> none(level_open)", () => {
    expect(nextAction(stuck(), [unblock(2)], now)).toEqual({ type: "none", reason: "level_open" });
  });

  it("state 3: level open past deadline -> advance with swapBlockerFrom", () => {
    const pastDeadline = new Date(now.getTime() - 1000).toISOString();
    const u = unblock(2);
    u.description = `Text\n\n${escalationMarker({ issue: "issue-stuck", level: 2, deadline: pastDeadline })}`;
    const result = nextAction(stuck(), [u], now);
    expect(result).toEqual({
      type: "advance",
      level: 3,
      cancelIds: ["unblock-level-2"],
      reason: "deadline_passed",
      swapBlockerFrom: "unblock-level-2",
    });
  });

  it("state 4a: closed blocker level n -> advance n+1 reason closed", () => {
    const s = stuck({ openBlockers: 0, closedBlockers: 1 });
    expect(nextAction(s, [unblock(2, { status: "done" })], now)).toEqual({
      type: "advance",
      level: 3,
      cancelIds: [],
      reason: "closed",
      replaceClosedBlockerIds: ["unblock-level-2"],
    });
  });

  it("state 4b: closed blocker level 4 -> none(ladder_end)", () => {
    const s = stuck({ openBlockers: 0, closedBlockers: 1 });
    expect(nextAction(s, [unblock(4 as Level, { status: "cancelled" })], now)).toEqual({
      type: "none",
      reason: "ladder_end",
    });
  });

  it("state 5a: open Unblock blocked-no-path -> advance unblock_stuck", () => {
    expect(nextAction(stuck(), [unblock(2, { blockedNoPath: true })], now)).toEqual({
      type: "advance",
      level: 3,
      cancelIds: ["unblock-level-2"],
      reason: "unblock_stuck",
      swapBlockerFrom: "unblock-level-2",
    });
  });

  it("state 5b: open Unblock in-storm -> advance unblock_stuck", () => {
    expect(nextAction(stuck(), [unblock(1, { inStorm: true })], now)).toEqual({
      type: "advance",
      level: 2,
      cancelIds: ["unblock-level-1"],
      reason: "unblock_stuck",
      swapBlockerFrom: "unblock-level-1",
    });
  });

  it("state 6: level 4 open -> none(owner_level) even past deadline", () => {
    const pastDeadline = new Date(now.getTime() - 1000).toISOString();
    const u = unblock(4 as Level);
    u.description = `Text\n\n${escalationMarker({ issue: "issue-stuck", level: 4, deadline: pastDeadline })}`;
    expect(nextAction(stuck(), [u], now)).toEqual({ type: "none", reason: "owner_level" });
  });

  it("state 7: status not blocked -> resolved", () => {
    expect(nextAction(stuck({ status: "done" }), [], now)).toEqual({ type: "resolved" });
  });

  it("state 8a: two levels open before deadline -> cancel lower", () => {
    const u1 = unblock(1);
    const u2 = unblock(3);
    expect(nextAction(stuck(), [u1, u2], now)).toEqual({
      type: "cancel_lower",
      cancelIds: ["unblock-level-1"],
    });
  });

  it("state 8b: two levels open past deadline -> advance highest, cancel both", () => {
    const pastDeadline = new Date(now.getTime() - 1000).toISOString();
    const u1 = unblock(1);
    const u2 = unblock(2);
    u2.description = `Text\n\n${escalationMarker({ issue: "issue-stuck", level: 2, deadline: pastDeadline })}`;
    const result = nextAction(stuck(), [u1, u2], now);
    expect(result).toEqual({
      type: "advance",
      level: 3,
      cancelIds: ["unblock-level-2", "unblock-level-1"],
      reason: "deadline_passed",
      swapBlockerFrom: "unblock-level-2",
    });
  });

  it("state 9: missing marker treated as ordinary -> create level 1 past 24h", () => {
    const u = unblock(1);
    u.description = "No marker";
    expect(nextAction(stuck({ openBlockers: 0 }), [u], now)).toEqual({ type: "create", level: 1 });
  });
});

describe("isTransientSetupError", () => {
  it("matches live Mac-build-host error", () => {
    expect(isTransientSetupError(LIVE_MAC_ERROR)).toBe(true);
  });

  it("case-insensitive and both parts required", () => {
    expect(isTransientSetupError(LIVE_MAC_ERROR.toUpperCase())).toBe(true);
    expect(isTransientSetupError('Failed to provision workspace (ssh)')).toBe(false);
    expect(isTransientSetupError('Environment driver "ssh" does not support X')).toBe(false);
    expect(isTransientSetupError("Some other error")).toBe(false);
  });
});

describe("transientSetupDecision", () => {
  it.each<[string, string, string[], string]>([
    ["not_transient for unrelated message", "unrelated", [], "not_transient"],
    ["resume when no earlier occurrence", LIVE_MAC_ERROR, [], "resume"],
    ["resume when >6h old", LIVE_MAC_ERROR, [new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString()], "resume"],
    ["escalate with recent occurrence", LIVE_MAC_ERROR, [new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString()], "escalate"],
    ["escalate with any recent in list", LIVE_MAC_ERROR, [
      new Date(now.getTime() - 10 * 60 * 60 * 1000).toISOString(),
      new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    ], "escalate"],
  ])("%s", (_, msg, occurrences, expected) => {
    expect(transientSetupDecision(msg, occurrences, now)).toBe(expected);
  });
});
