import { describe, expect, it } from "vitest";
import { improvementBrief, improvementVerdict, isDue, isOverdue, OVERDUE_GRACE_DAYS, parseImprovementInput, type ImprovementRow } from "../src/improvements-model.js";
import { kpiNumber, metricBetter, parseMetricKey } from "../src/metrics-keys.js";

describe("the improvement verdict", () => {
  const v = (input: Partial<Parameters<typeof improvementVerdict>[0]>) => improvementVerdict({ direction: "lower", baseline: 20, target: null, result: 10, label: "Failure rate", ...input });

  it("lower is better: a fall is improved, a rise is worse, a small wobble is no change", () => {
    expect(v({ result: 10 })).toEqual({ outcome: "improved", detail: "Failure rate went from 20 to 10: improved." });
    expect(v({ result: 30 }).outcome).toBe("worse");
    expect(v({ result: 20.9 }).outcome).toBe("no_change"); // under 5% of the baseline
    expect(v({ result: 19.1 }).outcome).toBe("no_change");
    expect(v({ result: 18.9 }).outcome).toBe("improved");
  });

  it("higher is better flips it", () => {
    expect(v({ direction: "higher", baseline: 40, result: 60 }).outcome).toBe("improved");
    expect(v({ direction: "higher", baseline: 40, result: 30 }).outcome).toBe("worse");
  });

  it("reaching the target is improved, however small the move", () => {
    const r = v({ baseline: 10.2, result: 10, target: 10 });
    expect(r.outcome).toBe("improved");
    expect(r.detail).toBe("Failure rate went from 10.2 to 10 (target 10, reached): improved.");
    expect(v({ baseline: 20, result: 15, target: 10 }).detail).toContain("(target 10)");
  });

  it("says inconclusive, with why, when it cannot compare", () => {
    expect(v({ result: null }).detail).toBe("Failure rate could not be measured at the re-check, so nothing can be said.");
    expect(v({ baseline: null })).toMatchObject({ outcome: "inconclusive" });
    expect(v({ baseline: null }).detail).toContain("no baseline was recorded");
  });

  it("copes with a zero baseline", () => {
    expect(v({ baseline: 0, result: 0 }).outcome).toBe("no_change");
    expect(v({ baseline: 0, result: 3 }).outcome).toBe("worse");
    expect(v({ baseline: 0, result: 3, direction: "higher" }).outcome).toBe("improved");
  });

  it("uses a plain name when there is no label", () => {
    expect(improvementVerdict({ direction: "lower", baseline: 5, target: null, result: 1 }).detail).toBe("the number went from 5 to 1: improved.");
  });
});

describe("open, due and overdue", () => {
  const now = new Date("2026-10-10T00:00:00.000Z");
  const row = (recheckAt: string, status: ImprovementRow["status"] = "open") => ({ recheckAt, status });

  it("is due on its date and overdue three days after", () => {
    expect(isDue(row("2026-10-10T00:00:00.000Z"), now)).toBe(true);
    expect(isDue(row("2026-10-11T00:00:00.000Z"), now)).toBe(false);
    expect(isOverdue(row("2026-10-08T00:00:00.000Z"), now)).toBe(false);
    expect(isOverdue(row(new Date(now.getTime() - (OVERDUE_GRACE_DAYS * 86_400_000 + 1)).toISOString()), now)).toBe(true);
    expect(isOverdue(row("2026-09-01T00:00:00.000Z", "resolved"), now)).toBe(false);
    expect(isDue(row("2026-09-01T00:00:00.000Z", "dropped"), now)).toBe(false);
  });

  it("prints a row short, with the overdue days or the verdict", () => {
    const base: ImprovementRow = {
      id: "imp1", companyId: "c", title: "Fold X into the SEO skill", kind: "skill", targetRef: "pib-seo", summary: null, ownerAgentId: "agent-1", ownerUserId: null,
      metricKey: "company:fail_rate", metricLabel: "Run failure rate", direction: "lower", baselineValue: 30, baselineAt: "2026-09-26T00:00:00.000Z", targetValue: 10, recheckAt: "2026-10-01T00:00:00.000Z",
      status: "open", outcome: null, resultValue: null, measuredAt: null, resultNote: null, sourceRef: null, sourceIssueId: null, createdAt: "", updatedAt: "", resolvedAt: null,
    };
    expect(improvementBrief(base, now)).toMatchObject({ id: "imp1", metric: "company:fail_rate", baseline: 30, goal: 10, recheckAt: "2026-10-01", overdueDays: 9, owner: "agent-1" });
    expect(improvementBrief({ ...base, recheckAt: "2026-10-10T00:00:00.000Z" }, now)).toMatchObject({ due: true });
    expect(improvementBrief({ ...base, status: "resolved", outcome: "improved", resultValue: 9, resultNote: "x", measuredAt: "2026-10-09T00:00:00.000Z" }, now)).toMatchObject({ outcome: "improved", result: 9, measuredAt: "2026-10-09" });
  });
});

describe("what an agent may send to improvement-propose", () => {
  const now = new Date("2026-10-03T12:00:00.000Z");
  const base = { title: "Tighten the Developer skill", metricKey: "company:fail_rate" };

  it("fills the defaults: system kind, 14 days, trimmed text", () => {
    const input = parseImprovementInput({ ...base, title: "  Tighten   the Developer skill  " }, now);
    expect(input).toMatchObject({ title: "Tighten the Developer skill", kind: "system", recheckAt: "2026-10-17T12:00:00.000Z", baselineValue: null, targetValue: null, direction: null });
  });

  it("takes a date or a number of days, never past or more than 120 days out", () => {
    expect(parseImprovementInput({ ...base, recheckAt: "2026-11-01" }, now).recheckAt).toBe("2026-11-01T00:00:00.000Z");
    expect(parseImprovementInput({ ...base, recheckInDays: 30 }, now).recheckAt).toBe("2026-11-02T12:00:00.000Z");
    expect(() => parseImprovementInput({ ...base, recheckAt: "2027-06-01" }, now)).toThrow("more than 120 days away");
    expect(() => parseImprovementInput({ ...base, recheckAt: "soon" }, now)).toThrow("must be a date");
    expect(() => parseImprovementInput({ ...base, baselineValue: "lots" }, now)).toThrow("baselineValue must be a number");
  });
});

describe("metric keys", () => {
  it("parses the four kinds and nothing else", () => {
    expect(parseMetricKey("manual")).toEqual({ kind: "manual" });
    expect(parseMetricKey("company:fail_rate")).toEqual({ kind: "company", metric: "fail_rate" });
    expect(parseMetricKey("agent:aaaaaaaa-0000-4000-8000-000000000001:p90_sec")).toEqual({ kind: "agent", agentId: "aaaaaaaa-0000-4000-8000-000000000001", metric: "p90_sec" });
    expect(parseMetricKey("kpi:partnersinbiz.crm:new_leads_week")).toEqual({ kind: "kpi", plugin: "partnersinbiz.crm", kpi: "new_leads_week" });
    for (const bad of ["", "company:", "company:nothing", "agent:short:fail_rate", "agent:aaaaaaaa-0000-4000-8000-000000000001:nope", "kpi:crm", "kpi:../x:y", "sql;drop"]) expect(parseMetricKey(bad), bad).toBeNull();
  });

  it("knows which way is better for the built-in metrics only", () => {
    expect(metricBetter(parseMetricKey("company:review_coverage")!)).toBe("higher");
    expect(metricBetter(parseMetricKey("company:fail_rate")!)).toBe("lower");
    expect(metricBetter(parseMetricKey("manual")!)).toBeNull();
    expect(metricBetter(parseMetricKey("kpi:partnersinbiz.crm:new_leads_week")!)).toBeNull();
  });

  it("reads a module's money KPI in whole units and a count as it is", () => {
    expect(kpiNumber({ raw: 1_240_000, value: "R 12,400.00" })).toBe(12_400);
    expect(kpiNumber({ raw: 1500, value: "$15.00" })).toBe(15);
    expect(kpiNumber({ raw: 7, value: "7" })).toBe(7);
    expect(kpiNumber({ raw: 12, value: "12 leads" })).toBe(12);
    expect(kpiNumber({ raw: null, value: "–" })).toBeNull();
  });
});
