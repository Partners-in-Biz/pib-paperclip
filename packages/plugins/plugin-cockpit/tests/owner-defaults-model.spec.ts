import { describe, it, expect } from "vitest";
import {
  evaluate, minHoursFloor, pinDeadline, textTripsScreen, POLICY_CLASSES, DEFAULT_MIN_HOURS,
  type OwnerDefaultsPolicy, type PolicyAsk,
} from "../src/owner-defaults-model.js";

const policy: OwnerDefaultsPolicy = {
  enabled: true, name: "c", rootIssueIds: ["root-1"],
  classes: POLICY_CLASSES.slice() as any, minHours: null,
};
const ask: PolicyAsk = {
  key: "k", issueId: "c9", kind: "decision", question: "?",
  options: ["A", "B"], recommended: "A", policyClass: "engineering-decision",
  defaultAfterHours: 24, effect: null, askedAt: "2026-10-20T00:00:00Z", deadlineAt: null,
};

describe("minHoursFloor", () => {
  it.each([
    [6, undefined, 6],
    [null, 8, 8],
    [0, 8, 8],
    [null, null, DEFAULT_MIN_HOURS],
  ])("p=%s c=%s => %s", (p, c, x) => {
    const pol = p !== null ? ({ minHours: p } as any) : null;
    const cfg = c !== undefined ? { minHours: c } : undefined;
    expect(minHoursFloor(pol, cfg)).toBe(x);
  });
});

describe("pinDeadline", () => {
  it.each([
    ["existing", "2026-10-25T00:00:00Z", "2026-10-20T00:00:00Z", 24, "2026-10-25T00:00:00Z"],
    ["computed", null, "2026-10-20T00:00:00Z", 24, "2026-10-21T00:00:00.000Z"],
    ["0.05h", null, "2026-10-20T00:00:00Z", 0.05, "2026-10-20T00:03:00.000Z"],
    ["bad", null, "x", 24, null],
  ])("%s", (_, e, a, h, x) => expect(pinDeadline(e, a, h)).toBe(x));
});

describe("textTripsScreen", () => {
  it.each([
    ["credential", true], ["key", true], ["login", true], ["password", true],
    ["secret", true], ["token", true], ["payment", true], ["invoice", true],
    ["money", true], ["legal", true], ["contract", true], ["bank", true],
    ["refund", true], ["client-send", true], ["send to the client", true],
    ["email to client", true], ["normal", false],
  ])("%s => %b", (t, exp) => expect(textTripsScreen(t)).toBe(exp));
});

describe("evaluate", () => {
  const now = new Date("2026-10-21T01:00:00Z");
  const roots = ["c9", "root-1"];

  it.each([
    ["past", "2026-10-21T01:00:00Z", "apply"],
    ["before", "2026-10-20T12:00:00Z", "wait"],
  ])("%s => %s", (_, n, exp) => {
    const result = evaluate({ ask, policy, now: new Date(n), rootsOfIssue: roots });
    expect(result.action).toBe(exp);
  });

  it.each([
    [null, ask, roots, "policy null"],
    [{ ...policy, enabled: false }, ask, roots, "disabled"],
    [policy, { ...ask, effect: { x: 1 } }, roots, "effect"],
    [policy, { ...ask, kind: "grant" }, roots, "kind"],
    [policy, { ...ask, policyClass: "unknown" }, roots, "class"],
    [policy, ask, ["other"], "scope"],
    [policy, { ...ask, recommended: "C" }, roots, "rec"],
    [policy, { ...ask, question: "login?" }, roots, "text"],
    [policy, { ...ask, defaultAfterHours: 1 }, roots, "hours"],
  ])("escalate: %s", (p: any, a: any, r: any, desc: string) => {
    const result = evaluate({ ask: a, policy: p, now, rootsOfIssue: r });
    expect(result.action).toBe("escalate");
  });

  it("minHours floor respected", () => {
    const a = { ...ask, defaultAfterHours: 6 };
    const result = evaluate({ ask: a, policy, now, rootsOfIssue: roots, config: { minHours: 8 } });
    expect(result.action).toBe("escalate");
  });

  it("no mutate frozen", () => {
    const frozen = Object.freeze({ ask: Object.freeze(ask), policy: Object.freeze(policy), now, rootsOfIssue: Object.freeze(roots) });
    expect(() => evaluate(frozen)).not.toThrow();
  });

  it("stored deadline wins", () => {
    const a = { ...ask, deadlineAt: "2026-10-20T20:00:00Z" };
    const result = evaluate({ ask: a, policy, now, rootsOfIssue: roots });
    expect(result.action).toBe("apply");
    expect((result as any).deadlineAt).toBe("2026-10-20T20:00:00Z");
  });
  it("escalates when now is NaN, even with valid past-deadline ask", () => {
    const result = evaluate({ ask, policy, now: new Date(NaN), rootsOfIssue: roots });
    expect(result.action).toBe("escalate");
    expect(result.reason).toBe("Invalid deadline or clock");
  });

  it("escalates when ask.askedAt is invalid and no stored deadlineAt", () => {
    const a = { ...ask, askedAt: "not-a-date", deadlineAt: null };
    const result = evaluate({ ask: a, policy, now, rootsOfIssue: roots });
    expect(result.action).toBe("escalate");
    expect(result.reason).toBe("Invalid deadline calculation");
  });
});
