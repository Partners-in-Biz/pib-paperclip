import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderHttpError } from "../src/oauth/http.js";
import { fakeCtx } from "./helpers.js";

const providerMetrics = vi.fn();
vi.mock("../src/oauth/registry.js", () => ({ providerFor: () => ({ metrics: providerMetrics }) }));
vi.mock("../src/modules.js", () => ({ socialOn: async () => true }));
vi.mock("../src/config.js", () => ({ loadSocialConfig: async () => ({ saved: true, companyId: "co" }) }));
vi.mock("../src/accounts.js", () => ({ envFor: async () => ({}) }));
vi.mock("../src/tokens.js", () => ({ freshAccount: async () => ({ id: "a1", meta: {} }) }));

const { recollectPostMetrics } = await import("../src/metrics.js");

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

function setup(platform: string, meta: Record<string, unknown> = {}, publishedAt = daysAgo(3), count = 1, outcomeRows = 1) {
  const dests = Array.from({ length: count }, (_, i) => ({ id: `d${i + 1}`, company_id: "co", post_id: `p${i + 1}`, account_id: "a1", platform, external_id: `ext${i + 1}`, published_at: publishedAt, metric_windows: ["1h", "24h", "7d", "30d"] }));
  return fakeCtx({}, {
    queryResult: (sql: string) => {
      if (sql.includes("FROM plugin_social_e70c4e79f2.accounts")) return [{ id: "a1", token_enc: "x", status: "connected", meta }];
      if (sql.includes(".post_metrics")) return [{ id: "m1" }];
      if (sql.includes("destinations")) return dests;
      return [];
    },
    executeResult: () => outcomeRows,
  });
}
const writes = (ctx: ReturnType<typeof fakeCtx>) => ctx.fakeDb.executes;
const inserts = (ctx: ReturnType<typeof fakeCtx>) => writes(ctx).filter((e) => e.sql.includes("INSERT INTO"));
const marked = (ctx: ReturnType<typeof fakeCtx>) => writes(ctx).filter((e) => e.sql.includes("metric_windows")).map((e) => JSON.parse(e.params[1] as string));

beforeEach(() => {
  providerMetrics.mockReset();
});

describe("recollect-post-metrics", () => {
  it("selects the company's published destinations with token, newest first, bounded by a parameter", async () => {
    const ctx = setup("facebook");
    providerMetrics.mockResolvedValue({ views: 5, likes: 1, comments: 0, shares: 0 });
    await recollectPostMetrics(ctx, "co", {});
    const q = ctx.fakeDb.queries.find((x) => x.sql.includes("make_interval"))!;
    expect(q.sql).toContain("d.company_id = $1");
    expect(q.sql).toContain("d.status = 'published'");
    expect(q.sql).toContain("d.external_id IS NOT NULL");
    expect(q.sql).toContain("a.token_enc IS NOT NULL");
    expect(q.sql).toContain("LIMIT $3");
    expect(q.sql).not.toContain("cardinality");
    expect(q.params).toEqual(["co", 14, 50]);
  });

  it("clamps sinceDays/limit and adds the destination filter", async () => {
    const ctx = setup("facebook");
    await recollectPostMetrics(ctx, "co", { sinceDays: 99, limit: 500, destinationId: "d9" });
    const q = ctx.fakeDb.queries.find((x) => x.sql.includes("make_interval"))!;
    expect(q.sql).toContain("AND d.id = $4");
    expect(q.params).toEqual(["co", 32, 50, "d9"]);
    await expect(recollectPostMetrics(ctx, "co", { limit: 0 })).rejects.toThrow(/limit/);
  });

  it("uses the latest passed window from publishedAt, tags backfill and marks only that window", async () => {
    providerMetrics.mockResolvedValue({ views: 5, likes: 1, comments: 0, shares: 0, impressions: 9, raw: { a: 1 } });
    const ctx = setup("facebook", {}, daysAgo(3));
    const out = await recollectPostMetrics(ctx, "co", {});
    expect(out.destinations).toEqual([{ destinationId: "d1", platform: "facebook", window: "24h", action: "filled" }]);
    expect(out.totals).toMatchObject({ filled: 1, error: 0 });
    const ins = inserts(ctx)[0]!;
    expect(ins.params[6]).toBe("24h");
    expect(JSON.parse(ins.params[15] as string)).toEqual({ a: 1, backfill: true });
    expect(marked(ctx)).toEqual([["24h"]]);
  });

  it("an old post resolves to the 7d window; a 'unchanged' outcome is reported", async () => {
    providerMetrics.mockResolvedValue({ views: 5, likes: 1, comments: 0, shares: 0 });
    const ctx = setup("facebook", {}, daysAgo(10), 1, 0);
    const out = await recollectPostMetrics(ctx, "co", {});
    expect(out.destinations[0]).toMatchObject({ window: "7d", action: "unchanged" });
  });

  it("insightsError: persists metricsError and does not mark the window", async () => {
    providerMetrics.mockResolvedValue({ views: 5, likes: 1, comments: 0, shares: 0, insightsError: "no reach https://x.test/p?access_token=SECRET" });
    const ctx = setup("facebook");
    const out = await recollectPostMetrics(ctx, "co", {});
    expect(marked(ctx)).toEqual([]);
    const err = writes(ctx).find((e) => e.sql.includes("jsonb_build_object('metricsError'"))!;
    const rec = JSON.parse(err.params[1] as string);
    expect(rec).toMatchObject({ kind: "insights", window: "24h" });
    expect(rec.message).not.toContain("SECRET");
    expect(rec.message).not.toContain("?");
    expect(out.destinations[0]!.message).not.toContain("SECRET");
  });

  it("provider error is reported and persisted without marking", async () => {
    providerMetrics.mockImplementation(async () => { throw new ProviderHttpError(400, JSON.stringify({ error: { message: "bad" } })); });
    const ctx = setup("facebook");
    const out = await recollectPostMetrics(ctx, "co", {});
    expect(out.totals.error).toBe(1);
    expect(out.destinations[0]!.action).toBe("error");
    expect(marked(ctx)).toEqual([]);
    expect(inserts(ctx)).toHaveLength(0);
  });

  it("skips LinkedIn person destinations without calling the provider; runs organizations", async () => {
    const person = setup("linkedin", { kind: "person" });
    const out = await recollectPostMetrics(person, "co", {});
    expect(out.destinations[0]).toMatchObject({ action: "skipped" });
    expect(providerMetrics).not.toHaveBeenCalled();
    providerMetrics.mockResolvedValue({ views: 5, likes: 1, comments: 0, shares: 0 });
    const org = setup("linkedin", { kind: "organization" });
    expect((await recollectPostMetrics(org, "co", {})).destinations[0]!.action).toBe("filled");
  });

  it("a post under one hour old is skipped with no provider call", async () => {
    const ctx = setup("facebook", {}, new Date(Date.now() - 600_000).toISOString());
    const out = await recollectPostMetrics(ctx, "co", {});
    expect(out.destinations[0]).toMatchObject({ window: null, action: "skipped" });
    expect(providerMetrics).not.toHaveBeenCalled();
  });

  it("never processes more than the cap", async () => {
    providerMetrics.mockResolvedValue({ views: 1, likes: 0, comments: 0, shares: 0 });
    const ctx = setup("facebook", {}, daysAgo(3), 5);
    const out = await recollectPostMetrics(ctx, "co", { limit: 2 });
    expect(out.destinations).toHaveLength(2);
    expect(providerMetrics).toHaveBeenCalledTimes(2);
  });
});
