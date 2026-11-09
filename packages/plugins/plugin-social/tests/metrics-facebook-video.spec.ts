import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { facebookProvider } from "../src/oauth/providers/meta.js";
import type { ProviderAccount, ProviderEnv } from "../src/oauth/types.js";
import { fakeCtx, fastNetwork, json, mockFetch } from "./helpers.js";

const env: ProviderEnv = { app: { platform: "facebook", clientId: "app-id", clientSecret: "app-secret" }, redirectUri: "https://paperclip.example.com/cb" };
const account: ProviderAccount = { id: "a1", platform: "facebook", externalId: "p1", handle: null, displayName: "P", meta: {}, token: { accessToken: "TOK" } };
const VID = "1164596305897468";
const G = `https://graph.facebook.com/v21.0/${VID}`;
const V1 = `${G}?fields=comments.summary%28true%29.limit%280%29%2Clikes.summary%28true%29.limit%280%29&access_token=TOK`;
const V2 = `${G}/video_insights?metric=total_video_impressions%2Ctotal_video_impressions_unique&period=lifetime&access_token=TOK`;
const V3 = `${G}/video_insights?metric=total_video_views&period=lifetime&access_token=TOK`;

const fields = () => json({ id: VID, comments: { summary: { total_count: 3 } }, likes: { summary: { total_count: 4 } } });
const reach = () => json({ data: [{ name: "total_video_impressions", values: [{ value: 120 }] }, { name: "total_video_impressions_unique", values: [{ value: 80 }] }] });
const views = () => json({ data: [{ name: "total_video_views", values: [{ value: 50 }] }] });
const invalidMetric = () => json({ error: { message: "(#100) The value must be a valid insights metric", code: 100 } }, 400);
const down = () => json({ error: { message: "Service unavailable" } }, 503);

beforeEach(() => fastNetwork());
afterEach(() => vi.unstubAllGlobals());

function routes(v1: () => Response, v2: () => Response, v3: () => Response) {
  return mockFetch([
    [`GET ${G}/video_insights`, (url: URL) => (url.searchParams.get("metric") === "total_video_views" ? v3() : v2())],
    [`GET ${G}`, v1],
  ] as never);
}

describe("Facebook video metrics (bare Video id)", () => {
  it("makes exactly V1, V2, V3 and never asks for shares", async () => {
    const { calls } = routes(fields, reach, views);
    const s = await facebookProvider.metrics!(env, account, VID);
    expect(calls.map((c: { url: string }) => c.url)).toEqual([V1, V2, V3]);
    expect(calls.some((c: { url: string }) => c.url.includes("shares"))).toBe(false);
    expect(s).toMatchObject({ likes: 4, comments: 3, impressions: 120, reach: 80, views: 50, shares: 0 });
    expect(s!.raw).toMatchObject({ sharesSource: "not_available" });
    expect([s!.insightsError, s!.insightsUnavailable, s!.externalId]).toEqual([undefined, undefined, undefined]);
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
