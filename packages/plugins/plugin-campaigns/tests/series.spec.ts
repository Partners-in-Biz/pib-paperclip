import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it } from "vitest";
import { eventCounts, eventDays } from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { eventTotals, replyRate, weekStarts, weeklySends } from "../src/series.js";
import { validateParams, validateRuntimeQuery } from "./helpers/sql-guard.js";

const NOW = new Date("2026-09-26T15:00:00Z");

describe("campaign chart series", () => {
  it("adds up events per campaign and splits sends and replies by variant", () => {
    const totals = eventTotals([
      { campaign_id: "c1", event_type: "sent", variant: "a", count: "90" },
      { campaign_id: "c1", event_type: "sent", variant: "b", count: 91 },
      { campaign_id: "c1", event_type: "sent", variant: null, count: 4 },
      { campaign_id: "c1", event_type: "reply", variant: "a", count: 3 },
      { campaign_id: "c1", event_type: "reply", variant: "b", count: 9 },
      { campaign_id: "c1", event_type: "bounce", variant: "a", count: 2 },
      { campaign_id: "c1", event_type: "open", variant: null, count: 40 },
      { campaign_id: "c1", event_type: "weird", variant: null, count: 7 },
      { campaign_id: "c2", event_type: "sent", variant: "a", count: 5 },
    ], new Set(["c1"]));
    expect(Object.keys(totals)).toEqual(["c1"]);
    expect(totals.c1).toEqual({
      sent: 185, replies: 12, bounces: 2, unsubscribes: 0, opens: 40, clicks: 0,
      variants: { a: { sent: 94, replies: 3 }, b: { sent: 91, replies: 9 } },
    });
  });

  it("lists 7-day window starts ending today", () => {
    expect(weekStarts(NOW, 2)).toEqual(["2026-09-13", "2026-09-20"]);
  });

  it("buckets per-day counts into weeks for the listed campaigns", () => {
    const weeks = weeklySends([
      { campaign_id: "c1", event_type: "sent", day: "2026-09-26", count: 10 },
      { campaign_id: "c1", event_type: "reply", day: "2026-09-20", count: 2 },
      { campaign_id: "c1", event_type: "sent", day: "2026-09-19", count: 5 },
      { campaign_id: "c1", event_type: "bounce", day: "2026-09-19", count: 1 },
      { campaign_id: "c1", event_type: "sent", day: "2026-01-01", count: 99 },
      { campaign_id: "c1", event_type: "sent", day: "2026-09-27", count: 99 },
      { campaign_id: "other", event_type: "sent", day: "2026-09-26", count: 50 },
    ], NOW, 3, new Set(["c1"]));
    expect(weeks).toEqual([
      { start: "2026-09-06", sent: 0, replies: 0, bounces: 0 },
      { start: "2026-09-13", sent: 5, replies: 0, bounces: 1 },
      { start: "2026-09-20", sent: 10, replies: 2, bounces: 0 },
    ]);
  });

  it("gives no reply rate before the first send", () => {
    expect(replyRate({ sent: 0, replies: 0 })).toBeNull();
    expect(replyRate({ sent: 200, replies: 10 })).toBe(0.05);
  });
});

describe("overview queries", () => {
  function fakeCtx() {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const ctx = {
      db: {
        namespace: NAMESPACE,
        query: async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          return [];
        },
      },
    } as unknown as PluginContext;
    return { ctx, calls };
  }

  it("reads event counts and per-day sends with guarded, company-scoped SELECTs", async () => {
    const { ctx, calls } = fakeCtx();
    await eventCounts(ctx, "co-1");
    await eventDays(ctx, "co-1", "2026-07-04T00:00:00.000Z");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.sql).toContain(`FROM ${NAMESPACE}.campaign_step_events`);
      expect(call.sql).toContain("company_id = $1");
      expect(call.params[0]).toBe("co-1");
      validateRuntimeQuery(call.sql, NAMESPACE);
      validateParams(call.sql, call.params);
    }
    expect(calls[1]!.params[1]).toBe("2026-07-04T00:00:00.000Z");
  });
});
