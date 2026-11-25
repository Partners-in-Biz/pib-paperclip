import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderHttpError } from "../src/oauth/http.js";
import { facebookProvider } from "../src/oauth/providers/meta.js";
import type { ProviderAccount, ProviderEnv } from "../src/oauth/types.js";
import { fakeCtx, fastNetwork, json, mockFetch } from "./helpers.js";

const providerMetrics = vi.fn();
vi.mock("../src/oauth/registry.js", () => ({ providerFor: () => ({ metrics: providerMetrics }) }));
vi.mock("../src/modules.js", () => ({ socialOn: async () => true }));
vi.mock("../src/config.js", async (orig) => ({ ...(await orig<object>()), loadSocialConfig: async () => ({ saved: true, companyId: "co" }) }));
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

// PAR-11950: recollect on a Facebook video drives the real provider against recorded Graph shapes,
// so reverting the recollectOne gap handling fails here (destination 6676b3c4).
describe("recollect-post-metrics on a Facebook video (PAR-11950)", () => {
  const env: ProviderEnv = { app: { platform: "facebook", clientId: "app-id", clientSecret: "app-secret" }, redirectUri: "https://paperclip.example.com/cb" };
  const account: ProviderAccount = { id: "a1", platform: "facebook", externalId: "p1", handle: null, displayName: "P", meta: {}, token: { accessToken: "TOK" } };
  const VID = "1164596305897468";
  const POST = `105961684676894_${VID}`;
  const G = `https://graph.facebook.com/v21.0/${VID}`;
  const fields = () => json({ id: VID, comments: { summary: { total_count: 3 } }, likes: { summary: { total_count: 4 } } });
  const owner = () => json({ id: VID, post_id: POST });
  const badPost = () => json({ error: { message: "(#100) Object with ID '105961684676894_1164596305897468' does not exist, cannot be loaded due to missing permissions, or does not support this operation", type: "GraphMethodException", code: 100, error_subcode: 33 } }, 400);
  const reach = () => json({ data: [{ name: "post_media_view", values: [{ value: 120 }] }, { name: "post_total_media_view_unique", values: [{ value: 80 }] }] });
  const views = () => json({ data: [{ name: "total_video_views", values: [{ value: 50 }] }] });
  const empty = () => json({ data: [] });

  function graph(post: () => Response, video: () => Response) {
    mockFetch([
      [`GET ${G}/video_insights`, (url: URL) => (url.searchParams.get("metric") === "total_video_views" ? video() : empty())],
      [`GET https://graph.facebook.com/v21.0/${POST}/insights`, post],
      [`GET ${G}`, (url: URL) => (url.searchParams.get("fields")?.startsWith("post_id") ? owner() : fields())],
    ] as never);
    providerMetrics.mockImplementation((_env: unknown, _account: unknown, externalId: string) => facebookProvider.metrics!(env, account, externalId));
  }
  function videoDest() {
    const dest = { id: "d1", company_id: "co", post_id: "p1", account_id: "a1", platform: "facebook", external_id: VID, published_at: daysAgo(3), metric_windows: ["1h", "24h"] };
    return fakeCtx({}, {
      queryResult: (sql: string) => {
        if (sql.includes("FROM plugin_social_e70c4e79f2.accounts")) return [{ id: "a1", token_enc: "x", status: "connected", meta: {} }];
        if (sql.includes(".post_metrics")) return [{ id: "m1" }];
        if (sql.includes("destinations")) return [dest];
        return [];
      },
      executeResult: () => 1,
    });
  }
  const errorsSet = (ctx: ReturnType<typeof fakeCtx>) => writes(ctx).filter((e) => e.sql.includes("jsonb_build_object('metricsError'")).map((e) => JSON.parse(e.params[1] as string));
  const cleared = (ctx: ReturnType<typeof fakeCtx>) => writes(ctx).filter((e) => e.sql.includes("result - 'metricsError'"));

  beforeEach(() => fastNetwork());
  afterEach(() => vi.unstubAllGlobals());

  it("post 4xx + empty video_insights: metricsError keeps the real Graph message and calls, window marked", async () => {
    graph(badPost, empty);
    const ctx = videoDest();
    const out = await recollectPostMetrics(ctx, "co", {});
    const [rec, ...more] = errorsSet(ctx);
    expect(more).toEqual([]);
    expect(rec).toMatchObject({ kind: "insights", window: "24h" });
    expect(rec.message).toContain("does not exist");
    expect(rec.message).toContain("unavailable: Graph offers no view metric for this video");
    expect(rec.message).not.toContain("missing total_video_views");
    expect(rec.calls).toEqual([
      expect.objectContaining({ label: "post insights", path: `${POST}/insights`, ok: false, status: 400, code: 100 }),
      expect.objectContaining({ label: "video insights", metric: "total_video_views", ok: true, returned: [] }),
      expect.objectContaining({ label: "video insights (all)", metric: null, ok: true, returned: [] }),
    ]);
    expect(JSON.stringify(rec)).not.toContain("TOK");
    expect(cleared(ctx)).toEqual([]);
    expect(marked(ctx)).toEqual([["24h"]]);
    expect(out.destinations[0]).toEqual({ destinationId: "d1", platform: "facebook", window: "24h", action: "filled", message: rec.message });
    const raw = JSON.parse(inserts(ctx)[0]!.params[15] as string);
    expect(raw).toMatchObject({ backfill: true, insights: rec.calls });
  });

  it("Graph now returns reach and views: the earlier metricsError is cleared and the window marked", async () => {
    graph(reach, views);
    const ctx = videoDest();
    const out = await recollectPostMetrics(ctx, "co", {});
    expect(errorsSet(ctx)).toEqual([]);
    expect(cleared(ctx)).toHaveLength(1);
    expect(cleared(ctx)[0]!.params).toEqual(["d1"]);
    expect(marked(ctx)).toEqual([["24h"]]);
    expect(out.destinations[0]).toEqual({ destinationId: "d1", platform: "facebook", window: "24h", action: "filled" });
    const ins = inserts(ctx)[0]!;
    expect([ins.params[7], ins.params[11], ins.params[12]]).toEqual([50, 120, 80]);
  });
});
