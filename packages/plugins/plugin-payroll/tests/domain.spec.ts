import { describe, expect, it } from "vitest";
import {
  assertApproverAllowed,
  assertCanAdjust,
  assertCanApprove,
  assertCanCalculate,
  assertCanCancel,
  assertCanLock,
  assertCanRequestApproval,
  assertCanReverse,
  assertPeriod,
  defaultPeriod,
  runNumber,
  sdlApplies,
  variances,
  type RunState,
} from "../src/domain.js";

const run = (patch: Partial<RunState> = {}): RunState => ({
  status: "calculated",
  kind: "regular",
  preparedByUserId: "user-a",
  preparedByAgentId: null,
  approverUserId: null,
  ...patch,
});
const user = (userId: string) => ({ kind: "user" as const, userId, agentId: null });
const agent = { kind: "agent" as const, userId: null, agentId: "agent-1" };

describe("separation of duties", () => {
  it("refuses the preparer as approver", () => {
    expect(() => assertApproverAllowed(run(), "user-a")).toThrow(/prepared the pay run cannot approve/);
    expect(() => assertApproverAllowed(run(), null)).toThrow(/Choose a board member/);
    expect(assertApproverAllowed(run(), "user-b")).toBe("user-b");
    // An agent-prepared run can go to any board member.
    expect(assertApproverAllowed(run({ preparedByUserId: null, preparedByAgentId: "agent-1" }), "user-a")).toBe("user-a");
  });

  it("only lets a board member who did not prepare it approve, and only the named approver", () => {
    const pending = run({ status: "pending_approval", approverUserId: "user-b" });
    expect(() => assertCanApprove(pending, user("user-a"))).toThrow(/someone else must approve/);
    expect(() => assertCanApprove(pending, agent)).toThrow(/Only a board member/);
    expect(() => assertCanApprove(pending, { kind: "system", userId: null, agentId: null })).toThrow(/Only a board member/);
    expect(() => assertCanApprove(pending, user("user-c"))).toThrow(/different approver/);
    expect(assertCanApprove(pending, user("user-b"))).toBe("user-b");
    expect(() => assertCanApprove(run({ status: "calculated" }), user("user-b"))).toThrow(/not waiting/);
    expect(() => assertCanApprove(run({ status: "approved" }), user("user-b"))).toThrow(/already approved/);
  });

  it("locks only approved runs, by a board member", () => {
    expect(() => assertCanLock(run({ status: "pending_approval" }), user("user-b"))).toThrow(/Only an approved/);
    expect(() => assertCanLock(run({ status: "approved" }), agent)).toThrow(/board member/);
    expect(() => assertCanLock(run({ status: "locked" }), user("user-b"))).toThrow(/already locked/);
    expect(() => assertCanLock(run({ status: "approved" }), user("user-a"))).not.toThrow();
  });
});

describe("pay run status machine", () => {
  it("recalculates and adjusts only before approval", () => {
    for (const status of ["draft", "calculated", "pending_approval"] as const) {
      expect(() => assertCanCalculate(run({ status }))).not.toThrow();
      expect(() => assertCanAdjust(run({ status }))).not.toThrow();
      expect(() => assertCanCancel(run({ status }))).not.toThrow();
    }
    for (const status of ["approved", "locked", "reversed", "cancelled"] as const) {
      expect(() => assertCanCalculate(run({ status }))).toThrow();
      expect(() => assertCanAdjust(run({ status }))).toThrow();
      expect(() => assertCanCancel(run({ status }))).toThrow();
    }
    expect(() => assertCanCalculate(run({ kind: "reversal" }))).toThrow(/reversal/);
  });

  it("needs a clean calculation before asking for approval", () => {
    expect(() => assertCanRequestApproval(run({ status: "draft" }), 1, 0)).toThrow(/Calculate/);
    expect(() => assertCanRequestApproval(run(), 0, 0)).toThrow(/no employees/);
    expect(() => assertCanRequestApproval(run(), 3, 1)).toThrow(/errors/);
    expect(() => assertCanRequestApproval(run(), 3, 0)).not.toThrow();
  });

  it("reverses a locked run once", () => {
    expect(() => assertCanReverse({ ...run({ status: "locked" }), reversedByRunId: null })).not.toThrow();
    expect(() => assertCanReverse({ ...run({ status: "locked" }), reversedByRunId: "rv" })).toThrow(/already has a reversal/);
    expect(() => assertCanReverse({ ...run({ status: "approved" }) })).toThrow(/Only a locked/);
    expect(() => assertCanReverse({ ...run({ status: "locked", kind: "reversal" }) })).toThrow(/cannot be reversed/);
  });
});

describe("numbering and periods", () => {
  it("numbers runs by pay month, frequency and kind", () => {
    expect(runNumber("2026-09-25", "monthly", 1)).toBe("PR-2026-09-M01");
    expect(runNumber("2026-09-11", "weekly", 12)).toBe("PR-2026-09-W12");
    expect(runNumber("2026-10-02", "fortnightly", 2, "reversal")).toBe("RV-2026-10-F02");
    expect(runNumber("2026-10-25", "monthly", 1, "correction")).toBe("PC-2026-10-M01");
  });

  it("defaults the month and moves a weekend pay day back to Friday", () => {
    expect(defaultPeriod("monthly", "2026-09-20", 25)).toEqual({ periodStart: "2026-09-01", periodEnd: "2026-09-30", payDate: "2026-09-25" });
    // 25 October 2026 is a Sunday → Friday 23 October
    expect(defaultPeriod("monthly", "2026-10-03", 25).payDate).toBe("2026-10-23");
    // Pay day 31 in a 30-day month → last day (30 September 2026 is a Wednesday)
    expect(defaultPeriod("monthly", "2026-09-01", 31).payDate).toBe("2026-09-30");
    // Weekly: the 7 days ending on the coming Friday
    expect(defaultPeriod("weekly", "2026-09-22", 25)).toEqual({ periodStart: "2026-09-19", periodEnd: "2026-09-25", payDate: "2026-09-25" });
  });

  it("checks period dates", () => {
    expect(() => assertPeriod("2026-09-30", "2026-09-01", "2026-09-25")).toThrow(/ends before/);
    expect(() => assertPeriod("2026-08-01", "2026-09-30", "2026-09-25")).toThrow(/at most one month/);
    expect(() => assertPeriod("2026-09-01", "2026-09-30", "25 Sept")).toThrow(/pay date/);
  });
});

describe("SDL applicability", () => {
  it("charges SDL in auto mode only above R500 000 a year", () => {
    expect(sdlApplies("auto", 50_000_000, 50_000_000)).toBe(false);
    expect(sdlApplies("auto", 50_000_001, 50_000_000)).toBe(true);
    expect(sdlApplies("registered", 0, 50_000_000)).toBe(true);
    expect(sdlApplies("exempt", 900_000_000, 50_000_000)).toBe(false);
  });
});

describe("variances", () => {
  it("flags changes of 10% or more, new and missing staff", () => {
    const prev = [
      { employeeId: "a", name: "A", grossMinor: 1_000_000, netMinor: 800_000, payeMinor: 100_000 },
      { employeeId: "b", name: "B", grossMinor: 2_000_000, netMinor: 1_500_000, payeMinor: 300_000 },
      { employeeId: "gone", name: "Gone", grossMinor: 1, netMinor: 1, payeMinor: 0 },
    ];
    const current = [
      { employeeId: "a", name: "A", grossMinor: 1_050_000, netMinor: 830_000, payeMinor: 115_000 },
      { employeeId: "b", name: "B", grossMinor: 2_000_000, netMinor: 1_500_000, payeMinor: 300_000 },
      { employeeId: "new", name: "New", grossMinor: 1, netMinor: 1, payeMinor: 0 },
    ];
    const result = variances(current, prev);
    expect(result.changes).toEqual([{ employeeId: "a", name: "A", field: "paye", previousMinor: 100_000, currentMinor: 115_000, changeMinor: 15_000, changeBp: 1_500 }]);
    expect(result.added).toEqual(["New"]);
    expect(result.missing).toEqual(["Gone"]);
  });
});
