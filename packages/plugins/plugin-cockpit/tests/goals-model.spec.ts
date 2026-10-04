import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { askCardProblems } from "@partnersinbiz/pib-plugin-kit";
import { METRIC_KEY_HELP, parseMetricKey } from "../src/metrics-keys.js";
import { ACTIVATE_GOALS_EFFECT, businessReviewContent, GOALS_MAX_ACTIVE, GoalError, goalBrief, goalProgress, goalsAskCard, parseGoalInput, type GoalRow } from "../src/goals-model.js";

const goal = (extra: Partial<GoalRow> = {}): GoalRow => ({
  id: "goal000000000001", companyId: "c", title: "30 new leads a week", description: null, metricKey: "kpi:partnersinbiz.crm:new_leads_week", metricLabel: "New leads this week", unit: "leads", direction: "higher",
  targetValue: 30, baselineValue: 10, period: "week", dueOn: null, status: "active", hostGoalId: null, ownerAgentId: "op", lastValue: null, lastValueAt: null, proposedByAgentId: "op", confirmedByUserId: null,
  confirmedAt: null, createdAt: "", updatedAt: "", ...extra,
});

describe("what an agent may send to goal-set", () => {
  const base = { title: "30 new leads a week", metricKey: "kpi:partnersinbiz.crm:new_leads_week", targetValue: 30 };

  it("a new goal needs a title, a metric and a number, and says what to pass", () => {
    expect(parseGoalInput(base)).toMatchObject({ id: null, title: "30 new leads a week", targetValue: 30, period: null, drop: false, value: null });
    expect(() => parseGoalInput({ metricKey: base.metricKey, targetValue: 3 })).toThrow("title is required for a new goal");
    expect(() => parseGoalInput({ title: "x", targetValue: 3 })).toThrow("metricKey is required");
    expect(() => parseGoalInput({ title: "x", metricKey: "manual" })).toThrow("targetValue is required");
    expect(() => parseGoalInput({ ...base, metricKey: "kpi:nothing" })).toThrow("is not a metric key");
    expect(() => parseGoalInput({ ...base, targetValue: "lots" })).toThrow("targetValue must be a number");
    expect(() => parseGoalInput({ ...base, period: "decade" })).toThrow("period must be one of week, month, quarter, year");
    expect(() => parseGoalInput({ ...base, direction: "up" })).toThrow("direction must be lower or higher");
    expect(() => parseGoalInput({ ...base, dueOn: "soon" })).toThrow("dueOn must be a date as YYYY-MM-DD");
    expect(() => parseGoalInput({ ...base })).not.toThrow(GoalError);
  });

  it("a change to an existing goal needs only its id", () => {
    expect(parseGoalInput({ id: "goal000000000001", value: 12 })).toMatchObject({ id: "goal000000000001", title: null, metricKey: null, value: 12 });
    expect(parseGoalInput({ id: "goal000000000001", drop: true }).drop).toBe(true);
  });

  it("keeps a small cap on goals: a wish list is not a plan", () => {
    expect(GOALS_MAX_ACTIVE).toBe(12);
  });
});

describe("progress", () => {
  it("higher is better: the share of the way from the baseline to the target", () => {
    expect(goalProgress(goal(), 10)).toMatchObject({ state: "behind", progress: 0 });
    expect(goalProgress(goal(), 26)).toMatchObject({ state: "on_track", progress: 0.8 });
    expect(goalProgress(goal(), 25)).toMatchObject({ state: "behind", progress: 0.75 });
    expect(goalProgress(goal(), 30)).toMatchObject({ state: "reached", progress: 1 });
    expect(goalProgress(goal(), 41)).toMatchObject({ state: "reached", progress: 1.55 });
  });

  it("lower is better: from the baseline down to the target", () => {
    const g = goal({ direction: "lower", baselineValue: 30, targetValue: 10 });
    expect(goalProgress(g, 30)).toMatchObject({ state: "behind", progress: 0 });
    expect(goalProgress(g, 14)).toMatchObject({ state: "on_track", progress: 0.8 });
    expect(goalProgress(g, 10)).toMatchObject({ state: "reached" });
    expect(goalProgress(g, 5)).toMatchObject({ state: "reached" });
  });

  it("copes with no baseline and a zero target", () => {
    expect(goalProgress(goal({ baselineValue: null }), 15)).toMatchObject({ progress: 0.5, state: "behind" });
    expect(goalProgress(goal({ direction: "lower", baselineValue: null, targetValue: 0 }), 0)).toMatchObject({ state: "reached", progress: 1 });
    expect(goalProgress(goal({ direction: "lower", baselineValue: null, targetValue: 5 }), 10).state).toBe("behind");
  });

  it("says no number is no number, and the change since last time", () => {
    expect(goalProgress(goal(), null)).toEqual({ state: "no_data", current: null, progress: null, change: null });
    expect(goalProgress(goal(), 20, 14).change).toBe(6);
    expect(goalProgress(goal(), 20, null).change).toBeNull();
  });

  it("prints a goal short for the tool", () => {
    expect(goalBrief(goal(), goalProgress(goal(), 20))).toMatchObject({ id: "goal000000000001", metric: "kpi:partnersinbiz.crm:new_leads_week", target: 30, current: 20, progressPct: 50, state: "behind", better: "higher", period: "week", owner: "op" });
  });
});

describe("the one question that confirms the goals", () => {
  const goals = [
    { id: "goal000000000001", title: "30 new leads a week", targetValue: 30, direction: "higher" as const, period: "week" as const, unit: "leads" },
    { id: "goal000000000002", title: "Fewer failed runs", targetValue: 10, direction: "lower" as const, period: "week" as const, unit: "%" },
  ];

  it("lists every goal in one question, with the yes the effect acts on first", () => {
    const card = goalsAskCard(goals, { cockpitHref: "/PAR/cockpit" });
    expect(card.question).toBe("Adopt these 2 goals? 30 new leads a week (30 leads per week); Fewer failed runs (at most 10 % per week).");
    expect(card.options[0]).toBe("Yes: adopt all of them as written");
    expect(card.options[1]).toContain("I want changes");
    expect(card.effect).toEqual({ key: ACTIVATE_GOALS_EFFECT, params: { goalIds: "goal000000000001,goal000000000002" } });
    expect(card.links).toEqual([{ label: "Open the Cockpit", href: "/PAR/cockpit" }]); // there is no goals page: the link does not pretend there is
    expect(askCardProblems({ kind: card.kind, links: card.links, steps: card.steps, effect: card.effect })).toEqual([]);
  });

  it("says this goal for one, and for many lists at most six and adopts exactly those: nothing is adopted unseen", () => {
    expect(goalsAskCard(goals.slice(0, 1)).question).toMatch(/^Adopt this goal\? /);
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `goal0000000000${String(i).padStart(2, "0")}`, title: `A rather long goal title number ${i} that goes on a while`, targetValue: 100 + i, direction: "higher" as const, period: "month" as const, unit: "ZAR" }));
    const card = goalsAskCard(many);
    expect(card.question.length).toBeLessThanOrEqual(600);
    expect(card.question).toMatch(/^Adopt these 6 goals\? /);
    expect(card.question).toContain("6 more proposed goals are asked right after this one.");
    expect(card.question).not.toContain("all listed in the Cockpit");
    for (let i = 0; i < 6; i += 1) expect(card.question).toContain(`number ${i} that`);
    expect(card.question).not.toContain("number 6 that");
    // every goal the effect adopts is a goal the question names
    expect(card.effect.params.goalIds.split(",")).toEqual(many.slice(0, 6).map((g) => g.id));
    expect(goalsAskCard(many.slice(0, 7)).question).toContain("1 more proposed goal is asked right after this one.");
  });

  it("lists fewer when six would not fit in the question, and still adopts only what it lists", () => {
    const wordy = Array.from({ length: 6 }, (_, i) => ({ id: `goal0000000001${i}0`, title: `${"A very long goal title ".repeat(5).trim()} ${i}`, targetValue: 5, direction: "higher" as const, period: "week" as const, unit: "leads" }));
    const card = goalsAskCard(wordy);
    expect(card.question.length).toBeLessThanOrEqual(600);
    const listed = card.effect.params.goalIds.split(",");
    expect(listed.length).toBeLessThan(6);
    expect(card.question).toContain(`${wordy.length - listed.length} more proposed`);
    for (let i = 0; i < listed.length; i += 1) expect(card.question).toContain(`title ${i} (`);
  });
});

describe("the weekly business review", () => {
  const row = (g: GoalRow, current: number | null, previous: number | null = null, note: string | null = null) => ({ goal: g, progress: goalProgress(g, current, previous), note });

  it("compares actuals to targets, and says what to do about each goal that is behind", () => {
    const { title, description } = businessReviewContent({
      weekLabel: "2026-09-28",
      proposedWaiting: 1,
      cockpitHref: "/PAR/cockpit",
      rows: [
        row(goal(), 12, 8),
        row(goal({ id: "goal000000000002", title: "Keywords in the top 10", metricKey: "kpi:partnersinbiz.seo:seo_keywords_top10", metricLabel: null, targetValue: 20, baselineValue: 5, unit: null }), 21),
        row(goal({ id: "goal000000000003", title: "Fewer failed runs", direction: "lower", targetValue: 10, baselineValue: 30, metricKey: "company:fail_rate", metricLabel: "Run failure rate", unit: "%" }), 14, 18),
        row(goal({ id: "goal000000000004", title: "Revenue", metricKey: "manual", metricLabel: null, targetValue: 50000, unit: "ZAR" }), null, null, "Nobody has recorded a value yet"),
      ],
    });
    expect(title).toBe("Business review: week of 2026-09-28");
    expect(description).toContain("4 active goals: 1 reached, 1 on track, 1 behind, 1 with no number.");
    expect(description).toContain("| 30 new leads a week | New leads this week (week) | 30 leads | 12 leads | 8 leads | 10% | Behind |");
    expect(description).toContain("| Keywords in the top 10 | kpi:partnersinbiz.seo:seo_keywords_top10 (week) | 20 | 21 | – | 107% | Reached |");
    expect(description).toContain("| Fewer failed runs | Run failure rate (week) | at most 10 % | 14 % | 18 % | 80% | On track |");
    expect(description).toContain("1 proposed goal waits for the owner's yes (one question is already open; do not ask again).");
    expect(description).toContain("- [ ] **30 new leads a week** is behind (10% of the way)");
    expect(description).toContain("- [ ] **Revenue** has no number: Nobody has recorded a value yet. Fix the source, or record it with goal-set (id, value).");
    expect(description).toContain("- [ ] Close this issue with one line per behind goal");
    expect(description).toContain("[Open the Cockpit](/PAR/cockpit)");
  });

  it("with nothing behind asks only for the one-line cause of the best number", () => {
    const { description } = businessReviewContent({ weekLabel: "2026-09-28", proposedWaiting: 0, cockpitHref: "/cockpit", rows: [row(goal(), 31, 20)] });
    expect(description).toContain("1 active goal: 1 reached, 0 on track, 0 behind.");
    expect(description).toContain("- [ ] Nothing is behind. Say in one line what drove the best number");
    expect(description).not.toContain("proposed goal");
  });
});

describe("the numbers the CRM reports for goals", () => {
  const CRM_KPIS = ["leads_30d", "organic_leads_30d", "attributed_revenue_30d", "site_visits_30d", "site_conversions_30d", "docs_signed_30d", "docs_waiting_signature"];

  it("are named in the metric key help an agent reads when it sets a goal, and each is a key a goal accepts", () => {
    for (const key of CRM_KPIS) {
      expect(METRIC_KEY_HELP, key).toContain(key);
      expect(parseMetricKey(`kpi:partnersinbiz.crm:${key}`), key).toEqual({ kind: "kpi", plugin: "partnersinbiz.crm", kpi: key });
    }
    expect(METRIC_KEY_HELP).toContain("each only once what it counts is set up");
  });

  it("are numbers the CRM really reports (the help cannot name one that is gone)", () => {
    const crm = readFileSync(new URL("../../plugin-crm/src/growth-kpis.ts", import.meta.url), "utf8");
    for (const key of CRM_KPIS) expect(crm, key).toContain(`key: "${key}"`);
    expect(readFileSync(new URL("../../plugin-crm/src/cockpit.ts", import.meta.url), "utf8")).toContain('key: "new_leads_week"');
  });
});
