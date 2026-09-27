import { describe, expect, it } from "vitest";
import { setupLeftLabel, setupSummary } from "../src/setup.js";

const item = (key: string, required: boolean, status: "done" | "missing" | "optional" | "blocked") => ({ key, title: key, required, status });

describe("setup summary (one count everywhere)", () => {
  it("counts required steps left, skips switched-off modules, keeps optional apart", () => {
    const statuses = [
      { module: "crm" as const, items: [item("a", true, "done"), item("b", true, "missing"), item("c", false, "optional")] },
      { module: "payroll" as const, items: [item("d", true, "missing")] },
      { module: null, items: [item("e", true, "blocked")] },
    ];
    expect(setupSummary(statuses)).toEqual({ requiredDone: 1, requiredTotal: 4, requiredLeft: 3, optionalLeft: 1 });
    expect(setupSummary(statuses, { payroll: false })).toEqual({ requiredDone: 1, requiredTotal: 3, requiredLeft: 2, optionalLeft: 1 });
  });

  it("words it the same way", () => {
    expect(setupLeftLabel(0)).toBe("Setup done");
    expect(setupLeftLabel(1)).toBe("1 step left");
    expect(setupLeftLabel(16)).toBe("16 steps left");
  });
});
