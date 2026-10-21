import { describe, expect, it } from "vitest";
import {
  parseTier,
  maxTier,
  resolveTier,
  readVerdicts,
  closeDecision,
  evaluateIssue,
  tierRank,
  type Tier,
  type TierRoles,
  type VerdictComment,
} from "../src/risk-tier-model.js";

const roles: TierRoles = {
  planner: ["p1"],
  deliveryLead: ["dl1"],
  codeReviewer: ["cr1"],
  dogfoodTester: ["df1"],
  reviewer: ["rev1"],
};
const c = (id: string, body: string, t: string | Date = "2026-01-01T10:00:00Z"): VerdictComment => ({
  authorAgentId: id,
  body,
  createdAt: t,
});

describe("parseTier", () => {
  it.each([
    [null, "high"],
    ["", "high"],
    ["Risk tier: low", "low"],
    ["RISK TIER: LOW", "low"],
    ["Risk tier: medium", "medium"],
    ["Risk tier: invalid", "high"],
    ["Risk tier: low\nRisk tier: high", "high"],
    ["Risk tier: medium\nRisk tier: low", "medium"],
    ["Risk tier: constructor", "high"],
    ["Risk tier: toString", "high"],
    ["Risk tier: __proto__", "high"],
  ])("parseTier %#", (desc, expected) => {
    expect(parseTier(desc as string | null)).toBe(expected);
  });
});

describe("maxTier", () => {
  it.each([
    ["low", "medium", "medium"],
    ["high", "low", "high"],
    ["low", "low", "low"],
  ] as const)("maxTier %#", (a, b, exp) => {
    expect(maxTier(a, b)).toBe(exp);
  });
});

describe("resolveTier", () => {
  it("trusts planner/DL", () => {
    expect(
      resolveTier({ description: "Risk tier: low", createdByAgentId: "p1", roles }),
    ).toEqual({ tier: "low", trusted: true });
    expect(
      resolveTier({ description: "Risk tier: low", createdByAgentId: "other", roles }),
    ).toEqual({ tier: "high", trusted: false });
  });
  it("raises tier, never lowers", () => {
    const s = { tier: "low" as Tier, trusted: true };
    expect(
      resolveTier({ stored: s, description: "Risk tier: high", createdByAgentId: "p1", roles }),
    ).toEqual({ tier: "high", trusted: true });
    expect(
      resolveTier({ stored: s, description: "Risk tier: low", createdByAgentId: "p1", roles }),
    ).toEqual({ tier: "low", trusted: true });
  });
});

describe("readVerdicts", () => {
  it("returns none for empty", () => {
    expect(readVerdicts({ comments: [], statusChanges: [], roles })).toEqual({
      codeReviewer: "none",
      dogfood: "none",
      reviewer: "none",
    });
  });
  it("parses strict REVIEW: PASS", () => {
    expect(
      readVerdicts({
        comments: [c("cr1", "REVIEW: PASS sha=abc123456789 ci=green")],
        statusChanges: [],
        roles,
      }).codeReviewer,
    ).toBe("pass");
  });
  it("detects malformed PASS as changes", () => {
    expect(
      readVerdicts({
        comments: [c("cr1", "REVIEW: PASS sha=abc123456789 ci=red")],
        statusChanges: [],
        roles,
      }).codeReviewer,
    ).toBe("changes");
  });
  it("parses DOGFOOD PASS", () => {
    expect(readVerdicts({
      comments: [c("df1", "DOGFOOD: PASS")],
      statusChanges: [],
      roles,
    }).dogfood).toBe("pass");
  });
  it("ignores deleted", () => {
    expect(
      readVerdicts({
        comments: [
          {
            authorAgentId: "cr1",
            body: "REVIEW: PASS sha=abc123456789 ci=green",
            createdAt: "2026-01-01T10:00:00Z",
            deletedAt: "2026-01-01T11:00:00Z",
          },
        ],
        statusChanges: [],
        roles,
      }).codeReviewer,
    ).toBe("none");
  });
  it("takes latest verdict", () => {
    expect(
      readVerdicts({
        comments: [
          c("cr1", "REVIEW: PASS sha=abc123456789 ci=green", "2026-01-01T10:00:00Z"),
          c("cr1", "REVIEW: CHANGES NEEDED", "2026-01-01T11:00:00Z"),
        ],
        statusChanges: [],
        roles,
      }).codeReviewer,
    ).toBe("changes");
  });
  it("invalidates pass if assignee has later comment", () => {
    expect(
      readVerdicts({
        comments: [
          c("cr1", "REVIEW: PASS sha=abc123456789 ci=green", "2026-01-01T10:00:00Z"),
          c("dev1", "Updated", "2026-01-01T11:00:00Z"),
        ],
        assigneeAgentId: "dev1",
        statusChanges: [],
        roles,
      }).codeReviewer,
    ).toBe("stale");
  });
  it("invalidates pass if assignee has later status change", () => {
    expect(
      readVerdicts({
        comments: [c("cr1", "REVIEW: PASS sha=abc123456789 ci=green", "2026-01-01T10:00:00Z")],
        assigneeAgentId: "dev1",
        statusChanges: [{ actorAgentId: "dev1", at: "2026-01-01T11:00:00Z" }],
        roles,
      }).codeReviewer,
    ).toBe("stale");
  });
  it("same-timestamp ordering by array position", () => {
    const time = "2026-01-01T10:00:00Z";
    expect(
      readVerdicts({
        comments: [
          c("cr1", "REVIEW: PASS sha=abc123456789 ci=green", time),
          c("dev1", "Updated", time),
        ],
        assigneeAgentId: "dev1",
        statusChanges: [],
        roles,
      }).codeReviewer,
    ).toBe("stale");
    expect(
      readVerdicts({
        comments: [
          c("dev1", "Updated", time),
          c("cr1", "REVIEW: PASS sha=abc123456789 ci=green", time),
        ],
        assigneeAgentId: "dev1",
        statusChanges: [],
        roles,
      }).codeReviewer,
    ).toBe("pass");
  });
  it("excludes assignee activity before verdict", () => {
    expect(
      readVerdicts({
        comments: [
          c("dev1", "Initial", "2026-01-01T09:00:00Z"),
          c("cr1", "REVIEW: PASS sha=abc123456789 ci=green", "2026-01-01T10:00:00Z"),
        ],
        assigneeAgentId: "dev1",
        statusChanges: [],
        roles,
      }).codeReviewer,
    ).toBe("pass");
  });
  it("does not invalidate if assignee holds role", () => {
    const r = { ...roles, reviewer: ["dev1", "rev1"] };
    expect(
      readVerdicts({
        comments: [
          c("rev1", "REVIEW: PASS sha=abc123456789 ci=green", "2026-01-01T10:00:00Z"),
          c("dev1", "Updated", "2026-01-01T11:00:00Z"),
        ],
        assigneeAgentId: "dev1",
        statusChanges: [],
        roles: r,
      }).reviewer,
    ).toBe("pass");
  });
  it("changes cancels prior pass", () => {
    expect(
      readVerdicts({
        comments: [
          c("cr1", "REVIEW: PASS sha=abc123456789 ci=green", "2026-01-01T10:00:00Z"),
          c("cr1", "REVIEW: CHANGES NEEDED", "2026-01-01T12:00:00Z"),
        ],
        statusChanges: [],
        roles,
      }).codeReviewer,
    ).toBe("changes");
  });
});

describe("closeDecision", () => {
  it("returns never for high or invalid", () => {
    expect(closeDecision({
      tier: "high",
      verdicts: { codeReviewer: "pass", dogfood: "pass", reviewer: "pass" },
    })).toBe("never");
    expect(closeDecision({
      tier: "invalid" as Tier,
      verdicts: { codeReviewer: "pass", dogfood: "pass", reviewer: "pass" },
    })).toBe("never");
  });
  it.each([
    ["low", "pass", "pass", "none", "close"],
    ["low", "changes", "pass", "none", "wait"],
    ["medium", "pass", "pass", "pass", "close"],
    ["medium", "pass", "pass", "none", "wait"],
    ["medium", "pass", "pass", "changes", "wait"],
  ] as const)("%p: cr=%p df=%p rev=%p => %p", (tier, cr, df, rev, exp) => {
    expect(closeDecision({
      tier: tier as Tier,
      verdicts: { codeReviewer: cr as any, dogfood: df as any, reviewer: rev as any },
    })).toBe(exp);
  });
  it("prototype pollution: constructor tier => never", () => {
    expect(closeDecision({
      tier: "constructor" as any,
      verdicts: { codeReviewer: "pass", dogfood: "pass", reviewer: "pass" },
    })).toBe("never");
  });
});

describe("evaluateIssue", () => {
  it("happy path: low tier all pass", () => {
    const r = evaluateIssue({
      description: "Risk tier: low",
      createdByAgentId: "p1",
      assigneeAgentId: "dev1",
      comments: [
        c("cr1", "REVIEW: PASS sha=abc123456789 ci=green", "2026-01-01T10:00:00Z"),
        c("df1", "DOGFOOD: PASS", "2026-01-01T10:30:00Z"),
      ],
      statusChanges: [],
      roles,
    });
    expect(r.pin).toEqual({ tier: "low", trusted: true });
    expect(r.verdicts.codeReviewer).toBe("pass");
    expect(r.decision).toBe("close");
  });
  it("medium all pass closes", () => {
    expect(
      evaluateIssue({
        description: "Risk tier: medium",
        createdByAgentId: "p1",
        comments: [
          c("cr1", "REVIEW: PASS sha=abc123456789 ci=green"),
          c("df1", "DOGFOOD: PASS"),
          c("rev1", "REVIEW: PASS sha=def123456789 ci=green"),
        ],
        statusChanges: [],
        roles,
        assigneeAgentId: "dev1",
      }).decision,
    ).toBe("close");
  });
  it("same agent in multiple roles", () => {
    const r = { ...roles, reviewer: ["cr1"] };
    expect(
      evaluateIssue({
        description: "Risk tier: medium",
        createdByAgentId: "p1",
        comments: [
          c("cr1", "REVIEW: PASS sha=abc123456789 ci=green"),
          c("df1", "DOGFOOD: PASS"),
        ],
        statusChanges: [],
        roles: r,
        assigneeAgentId: "dev1",
      }).decision,
    ).toBe("close");
  });
  it("untrusted pin defaults to high", () => {
    expect(
      evaluateIssue({
        description: "Risk tier: low",
        createdByAgentId: "other",
        comments: [c("cr1", "REVIEW: PASS sha=abc123456789 ci=green")],
        statusChanges: [],
        roles,
        assigneeAgentId: "dev1",
      }).decision,
    ).toBe("never");
  });
});
