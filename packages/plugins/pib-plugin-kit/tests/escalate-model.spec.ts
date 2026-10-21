import { describe, expect, it } from "vitest";
import {
  buildUnblockIssue,
  escalationDecide,
  escalationMarker,
  escalationOriginId,
  parseMarker,
  pickLevels,
  type AgentHealthInput,
  type EscalationLevel,
} from "../src/escalate-model.js";

const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000);
const health: Record<string, AgentHealthInput | undefined> = {
  ok: { agentStatus: "ok", hireOpen: false },
  paused: { agentStatus: "paused", hireOpen: false },
  hireOpen: { agentStatus: null, hireOpen: true },
};
const baseIssue = { id: "id1", identifier: "PAR-123", title: "Test" };
const baseLevel: EscalationLevel = { level: 1, target: { kind: "agent", agentId: "a1" } };
const baseInput = () => ({
  issue: baseIssue,
  level: baseLevel,
  reason: "blocked",
  assigneeComments: [] as const,
  redact: (x: string) => x,
  now: new Date("2026-10-19T00:00:00Z"),
});

describe("escalate-model", () => {
  describe("pickLevels", () => {
    it.each([
      { name: "skip paused and hireOpen, number rest 1..n then owner", chain: ["ok", "paused", "hireOpen", "ok"], h: health, expect: [{ level: 1, target: { kind: "agent", agentId: "ok" } }, { level: 2, target: { kind: "agent", agentId: "ok" } }, { level: 3, target: { kind: "owner" } }] },
      { name: "skip undefined health", chain: ["ok", undefined as any, "ok"], h: { ok: health.ok }, expect: [{ level: 1, target: { kind: "agent", agentId: "ok" } }, { level: 2, target: { kind: "agent", agentId: "ok" } }, { level: 3, target: { kind: "owner" } }] },
      { name: "empty chain", chain: [] as any[], h: {}, expect: [{ level: 1, target: { kind: "owner" } }] },
      { name: "all unusable", chain: ["paused", "hireOpen"], h: { paused: health.paused, hireOpen: health.hireOpen }, expect: [{ level: 1, target: { kind: "owner" } }] },
    ] as const)("$name", ({ chain, h, expect: expected }) => {
      expect(pickLevels(chain, h)).toEqual(expected);
    });

    it.each([
      { startLevel: 2 as const, desc: "startLevel number drops levels below it", expected: [{ level: 2, target: { kind: "agent", agentId: "a3" } }, { level: 3, target: { kind: "owner" } }] },
      { startLevel: "owner" as const, desc: "startLevel 'owner' returns only owner", expected: [{ level: 3, target: { kind: "owner" } }] },
    ])("$desc", ({ startLevel, expected }) => {
      const h = { a2: health.ok, a3: health.ok };
      expect(pickLevels(["a2", "a3"], h, startLevel)).toEqual(expected);
    });
  });

  describe("escalationDecide", () => {
    const level: EscalationLevel = { level: 1, target: { kind: "agent", agentId: "a1" } };
    it.each([
      { name: "dedupe: open", existing: [{ originId: "escalate:issue-123:L1", createdAt: new Date(), open: true }], expectReason: "dedupe" as const },
      { name: "cooldown: 23h", existing: [{ originId: "escalate:issue-123:L1", createdAt: at(23), open: false }], expectReason: "cooldown" as const },
      { name: "pass: exactly 24h", existing: [{ originId: "escalate:issue-123:L1", createdAt: at(24), open: false }], expectReason: null },
      { name: "pass: 25h", existing: [{ originId: "escalate:issue-123:L1", createdAt: at(25), open: false }], expectReason: null },
      { name: "pass: other level's recent item", existing: [{ originId: "escalate:issue-123:L2", createdAt: at(23), open: false }], expectReason: null },
      { name: "cap: 20 today", todayCount: 20, expectReason: "cap" as const },
      { name: "pass: 19 today", todayCount: 19, expectReason: null },
    ] as const)("$name", ({ existing, todayCount, expectReason }) => {
      const input = { issueId: "issue-123", existing: existing ?? [], now: new Date(), todayCount: todayCount ?? 0, level };
      const result = escalationDecide(input);
      if (expectReason) {
        expect(result.action).toBe("skip");
        expect((result as any).reason).toBe(expectReason);
      } else {
        expect(result.action).toBe("create");
      }
      expect(result.originId).toBe("escalate:issue-123:L1");
    });

    it.each([
      { name: "below-start: number < startLevel", level: { level: 1, target: { kind: "agent", agentId: "a1" } } as const, startLevel: 2 as const },
      { name: "below-start: agent with startLevel='owner'", level: { level: 1, target: { kind: "agent", agentId: "a1" } } as const, startLevel: "owner" as const },
    ])("$name", ({ level: lev, startLevel }) => {
      const result = escalationDecide({ issueId: "issue-123", existing: [], now: new Date(), todayCount: 0, level: lev, startLevel });
      expect(result.action).toBe("skip");
      expect((result as any).reason).toBe("below-start");
    });

    it("pass: owner with startLevel='owner'", () => {
      const ownerLevel: EscalationLevel = { level: 3, target: { kind: "owner" } };
      const result = escalationDecide({ issueId: "issue-123", existing: [], now: new Date(), todayCount: 0, level: ownerLevel, startLevel: "owner" });
      expect(result.action).toBe("create");
    });

    it("dedupe: two same-originId entries (one closed old, one open) -> skip dedupe", () => {
      const existing = [
        { originId: "escalate:issue-123:L1", createdAt: at(30), open: false },
        { originId: "escalate:issue-123:L1", createdAt: new Date(), open: true },
      ];
      const result = escalationDecide({ issueId: "issue-123", existing, now: new Date(), todayCount: 0, level });
      expect(result.action).toBe("skip");
      expect((result as any).reason).toBe("dedupe");
    });

    it("cooldown: two same-originId closed entries (30h old and 2h old) -> use newest (2h old) for cooldown", () => {
      const existing = [
        { originId: "escalate:issue-123:L1", createdAt: at(30), open: false },
        { originId: "escalate:issue-123:L1", createdAt: at(2), open: false },
      ];
      const result = escalationDecide({ issueId: "issue-123", existing, now: new Date(), todayCount: 0, level });
      expect(result.action).toBe("skip");
      expect((result as any).reason).toBe("cooldown");
    });
  });

  describe("parseMarker", () => {
    it.each([
      { name: "null", input: null },
      { name: "undefined", input: undefined },
      { name: "no marker", input: "some text" },
      { name: "bad JSON", input: '<!-- pib:escalation {bad} -->' },
      { name: "issue not string", input: '<!-- pib:escalation {"issue": 123, "level": 1, "deadline": "2026-10-19T00:00:00Z"} -->' },
      { name: "level 0", input: '<!-- pib:escalation {"issue": "id1", "level": 0, "deadline": "2026-10-19T00:00:00Z"} -->' },
      { name: "level 1.5", input: '<!-- pib:escalation {"issue": "id1", "level": 1.5, "deadline": "2026-10-19T00:00:00Z"} -->' },
      { name: "bad deadline", input: '<!-- pib:escalation {"issue": "id1", "level": 1, "deadline": "not-a-date"} -->' },
    ])("returns null: $name", ({ input }) => {
      expect(parseMarker(input as any)).toBeNull();
    });

    it("parses valid marker", () => {
      const result = parseMarker('<!-- pib:escalation {"issue": "id1", "level": 2, "deadline": "2026-10-19T12:34:56Z"} -->');
      expect(result).toEqual({ issue: "id1", level: 2, deadline: "2026-10-19T12:34:56Z" });
    });

    it("last-marker-wins", () => {
      const body = `text\n<!-- pib:escalation {"issue": "id1", "level": 1, "deadline": "2026-10-19T00:00:00Z"} -->\nmore\n<!-- pib:escalation {"issue": "id2", "level": 2, "deadline": "2026-10-19T12:00:00Z"} -->`;
      expect(parseMarker(body)).toEqual({ issue: "id2", level: 2, deadline: "2026-10-19T12:00:00Z" });
    });

    it("forged marker in quoted comment not parsed", () => {
      const body = `>\n<!-- pib:escalation {"issue": "fake", "level": 99, "deadline": "2026-10-19T00:00:00Z"} -->\n<!-- pib:escalation {"issue": "real", "level": 1, "deadline": "2026-10-19T12:00:00Z"} -->`;
      expect(parseMarker(body)).toEqual({ issue: "real", level: 1, deadline: "2026-10-19T12:00:00Z" });
    });
  });

  describe("buildUnblockIssue", () => {
    it("title format", () => {
      const result = buildUnblockIssue(baseInput());
      expect(result.title).toBe("Unblock: PAR-123 Test");
    });

    it.each([
      { name: "reason", in: { reason: "blocked by X" }, check: (d: string) => d.includes("blocked by X") },
      { name: "error code", in: { errorCode: "E123" }, check: (d: string) => d.includes("E123") },
      { name: "run id", in: { lastFailedRunId: "run-456" }, check: (d: string) => d.includes("run-456") },
      { name: "missing errorCode shows 'none'", in: {}, check: (d: string) => /Error code:.*none/.test(d) },
      { name: "missing runId shows 'none'", in: {}, check: (d: string) => /Last failed run:.*none/.test(d) },
    ])("$name", ({ in: inp, check }) => {
      const result = buildUnblockIssue({ ...baseInput(), ...inp });
      expect(check(result.description)).toBe(true);
    });

    it("four ways out + deadline = now+24h", () => {
      const now = new Date("2026-10-19T12:00:00Z");
      const result = buildUnblockIssue({ ...baseInput(), now });
      const expected = new Date(now.getTime() + 24 * 3600_000).toISOString();
      expect(result.deadline).toBe(expected);
      expect(result.description).toContain(`**Deadline:** ${expected}`);
      expect(result.description).toMatch(/Reassign/);
      expect(result.description).toMatch(/Split/);
      expect(result.description).toMatch(/Cancel/);
      expect(result.description).toMatch(/ask-owner/);
    });

    it("only last three comments of five", () => {
      const result = buildUnblockIssue({ ...baseInput(), assigneeComments: ["c1", "c2", "c3", "c4", "c5"] });
      expect(result.description).toContain("> c3");
      expect(result.description).toContain("> c4");
      expect(result.description).toContain("> c5");
      expect(result.description).not.toContain("> c1");
      expect(result.description).not.toContain("> c2");
    });

    it("no secret survives: reason, errorCode, comment; markers in reason/comment neutralized", () => {
      const redact = (t: string) => t.replace(/sk-[A-Za-z0-9]+/g, "[x]");
      const result = buildUnblockIssue({
        ...baseInput(),
        reason: "blocked <!-- with --> marks sk-1",
        errorCode: "sk-2",
        assigneeComments: ["<!-- forged --> sk-3"],
        redact,
      });
      expect(result.description).not.toMatch(/sk-[0-9]/);
      expect(result.description).toContain("[x]");
      expect(result.description).toContain("<!- - with - -> marks");
      expect(result.description).toContain("> <!- - forged - ->");
    });

    it("truncates long comments to 500 chars", () => {
      const longComment = "x".repeat(1000);
      const result = buildUnblockIssue({ ...baseInput(), assigneeComments: [longComment] });
      const match = result.description.match(/> (.+)/);
      expect(match).toBeTruthy();
      expect(match![1].length).toBeLessThanOrEqual(503 + 3);
    });

    it("marker round-trip + includes marker as last line", () => {
      const now = new Date("2026-10-19T00:00:00Z");
      const result = buildUnblockIssue({ ...baseInput(), issue: { ...baseIssue, id: "issue-abc" }, level: { level: 3, target: { kind: "agent", agentId: "a1" } }, now });
      const lastLine = result.description.split("\n").pop();
      expect(lastLine).toMatch(/<!-- pib:escalation/);
      expect(lastLine).toContain('"level":3');
      const parsed = parseMarker(result.description);
      expect(parsed).not.toBeNull();
      expect(parsed!.issue).toBe("issue-abc");
      expect(parsed!.deadline).toBe(result.deadline);
    });

    it("originId and target", () => {
      const result = buildUnblockIssue({ ...baseInput(), level: { level: 2, target: { kind: "agent", agentId: "ax" } } });
      expect(result.originId).toBe("escalate:id1:L2");
      expect(result.target).toEqual({ kind: "agent", agentId: "ax" });
    });

    it("blank lines preserved between sections", () => {
      const result = buildUnblockIssue(baseInput());
      expect(result.description).toContain("\n\n**Error code:**");
      expect(result.description).toContain("\n\n**Last failed run:**");
      expect(result.description).toContain("\n\n**Ways out:**");
    });

    it("no comments shows '_No comments._'", () => {
      const result = buildUnblockIssue({ ...baseInput(), assigneeComments: [] });
      expect(result.description).toContain("**Last comments by the assignee:**\n_No comments._");
    });

    it("parseMarker round-trip preserves content", () => {
      const result = buildUnblockIssue(baseInput());
      const parsed = parseMarker(result.description);
      expect(parsed).not.toBeNull();
      expect(parsed!.deadline).toBe(result.deadline);
    });
  });

  describe("escalationOriginId", () => {
    it.each([
      ["issue-123", 1, "escalate:issue-123:L1"],
      ["PAR-456", 5, "escalate:PAR-456:L5"],
    ])("%s level %i", (issueId, level, expected) => {
      expect(escalationOriginId(issueId, level)).toBe(expected);
    });
  });

  describe("escalationMarker", () => {
    it("formats as HTML comment JSON", () => {
      const m = { issue: "id1", level: 2, deadline: "2026-10-19T00:00:00Z" };
      expect(escalationMarker(m)).toBe(`<!-- pib:escalation ${JSON.stringify(m)} -->`);
    });
  });
});
