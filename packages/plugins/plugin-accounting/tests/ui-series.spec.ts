import { describe, expect, it } from "vitest";
import { changeText, monthLabel, vatCountdown } from "../src/ui/series.js";

describe("accounting UI series", () => {
  it("labels months and describes changes", () => {
    expect(monthLabel("2026-02")).toEqual({ label: "Feb", title: "Feb 2026" });
    const fmt = (m: number) => `R ${m / 100}`;
    expect(changeText(15_000, 10_000, fmt)).toBe("+R 50 vs last month");
    expect(changeText(5_000, 10_000, fmt)).toBe("−R 50 vs last month");
    expect(changeText(5_000, 5_000, fmt)).toBeNull();
    expect(changeText(5_000, undefined, fmt)).toBeNull();
  });

  it("counts down to the VAT201 due date", () => {
    const period = { start: "2026-09-01", end: "2026-10-31", dueDate: "2026-11-30" };
    expect(vatCountdown(period, "2026-09-26")).toMatchObject({ daysLeft: 65, tone: "info", text: "Due in 65 days" });
    expect(vatCountdown(period, "2026-11-20")).toMatchObject({ daysLeft: 10, tone: "warn" });
    expect(vatCountdown(period, "2026-11-05")).toMatchObject({ daysLeft: 25, tone: "ok" });
    expect(vatCountdown(period, "2026-11-30")).toMatchObject({ daysLeft: 0, text: "Due today", elapsed: 1 });
    expect(vatCountdown(period, "2026-12-02")).toMatchObject({ daysLeft: -2, tone: "bad", text: "2 days late" });
  });
});
