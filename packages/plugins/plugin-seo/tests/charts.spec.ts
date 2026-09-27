import { describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import {
  backlinkSegments,
  changeText,
  chipState,
  healthTone,
  optimizationSegments,
  positionBuckets,
  positionTrendTone,
  severitySegments,
  statusTone,
  taskSegments,
  trafficSeries,
} from "../src/ui/series.js";
import { validateParams, validateRuntimeQuery } from "./helpers/sql-guard.js";

describe("sprint traffic series (worker)", () => {
  it("sums Search Console impressions and clicks of tracked keywords per day in one guarded SELECT", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const fake: db.SeoDb = {
      namespace: NAMESPACE,
      async query<T>(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE, []);
        validateParams(sql, params);
        calls.push({ sql, params });
        return [
          { on_day: "2026-09-24", impressions: "120", clicks: 4, keywords: 3 },
          { on_day: "2026-09-25", impressions: 90, clicks: null, keywords: "2" },
        ] as T[];
      },
      async execute() {
        throw new Error("read only");
      },
    };
    const rows = await db.sprintTraffic(fake, "co", "sp-1", 56);
    expect(rows).toEqual([
      { on: "2026-09-24", impressions: 120, clicks: 4, keywords: 3 },
      { on: "2026-09-25", impressions: 90, clicks: 0, keywords: 2 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain(`${NAMESPACE}.rank_history`);
    expect(calls[0]!.sql).toContain("h.source = 'gsc'");
    expect(calls[0]!.params).toEqual(["sp-1", "co", 56]);
  });
});

describe("SEO chart series (page)", () => {
  it("maps statuses to one set of tones", () => {
    expect(statusTone("done")).toBe("ok");
    expect(statusTone("live")).toBe("ok");
    expect(statusTone("submitted")).toBe("warn");
    expect(statusTone("proposed")).toBe("warn");
    expect(statusTone("blocked")).toBe("bad");
    expect(statusTone("critical")).toBe("bad");
    expect(statusTone("in_progress")).toBe("info");
    expect(statusTone("archived")).toBe("neutral");
    expect(statusTone(null)).toBe("neutral");
  });

  it("puts tasks in plan states (engine/due.ts) and counts them", () => {
    expect(chipState({ status: "not_started", dueDay: 10 }, 12)).toBe("due");
    expect(chipState({ status: "not_started", dueDay: 2 }, 12)).toBe("overdue");
    expect(chipState({ status: "not_started", dueDay: 20 }, 12)).toBe("upcoming");
    expect(chipState({ status: "na", dueDay: 1 }, 12)).toBe("skipped");
    expect(chipState({ status: "in_progress", dueDay: 10, assigneeKind: "agent", issueId: "i" }, 12, false)).toBe("stuck");
    const segs = taskSegments([{ status: "done", dueDay: 1 }, { status: "done", dueDay: 2 }, { status: "blocked", dueDay: 3 }, { status: "not_started", dueDay: 50 }], 12);
    expect(Object.fromEntries(segs.map((s) => [s.key, s.value]))).toEqual({ done: 2, in_progress: 0, due: 0, overdue: 0, waiting: 1, stuck: 0, upcoming: 1, skipped: 0 });
    expect(segs.find((s) => s.key === "waiting")).toMatchObject({ label: "Waiting on you", tone: "warn" });
  });

  it("bands keyword positions and ignores retired keywords", () => {
    const items = positionBuckets([
      { currentPosition: 2, retiredAt: null },
      { currentPosition: 3.4, retiredAt: null },
      { currentPosition: 9, retiredAt: null },
      { currentPosition: 15, retiredAt: null },
      { currentPosition: 48, retiredAt: null },
      { currentPosition: null, retiredAt: null },
      { currentPosition: 1, retiredAt: "2026-09-01" },
    ]);
    expect(items.map((i) => [i.label, i.value])).toEqual([["Top 3", 1], ["4–10", 2], ["11–20", 1], ["21+", 1], ["Not ranking yet", 1]]);
  });

  it("reads a position trend the right way round", () => {
    expect(positionTrendTone([18, 12, 7])).toBe("ok");
    expect(positionTrendTone([7, 9])).toBe("bad");
    expect(positionTrendTone([7, 7.2])).toBe("neutral");
    expect(positionTrendTone([7])).toBe("neutral");
  });

  it("fills 28 days of traffic and totals the 28 before", () => {
    const t = trafficSeries([
      { on: "2026-09-26", impressions: 100, clicks: 5 },
      { on: "2026-09-01", impressions: 50, clicks: 1 },
      { on: "2026-08-28", impressions: 40, clicks: 2 },
      { on: "2026-07-01", impressions: 999, clicks: 99 },
    ], "2026-09-26", 28);
    expect(t.labels).toHaveLength(28);
    expect(t.labels[0]).toBe("30 Aug");
    expect(t.labels.at(-1)).toBe("26 Sep");
    expect(t.impressions.at(-1)).toBe(100);
    expect(t.totals).toEqual({ impressions: 150, clicks: 6 });
    expect(t.previous).toEqual({ impressions: 40, clicks: 2 });
    expect(t.hasData).toBe(true);
    expect(trafficSeries(undefined, "2026-09-26").hasData).toBe(false);
    // Search Console lag: the window ends on the latest day with data.
    const lag = trafficSeries([{ on: "2026-09-23", impressions: 10, clicks: 1 }], "2026-09-26", 28);
    expect(lag.end).toBe("23 Sep");
    expect(lag.impressions.at(-1)).toBe(10);
    expect(changeText(150, 100, "last month")).toBe("+50% vs last month");
    expect(changeText(0, 0, "last month")).toBeNull();
  });

  it("tones health and counts results, severities and backlinks", () => {
    expect([healthTone(85), healthTone(60), healthTone(20), healthTone(null)]).toEqual(["ok", "warn", "bad", "neutral"]);
    const board = optimizationSegments({ "title:rewrite": { wins: 2, losses: 1, noChange: 1 }, "links:internal": { wins: 1, losses: 0, noChange: 0, inconclusive: 2 } });
    expect(board.map((s) => s.value)).toEqual([3, 1, 1, 2]);
    expect(optimizationSegments({}, [{ result: "win" }, { result: "loss" }, { result: null }]).map((s) => s.value)).toEqual([1, 1, 0, 0]);
    expect(severitySegments([{ severity: "high" }, { severity: "low" }, { severity: "high" }]).map((s) => [s.key, s.value, s.tone])).toEqual([["critical", 0, "bad"], ["high", 2, "bad"], ["medium", 0, "warn"], ["low", 1, "neutral"]]);
    expect(backlinkSegments([{ status: "lost" }, { status: "live" }, { status: "live" }]).map((s) => [s.key, s.value])).toEqual([["live", 2], ["lost", 1]]);
  });
});
