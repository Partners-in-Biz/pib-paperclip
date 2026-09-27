/**
 * People never see rule paths such as `treatment.uifFringeBenefits`: one
 * mapping gives each its plain name, with a readable fallback. Worker texts
 * show dates as "25 Sep 2026".
 */
import { describe, expect, it } from "vitest";
import { readableDate, readableMonth } from "../src/dates.js";
import { RULE_LABELS, ruleLabel, rulesCheckText, withRuleLabels } from "../src/rule-labels.js";
import { UNVERIFIED_2026_27 } from "../src/seed.js";

describe("rule labels", () => {
  it("names each 2026/27 unconfirmed rule in plain words", () => {
    expect(ruleLabel("treatment.uifFringeBenefits")).toBe("UIF on fringe benefits");
    expect(ruleLabel("treatment.uifSdlTravelAllowance")).toBe("UIF and SDL on travel allowances");
    expect(ruleLabel("statutory.it3aReasonCode")).toBe("IT3(a) reason code");
    expect(ruleLabel("leave.annualWorkingDays")).toBe("Annual leave in working days");
    // Every seeded path has its own name (a new one must be added to RULE_LABELS).
    for (const rule of UNVERIFIED_2026_27) expect(RULE_LABELS[rule.path], rule.path).toBeTruthy();
  });

  it("falls back to readable words for a path it does not know, never the raw key", () => {
    expect(ruleLabel("paye.brackets")).toBe("PAYE brackets");
    expect(ruleLabel("treatment.sdlOnBonusPay")).toBe("SDL on bonus pay");
    expect(ruleLabel("statutory.emp201DueDay")).toBe("EMP201 due day");
    expect(ruleLabel("eti.minimumWageHourlyMinor")).toBe("Minimum wage hourly minor");
    expect(ruleLabel("retirement")).toBe("Retirement");
    for (const path of ["", "  ", ".", null, undefined]) expect(ruleLabel(path)).toBe("A payroll rule");
    for (const path of ["treatment.newThing", "statutory.x_y", "a.b.cDe"]) {
      const label = ruleLabel(path);
      expect(label).not.toContain(".");
      expect(label).not.toMatch(/[a-z][A-Z]/);
    }
  });

  it("adds the label to each rule and words the check the same everywhere", () => {
    expect(withRuleLabels([{ path: "statutory.it3aReasonCode", note: "n" }])).toEqual([{ path: "statutory.it3aReasonCode", note: "n", label: "IT3(a) reason code" }]);
    expect(rulesCheckText(4)).toBe("4 tax rules need your accountant's check");
    expect(rulesCheckText(1)).toBe("1 tax rule needs your accountant's check");
  });
});

describe("readable dates in worker texts", () => {
  it("shows days and months as words, never ISO", () => {
    expect(readableDate("2026-09-25")).toBe("25 Sep 2026");
    expect(readableDate("2026-10-07T00:00:00.000Z")).toBe("7 Oct 2026");
    expect(readableDate("2026-09")).toBe("Sep 2026");
    expect(readableMonth("2026-09")).toBe("Sep 2026");
    expect(readableMonth("2027-02-28")).toBe("Feb 2027");
    for (const bad of [null, undefined, "", "soon", "2026-13-01"]) {
      expect(readableDate(bad)).toBe("–");
      expect(readableMonth(bad)).toBe("–");
    }
  });
});
