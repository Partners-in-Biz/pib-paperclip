import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import { recordDates } from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { crmSeries, lastMonths, leadBands, perWeek, recentDelta, wonPerMonth } from "../src/series.js";
import { validateParams, validateRuntimeQuery } from "./helpers/sql-guard.js";

const NOW = new Date("2026-09-26T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("CRM chart series", () => {
  it("lists the last months oldest first, across a year end", () => {
    expect(lastMonths(NOW, 3)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(lastMonths(new Date("2026-01-15T00:00:00Z"), 2)).toEqual(["2025-12", "2026-01"]);
  });

  it("counts won deals and their amounts per month by last update", () => {
    const deals = [
      { id: "d1", stageId: "won", amountMinor: 100_00, currency: "ZAR" },
      { id: "d2", stageId: "won", amountMinor: 50_00, currency: "ZAR" },
      { id: "d3", stageId: "won", amountMinor: 20_00, currency: "USD" },
      { id: "d4", stageId: "open", amountMinor: 999_00, currency: "ZAR" },
      { id: "d5", stageId: "won", amountMinor: 5_00, currency: "ZAR" },
    ];
    const dates = [
      { id: "d1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-09-02T10:00:00Z" },
      { id: "d2", createdAt: "2026-08-10T00:00:00Z", updatedAt: null },
      { id: "d3", createdAt: null, updatedAt: "2026-09-20T00:00:00Z" },
      { id: "d4", createdAt: null, updatedAt: "2026-09-20T00:00:00Z" },
      { id: "d5", createdAt: null, updatedAt: "2024-01-01T00:00:00Z" },
    ];
    const months = wonPerMonth(deals, new Set(["won"]), dates, NOW, 3);
    expect(months).toEqual([
      { month: "2026-07", count: 0, amountMinor: {} },
      { month: "2026-08", count: 1, amountMinor: { ZAR: 50_00 } },
      { month: "2026-09", count: 2, amountMinor: { ZAR: 100_00, USD: 20_00 } },
    ]);
  });

  it("buckets created dates into 7-day windows ending now", () => {
    expect(perWeek([day(0), day(1), day(6.9), day(7.1), day(20), day(60), null, "bad", day(-2)], NOW, 4)).toEqual([0, 1, 1, 3]);
  });

  it("builds the load series from visible records only", () => {
    const series = crmSeries({
      deals: [{ id: "d1", stageId: "s-won", amountMinor: 10_00, currency: "ZAR" }],
      stages: [{ id: "s-open", kind: "open" }, { id: "s-won", kind: "won" }],
      dealDates: [{ id: "d1", createdAt: day(2), updatedAt: day(1) }, { id: "hidden", createdAt: day(1), updatedAt: day(1) }],
      contactDates: [{ id: "p1", createdAt: day(3), updatedAt: null }, { id: "p2", createdAt: day(10), updatedAt: null }, { id: "px", createdAt: day(1), updatedAt: null }],
      visibleContactIds: new Set(["p1", "p2"]),
      now: NOW,
    });
    expect(series.wonByMonth).toHaveLength(12);
    expect(series.wonByMonth.at(-1)).toEqual({ month: "2026-09", count: 1, amountMinor: { ZAR: 10_00 } });
    expect(series.newDealsByWeek.at(-1)).toBe(1);
    expect(series.newContactsByWeek.slice(-2)).toEqual([1, 1]);
    expect(series.newContactsByWeek).toHaveLength(8);
  });

  it("counts contacts per lead band", () => {
    const score = (fit: number, intent: number) => ({ fit, intent, urgency: 0, confidence: 0.9, scoredAt: day(1) });
    expect(leadBands([{ leadScore: score(3, 3) }, { leadScore: score(2, 0) }, { leadScore: score(0, 1) }, { leadScore: null }, {}])).toEqual({ hot: 1, warm: 1, cold: 1, unscored: 2 });
  });

  it("compares the recent span with the one before", () => {
    expect(recentDelta([1, 1, 2, 5], 2)).toBe(5);
    expect(recentDelta([3], 2)).toBe(3);
  });
});

describe("recordDates", () => {
  it("reads created and updated times for the given ids with a guarded SELECT", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const ctx = {
      db: {
        namespace: NAMESPACE,
        query: async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          return [{ id: "d1", created_at: new Date("2026-09-01T00:00:00Z"), updated_at: "2026-09-02T00:00:00.000Z" }];
        },
      },
    } as unknown as PluginContext;
    expect(await recordDates(ctx, "deals", [])).toEqual([]);
    expect(calls).toHaveLength(0);
    const rows = await recordDates(ctx, "deals", ["d1"]);
    expect(rows).toEqual([{ id: "d1", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" }]);
    expect(calls[0]!.sql).toContain(`FROM ${NAMESPACE}.deals`);
    expect(calls[0]!.params).toEqual(['["d1"]']);
    validateRuntimeQuery(calls[0]!.sql, NAMESPACE);
    validateParams(calls[0]!.sql, calls[0]!.params);
  });
});
