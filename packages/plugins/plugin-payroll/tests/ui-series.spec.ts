import { describe, expect, it } from "vitest";
import { costPerRun, costSplit, daysUntil, emp201Month, leaveUsed, runTone, statusTone, type RunLite } from "../src/ui/series.js";

const totals = { employeeCount: 2, grossMinor: 3_600_000, payeMinor: 468_100, uifEmployeeMinor: 23_712, uifEmployerMinor: 23_712, sdlMinor: 36_000, deductionsMinor: 0, employerContributionsMinor: 10_000, netPayMinor: 3_108_188, employerCostMinor: 3_669_712 };
const run = (id: string, payDate: string, status = "locked", kind = "regular"): RunLite => ({ id, number: `PR-${id}`, kind, status, payDate, totals });

describe("payroll UI series", () => {
  it("tones run and other statuses", () => {
    expect(["locked", "pending_approval", "calculated", "cancelled", "reversed"].map(runTone)).toEqual(["ok", "warn", "info", "neutral", "neutral"]);
    expect(["approved", "pending", "rejected", "ready", "cancelled"].map(statusTone)).toEqual(["ok", "warn", "bad", "info", "neutral"]);
  });

  it("charts locked regular runs oldest first, parts adding up to the cost to company", () => {
    const rows = costPerRun([run("c", "2026-09-25"), run("a", "2026-07-25"), run("x", "2026-08-25", "calculated"), run("r", "2026-08-26", "locked", "reversal"), run("b", "2026-08-25")], 2);
    expect(rows.map((r) => r.id)).toEqual(["b", "c"]);
    expect(rows[1]).toMatchObject({ label: "Sep", title: "PR-c · paid 25 Sep 2026", employeeCount: 2 });
    const v = rows[1]!.values;
    expect(v.net + v.tax + v.deductions + v.employer).toBe(totals.employerCostMinor);
    expect(v).toEqual({ net: 3_108_188, tax: 491_812, deductions: 0, employer: 69_712 });
  });

  it("splits one run's cost and drops empty parts", () => {
    expect(costSplit(totals).map((s) => s.key)).toEqual(["net", "paye", "uif", "sdl", "employer"]);
    expect(costSplit(totals).find((s) => s.key === "uif")!.value).toBe(47_424);
  });

  it("picks the EMP201 month and counts days to its due date", () => {
    expect(emp201Month("2026-09-26")).toBe("2026-09");
    expect(emp201Month("2026-10-05")).toBe("2026-09");
    expect(emp201Month("2026-01-03")).toBe("2025-12");
    expect(daysUntil("2026-09-26", "2026-10-07")).toBe(11);
    expect(daysUntil("2026-10-09", "2026-10-07")).toBe(-2);
  });

  it("measures leave used against the entitlement", () => {
    expect(leaveUsed({ balanceCenti: 1_500, takenCenti: 600, pendingCenti: 200 })).toEqual({ ratio: 800 / 2_100, entitlementCenti: 2_100 });
    expect(leaveUsed({ balanceCenti: 0, takenCenti: 0, pendingCenti: 0 })).toEqual({ ratio: 0, entitlementCenti: 0 });
  });
});
