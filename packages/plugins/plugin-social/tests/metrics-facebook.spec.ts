import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeRedirectUri } from "../src/platforms.js";
import { FACEBOOK_SCOPES, facebookProvider } from "../src/oauth/providers/meta.js";
import type { ProviderAccount, ProviderEnv } from "../src/oauth/types.js";
import { fastNetwork, json, mockFetch } from "./helpers.js";

const env: ProviderEnv = { app: { platform: "facebook", clientId: "app-id", clientSecret: "app-secret" }, redirectUri: bridgeRedirectUri("https://paperclip.example.com", "/_plugins/e588ce00-a14b-49fc-b62d-54b0208daafa/ui/") };
const account: ProviderAccount = { id: "a", platform: "facebook", externalId: "p1", handle: null, displayName: "P", meta: {}, token: { accessToken: "SECRET_TOK" } };
const G = "GET https://graph.facebook.com/v21.0/p1_99";
const fields = () => json({ shares: { count: 2 }, comments: { summary: { total_count: 3 } }, reactions: { summary: { total_count: 4 } } });
const isClicks = (url: URL) => url.searchParams.get("metric") === "post_clicks";

beforeEach(() => fastNetwork());
afterEach(() => vi.unstubAllGlobals());

function routes(call1: () => Response, call2: () => Response) {
  return mockFetch([
    [`${G}/insights`, (url: URL) => (isClicks(url) ? call2() : call1())],
    [G, fields],
  ] as never);
}

describe("Facebook metrics", () => {
  it("asks for read_insights", () => expect(FACEBOOK_SCOPES).toContain("read_insights"));

  it("maps the three metrics", async () => {
    const { calls } = routes(
      () => json({ data: [{ name: "post_media_view", values: [{ value: 100 }] }, { name: "post_total_media_view_unique", values: [{ value: 60 }] }] }),
      () => json({ data: [{ name: "post_clicks", values: [{ value: 7 }] }] }),
    );
    const s = await facebookProvider.metrics!(env, account, "p1_99");
    expect(s).toMatchObject({ impressions: 100, views: 100, reach: 60, clicks: 7, likes: 4, comments: 3, shares: 2 });
    expect(s!.insightsError).toBeUndefined();
    expect(calls.filter((c: { url: string }) => c.url.includes("/insights"))).toHaveLength(2);
  });

  it("call 1 error leaves impressions/reach undefined, keeps likes and comments, sanitises the token", async () => {
    routes(
      () => json({ error: { message: "bad https://graph.facebook.com/x?access_token=SECRET_TOK&a=1 access_token=SECRET_TOK", code: 100 } }, 400),
      () => json({ data: [{ name: "post_clicks", values: [{ value: 7 }] }] }),
    );
    const s = await facebookProvider.metrics!(env, account, "p1_99");
    expect(s!.impressions).toBeUndefined();
    expect(s!.reach).toBeUndefined();
    expect(s).toMatchObject({ likes: 4, comments: 3, clicks: 7 });
    expect(s!.insightsError).toBeTruthy();
    expect(s!.insightsError).not.toContain("SECRET_TOK");
  });

  it("missing metric name sets insightsError", async () => {
    routes(() => json({ data: [{ name: "post_media_view", values: [{ value: 5 }] }] }), () => json({ data: [{ name: "post_clicks", values: [{ value: 1 }] }] }));
    const s = await facebookProvider.metrics!(env, account, "p1_99");
    expect(s).toMatchObject({ impressions: 5, insightsError: "insights: missing post_total_media_view_unique" });
    expect(s!.reach).toBeUndefined();
  });

  it("call 2 error alone leaves clicks undefined and impressions intact", async () => {
    routes(
      () => json({ data: [{ name: "post_media_view", values: [{ value: 100 }] }, { name: "post_total_media_view_unique", values: [{ value: 60 }] }] }),
      () => json({ error: { message: "invalid metric", code: 100 } }, 400),
    );
    const s = await facebookProvider.metrics!(env, account, "p1_99");
    expect(s).toMatchObject({ impressions: 100, reach: 60 });
    expect(s!.clicks).toBeUndefined();
    expect(s!.insightsError).toBeTruthy();
  });
});
