/**
 * The platform adapters against a scripted `fetch`: what they send (URLs, headers, bodies), how they read what comes back, what they refuse,
 * and that no token ever travels in a URL or lands in an error message. Nothing here talks to Meta or Google.
 */
import { describe, expect, it } from "vitest";
import { AdsError } from "../src/domain.js";
import { googleProvider, GOOGLE_SCOPE } from "../src/providers/google.js";
import { ProviderError, platformMessage, redactSecrets } from "../src/providers/http.js";
import { conversionOf, DEFAULT_CONVERSION_ACTIONS, metaProvider } from "../src/providers/meta.js";
import type { ProviderApp, ProviderEnv } from "../src/providers/types.js";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Reply = { status?: number; body: unknown } | ((seen: Seen) => { status?: number; body: unknown });

/** A fetch that answers from a list of [matcher, reply] pairs, in order of first match, and records every request. */
function scripted(routes: Array<[RegExp, Reply]>): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const s: Seen = { url: String(input), method: String(init?.method ?? "GET"), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: init?.body as string | undefined };
    seen.push(s);
    const hit = routes.find(([re]) => re.test(`${s.method} ${s.url}`));
    if (!hit) return new Response(JSON.stringify({ error: { message: `no route for ${s.method} ${s.url}` } }), { status: 599 });
    const reply = typeof hit[1] === "function" ? hit[1](s) : hit[1];
    return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const metaApp = (extra: Partial<ProviderApp> = {}): ProviderApp => ({ platform: "meta", clientId: "app-1", clientSecret: "meta-secret-value", ...extra });
const googleApp = (extra: Partial<ProviderApp> = {}): ProviderApp => ({ platform: "google", clientId: "g-client", clientSecret: "google-secret-value", ...extra });
const env = (app: ProviderApp, fetchImpl?: typeof fetch): ProviderEnv => ({ app, redirectUri: "https://paperclip.example.test/_plugins/uuid/ui/oauth-callback.html", ...(fetchImpl ? { fetchImpl } : {}) });
// Token-shaped values are built when the test runs, never written as literals: GitHub push protection refuses a push whose files hold something
// shaped like a Meta or Google token, even a made-up one.
const fakeToken = (prefix: string, rest: string) => [prefix, rest].join("");
const META_TOKEN = fakeToken("EAAB", "-token-never-in-a-url-0123456789abcdef");
const GOOGLE_ACCESS = fakeToken("ya29", ".access-token-0123456789");
const GOOGLE_FRESH = fakeToken("ya29", ".fresh-token-0123456789");
const token = { accessToken: META_TOKEN };
const accountRef = { externalId: "123456", currency: "ZAR", loginCustomerId: null, conversionActions: [] as string[] };

describe("Meta: signing in", () => {
  it("asks for read access only unless the settings ask for the change permission", () => {
    const read = metaProvider.authorize(env(metaApp()), "state-1");
    const url = new URL(read.url);
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v25.0/dialog/oauth");
    expect(url.searchParams.get("scope")).toBe("ads_read");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("client_id")).toBe("app-1");
    expect(url.searchParams.get("redirect_uri")).toContain("oauth-callback.html");
    expect(read.scopes).toEqual(["ads_read"]);
    const write = metaProvider.authorize(env(metaApp({ requestWrite: true })), "s");
    expect(new URL(write.url).searchParams.get("scope")).toBe("ads_read,ads_management");
    expect(new URL(metaProvider.authorize(env(metaApp({ apiVersion: "26.0" })), "s").url).pathname).toBe("/v26.0/dialog/oauth");
  });

  it("exchanges the code for a long-lived token and learns whether the change permission was granted, without the token in any URL", async () => {
    const { fetchImpl, seen } = scripted([
      [/oauth\/access_token\?.*code=abc/, { body: { access_token: "short-lived-token-0123456789" } }],
      [/oauth\/access_token\?.*fb_exchange_token=/, { body: { access_token: token.accessToken, expires_in: 5_184_000 } }],
      [/GET .*\/me\?fields=id%2Cname/, { body: { id: "u-42", name: "Pat Person" } }],
      [/GET .*\/me\/permissions/, { body: { data: [{ permission: "ads_read", status: "granted" }, { permission: "ads_management", status: "granted" }, { permission: "business_management", status: "declined" }] } }],
    ]);
    const result = await metaProvider.exchange(env(metaApp(), fetchImpl), { code: "abc" });
    expect(result).toMatchObject({ label: "Pat Person (Meta)", externalUserId: "u-42", canWrite: true, scopes: ["ads_read", "ads_management"] });
    expect(result.token.accessToken).toBe(token.accessToken);
    expect(Date.parse(result.token.expiresAt!)).toBeGreaterThan(Date.now() + 50 * 86_400_000);
    // Calls made with the token carry it in the header, never the URL.
    for (const s of seen.filter((x) => /\/me/.test(x.url))) {
      expect(s.url).not.toContain(token.accessToken);
      expect(s.headers.Authorization).toBe(`Bearer ${token.accessToken}`);
    }
    const read = scripted([
      [/access_token/, { body: { access_token: "t-0123456789abcdefgh" } }],
      [/\/me\?/, { body: { id: "u", name: "A" } }],
      [/permissions/, { body: { data: [{ permission: "ads_read", status: "granted" }] } }],
    ]);
    expect((await metaProvider.exchange(env(metaApp(), read.fetchImpl), { code: "c" })).canWrite).toBe(false);
  });

  it("refuses to continue without a code", async () => {
    await expect(metaProvider.exchange(env(metaApp()), {})).rejects.toThrow(/authorization code/);
  });
});

describe("Meta: reading", () => {
  it("lists ad accounts across pages without ever using Meta's next link (it carries the token)", async () => {
    const { fetchImpl, seen } = scripted([
      [/\/me\/adaccounts\?(?!.*after=)/, { body: { data: [{ id: "act_1", account_id: "1", name: "Acme", currency: "zar", timezone_name: "Africa/Johannesburg", account_status: 1, business: { name: "Acme Ltd" } }], paging: { cursors: { after: "CUR1" }, next: "https://graph.facebook.com/v25.0/me/adaccounts?access_token=LEAKED-TOKEN-0123456789&after=CUR1" } } }],
      [/\/me\/adaccounts\?.*after=CUR1/, { body: { data: [{ id: "act_2", account_id: "2", name: "Old", currency: "USD", account_status: 2 }] } }],
    ]);
    const accounts = await metaProvider.listAccounts(env(metaApp(), fetchImpl), token);
    expect(accounts.map((a) => [a.externalId, a.currency, a.status, a.business])).toEqual([["1", "ZAR", "active", "Acme Ltd"], ["2", "USD", "disabled", null]]);
    expect(seen).toHaveLength(2);
    expect(seen.some((s) => s.url.includes("LEAKED-TOKEN"))).toBe(false);
  });

  it("reads campaign insights one row per day and turns spend into minor units", async () => {
    const { fetchImpl, seen } = scripted([
      [/\/act_123456\/insights\?/, { body: { data: [
        { campaign_id: "c1", campaign_name: "Leads", date_start: "2026-10-14", spend: "123.45", impressions: "10000", clicks: "250", account_currency: "ZAR", actions: [{ action_type: "link_click", value: "250" }, { action_type: "lead", value: "7" }], action_values: [{ action_type: "lead", value: "700.50" }] },
        { campaign_id: "c1", campaign_name: "Leads", date_start: "not-a-date", spend: "1" },
        { campaign_id: "", date_start: "2026-10-14", spend: "1" },
      ] } }],
    ]);
    const rows = await metaProvider.insights(env(metaApp(), fetchImpl), token, accountRef, { since: "2026-10-12", until: "2026-10-14" });
    expect(rows).toEqual([{ campaignExternalId: "c1", campaignName: "Leads", day: "2026-10-14", spendMinor: 12_345, impressions: 10_000, clicks: 250, conversions: 7, valueMinor: 70_050 }]);
    const url = new URL(seen[0]!.url);
    expect(url.searchParams.get("level")).toBe("campaign");
    expect(url.searchParams.get("time_increment")).toBe("1");
    expect(JSON.parse(url.searchParams.get("time_range")!)).toEqual({ since: "2026-10-12", until: "2026-10-14" });
    expect(seen[0]!.headers.Authorization).toBe(`Bearer ${token.accessToken}`);
    expect(seen[0]!.url).not.toContain(token.accessToken);
  });

  it("an answer with more pages than we follow fails the read: a part must never pass for the whole (the sync would zero what it did not see)", async () => {
    let calls = 0;
    const endless = scripted([[/\/act_123456\/insights\?/, () => ({ body: { data: [{ campaign_id: "c1", campaign_name: "Leads", date_start: "2026-10-14", spend: "1", impressions: "1", clicks: "1", account_currency: "ZAR" }], paging: { cursors: { after: `CUR${(calls += 1)}` }, next: "https://graph.facebook.com/next" } } })]]);
    const error = await metaProvider.insights(env(metaApp(), endless.fetchImpl), token, accountRef, { since: "2026-10-12", until: "2026-10-14" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toMatch(/more than 40 pages.*incomplete/);
    expect(endless.seen).toHaveLength(40);
    // The last page of a long but finite answer is still read in full.
    let n = 0;
    const finite = scripted([[/\/act_123456\/insights\?/, () => ({ body: { data: [{ campaign_id: "c1", campaign_name: "Leads", date_start: "2026-10-14", spend: "1", impressions: "1", clicks: "1", account_currency: "ZAR" }], ...((n += 1) < 40 ? { paging: { cursors: { after: `CUR${n}` }, next: "https://graph.facebook.com/next" } } : {}) } })]]);
    expect(await metaProvider.insights(env(metaApp(), finite.fetchImpl), token, accountRef, { since: "2026-10-12", until: "2026-10-14" })).toHaveLength(40);
  });

  it("counts one result type per row, never several that overlap", () => {
    const row = { actions: [{ action_type: "omni_purchase", value: "3" }, { action_type: "purchase", value: "3" }, { action_type: "offsite_conversion.fb_pixel_purchase", value: "3" }, { action_type: "lead", value: "9" }], action_values: [{ action_type: "omni_purchase", value: "300" }, { action_type: "purchase", value: "300" }] };
    expect(conversionOf(row, "ZAR", [])).toEqual({ conversions: 3, valueMinor: 30_000 });
    expect(conversionOf(row, "ZAR", ["lead"])).toEqual({ conversions: 9, valueMinor: 0 });
    expect(conversionOf({ actions: [{ action_type: "link_click", value: "5" }] }, "ZAR", [])).toEqual({ conversions: 0, valueMinor: 0 });
    expect(DEFAULT_CONVERSION_ACTIONS[0]).toBe("omni_purchase");
  });

  it("maps campaign status and budgets (budgets are already minor units)", async () => {
    const { fetchImpl } = scripted([[/\/act_123456\/campaigns\?/, { body: { data: [
      { id: "c1", name: "A", objective: "OUTCOME_LEADS", effective_status: "ACTIVE", daily_budget: "15000" },
      { id: "c2", name: "B", effective_status: "CAMPAIGN_PAUSED", lifetime_budget: "90000" },
      { id: "c3", name: "C", effective_status: "WITH_ISSUES" },
    ] } }]]);
    const campaigns = await metaProvider.listCampaigns(env(metaApp(), fetchImpl), token, accountRef);
    expect(campaigns.map((c) => [c.externalId, c.status, c.dailyBudgetMinor, c.lifetimeBudgetMinor])).toEqual([["c1", "active", 15_000, null], ["c2", "paused", null, 90_000], ["c3", "other", null, null]]);
  });
});

describe("Meta: changing (only ever called from an approved proposal)", () => {
  it("creates a campaign PAUSED with its budget and the special-ad-category field Meta requires", async () => {
    const { fetchImpl, seen } = scripted([[/POST .*\/act_123456\/campaigns$/, { body: { id: "cmp-99" } }]]);
    const made = await metaProvider.createCampaign(env(metaApp(), fetchImpl), token, accountRef, { name: "Spring leads", objective: "OUTCOME_LEADS", dailyBudgetMinor: 15_000, specialAdCategories: [] });
    expect(made).toEqual({ externalId: "cmp-99", name: "Spring leads" });
    const body = new URLSearchParams(seen[0]!.body);
    expect(body.get("status")).toBe("PAUSED");
    expect(body.get("special_ad_categories")).toBe("[]");
    expect(body.get("daily_budget")).toBe("15000");
    expect(body.get("objective")).toBe("OUTCOME_LEADS");
    expect(seen[0]!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(seen[0]!.body).not.toContain(token.accessToken);
  });

  it("sets status and refuses a budget change it cannot make, before asking Meta to change anything", async () => {
    const status = scripted([[/POST .*\/cmp-1$/, { body: { success: true } }]]);
    await metaProvider.setCampaignStatus(env(metaApp(), status.fetchImpl), token, accountRef, "cmp-1", "paused");
    expect(new URLSearchParams(status.seen[0]!.body).get("status")).toBe("PAUSED");

    const lifetime = scripted([[/GET .*\/cmp-1\?/, { body: { lifetime_budget: "100000" } }]]);
    await expect(metaProvider.setCampaignBudget(env(metaApp(), lifetime.fetchImpl), token, accountRef, "cmp-1", 20_000)).rejects.toThrow(/lifetime budget/);
    expect(lifetime.seen.every((s) => s.method === "GET")).toBe(true);

    const adset = scripted([[/GET .*\/cmp-1\?/, { body: {} }]]);
    await expect(metaProvider.setCampaignBudget(env(metaApp(), adset.fetchImpl), token, accountRef, "cmp-1", 20_000)).rejects.toBeInstanceOf(AdsError);

    const ok = scripted([[/GET .*\/cmp-1\?/, { body: { daily_budget: "10000" } }], [/POST .*\/cmp-1$/, { body: { success: true } }]]);
    await metaProvider.setCampaignBudget(env(metaApp(), ok.fetchImpl), token, accountRef, "cmp-1", 20_000);
    expect(new URLSearchParams(ok.seen[1]!.body).get("daily_budget")).toBe("20000");
  });
});

describe("Google Ads: signing in", () => {
  it("asks for the Ads scope with a refresh token (offline access, consent each time)", () => {
    const { url, scopes } = googleProvider.authorize(env(googleApp()), "st");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")).toBe(GOOGLE_SCOPE);
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("state")).toBe("st");
    expect(scopes).toEqual([GOOGLE_SCOPE]);
  });

  it("keeps the refresh token, and says what to do when Google sends none", async () => {
    const ok = scripted([[/POST https:\/\/oauth2\.googleapis\.com\/token/, { body: { access_token: GOOGLE_ACCESS, refresh_token: "1//refresh-0123456789", expires_in: 3599, scope: GOOGLE_SCOPE } }]]);
    const result = await googleProvider.exchange(env(googleApp(), ok.fetchImpl), { code: "abc" });
    expect(result.token).toMatchObject({ accessToken: GOOGLE_ACCESS, refreshToken: "1//refresh-0123456789" });
    expect(new URLSearchParams(ok.seen[0]!.body)).toMatchObject({});
    expect(new URLSearchParams(ok.seen[0]!.body).get("grant_type")).toBe("authorization_code");
    const none = scripted([[/token/, { body: { access_token: GOOGLE_ACCESS, expires_in: 3599 } }]]);
    await expect(googleProvider.exchange(env(googleApp(), none.fetchImpl), { code: "abc" })).rejects.toThrow(/refresh token/);
  });

  it("refreshes an access token, and a revoked one means signing in again", async () => {
    const ok = scripted([[/token/, { body: { access_token: GOOGLE_FRESH, expires_in: 3599 } }]]);
    const fresh = await googleProvider.refresh(env(googleApp(), ok.fetchImpl), { accessToken: "old", refreshToken: "1//r" });
    expect(fresh).toMatchObject({ accessToken: GOOGLE_FRESH, refreshToken: "1//r" });
    const revoked = scripted([[/token/, { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }]]);
    const error = await googleProvider.refresh(env(googleApp(), revoked.fetchImpl), { accessToken: "old", refreshToken: "1//r" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).tokenInvalid).toBe(true);
  });
});

describe("Google Ads: reading", () => {
  const gToken = { accessToken: GOOGLE_ACCESS };

  it("lists the accounts a sign-in can see, with a manager's client accounts addressed through the manager", async () => {
    const { fetchImpl, seen } = scripted([
      [/GET .*customers:listAccessibleCustomers/, { body: { resourceNames: ["customers/111", "customers/222"] } }],
      [/POST .*customers\/111\/googleAds:search/, (s) => ({ body: /customer_client/.test(s.body ?? "") ? { results: [{ customerClient: { id: "333", descriptiveName: "Client A", currencyCode: "ZAR", timeZone: "Africa/Johannesburg", status: "ENABLED" } }] } : { results: [{ customer: { id: "111", descriptiveName: "Agency MCC", currencyCode: "USD", timeZone: "UTC", manager: true, status: "ENABLED" } }] } })],
      [/POST .*customers\/222\/googleAds:search/, { body: { results: [{ customer: { id: "222", descriptiveName: "Own account", currencyCode: "EUR", timeZone: "Europe/Berlin", manager: false, status: "ENABLED" } }] } }],
    ]);
    const accounts = await googleProvider.listAccounts(env(googleApp(), fetchImpl), gToken);
    expect(accounts.map((a) => [a.externalId, a.name, a.currency, a.loginCustomerId])).toEqual([["333", "Client A", "ZAR", "111"], ["222", "Own account", "EUR", null]]);
    const child = seen.find((s) => /customer_client/.test(s.body ?? ""))!;
    expect(child.headers["login-customer-id"]).toBe("111");
    expect(child.headers.Authorization).toBe(`Bearer ${gToken.accessToken}`);
    expect(seen.every((s) => !s.url.includes(gToken.accessToken))).toBe(true);
    expect(seen.every((s) => !("developer-token" in s.headers))).toBe(true);
  });

  it("sends the legacy developer token only when one is saved", async () => {
    const { fetchImpl, seen } = scripted([[/listAccessibleCustomers/, { body: { resourceNames: [] } }]]);
    await googleProvider.listAccounts(env(googleApp({ developerToken: "DEVTOKEN123456789012" }), fetchImpl), gToken);
    expect(seen[0]!.headers["developer-token"]).toBe("DEVTOKEN123456789012");
  });

  it("reads campaign metrics by day with a GAQL query for the dates and converts micros to minor units", async () => {
    const page1 = { results: [{ campaign: { id: "8", name: "Search" }, segments: { date: "2026-10-14" }, metrics: { costMicros: "123450000", impressions: "5000", clicks: "250", conversions: 7.5, conversionsValue: 700.5 } }, { campaign: { id: "x" }, segments: {}, metrics: {} }], nextPageToken: "PAGE2" };
    const page2 = { results: [{ campaign: { id: "9", name: "Brand" }, segments: { date: "2026-10-14" }, metrics: { costMicros: "5000000", impressions: "100", clicks: "10", conversions: 0, conversionsValue: 0 } }] };
    const { fetchImpl, seen } = scripted([[/POST .*customers\/123456\/googleAds:search/, (s) => ({ body: JSON.parse(s.body!).pageToken ? page2 : page1 })]]);
    const rows = await googleProvider.insights(env(googleApp(), fetchImpl), gToken, accountRef, { since: "2026-10-12", until: "2026-10-14" });
    expect(rows).toEqual([
      { campaignExternalId: "8", campaignName: "Search", day: "2026-10-14", spendMinor: 12_345, impressions: 5000, clicks: 250, conversions: 7.5, valueMinor: 70_050 },
      { campaignExternalId: "9", campaignName: "Brand", day: "2026-10-14", spendMinor: 500, impressions: 100, clicks: 10, conversions: 0, valueMinor: 0 },
    ]);
    const query = JSON.parse(seen[0]!.body!).query as string;
    expect(query).toContain("FROM campaign");
    expect(query).toContain("segments.date BETWEEN '2026-10-12' AND '2026-10-14'");
    expect(query).toContain("metrics.cost_micros");
    expect(seen).toHaveLength(2);
  });

  it("an answer with more pages than we follow fails the read here too", async () => {
    let calls = 0;
    const endless = scripted([[/POST .*customers\/123456\/googleAds:search/, () => ({ body: { results: [{ campaign: { id: "8", name: "Search" }, segments: { date: "2026-10-14" }, metrics: { costMicros: "1000000", impressions: "1", clicks: "1", conversions: 0, conversionsValue: 0 } }], nextPageToken: `P${(calls += 1)}` } })]]);
    await expect(googleProvider.insights(env(googleApp(), endless.fetchImpl), gToken, accountRef, { since: "2026-10-12", until: "2026-10-14" })).rejects.toThrow(/more than 20 pages.*incomplete/);
    expect(endless.seen).toHaveLength(20);
  });

  it("maps campaign status and the budget in micros", async () => {
    const { fetchImpl } = scripted([[/googleAds:search/, { body: { results: [
      { campaign: { id: "1", name: "On", status: "ENABLED", advertisingChannelType: "SEARCH" }, campaignBudget: { amountMicros: "150000000" } },
      { campaign: { id: "2", name: "Off", status: "PAUSED" } },
    ] } }]]);
    const campaigns = await googleProvider.listCampaigns(env(googleApp(), fetchImpl), gToken, accountRef);
    expect(campaigns.map((c) => [c.externalId, c.status, c.channel, c.dailyBudgetMinor])).toEqual([["1", "active", "SEARCH", 15_000], ["2", "paused", null, null]]);
  });
});

describe("Google Ads: changing (only ever called from an approved proposal)", () => {
  const gToken = { accessToken: GOOGLE_ACCESS };
  const ref = { ...accountRef, externalId: "555-666-7777", loginCustomerId: "111-222-3333" };

  it("creates the budget and a PAUSED search campaign in one atomic request", async () => {
    const { fetchImpl, seen } = scripted([[/POST .*googleAds:mutate/, { body: { mutateOperationResponses: [{ campaignBudgetResult: { resourceName: "customers/5556667777/campaignBudgets/1" } }, { campaignResult: { resourceName: "customers/5556667777/campaigns/4242" } }] } }]]);
    const made = await googleProvider.createCampaign(env(googleApp(), fetchImpl), gToken, ref, { name: "Brand search", objective: "SEARCH", dailyBudgetMinor: 15_000 });
    expect(made).toEqual({ externalId: "4242", name: "Brand search" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain("/customers/5556667777/googleAds:mutate");
    expect(seen[0]!.headers["login-customer-id"]).toBe("1112223333");
    const ops = JSON.parse(seen[0]!.body!).mutateOperations;
    expect(ops[0].campaignBudgetOperation.create).toMatchObject({ amountMicros: "150000000", deliveryMethod: "STANDARD", explicitlyShared: false });
    expect(ops[1].campaignOperation.create).toMatchObject({ status: "PAUSED", advertisingChannelType: "SEARCH", containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING" });
    expect(ops[1].campaignOperation.create.campaignBudget).toBe(ops[0].campaignBudgetOperation.create.resourceName);
  });

  it("changes status with an update mask", async () => {
    const { fetchImpl, seen } = scripted([[/campaigns:mutate/, { body: { results: [{}] } }]]);
    await googleProvider.setCampaignStatus(env(googleApp(), fetchImpl), gToken, ref, "4242", "paused");
    expect(JSON.parse(seen[0]!.body!).operations[0]).toEqual({ updateMask: "status", update: { resourceName: "customers/5556667777/campaigns/4242", status: "PAUSED" } });
    await googleProvider.setCampaignStatus(env(googleApp(), fetchImpl), gToken, ref, "4242", "active");
    expect(JSON.parse(seen[1]!.body!).operations[0].update.status).toBe("ENABLED");
  });

  it("refuses a budget shared with other campaigns, and otherwise updates the amount in micros", async () => {
    const shared = scripted([[/googleAds:search/, { body: { results: [{ campaign: { campaignBudget: "customers/1/campaignBudgets/9" }, campaignBudget: { explicitlyShared: true, referenceCount: 3 } }] } }]]);
    await expect(googleProvider.setCampaignBudget(env(googleApp(), shared.fetchImpl), gToken, ref, "4242", 20_000)).rejects.toThrow(/shares its budget/);
    expect(shared.seen.every((s) => !/campaignBudgets:mutate/.test(s.url))).toBe(true);
    const own = scripted([
      [/googleAds:search/, { body: { results: [{ campaign: { campaignBudget: "customers/5556667777/campaignBudgets/9" }, campaignBudget: { explicitlyShared: false, referenceCount: 1 } }] } }],
      [/campaignBudgets:mutate/, { body: {} }],
    ]);
    await googleProvider.setCampaignBudget(env(googleApp(), own.fetchImpl), gToken, ref, "4242", 20_000);
    expect(JSON.parse(own.seen[1]!.body!).operations[0]).toEqual({ updateMask: "amount_micros", update: { resourceName: "customers/5556667777/campaignBudgets/9", amountMicros: "200000000" } });
  });
});

describe("errors never leak a token and say what happened", () => {
  it("reads Meta, Google and OAuth error shapes", () => {
    expect(platformMessage(JSON.stringify({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }))).toMatchObject({ message: "Invalid OAuth access token.", tokenInvalid: true });
    expect(platformMessage(JSON.stringify({ error: { message: "Rate limit", type: "OAuthException", code: 17, is_transient: true } }))).toMatchObject({ transient: true, tokenInvalid: false });
    expect(platformMessage(JSON.stringify({ error: { code: 401, message: "x", status: "UNAUTHENTICATED" } }))).toMatchObject({ tokenInvalid: true });
    expect(platformMessage(JSON.stringify({ error: { code: 429, message: "x", status: "RESOURCE_EXHAUSTED" } }))).toMatchObject({ transient: true });
    expect(platformMessage(JSON.stringify({ error: { code: 400, message: "outer", status: "INVALID_ARGUMENT", details: [{ errors: [{ message: "Budget is too low.", errorCode: {} }] }] } }))).toMatchObject({ message: "Budget is too low." });
    expect(platformMessage(JSON.stringify({ error: "invalid_grant", error_description: "revoked" }))).toMatchObject({ tokenInvalid: true });
    expect(platformMessage("<html>")).toMatchObject({ message: null });
  });

  it("classifies an HTTP failure and removes anything token-shaped from its message", async () => {
    const down = scripted([[/insights/, { status: 503, body: { error: { message: `Service down for access_token=${token.accessToken} and Bearer ${token.accessToken}` } } }]]);
    const error = (await metaProvider.insights(env(metaApp(), down.fetchImpl), token, accountRef, { since: "2026-10-01", until: "2026-10-02" }).catch((e: unknown) => e)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
    expect(error.tokenInvalid).toBe(false);
    expect(error.message).not.toContain(token.accessToken);
    expect(error.message).toContain("[redacted]");
    const expired = scripted([[/insights/, { status: 400, body: { error: { message: "Error validating access token", type: "OAuthException", code: 190 } } }]]);
    const e2 = (await metaProvider.insights(env(metaApp(), expired.fetchImpl), token, accountRef, { since: "2026-10-01", until: "2026-10-02" }).catch((e: unknown) => e)) as ProviderError;
    expect(e2.tokenInvalid).toBe(true);
    expect(e2.retryable).toBe(false);
  });

  it("redacts keys, bearer tokens and Meta and Google token shapes", () => {
    const google = fakeToken("ya29", ".abcdefghijklmnopqrstuvwxyz");
    const meta = fakeToken("EAAG", "abcdefghijklmnopqrstuvwxyz");
    const text = redactSecrets(`client_secret=abc123 refresh_token=1//xyz Bearer ${google} ${meta} fine`);
    expect(text).not.toMatch(/abc123|1\/\/xyz|ya29\.abc|EAAGabc/);
    expect(text).toContain("fine");
  });
});
