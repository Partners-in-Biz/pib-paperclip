import { describe, expect, it } from "vitest";
import { STATS_DAYS, scopeStats, shapeStats, statsQuery } from "../src/stats.js";
import { countDelta, destinationSegments, lastDays, liftTrend, postSegments, publishedSeries, recentActivity, toneOf, POST_TONE, ACCOUNT_TONE, DEST_TONE, verdictSegments, upcoming } from "../src/ui/series.js";
import type { Post } from "../src/ui/types.js";
import { NAMESPACE } from "../src/namespace.js";
import { fakeCtx } from "./helpers.js";

describe("social chart stats (worker)", () => {
  it("reads published per day, destination statuses and weekly lift in one guarded SELECT", async () => {
    const ctx = fakeCtx({}, {
      queryResult: () => [
        { kind: "published", bucket: "2026-09-25", key: "linkedin", n: "2", value: null },
        { kind: "published", bucket: "2026-09-24", key: "facebook", n: 1, value: null },
        { kind: "destination", bucket: null, key: "failed", n: "3", value: null },
        { kind: "destination", bucket: null, key: "published", n: 5, value: null },
        { kind: "lift", bucket: "2026-09-21", key: null, n: 4, value: "0.25" },
        { kind: "lift", bucket: "2026-09-14", key: null, n: 2, value: -0.1 },
      ],
    });
    const stats = await scopeStats(ctx, "co", { kind: "company", id: "c1" });
    expect(ctx.fakeDb.queries).toHaveLength(1);
    const { sql, params } = ctx.fakeDb.queries[0]!;
    expect(sql).toContain(`${NAMESPACE}.destinations`);
    expect(sql).toContain(`${NAMESPACE}.post_scores`);
    expect(sql).toMatch(/^SELECT/);
    expect(params).toEqual(["co", "company", "c1", STATS_DAYS]);
    expect(stats.publishedPerDay).toEqual([
      { date: "2026-09-24", platform: "facebook", count: 1 },
      { date: "2026-09-25", platform: "linkedin", count: 2 },
    ]);
    expect(stats.destinationStatus).toEqual({ failed: 3, published: 5 });
    expect(stats.liftPerWeek).toEqual([{ week: "2026-09-14", medianLift: -0.1, posts: 2 }, { week: "2026-09-21", medianLift: 0.25, posts: 4 }]);
  });

  it("scopes own work to client_ref IS NULL", () => {
    const { sql, params } = statsQuery(fakeCtx(), "co", null, 14);
    expect(sql).toContain("p.client_ref IS NULL");
    expect(params).toEqual(["co", 14]);
  });

  it("gives empty series when the read fails", async () => {
    const ctx = fakeCtx({}, { queryResult: () => { throw new Error("boom"); } });
    expect(await scopeStats(ctx, "co", null)).toEqual({ days: STATS_DAYS, publishedPerDay: [], destinationStatus: {}, liftPerWeek: [] });
  });

  it("ignores rows it does not know", () => {
    expect(shapeStats([{ kind: "other", bucket: "x", key: "y", n: 1, value: null }, { kind: "lift", bucket: "2026-09-21", key: null, n: 1, value: null }]).liftPerWeek).toEqual([]);
  });
});

describe("social chart series (page)", () => {
  const now = new Date("2026-09-26T10:00:00Z");

  it("builds 14 days stacked by platform, busiest first, with the 14 days before", () => {
    const stats = shapeStats([
      { kind: "published", bucket: "2026-09-26", key: "linkedin", n: 2, value: null },
      { kind: "published", bucket: "2026-09-20", key: "facebook", n: 1, value: null },
      { kind: "published", bucket: "2026-09-13", key: "linkedin", n: 1, value: null },
      { kind: "published", bucket: "2026-09-12", key: "facebook", n: 4, value: null },
    ]);
    const s = publishedSeries(stats, now, 14);
    expect(s.data).toHaveLength(14);
    expect(s.data[0]!.label).toBe("9/13");
    expect(s.data[13]).toMatchObject({ label: "9/26", title: "Sat 26 Sep", values: { linkedin: 2, facebook: 0 } });
    expect(s.series.map((x) => x.key)).toEqual(["linkedin", "facebook"]);
    expect(s.series[0]!.label).toBe("LinkedIn");
    expect(s.total).toBe(4);
    expect(s.previous).toBe(4);
    expect(s.totals.at(-1)).toBe(2);
    expect(lastDays(now, 3)).toEqual(["2026-09-24", "2026-09-25", "2026-09-26"]);
  });

  it("says how the count moved", () => {
    expect(countDelta(6, 4, "last week")).toBe("+50% vs last week");
    expect(countDelta(2, 4, "last week")).toBe("−50% vs last week");
    expect(countDelta(3, 0, "last week")).toBe("+3 vs last week");
    expect(countDelta(0, 0, "last week")).toBeNull();
    expect(countDelta(4, 4, "last week")).toBe("same as last week");
  });

  it("turns weekly lift into percentages", () => {
    const t = liftTrend(shapeStats([{ kind: "lift", bucket: "2026-09-21", key: null, n: 3, value: 0.1234 }, { kind: "lift", bucket: "2026-09-14", key: null, n: 2, value: -0.05 }]));
    expect(t).toEqual({ labels: ["14 Sep", "21 Sep"], values: [-5, 12.3], posts: 5 });
    expect(liftTrend(undefined)).toEqual({ labels: [], values: [], posts: 0 });
  });

  it("uses one tone mapping for statuses", () => {
    expect(toneOf(POST_TONE, "published")).toBe("ok");
    expect(toneOf(POST_TONE, "review")).toBe("warn");
    expect(toneOf(POST_TONE, "failed")).toBe("bad");
    expect(toneOf(POST_TONE, "scheduled")).toBe("info");
    expect(toneOf(POST_TONE, "draft")).toBe("info");
    expect(toneOf(ACCOUNT_TONE, "needs_reconnect")).toBe("bad");
    expect(toneOf(ACCOUNT_TONE, "expiring")).toBe("warn");
    expect(toneOf(DEST_TONE, "pending")).toBe("warn");
    expect(toneOf(DEST_TONE, "unknown")).toBe("neutral");
  });

  it("orders post and destination segments along the pipeline", () => {
    const segs = postSegments([{ status: "failed" }, { status: "published" }, { status: "review" }, { status: "published" }]);
    expect(segs.map((s) => [s.label, s.value, s.tone])).toEqual([["Published", 2, "ok"], ["In review", 1, "warn"], ["Failed", 1, "bad"]]);
    expect(destinationSegments({ failed: 1, published: 3, pending: 0 }).map((s) => s.key)).toEqual(["published", "failed"]);
  });

  it("counts verdicts", () => {
    const v = verdictSegments([{ verdict: "win" }, { verdict: "win" }, { verdict: "loss" }, { verdict: null }]);
    expect(v.map((s) => s.value)).toEqual([2, 1, 0, 0]);
  });

  it("lists recent publish results and upcoming posts", () => {
    const dest = (id: string, status: string, publishedAt: string | null) => ({ id, accountId: "a", platform: "linkedin" as const, accountName: "PiB", accountStatus: null, status: status as never, attempts: 1, nextAttemptAt: null, externalId: null, externalUrl: null, lastError: status === "failed" ? "nope" : null, publishedAt, issueId: null });
    const post = (id: string, status: string, destinations: ReturnType<typeof dest>[], scheduledAt: string | null = null) => ({ id, body: `Post ${id}`, status, scheduledAt, updatedAt: "2026-09-25T08:00:00Z", createdAt: null, destinations }) as unknown as Post;
    const posts = [
      post("p1", "published", [dest("d1", "published", "2026-09-26T09:00:00Z")]),
      post("p2", "partially_published", [dest("d2", "published", "2026-09-24T09:00:00Z"), dest("d3", "failed", null)]),
      post("p3", "scheduled", [], "2026-09-27T09:00:00Z"),
      post("p4", "scheduled", [], "2026-09-26T12:00:00Z"),
    ];
    expect(recentActivity(posts, now).map((a) => [a.id, a.kind])).toEqual([["d1", "published"], ["d3", "failed"], ["d2", "published"]]);
    expect(upcoming(posts, now).map((p) => p.id)).toEqual(["p4", "p3"]);
  });
});
