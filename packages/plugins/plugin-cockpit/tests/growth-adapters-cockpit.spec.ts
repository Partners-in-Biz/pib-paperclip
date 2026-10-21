/** Growth metrics adapter (pure, no pg): itemStates, isoWeek boundaries, onOwnMetricsEvent logic. */
import { describe, expect, it } from "vitest";
import { itemStates, type MetricRow } from "../src/growth-adapter.js";
import { isoWeek, onOwnMetricsEvent } from "../src/growth-own-metrics.js";
import type { Env } from "../src/env.js";

describe("itemStates (pure)", () => {
  it("single window: sums correctly and publishes", () => {
    const items = [
      { arm: "control", subjectId: "2026-W41" },
      { arm: "variant", subjectId: "2026-W42" },
    ];
    const rows: MetricRow[] = [
      { window: "2026-W41", value: 10 },
      { window: "2026-W42", value: 20 },
    ];
    const result = itemStates(items, rows);
    expect(result).toEqual([
      { subjectId: "2026-W41", arm: "control", published: true, value: 10 },
      { subjectId: "2026-W42", arm: "variant", published: true, value: 20 },
    ]);
  });

  it("two-window pair (book): mean of windows", () => {
    const items = [{ arm: "control", subjectId: "2026-W41+2026-W42" }];
    const rows: MetricRow[] = [
      { window: "2026-W41", value: 10 },
      { window: "2026-W42", value: 20 },
    ];
    const result = itemStates(items, rows);
    expect(result).toEqual([
      { subjectId: "2026-W41+2026-W42", arm: "control", published: true, value: 15 },
    ]);
  });

  it("one missing window => null and unpublished", () => {
    const items = [{ arm: "control", subjectId: "2026-W41+2026-W42" }];
    const rows: MetricRow[] = [{ window: "2026-W41", value: 10 }];
    const result = itemStates(items, rows);
    expect(result).toEqual([
      { subjectId: "2026-W41+2026-W42", arm: "control", published: false, value: null },
    ]);
  });

  it("unknown subject (empty label) => unpublished", () => {
    const items = [{ arm: "control", subjectId: "" }];
    const rows: MetricRow[] = [];
    const result = itemStates(items, rows);
    expect(result).toEqual([
      { subjectId: "", arm: "control", published: false, value: null },
    ]);
  });

  it("preserves input order", () => {
    const items = [
      { arm: "variant", subjectId: "2026-W42" },
      { arm: "control", subjectId: "2026-W41" },
      { arm: "control", subjectId: "2026-W43" },
    ];
    const rows: MetricRow[] = [
      { window: "2026-W41", value: 10 },
      { window: "2026-W42", value: 20 },
      { window: "2026-W43", value: 30 },
    ];
    const result = itemStates(items, rows);
    expect(result.map((r) => r.subjectId)).toEqual(["2026-W42", "2026-W41", "2026-W43"]);
  });
});

describe("isoWeek", () => {
  it("2024-12-30 gives 2025-W01", () => {
    const d = new Date("2024-12-30T00:00:00Z");
    expect(isoWeek(d)).toBe("2025-W01");
  });

  it("2026-12-31 gives 2026-W53 (2026 starts on Thursday)", () => {
    const d = new Date("2026-12-31T00:00:00Z");
    expect(isoWeek(d)).toBe("2026-W53");
  });

  it("2027-01-03 gives 2026-W53 (same Thursday rule)", () => {
    const d = new Date("2027-01-03T00:00:00Z");
    expect(isoWeek(d)).toBe("2026-W53");
  });

  it("2027-01-04 gives 2027-W01", () => {
    const d = new Date("2027-01-04T00:00:00Z");
    expect(isoWeek(d)).toBe("2027-W01");
  });

  it("2021-01-03 gives 2020-W53", () => {
    const d = new Date("2021-01-03T00:00:00Z");
    expect(isoWeek(d)).toBe("2020-W53");
  });

  it("zero-pads week number", () => {
    const d = new Date("2026-01-05T00:00:00Z");
    const result = isoWeek(d);
    expect(result).toMatch(/W\d{2}/);
  });
});

describe("onOwnMetricsEvent (pure logic)", () => {
  it("maps revenue.* to revenue channel, others to website", async () => {
    const captured: Array<{ channel: string; metric: string; value: number }> = [];
    const env = {
      ctx: {
        db: {
          execute: async (sql: string, params: unknown[]) => {
            // recordMetric params: [id, companyId, channel, subject, metric, window, value, source]
            // So channel is at index 2
            captured.push({
              channel: String(params[2]),
              metric: String(params[4]),
              value: Number(params[6]),
            });
          },
        },
        logger: { info: () => undefined },
      },
      now: () => new Date("2026-10-21T12:00:00.000Z"),
    } as unknown as Env;

    const event = {
      companyId: "company-a",
      payload: {
        scope: "own",
        metrics: [
          { key: "site_conversions", label: "Conversions", value: 100, unit: "count", period: "30d" },
          { key: "revenue.organic", label: "Revenue", value: 5000, unit: "ZAR", period: "30d" },
        ],
        updatedAt: "2026-10-21T12:00:00.000Z",
      },
    };

    const written = await onOwnMetricsEvent(env, event);
    expect(written).toBe(2);
    expect(captured).toContainEqual(expect.objectContaining({ channel: "website", metric: "site_conversions" }));
    expect(captured).toContainEqual(expect.objectContaining({ channel: "revenue", metric: "revenue.organic" }));
  });

  it("drops malformed scope", async () => {
    const env = {
      ctx: {
        db: { execute: async () => {} },
        logger: { info: () => undefined },
      },
      now: () => new Date(),
    } as unknown as Env;

    const event = {
      companyId: "company-a",
      payload: { scope: "other", metrics: [] },
    };

    const written = await onOwnMetricsEvent(env, event);
    expect(written).toBe(0);
  });

  it("drops event without companyId", async () => {
    const env = {
      ctx: { db: { execute: async () => {} }, logger: { info: () => undefined } },
      now: () => new Date(),
    } as unknown as Env;

    const event = { companyId: "", payload: { scope: "own", metrics: [] } };
    const written = await onOwnMetricsEvent(env, event);
    expect(written).toBe(0);
  });

  it("skips non-finite values", async () => {
    let writeCount = 0;
    const env = {
      ctx: {
        db: { execute: async () => void (writeCount += 1) },
        logger: { info: () => undefined },
      },
      now: () => new Date(),
    } as unknown as Env;

    const event = {
      companyId: "company-a",
      payload: {
        scope: "own",
        metrics: [
          { key: "metric1", label: "M1", value: 10, unit: "count", period: "30d" },
          { key: "metric2", label: "M2", value: NaN, unit: "count", period: "30d" },
          { key: "metric3", label: "M3", value: Infinity, unit: "count", period: "30d" },
        ],
      },
    };

    const written = await onOwnMetricsEvent(env, event);
    expect(written).toBe(1);
    expect(writeCount).toBe(1);
  });
});
