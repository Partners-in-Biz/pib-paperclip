import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { facebookProvider } from "../src/oauth/providers/meta.js";
import type { ProviderAccount, ProviderEnv } from "../src/oauth/types.js";
import { fakeCtx, fastNetwork, json, mockFetch } from "./helpers.js";

const env: ProviderEnv = { app: { platform: "facebook", clientId: "app-id", clientSecret: "app-secret" }, redirectUri: "https://paperclip.example.com/cb" };
const account: ProviderAccount = { id: "a1", platform: "facebook", externalId: "p1", handle: null, displayName: "P", meta: {}, token: { accessToken: "TOK" } };
const VID = "1164596305897468";
const POST = `105961684676894_${VID}`;
const G = `https://graph.facebook.com/v21.0/${VID}`;
const GP = `https://graph.facebook.com/v21.0/${POST}`;
const V1 = `${G}?fields=comments.summary%28true%29.limit%280%29%2Clikes.summary%28true%29.limit%280%29&access_token=TOK`;
const P0 = `${G}?fields=post_id%2Cpermalink_url&access_token=TOK`;
const V4 = `${G}/video_insights?period=lifetime&access_token=TOK`;
const V2 = `${GP}/insights?metric=post_media_view%2Cpost_total_media_view_unique&access_token=TOK`;
const V3 = `${G}/video_insights?metric=total_video_views&period=lifetime&access_token=TOK`;

const fields = () => json({ id: VID, comments: { summary: { total_count: 3 } }, likes: { summary: { total_count: 4 } } });
const owner = () => json({ id: VID, post_id: POST });
const noPostId = () => json({ id: VID });
const reach = () => json({ data: [{ name: "post_media_view", values: [{ value: 120 }] }, { name: "post_total_media_view_unique", values: [{ value: 80 }] }] });
const views = () => json({ data: [{ name: "total_video_views", values: [{ value: 50 }] }] });
// What Graph returns since Meta removed total_video_impressions(_unique) (v25.0 changelog): 200 with no row for them.
const removedVideoImpressions = () => json({ data: [] });
const invalidMetric = () => json({ error: { message: "(#100) The value must be a valid insights metric", code: 100 } }, 400);
const down = () => json({ error: { message: "Service unavailable" } }, 503);

beforeEach(() => fastNetwork());
afterEach(() => vi.unstubAllGlobals());

function routes(v1: () => Response, v2: () => Response, v3: () => Response, p0: () => Response = owner, v4: () => Response = removedVideoImpressions) {
  return mockFetch([
    [`GET ${G}/video_insights`, (url: URL) => (url.searchParams.get("metric") === "total_video_views" ? v3() : url.searchParams.has("metric") ? removedVideoImpressions() : v4())],
    [`GET ${GP}/insights`, v2],
    [`GET ${G}`, (url: URL) => (url.searchParams.get("fields")?.startsWith("post_id") ? p0() : v1())],
  ] as never);
}

describe("Facebook video metrics (bare Video id)", () => {
  it("makes exactly V1, the post lookup, post insights and V3; never asks for shares or the removed total_video_impressions", async () => {
    const { calls } = routes(fields, reach, views);
    const s = await facebookProvider.metrics!(env, account, VID);
    expect(calls.map((c: { url: string }) => c.url)).toEqual([V1, P0, V2, V3]);
    expect(calls.some((c: { url: string }) => c.url.includes("total_video_impressions"))).toBe(false);
    expect(calls.some((c: { url: string }) => c.url.includes("shares"))).toBe(false);
    expect(s).toMatchObject({ likes: 4, comments: 3, impressions: 120, reach: 80, views: 50, shares: 0 });
    expect(s!.raw).toMatchObject({ sharesSource: "not_available", postId: POST });
    expect([s!.insightsError, s!.insightsUnavailable, s!.externalId]).toEqual([undefined, undefined, undefined]);
  });

  it("no post_id on the Video: falls back to <pageId>_<videoId> with the Page id from the account", async () => {
    const { calls } = routes(fields, reach, views, noPostId);
    const s = await facebookProvider.metrics!({ ...env }, { ...account, meta: { pageId: "105961684676894" } }, VID);
    expect(calls.map((c: { url: string }) => c.url)).toContain(V2);
    expect(s).toMatchObject({ impressions: 120, reach: 80 });
  });

  it("bare post_id from Graph (#12 on the bare id): page-scoped to <pageId>_<postId> (PAR-11965)", async () => {
    const STORY = "1465382822359655";
    const scoped = `https://graph.facebook.com/v21.0/105961684676894_${STORY}/insights`;
    const statuses = () => json({ error: { message: "(#12) singular statuses API is deprecated for versions v2.4 and higher", code: 12 } }, 400);
    const { calls } = mockFetch([
      [`GET ${G}/video_insights`, (url: URL) => (url.searchParams.get("metric") === "total_video_views" ? views() : removedVideoImpressions())],
      [`GET ${scoped}`, reach],
      [`GET https://graph.facebook.com/v21.0/${STORY}/insights`, statuses],
      [`GET ${G}`, (url: URL) => (url.searchParams.get("fields")?.startsWith("post_id") ? json({ id: VID, post_id: STORY }) : fields())],
    ] as never);
    const s = await facebookProvider.metrics!(env, { ...account, meta: { pageId: "105961684676894" } }, VID);
    expect(calls.map((c: { url: string }) => c.url)).toContain(`${scoped}?metric=post_media_view%2Cpost_total_media_view_unique&access_token=TOK`);
    expect(s).toMatchObject({ impressions: 120, reach: 80, views: 50 });
    expect(s!.raw).toMatchObject({ postId: `105961684676894_${STORY}`, owner: { postIdSource: "video.post_id (page-scoped)" } });
    expect([s!.insightsError, s!.insightsUnavailable]).toEqual([undefined, undefined]);
  });

  it("post lookup fails: still reads the fallback post id, and a failed lookup is not an insights error", async () => {
    routes(fields, reach, views, invalidMetric);
    const s = await facebookProvider.metrics!(env, { ...account, externalId: "105961684676894" }, VID);
    expect(s).toMatchObject({ impressions: 120, reach: 80, views: 50 });
    expect([s!.insightsError, s!.insightsUnavailable]).toEqual([undefined, undefined]);
  });

  it("post insights without a row: impressions null and a named insights error, views kept", async () => {
    routes(fields, () => json({ data: [{ name: "post_media_view", values: [{ value: 7 }] }] }), views);
    const s = await facebookProvider.metrics!(env, account, VID);
    expect(s).toMatchObject({ impressions: 7, reach: null, views: 50 });
    expect(s!.insightsError).toBe("post insights: missing post_total_media_view_unique");
  });

  it("V2 permanent 400: views, likes, comments kept; impressions and reach null; insightsUnavailable", async () => {
    routes(fields, invalidMetric, views);
    const s = await facebookProvider.metrics!(env, account, VID);
    expect(s).toMatchObject({ views: 50, likes: 4, comments: 3, shares: 0, impressions: null, reach: null });
    expect(s!.insightsUnavailable).toContain("valid insights metric");
    expect(s!.insightsError).toBeUndefined();
  });

  it("V2 and V3 permanent: likes and comments only", async () => {
    routes(fields, invalidMetric, invalidMetric);
    const s = await facebookProvider.metrics!(env, account, VID);
    expect(s).toMatchObject({ views: 0, likes: 4, comments: 3, impressions: null, reach: null });
    expect(s!.insightsUnavailable).toBeTruthy();
    expect(s!.insightsError).toBeUndefined();
  });

  it("V2 503 is a retryable partial (insightsError)", async () => {
    routes(fields, down, views);
    const s = await facebookProvider.metrics!(env, account, VID);
    expect(s).toMatchObject({ views: 50, impressions: null, reach: null, insightsError: expect.any(String) });
    expect(s!.insightsUnavailable).toBeUndefined();
  });

  it("V1 failure throws as before", async () => {
    routes(invalidMetric, reach, views);
    await expect(facebookProvider.metrics!(env, account, VID)).rejects.toThrow(/Facebook metrics/);
  });
});

// Recorded shapes (PAR-11950): destination 6676b3c4 had impressions/reach NULL and only "missing total_video_views"
// recorded, because the permanent post-insights 4xx went to insightsUnavailable and was never surfaced.
describe("Facebook video metrics: every insights call is recorded (PAR-11950)", () => {
  const badPost = () => json({ error: { message: "(#100) Object with ID '105961684676894_1164596305897468' does not exist, cannot be loaded due to missing permissions, or does not support this operation", type: "GraphMethodException", code: 100, error_subcode: 33 } }, 400);
  const reelsMetrics = () => json({ data: [
    { name: "fb_reels_total_plays", period: "lifetime", values: [{ value: 42 }] },
    { name: "post_impressions_unique", period: "lifetime", values: [{ value: 31 }] },
  ] });

  it("post call 4xx + video call empty: both failures kept, per-call detail in raw, views unavailable (not an error)", async () => {
    const { calls } = routes(fields, badPost, removedVideoImpressions);
    const s = await facebookProvider.metrics!(env, account, VID);
    expect(calls.map((c: { url: string }) => c.url)).toEqual([V1, P0, V2, V3, V4]);
    expect(s).toMatchObject({ likes: 4, comments: 3, views: 0, impressions: null, reach: null });
    expect(s!.insightsError).toBeUndefined();
    expect(s!.insightsUnavailable).toContain("does not exist");
    expect(s!.unavailableReason).toBe("unavailable: Graph offers no view metric for this video (video_insights returned no metrics)");
    expect(s!.raw!.insights).toEqual([
      expect.objectContaining({ label: "post insights", path: `${POST}/insights`, ok: false, status: 400, code: 100 }),
      { label: "video insights", path: `${VID}/video_insights`, metric: "total_video_views", ok: true, returned: [] },
      { label: "video insights (all)", path: `${VID}/video_insights`, metric: null, ok: true, returned: [] },
    ]);
    expect(JSON.stringify(s!.raw)).not.toContain("TOK");
  });

  it("post call ok + video call empty: impressions/reach kept, views from post_media_view, no error", async () => {
    const { calls } = routes(fields, reach, removedVideoImpressions);
    const s = await facebookProvider.metrics!(env, account, VID);
    expect(calls.map((c: { url: string }) => c.url)).toEqual([V1, P0, V2, V3, V4]);
    expect(s).toMatchObject({ impressions: 120, reach: 80, views: 120 });
    expect(s!.raw).toMatchObject({ viewsSource: "post_media_view" });
    expect([s!.insightsError, s!.insightsUnavailable, s!.unavailableReason]).toEqual([undefined, undefined, undefined]);
  });

  it("Reel: total_video_views has no row, the metric-less call offers fb_reels_total_plays and reach", async () => {
    routes(fields, badPost, removedVideoImpressions, () => json({ id: VID, post_id: POST, permalink_url: `https://www.facebook.com/reel/${VID}` }), reelsMetrics);
    const s = await facebookProvider.metrics!(env, account, VID);
    expect(s).toMatchObject({ views: 42, reach: 31, impressions: null });
    expect(s!.raw).toMatchObject({ viewsSource: "fb_reels_total_plays", owner: { postIdSource: "video.post_id", isReel: true } });
    expect(s!.insightsUnavailable).toContain("does not exist");
    expect(s!.unavailableReason).toBeUndefined();
  });

  it("both ok: no metric-less probe, no gaps", async () => {
    const { calls } = routes(fields, reach, views);
    const s = await facebookProvider.metrics!(env, account, VID);
    expect(calls.map((c: { url: string }) => c.url)).not.toContain(V4);
    expect(s).toMatchObject({ impressions: 120, reach: 80, views: 50 });
    expect(s!.raw).toMatchObject({ viewsSource: "total_video_views" });
    expect((s!.raw!.insights as Array<{ ok: boolean }>).every((c) => c.ok)).toBe(true);
  });

  it("video call 503: retried next window, no metric-less probe", async () => {
    const { calls } = routes(fields, reach, down);
    const s = await facebookProvider.metrics!(env, account, VID);
    expect(calls.map((c: { url: string }) => c.url)).not.toContain(V4);
    expect(s).toMatchObject({ impressions: 120, reach: 80, views: 0 });
    expect(s!.insightsError).toBeTruthy();
  });
});

describe("collect-metrics on a Facebook video", () => {
  const publishedAt = new Date(Date.now() - 2 * 3600_000).toISOString();

  async function collect() {
    vi.resetModules();
    vi.doMock("../src/modules.js", () => ({ socialOn: async () => true }));
    vi.doMock("../src/config.js", async (orig) => ({ ...(await orig<object>()), loadSocialConfig: async () => ({ saved: true, companyId: "co" }) }));
    vi.doMock("../src/accounts.js", () => ({ envFor: async () => env }));
    vi.doMock("../src/tokens.js", () => ({ freshAccount: async () => account }));
    const { collectMetricsJob } = await import("../src/metrics.js");
    const dest = { id: "d1", company_id: "co", post_id: "p1", account_id: "a1", platform: "facebook", external_id: VID, published_at: publishedAt, metric_windows: [] };
    const ctx = fakeCtx({}, {
      queryResult: (sql: string) => {
        if (sql.includes("FROM plugin_social_e70c4e79f2.accounts")) return [{ id: "a1", token_enc: "x", status: "connected", meta: {} }];
        if (sql.includes("destinations")) return [dest];
        return [];
      },
    });
    const summary = await collectMetricsJob(ctx, async () => undefined);
    const ex = ctx.fakeDb.executes;
    const insert = ex.find((e) => e.sql.includes("INSERT INTO"));
    const errors = ex.filter((e) => e.sql.includes("jsonb_build_object('metricsError'")).map((e) => JSON.parse(e.params[1] as string));
    const windows = ex.filter((e) => e.sql.includes("metric_windows")).flatMap((e) => JSON.parse(e.params[1] as string) as string[]);
    return { summary, insert, errors, windows };
  }

  it("V2 permanent 400: inserts the row, records an insights error and closes the window", async () => {
    routes(fields, invalidMetric, views);
    const r = await collect();
    expect(r.summary.captured).toBe(1);
    expect(r.insert).toBeTruthy();
    expect(r.errors[0]).toMatchObject({ kind: "insights", window: "1h" });
    expect(r.windows).toContain("1h");
  });

  it("V2 permanent 400 + V3 503: metricsError keeps both messages and the per-call detail", async () => {
    routes(fields, invalidMetric, down);
    const r = await collect();
    expect(r.summary.partial).toBe(1);
    expect(r.errors[0].message).toContain("Service unavailable");
    expect(r.errors[0].message).toContain("valid insights metric");
    expect(r.errors[0].calls).toEqual([
      expect.objectContaining({ label: "post insights", ok: false, status: 400, code: 100 }),
      expect.objectContaining({ label: "video insights", ok: false, status: 503 }),
    ]);
  });

  it("V2 and V3 permanent: row inserted, window closed", async () => {
    routes(fields, invalidMetric, invalidMetric);
    const r = await collect();
    expect(r.insert).toBeTruthy();
    expect(r.errors[0]).toMatchObject({ kind: "insights" });
    expect(r.windows).toContain("1h");
  });

  it("V2 503: partial, window stays open", async () => {
    routes(fields, down, views);
    const r = await collect();
    expect(r.summary.partial).toBe(1);
    expect(r.insert).toBeTruthy();
    expect(r.windows).not.toContain("1h");
  });

  it("V1 failure: no row, error recorded as today", async () => {
    routes(invalidMetric, reach, views);
    const r = await collect();
    expect(r.summary.errors).toBe(1);
    expect(r.insert).toBeUndefined();
    expect(r.errors[0]).toMatchObject({ kind: "provider", status: 400 });
  });
});
