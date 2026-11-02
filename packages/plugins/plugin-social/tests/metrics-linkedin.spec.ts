import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeRedirectUri } from "../src/platforms.js";
import { linkedinProvider } from "../src/oauth/providers/linkedin.js";
import type { ProviderAccount, ProviderEnv } from "../src/oauth/types.js";
import { fastNetwork, json, mockFetch } from "./helpers.js";

const env: ProviderEnv = { app: { platform: "linkedin", clientId: "id", clientSecret: "secret", apiVersion: "202601" }, redirectUri: bridgeRedirectUri("https://paperclip.example.com", "/_plugins/e588ce00-a14b-49fc-b62d-54b0208daafa/ui/") };
const ORG = "urn:li:organization:2414183";
const account: ProviderAccount = { id: "a", platform: "linkedin", externalId: "2414183", handle: null, displayName: "Org", meta: { authorUrn: ORG, kind: "organization" }, token: { accessToken: "SECRET_TOK" } };
const SHARE = "urn:li:share:7132564752928563200";
const UGC = "urn:li:ugcPost:7132564752928563201";
const BASE = "https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=urn%3Ali%3Aorganization%3A2414183";
const stats = { totalShareStatistics: { impressionCount: 100, uniqueImpressionsCount: 60, clickCount: 7, likeCount: 4, commentCount: 3, shareCount: 2 } };
const actions = () => json({ likesSummary: { totalLikes: 9 }, commentsSummary: { aggregatedTotalComments: 8 } });

beforeEach(() => fastNetwork());
afterEach(() => vi.unstubAllGlobals());

function route(statsRes: () => Response, actionsRes: () => Response = actions) {
  return mockFetch([
    ["GET https://api.linkedin.com/rest/organizationalEntityShareStatistics", statsRes],
    ["GET https://api.linkedin.com/rest/socialActions/", actionsRes],
  ] as never);
}
const statsUrl = (calls: Array<{ url: string }>) => calls.find((c) => c.url.includes("organizationalEntityShareStatistics"))!.url;

describe("LinkedIn organization metrics", () => {
  it("share path: exact URL, mapped element", async () => {
    const { calls } = route(() => json({ elements: [{ share: SHARE, ...stats }] }));
    const s = await linkedinProvider.metrics!(env, account, SHARE);
    expect(statsUrl(calls)).toBe(`${BASE}&shares=List(urn%3Ali%3Ashare%3A7132564752928563200)`);
    expect(calls[0]!.headers.get("X-Restli-Protocol-Version")).toBe("2.0.0");
    expect(s).toMatchObject({ impressions: 100, views: 100, reach: 60, clicks: 7, likes: 4, comments: 3, shares: 2 });
    expect(s!.insightsError).toBeUndefined();
  });

  it("ugcPost path", async () => {
    const { calls } = route(() => json({ elements: [{ ugcPost: UGC, ...stats }] }));
    const s = await linkedinProvider.metrics!(env, account, UGC);
    expect(statsUrl(calls)).toBe(`${BASE}&ugcPosts=List(urn%3Ali%3AugcPost%3A7132564752928563201)`);
    expect(s).toMatchObject({ impressions: 100, reach: 60 });
  });

  it("organizationBrand author is accepted", async () => {
    const { calls } = route(() => json({ elements: [{ share: SHARE, ...stats }] }));
    await linkedinProvider.metrics!(env, { ...account, meta: { authorUrn: "urn:li:organizationBrand:5" } }, SHARE);
    expect(statsUrl(calls)).toContain("organizationalEntity=urn%3Ali%3AorganizationBrand%3A5&");
  });

  it("unknown prefix: no stats call, socialActions only, insightsError", async () => {
    const { calls } = route(() => json({ elements: [] }));
    const s = await linkedinProvider.metrics!(env, account, "urn:li:activity:1");
    expect(calls.some((c) => c.url.includes("organizationalEntityShareStatistics"))).toBe(false);
    expect(s).toMatchObject({ likes: 9, comments: 8, insightsError: "unsupported LinkedIn URN urn:li:activity" });
    expect(s!.impressions).toBeUndefined();
  });

  it("no matching element: undefined values and insightsError, never zeros", async () => {
    route(() => json({ elements: [{ share: "urn:li:share:other", ...stats }] }));
    const s = await linkedinProvider.metrics!(env, account, SHARE);
    expect(s!.impressions).toBeUndefined();
    expect(s!.reach).toBeUndefined();
    expect(s!.clicks).toBeUndefined();
    expect(s!.insightsError).toBe(`share statistics: no element for ${SHARE}`);
    expect(s).toMatchObject({ likes: 9, comments: 8 });
  });

  it("HTTP 400 sets insightsError without throwing and without secrets", async () => {
    route(() => json({ message: "bad https://api.linkedin.com/x?access_token=SECRET_TOK&a=1" }, 400));
    const s = await linkedinProvider.metrics!(env, account, SHARE);
    expect(s!.impressions).toBeUndefined();
    expect(s!.insightsError).toBeTruthy();
    expect(s!.insightsError).not.toContain("SECRET_TOK");
    expect(s!.insightsError).not.toContain("?");
  });

  it("socialActions 403 does not fail the org snapshot", async () => {
    route(() => json({ elements: [{ share: SHARE, totalShareStatistics: { impressionCount: 5 } }] }), () => json({ message: "forbidden" }, 403));
    const s = await linkedinProvider.metrics!(env, account, SHARE);
    expect(s).toMatchObject({ impressions: 5, likes: 0, comments: 0 });
    expect(s!.insightsError).toBeUndefined();
  });
});
