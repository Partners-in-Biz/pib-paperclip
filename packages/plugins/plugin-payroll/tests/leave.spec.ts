/**
 * BCEA leave (sections 20, 22 and 27): annual 21 consecutive days a cycle
 * (days per week × 3 working days, accrued monthly), sick 6 weeks' working
 * days per 36 months with 1 day per 26 worked in the first 6 months, family
 * responsibility 3 days a year after 4 months for 4+ days a week.
 */
import { describe, expect, it } from "vitest";
import { checkLeaveRequest, completedMonths, cycleContaining, leaveBalances, paidLeaveHoursInPeriod, unpaidLeaveHoursInPeriod, workingDaysBetween, type LeaveRequestLike } from "../src/leave.js";

const find = (list: ReturnType<typeof leaveBalances>, type: string) => list.find((b) => b.type === type)!;

describe("dates", () => {
  it("counts completed months and working days", () => {
    expect(completedMonths("2026-01-15", "2026-03-13")).toBe(1);
    expect(completedMonths("2026-01-15", "2026-03-14")).toBe(2);
    expect(completedMonths("2026-01-15", "2026-03-15")).toBe(2);
    expect(completedMonths("2026-01-31", "2026-02-28")).toBe(1);
    // 1–30 September 2026: 22 weekdays
    expect(workingDaysBetween("2026-09-01", "2026-09-30")).toBe(22);
    expect(workingDaysBetween("2026-09-01", "2026-09-30", 6)).toBe(26);
    expect(cycleContaining("2025-03-10", "2026-09-01", 12)).toEqual({ start: "2026-03-10", end: "2027-03-09" });
  });
});

describe("annual leave", () => {
  it("accrues 15 days a year for a 5-day week (1.25 a month)", () => {
    const b = leaveBalances({ employmentStart: "2026-01-01", asOf: "2026-09-30", daysPerWeek: 5, requests: [] });
    expect(find(b, "annual").entitlementCenti).toBe(1125); // 9 months × 1.25
  });

  it("uses a more generous company policy and deducts approved leave", () => {
    const requests: LeaveRequestLike[] = [
      { id: "1", type: "annual", status: "approved", startDate: "2026-04-01", endDate: "2026-04-03", daysCenti: 300 },
      { id: "2", type: "annual", status: "pending", startDate: "2026-12-21", endDate: "2026-12-24", daysCenti: 400 },
      { id: "3", type: "annual", status: "rejected", startDate: "2026-05-01", endDate: "2026-05-01", daysCenti: 100 },
    ];
    const annual = find(leaveBalances({ employmentStart: "2025-09-01", asOf: "2026-09-01", daysPerWeek: 5, annualDaysPerYear: 20, requests }), "annual");
    expect(annual.entitlementCenti).toBe(2000);
    expect(annual.takenCenti).toBe(300);
    expect(annual.pendingCenti).toBe(400);
    expect(annual.balanceCenti).toBe(1700);
    expect(checkLeaveRequest(annual, "annual", 1400)).toMatch(/Only 13/);
    expect(checkLeaveRequest(annual, "annual", 1300)).toBeNull();
  });

  it("starts from an opening balance", () => {
    const annual = find(leaveBalances({ employmentStart: "2020-01-01", asOf: "2026-06-30", daysPerWeek: 5, requests: [], openings: [{ type: "annual", daysCenti: 800, asOf: "2026-03-31" }] }), "annual");
    // 8 days on 31 March + 3 months × 1.25
    expect(annual.balanceCenti).toBe(800 + 375);
  });
});

describe("sick leave", () => {
  it("gives 1 day per 26 worked in the first 6 months", () => {
    // 1 July – 30 September 2026 = 66 weekdays → 2.53 days
    const sick = find(leaveBalances({ employmentStart: "2026-07-01", asOf: "2026-09-30", daysPerWeek: 5, requests: [] }), "sick");
    expect(sick.entitlementCenti).toBe(253);
  });

  it("gives 30 days per 36-month cycle for a 5-day week afterwards", () => {
    const requests: LeaveRequestLike[] = [
      { id: "s1", type: "sick", status: "approved", startDate: "2025-02-03", endDate: "2025-02-04", daysCenti: 200 },
      { id: "s2", type: "sick", status: "approved", startDate: "2022-06-01", endDate: "2022-06-10", daysCenti: 800 },
    ];
    const sick = find(leaveBalances({ employmentStart: "2023-01-01", asOf: "2026-09-30", daysPerWeek: 5, requests }), "sick");
    // Cycle 2026-01-01 … 2028-12-31: both requests fall in earlier cycles.
    expect(sick.cycleStart).toBe("2026-01-01");
    expect(sick.entitlementCenti).toBe(3000);
    expect(sick.balanceCenti).toBe(3000);
    const six = find(leaveBalances({ employmentStart: "2023-01-01", asOf: "2024-06-30", daysPerWeek: 6, requests }), "sick");
    expect(six.entitlementCenti).toBe(3600);
    expect(six.balanceCenti).toBe(3400);
  });
});

describe("family responsibility leave", () => {
  it("applies after 4 months for 4 or more days a week", () => {
    expect(find(leaveBalances({ employmentStart: "2026-07-01", asOf: "2026-10-30", daysPerWeek: 5, requests: [] }), "family").entitlementCenti).toBe(0);
    expect(find(leaveBalances({ employmentStart: "2026-06-01", asOf: "2026-10-01", daysPerWeek: 5, requests: [] }), "family").entitlementCenti).toBe(300);
    expect(find(leaveBalances({ employmentStart: "2025-01-01", asOf: "2026-10-01", daysPerWeek: 3, requests: [] }), "family").entitlementCenti).toBe(0);
  });
});

describe("unpaid leave in a pay run", () => {
  it("counts approved unpaid days inside the period, splitting a request across periods", () => {
    const requests: LeaveRequestLike[] = [
      { id: "u1", type: "unpaid", status: "approved", startDate: "2026-09-28", endDate: "2026-10-02", daysCenti: 500 },
      { id: "u2", type: "unpaid", status: "pending", startDate: "2026-09-10", endDate: "2026-09-10", daysCenti: 100 },
      { id: "a1", type: "annual", status: "approved", startDate: "2026-09-14", endDate: "2026-09-14", daysCenti: 100 },
    ];
    // 28–30 September are 3 of the 5 working days; 8 hours a day → 24 hours
    expect(unpaidLeaveHoursInPeriod(requests, "2026-09-01", "2026-09-30", 800)).toBe(2400);
    expect(unpaidLeaveHoursInPeriod(requests, "2026-10-01", "2026-10-31", 800)).toBe(1600);
    // Approved annual leave is paid leave for hourly staff: 1 day × 8 hours
    expect(paidLeaveHoursInPeriod(requests, "2026-09-01", "2026-09-30", 800)).toBe(800);
  });
});
