import { describe, expect, it } from "vitest";
import {
  shouldTrigger,
  pauseList,
  parseProviderQuotaClockReset,
  resumeAtFor,
  governorStuck,
  nextResume,
  canaryDecision,
  DEFAULT_PAUSE_ORDER,
  NEVER_PAUSE,
  DEFAULT_TRIGGER_FAILURES,
  DEFAULT_TRIGGER_AGENTS,
  RESET_FALLBACK_MS,
  STUCK_AFTER_RESET_HOURS,
  CANARY_MAX_TRIES,
  type GovernorAgent,
  type LimitFailures,
} from "../src/governor-model.js";

describe("shouldTrigger", () => {
  it("triggers when failures exceed threshold and two or more agents affected", () => {
    const failures: LimitFailures = {
      total: 3,
      byAgent: [
        { agentId: "a1", count: 2 },
        { agentId: "a2", count: 1 },
      ],
    };
    expect(shouldTrigger(failures)).toBe(true);
  });

  it("does not trigger when total failures are below threshold", () => {
    const failures: LimitFailures = {
      total: 2,
      byAgent: [
        { agentId: "a1", count: 1 },
        { agentId: "a2", count: 1 },
      ],
    };
    expect(shouldTrigger(failures)).toBe(false);
  });

  it("does not trigger when only one agent affected", () => {
    const failures: LimitFailures = {
      total: 5,
      byAgent: [{ agentId: "a1", count: 5 }],
    };
    expect(shouldTrigger(failures)).toBe(false);
  });

  it("respects custom threshold options", () => {
    const failures: LimitFailures = {
      total: 2,
      byAgent: [
        { agentId: "a1", count: 1 },
        { agentId: "a2", count: 1 },
      ],
    };
    expect(shouldTrigger(failures, { triggerFailures: 2, triggerAgents: 2 })).toBe(true);
  });
});

describe("pauseList", () => {
  const agents: GovernorAgent[] = [
    { id: "p1", name: "Developer" },
    { id: "p2", name: "Summarizer" },
    { id: "p3", name: "Plan Critic" },
    { id: "p4", name: "SEO Specialist" },
    { id: "p5", name: "Elon" },
  ];

  it("respects order and excludes names in neverList", () => {
    const result = pauseList(DEFAULT_PAUSE_ORDER, agents, NEVER_PAUSE);
    const names = result.map((a) => a.name);
    expect(names).toContain("Developer");
    expect(names).toContain("Plan Critic");
    expect(names).toContain("SEO Specialist");
    expect(names).not.toContain("Summarizer");
    expect(names).not.toContain("Elon");
  });

  it("handles case-insensitive and whitespace-trimmed matching", () => {
    const agents2: GovernorAgent[] = [
      { id: "a1", name: "  DEVELOPER  " },
      { id: "a2", name: "Summarizer" },
    ];
    const result = pauseList(["developer"], agents2, ["SUMMARIZER"]);
    expect(result).toEqual([{ id: "a1", name: "  DEVELOPER  " }]);
  });

  it("ignores agents not in the pause order", () => {
    const result = pauseList(["Developer"], agents, NEVER_PAUSE);
    expect(result.map((a) => a.name)).toEqual(["Developer"]);
  });

  it("skips names in order that have no matching agent", () => {
    const result = pauseList(["Developer", "Unknown", "Plan Critic"], agents, NEVER_PAUSE);
    expect(result.map((a) => a.name)).toEqual(["Developer", "Plan Critic"]);
  });

  it("never returns duplicates", () => {
    const result = pauseList(["Developer", "developer", "Developer"], agents, NEVER_PAUSE);
    expect(result).toHaveLength(1);
  });
});

describe("parseProviderQuotaClockReset", () => {
  const now = new Date("2026-07-15T20:00:00.000Z");

  it("parses GPT-style message with timezone", () => {
    const result = parseProviderQuotaClockReset(
      "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      now,
    );
    expect(result).toBeDefined();
    expect(result).toBeInstanceOf(Date);
  });

  it("parses message without timezone (treats as UTC)", () => {
    const result = parseProviderQuotaClockReset(
      "You've hit your usage limit. Try again at 4:30 PM.",
      now,
    );
    expect(result).toBeDefined();
    expect(result).toBeInstanceOf(Date);
  });

  it("parses 24-hour format with timezone", () => {
    const result = parseProviderQuotaClockReset(
      "You've hit your usage limit. Try again at 21:30 (UTC).",
      now,
    );
    expect(result).toBeDefined();
    expect(result).toBeInstanceOf(Date);
  });

  it("parses resets keyword with timezone", () => {
    const result = parseProviderQuotaClockReset(
      "Claude run failed: subtype=success: You've hit your limit · resets 2:30am (UTC)",
      new Date("2026-08-28T22:30:00.000Z"),
    );
    expect(result).toBeDefined();
    expect(result).toBeInstanceOf(Date);
  });

  it("returns null for text without clock info", () => {
    const result = parseProviderQuotaClockReset("You've hit your usage limit.", now);
    expect(result).toBeNull();
  });
});

describe("resumeAtFor", () => {
  const now = new Date("2026-07-15T20:00:00.000Z");

  it("picks the latest parsed reset time when multiple errors provided", () => {
    const errors = [
      "Try again at 21:00 (UTC)",
      "Try again at 23:00 (UTC)",
      "Try again at 22:00 (UTC)",
    ];
    const result = resumeAtFor(errors, now);
    expect(result.getUTCHours()).toBe(23);
  });

  it("returns now + 1h when no error parses", () => {
    const errors = ["Something went wrong without clock info"];
    const result = resumeAtFor(errors, now);
    expect(result.getTime()).toBe(now.getTime() + RESET_FALLBACK_MS);
  });

  it("ignores parsed resets that are in the past", () => {
    const past = new Date(now.getTime() - 1000);
    const errors = [
      `Try again at ${(past.getUTCHours() - 1).toString().padStart(2, "0")}:00 (UTC)`,
      "Try again at 21:00 (UTC)",
    ];
    const result = resumeAtFor(errors, now);
    // 18:00 today is in the past, so it gets rolled to 18:00 tomorrow,
    // which is later than 21:00 today; the latest logic picks it.
    expect(result.getUTCHours()).toBe(18);
  });

  it("empty error list falls back to now + 1h", () => {
    const result = resumeAtFor([], now);
    expect(result.getTime()).toBe(now.getTime() + RESET_FALLBACK_MS);
  });
});

describe("governorStuck", () => {
  const now = new Date("2026-07-15T20:00:00.000Z");

  it("returns false when resumed recent enough", () => {
    const resumeAt = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1 hour ago
    expect(governorStuck(resumeAt, now)).toBe(false);
  });

  it("returns true when resumed more than 6 hours ago", () => {
    const resumeAt = new Date(now.getTime() - 7 * 60 * 60 * 1000); // 7 hours ago
    expect(governorStuck(resumeAt, now)).toBe(true);
  });

  it("returns false at exactly the 6-hour boundary", () => {
    const resumeAt = new Date(now.getTime() - STUCK_AFTER_RESET_HOURS * 60 * 60 * 1000);
    expect(governorStuck(resumeAt, now)).toBe(false);
  });

  it("returns true just after the 6-hour boundary", () => {
    const resumeAt = new Date(now.getTime() - (STUCK_AFTER_RESET_HOURS * 60 * 60 * 1000 + 1));
    expect(governorStuck(resumeAt, now)).toBe(true);
  });
});

describe("nextResume", () => {
  it("returns empty when canaryOk is false", () => {
    const result = nextResume(["a1", "a2", "a3"], false);
    expect(result).toEqual([]);
  });

  it("returns up to 5 agents in reverse order", () => {
    const paused = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    const result = nextResume(paused, true);
    expect(result).toEqual(["a7", "a6", "a5", "a4", "a3"]);
  });

  it("returns all when fewer than 5 remain", () => {
    const paused = ["a1", "a2"];
    const result = nextResume(paused, true);
    expect(result).toEqual(["a2", "a1"]);
  });

  it("returns empty list for empty paused list", () => {
    const result = nextResume([], true);
    expect(result).toEqual([]);
  });

  it("returns successive batches correctly", () => {
    const paused = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10"];
    const batch1 = nextResume(paused, true);
    expect(batch1).toEqual(["a10", "a9", "a8", "a7", "a6"]);
    // Next call would use remaining: ["a1", "a2", "a3", "a4", "a5"]
    const batch2 = nextResume(["a1", "a2", "a3", "a4", "a5"], true);
    expect(batch2).toEqual(["a5", "a4", "a3", "a2", "a1"]);
  });
});

describe("canaryDecision", () => {
  it('returns "succeeded" for succeeded status', () => {
    expect(canaryDecision("succeeded", 1)).toBe("succeeded");
  });

  it('returns "wait" for queued status', () => {
    expect(canaryDecision("queued", 1)).toBe("wait");
  });

  it('returns "wait" for scheduled_retry status', () => {
    expect(canaryDecision("scheduled_retry", 2)).toBe("wait");
  });

  it('returns "wait" for running status', () => {
    expect(canaryDecision("running", 1)).toBe("wait");
  });

  it('returns "wait" for null/undefined status', () => {
    expect(canaryDecision(null, 1)).toBe("wait");
    expect(canaryDecision(undefined, 1)).toBe("wait");
  });

  it('returns "wait" for unknown status', () => {
    expect(canaryDecision("unknown", 1)).toBe("wait");
  });

  it('returns "retry" for failed status when tries < CANARY_MAX_TRIES', () => {
    expect(canaryDecision("failed", 1)).toBe("retry");
    expect(canaryDecision("failed", CANARY_MAX_TRIES - 1)).toBe("retry");
  });

  it('returns "give_up" for failed status when tries >= CANARY_MAX_TRIES', () => {
    expect(canaryDecision("failed", CANARY_MAX_TRIES)).toBe("give_up");
    expect(canaryDecision("failed", CANARY_MAX_TRIES + 1)).toBe("give_up");
  });

  it('returns "retry" for interrupted status when tries < max', () => {
    expect(canaryDecision("interrupted", 1)).toBe("retry");
  });

  it('returns "give_up" for interrupted status when tries >= max', () => {
    expect(canaryDecision("interrupted", CANARY_MAX_TRIES)).toBe("give_up");
  });

  it('returns "retry" for timed_out when tries < max', () => {
    expect(canaryDecision("timed_out", 2)).toBe("retry");
  });

  it('returns "give_up" for timed_out when tries >= max', () => {
    expect(canaryDecision("timed_out", CANARY_MAX_TRIES)).toBe("give_up");
  });

  it('returns "retry" for cancelled when tries < max', () => {
    expect(canaryDecision("cancelled", 1)).toBe("retry");
  });

  it('returns "give_up" for cancelled when tries >= max', () => {
    expect(canaryDecision("cancelled", CANARY_MAX_TRIES)).toBe("give_up");
  });
});
