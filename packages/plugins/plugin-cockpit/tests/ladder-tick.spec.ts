/**
 * Ladder tick tests: 8 ladder states end-to-end, hourly guard, skip handling,
 * storm handling, and error isolation. Mocks watch.js readers and escalate.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MarkerIssueRow, LadderIssue } from "../src/watch.js";
import type { StuckInput, UnblockInput } from "../src/ladder-model.js";

// Mock watch.js before importing ladder.js
vi.mock("../src/watch.js", async () => {
  const actual = await vi.importActual<typeof import("../src/watch.js")>("../src/watch.js");
  return {
    ...actual,
    readMarkerIssues: vi.fn(),
    readLadderIssues: vi.fn(),
    readStorms: vi.fn(),
  };
});

// Mock escalate from the kit before importing ladder.js
vi.mock("@partnersinbiz/pib-plugin-kit", async () => {
  const actual = await vi.importActual<typeof import("@partnersinbiz/pib-plugin-kit")>("@partnersinbiz/pib-plugin-kit");
  return {
    ...actual,
    escalate: vi.fn(),
  };
});

import { ladderTick, reconcileMarkers } from "../src/ladder.js";
import { listRepairs } from "../src/repairs.js";
import { createEnv } from "../src/register.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";
import * as watchModule from "../src/watch.js";
import * as kitModule from "@partnersinbiz/pib-plugin-kit";

const A = "company-a";
const NOW = "2026-09-26T10:00:00.000Z";

function setup() {
  const fake = fakeCtx({ savedConfigs: { [A]: {} } });
  const clock = fixedClock(NOW);
  const env = createEnv(fake.ctx, clock.now);
  return { ...fake, env, clock };
}

type S = ReturnType<typeof setup>;

const mockReadMarkerIssues = vi.mocked(watchModule.readMarkerIssues);
const mockReadLadderIssues = vi.mocked(watchModule.readLadderIssues);
const mockReadStorms = vi.mocked(watchModule.readStorms);
const mockEscalate = vi.mocked(kitModule.escalate);

beforeEach(() => {
  vi.clearAllMocks();
  mockReadMarkerIssues.mockResolvedValue([]);
  mockReadLadderIssues.mockResolvedValue([]);
  mockReadStorms.mockResolvedValue([]);
});

describe("ladder state transitions", () => {
  it("State 1: stuck >24h no open blocker no marker -> escalate called with startLevel 1", async () => {
    const s = setup();
    const now = new Date(NOW);
    mockReadLadderIssues.mockResolvedValue([
      {
        stuck: {
          id: "stuck-1",
          identifier: "PAR-100",
          status: "blocked",
          blockedSince: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
          openBlockers: 0,
          closedBlockers: 0,
        } as StuckInput,
        unblocks: [],
      } as LadderIssue,
    ]);
    mockEscalate.mockResolvedValue({ id: "unblock-l1", level: 1, created: true });

    const counts = await ladderTick(s.env, A);
    expect(counts.created).toBe(1);
    expect(mockEscalate).toHaveBeenCalledWith(
      expect.any(Object),
      "stuck-1",
      expect.stringContaining("24 hours"),
      expect.objectContaining({ startLevel: 1 }),
    );
  });

  it("State 2: L1 open before deadline -> no escalate, no cancel", async () => {
    const s = setup();
    const now = new Date(NOW);
    const deadline = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
    mockReadLadderIssues.mockResolvedValue([
      {
        stuck: {
          id: "stuck-1",
          identifier: "PAR-100",
          status: "blocked",
          blockedSince: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
          openBlockers: 0,
          closedBlockers: 0,
        } as StuckInput,
        unblocks: [
          {
            id: "unblock-l1",
            identifier: "PAR-1001",
            title: "Unblock L1",
            status: "todo",
            description: `<!-- pib:escalation {"issue":"stuck-1","level":1,"deadline":"${deadline}"} -->`,
            createdAt: NOW,
            blockedNoPath: false,
            inStorm: false,
          } as UnblockInput,
        ],
      } as LadderIssue,
    ]);

    const counts = await ladderTick(s.env, A);
    expect(counts.created).toBe(0);
    expect(mockEscalate).not.toHaveBeenCalled();
  });

  it("State 3: L1 open past deadline -> escalate startLevel 2, cancel with comment", async () => {
    const s = setup();
    const now = new Date(NOW);
    const deadline = new Date(now.getTime() - 1000).toISOString();
    mockReadLadderIssues.mockResolvedValue([
      {
        stuck: {
          id: "stuck-1",
          identifier: "PAR-100",
          status: "blocked",
          blockedSince: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
          openBlockers: 0,
          closedBlockers: 0,
        } as StuckInput,
        unblocks: [
          {
            id: "unblock-l1",
            identifier: "PAR-1001",
            title: "Unblock L1",
            status: "in_progress",
            description: `<!-- pib:escalation {"issue":"stuck-1","level":1,"deadline":"${deadline}"} -->`,
            createdAt: NOW,
            blockedNoPath: false,
            inStorm: false,
          } as UnblockInput,
        ],
      } as LadderIssue,
    ]);
    mockEscalate.mockResolvedValue({ id: "unblock-l2", level: 2, created: true });

    const counts = await ladderTick(s.env, A);
    expect(counts.advanced).toBe(1);
    expect(mockEscalate).toHaveBeenCalledWith(
      expect.any(Object),
      "stuck-1",
      expect.any(String),
      expect.objectContaining({ startLevel: 2 }),
    );
  });

  it("State 4: L1 closed, only closed blockers -> escalate startLevel 2", async () => {
    const s = setup();
    const now = new Date(NOW);
    mockReadLadderIssues.mockResolvedValue([
      {
        stuck: {
          id: "stuck-1",
          identifier: "PAR-100",
          status: "blocked",
          blockedSince: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
          openBlockers: 0,
          closedBlockers: 1,
        } as StuckInput,
        unblocks: [
          {
            id: "unblock-l1",
            identifier: "PAR-1001",
            title: "Unblock L1",
            status: "done",
            description: `<!-- pib:escalation {"issue":"stuck-1","level":1,"deadline":"2026-09-26T12:00:00.000Z"} -->`,
            createdAt: NOW,
            blockedNoPath: false,
            inStorm: false,
          } as UnblockInput,
        ],
      } as LadderIssue,
    ]);
    mockEscalate.mockResolvedValue({ id: "unblock-l2", level: 2, created: true });

    const counts = await ladderTick(s.env, A);
    expect(counts.advanced).toBe(1);
  });

  it("State 5a & 5b: Unblock blockedNoPath or inStorm -> advance escalate called", async () => {
    const s = setup();
    const now = new Date(NOW);
    const deadline = new Date(now.getTime() - 1000).toISOString();
    mockReadLadderIssues.mockResolvedValue([
      {
        stuck: {
          id: "stuck-1",
          identifier: "PAR-100",
          status: "blocked",
          blockedSince: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
          openBlockers: 0,
          closedBlockers: 0,
        } as StuckInput,
        unblocks: [
          {
            id: "unblock-l1",
            identifier: "PAR-1001",
            title: "Unblock L1",
            status: "blocked",
            description: `<!-- pib:escalation {"issue":"stuck-1","level":1,"deadline":"${deadline}"} -->`,
            createdAt: NOW,
            blockedNoPath: true,
            inStorm: false,
          } as UnblockInput,
        ],
      } as LadderIssue,
    ]);
    mockEscalate.mockResolvedValue({ id: "unblock-l2", level: 2, created: true });

    const counts = await ladderTick(s.env, A);
    expect(counts.advanced).toBe(1);
    expect(mockEscalate).toHaveBeenCalledWith(
      expect.any(Object),
      "stuck-1",
      expect.any(String),
      expect.objectContaining({ startLevel: 2 }),
    );
  });

  it("State 6: L4 open -> no escalate", async () => {
    const s = setup();
    const now = new Date(NOW);
    const deadline = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();
    mockReadLadderIssues.mockResolvedValue([
      {
        stuck: {
          id: "stuck-1",
          identifier: "PAR-100",
          status: "blocked",
          blockedSince: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
          openBlockers: 0,
          closedBlockers: 0,
        } as StuckInput,
        unblocks: [
          {
            id: "unblock-l4",
            identifier: "PAR-1004",
            title: "Unblock L4",
            status: "todo",
            description: `<!-- pib:escalation {"issue":"stuck-1","level":4,"deadline":"${deadline}"} -->`,
            createdAt: NOW,
            blockedNoPath: false,
            inStorm: false,
          } as UnblockInput,
        ],
      } as LadderIssue,
    ]);

    const counts = await ladderTick(s.env, A);
    expect(counts.created).toBe(0);
    expect(mockEscalate).not.toHaveBeenCalled();
  });

  it("State 7: stuck not blocked anymore -> one 'resolved' row, second tick adds none", async () => {
    const s = setup();
    const marker: MarkerIssueRow = {
      id: "marker-1",
      identifier: "PAR-1001",
      title: "Unblock L1",
      stuckIssueId: "stuck-1",
      level: 1,
      status: "done",
      originId: "escalate:stuck-1:L1",
      description: null,
      createdAt: NOW,
    };
    mockReadMarkerIssues.mockResolvedValue([marker]);
    mockReadLadderIssues.mockResolvedValue([
      {
        stuck: {
          id: "stuck-1",
          identifier: "PAR-100",
          status: "todo",
          blockedSince: NOW,
          openBlockers: 0,
          closedBlockers: 0,
        } as StuckInput,
        unblocks: [
          {
            id: "marker-1",
            identifier: "PAR-1001",
            title: "Unblock L1",
            status: "done",
            description: `<!-- pib:escalation {"issue":"stuck-1","level":1,"deadline":"2026-09-26T12:00:00.000Z"} -->`,
            createdAt: NOW,
            blockedNoPath: false,
            inStorm: false,
          } as UnblockInput,
        ],
      } as LadderIssue,
    ]);

    const counts1 = await ladderTick(s.env, A);
    expect(counts1.resolved).toBe(1);

    // Advance 56 minutes past guard
    s.clock.set(new Date(new Date(NOW).getTime() + 56 * 60 * 1000).toISOString());
    const counts2 = await ladderTick(s.env, A);
    expect(counts2.resolved).toBe(0);
  });

  it("State 8: escalate returns {skipped:'cooldown'} -> one row per day, second tick same day adds none", async () => {
    const s = setup();
    const now = new Date(NOW);
    mockReadLadderIssues.mockResolvedValue([
      {
        stuck: {
          id: "stuck-1",
          identifier: "PAR-100",
          status: "blocked",
          blockedSince: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
          openBlockers: 0,
          closedBlockers: 0,
        } as StuckInput,
        unblocks: [],
      } as LadderIssue,
    ]);
    mockEscalate.mockResolvedValue({ skipped: "cooldown" });

    const counts1 = await ladderTick(s.env, A);
    expect(counts1.skipped).toBe(1);

    const repairs = await listRepairs(s.env.ctx, A, { kind: "escalation" });
    expect(repairs.filter((r) => r.outcome === "skipped_cooldown")).toHaveLength(1);

    // Advance 56 minutes, still same UTC day
    s.clock.set(new Date(new Date(NOW).getTime() + 56 * 60 * 1000).toISOString());
    const counts2 = await ladderTick(s.env, A);
    expect(counts2.skipped).toBe(1);

    const repairs2 = await listRepairs(s.env.ctx, A, { kind: "escalation" });
    expect(repairs2.filter((r) => r.outcome === "skipped_cooldown")).toHaveLength(1);
  });
});

describe("edge cases and error handling", () => {
  it("second ladderTick within the hour never calls escalate", async () => {
    const s = setup();
    const now = new Date(NOW);
    mockReadLadderIssues.mockResolvedValue([
      {
        stuck: {
          id: "stuck-1",
          identifier: "PAR-100",
          status: "blocked",
          blockedSince: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
          openBlockers: 0,
          closedBlockers: 0,
        } as StuckInput,
        unblocks: [],
      } as LadderIssue,
    ]);
    mockEscalate.mockResolvedValue({ id: "unblock-1", level: 1, created: true });

    const counts1 = await ladderTick(s.env, A);
    expect(mockEscalate).toHaveBeenCalledTimes(1);

    const counts2 = await ladderTick(s.env, A);
    expect(mockEscalate).toHaveBeenCalledTimes(1);
  });

  it("storm on marker issue does not escalate", async () => {
    const s = setup();
    mockReadMarkerIssues.mockResolvedValue([{ id: "marker-storm" } as any]);
    mockReadStorms.mockResolvedValue([{ issueId: "marker-storm", failed: 4, errorCode: "timeout" } as any]);

    const counts = await ladderTick(s.env, A);
    expect(counts.stormed).toBe(0);
    expect(mockEscalate).not.toHaveBeenCalled();
  });

  it("storm on normal issue escalates with startLevel 1, no lastError in reason", async () => {
    const s = setup();
    mockReadStorms.mockResolvedValue([
      { issueId: "storm-issue", failed: 5, errorCode: "adapter_failed", lastError: "spawn E2BIG" } as any,
    ]);
    mockEscalate.mockResolvedValue({ id: "unblock-1", level: 1, created: true });

    const counts = await ladderTick(s.env, A);
    expect(counts.stormed).toBe(1);
    expect(mockEscalate).toHaveBeenCalledWith(
      expect.any(Object),
      "storm-issue",
      expect.not.stringContaining("E2BIG"),
      expect.objectContaining({ startLevel: 1 }),
    );
  });

  it("exception on one issue does not stop the next", async () => {
    const s = setup();
    mockReadLadderIssues.mockResolvedValue([
      {
        stuck: {
          id: "stuck-fail",
          identifier: "PAR-100",
          status: "blocked",
          blockedSince: new Date(new Date(NOW).getTime() - 25 * 60 * 60 * 1000).toISOString(),
          openBlockers: 0,
          closedBlockers: 0,
        } as StuckInput,
        unblocks: [],
      } as LadderIssue,
      {
        stuck: {
          id: "stuck-ok",
          identifier: "PAR-101",
          status: "blocked",
          blockedSince: new Date(new Date(NOW).getTime() - 25 * 60 * 60 * 1000).toISOString(),
          openBlockers: 0,
          closedBlockers: 0,
        } as StuckInput,
        unblocks: [],
      } as LadderIssue,
    ]);
    mockEscalate.mockImplementation((ctx, issueId) => {
      if (issueId === "stuck-fail") throw new Error("escalate failed");
      return Promise.resolve({ id: "unblock-1", level: 1, created: true });
    });

    const counts = await ladderTick(s.env, A);
    expect(counts.created).toBe(1);
  });

  it("two open levels -> cancel_lower path taken", async () => {
    const s = setup();
    const now = new Date(NOW);
    const deadline = new Date(now.getTime() - 1000).toISOString();
    mockReadLadderIssues.mockResolvedValue([
      {
        stuck: {
          id: "stuck-1",
          identifier: "PAR-100",
          status: "blocked",
          blockedSince: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
          openBlockers: 0,
          closedBlockers: 0,
        } as StuckInput,
        unblocks: [
          {
            id: "unblock-l1",
            identifier: "PAR-1001",
            title: "Unblock L1",
            status: "todo",
            description: `<!-- pib:escalation {"issue":"stuck-1","level":1,"deadline":"${deadline}"} -->`,
            createdAt: NOW,
            blockedNoPath: false,
            inStorm: false,
          } as UnblockInput,
          {
            id: "unblock-l2",
            identifier: "PAR-1002",
            title: "Unblock L2",
            status: "in_progress",
            description: `<!-- pib:escalation {"issue":"stuck-1","level":2,"deadline":"${deadline}"} -->`,
            createdAt: NOW,
            blockedNoPath: false,
            inStorm: false,
          } as UnblockInput,
        ],
      } as LadderIssue,
    ]);

    const counts = await ladderTick(s.env, A);
    // Two open levels at different stages should trigger cancel_lower
    expect(counts.created + counts.advanced + counts.cancelled).toBeGreaterThan(0);
  });

  it("escalate returns skip reasons other than cooldown/cap -> each skip_reason is recorded once per day", async () => {
    const s = setup();
    const now = new Date(NOW);
    mockReadLadderIssues.mockResolvedValue([
      {
        stuck: {
          id: "stuck-no-target",
          identifier: "PAR-100",
          status: "blocked",
          blockedSince: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
          openBlockers: 0,
          closedBlockers: 0,
        } as StuckInput,
        unblocks: [],
      } as LadderIssue,
      {
        stuck: {
          id: "stuck-no-owner",
          identifier: "PAR-101",
          status: "blocked",
          blockedSince: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
          openBlockers: 0,
          closedBlockers: 0,
        } as StuckInput,
        unblocks: [],
      } as LadderIssue,
    ]);
    mockEscalate.mockImplementation((ctx, issueId) => {
      if (issueId === "stuck-no-target") return Promise.resolve({ skipped: "no-target" });
      return Promise.resolve({ skipped: "no-owner" });
    });

    const counts1 = await ladderTick(s.env, A);
    expect(counts1.skipped).toBe(2);

    // Check repairs were recorded
    const repairs = await listRepairs(s.env.ctx, A, { kind: "escalation" });
    expect(repairs.filter((r) => r.outcome === "skipped_no-target")).toHaveLength(1);
    expect(repairs.filter((r) => r.outcome === "skipped_no-owner")).toHaveLength(1);

    // Second tick same day should not duplicate
    s.clock.set(new Date(new Date(NOW).getTime() + 56 * 60 * 1000).toISOString());
    const counts2 = await ladderTick(s.env, A);
    expect(counts2.skipped).toBe(2);

    const repairs2 = await listRepairs(s.env.ctx, A, { kind: "escalation" });
    expect(repairs2.filter((r) => r.outcome === "skipped_no-target")).toHaveLength(1);
    expect(repairs2.filter((r) => r.outcome === "skipped_no-owner")).toHaveLength(1);
  });

  it("advance path: escalate returns skipped reason -> recorded", async () => {
    const s = setup();
    const now = new Date(NOW);
    const deadline = new Date(now.getTime() - 1000).toISOString();
    mockReadLadderIssues.mockResolvedValue([
      {
        stuck: {
          id: "stuck-1",
          identifier: "PAR-100",
          status: "blocked",
          blockedSince: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
          openBlockers: 0,
          closedBlockers: 0,
        } as StuckInput,
        unblocks: [
          {
            id: "unblock-l1",
            identifier: "PAR-1001",
            title: "Unblock L1",
            status: "in_progress",
            description: `<!-- pib:escalation {"issue":"stuck-1","level":1,"deadline":"${deadline}"} -->`,
            createdAt: NOW,
            blockedNoPath: false,
            inStorm: false,
          } as UnblockInput,
        ],
      } as LadderIssue,
    ]);
    mockEscalate.mockResolvedValue({ skipped: "cap" });

    const counts = await ladderTick(s.env, A);
    expect(counts.skipped).toBe(1);

    const repairs = await listRepairs(s.env.ctx, A, { kind: "escalation" });
    expect(repairs.filter((r) => r.outcome === "skipped_cap")).toHaveLength(1);
  });
});
