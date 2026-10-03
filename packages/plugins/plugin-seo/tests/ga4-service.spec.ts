import { describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { completedWeeks } from "../src/engine/analytics.js";
import { ga4AccessItem, ga4ApiItem } from "../src/engine/items.js";
import { companyInfo } from "../src/service/common.js";
import { connectGa4, connectGa4Tool, ga4Daily, ga4ForSnapshot, ga4Summary, listGa4SummaryTool, propertyIdOf } from "../src/service/analytics.js";
import { addNeedsYou, checkNeedsYouItem } from "../src/service/needs-you.js";
import { executed, integrationRow, needsYouRoutes, SA_EMAIL, savedNeedsYouItems, seoHost, sprintRoutes, type Route } from "./helpers/seo-host.js";

const DATA_ERR = (status: number, message: string, reason?: string) =>
  new Response(JSON.stringify({ error: { code: status, message, status: status === 403 ? "PERMISSION_DENIED" : "INVALID_ARGUMENT", ...(reason ? { details: [{ reason }] } : {}) } }), { status });

/** Google as the plugin sees it: the token endpoint, the Admin API (properties and their web streams), the Data API. */
function google(opts: { visible?: string[]; streams?: Record<string, string>; dataError?: Response; adminError?: Response; sessions?: number } = {}) {
  const visible = opts.visible ?? ["222222222"];
  const streams = opts.streams ?? { "222222222": "https://www.acme.co.za" };
  return (url: string, init?: RequestInit): Response | undefined => {
    if (url.includes("analyticsadmin.googleapis.com")) {
      if (opts.adminError) return opts.adminError;
      if (url.includes("accountSummaries")) return new Response(JSON.stringify({ accountSummaries: [{ propertySummaries: visible.map((id) => ({ property: `properties/${id}`, displayName: `Property ${id}` })) }] }), { status: 200 });
      const id = /properties\/(\d+)\/dataStreams/.exec(url)?.[1] ?? "";
      return new Response(JSON.stringify({ dataStreams: streams[id] ? [{ webStreamData: { defaultUri: streams[id] } }] : [] }), { status: 200 });
    }
    if (url.includes("analyticsdata.googleapis.com")) {
      if (opts.dataError) return opts.dataError;
      const body = JSON.parse(String(init?.body)) as { dimensions?: Array<{ name: string }>; metrics: Array<{ name: string }> };
      const dims = (body.dimensions ?? []).map((d) => d.name);
      if (dims.length === 0) return new Response(JSON.stringify({ rows: [{ dimensionValues: [], metricValues: [{ value: String(opts.sessions ?? 77) }] }] }), { status: 200 });
      // Two completed weeks of numbers for each report (ISO weeks 38 and 39 of 2026: the Mondays 14 and 21 September).
      const week = (code: string, values: number[], extra: string[] = []) => ({ dimensionValues: [{ value: code }, ...extra.map((value) => ({ value }))], metricValues: values.map((value) => ({ value: String(value) })) });
      const rows = dims.length === 1
        ? [week("202638", [500, 380, 40, 410]), week("202639", [620, 470, 51, 520])]
        : dims[1] === "sessionDefaultChannelGroup"
          ? [week("202639", [260, 200, 18, 220], ["Organic Search"])]
          : dims[1] === "landingPage"
            ? [week("202639", [120, 100, 9], ["/blog/vat-guide"])]
            : dims[1] === "sessionSourceMedium"
              ? [week("202639", [14, 10, 2], ["chatgpt.com / referral"])]
              : [week("202639", [14], ["generate_lead"])];
      return new Response(JSON.stringify({ rows }), { status: 200 });
    }
    return undefined;
  };
}

const agent = { kind: "agent" as const, agentId: "agent-1", runId: "run-1", responsibleUserId: null };
const person = { kind: "user" as const, userId: "user-1" };

const connectedRow = integrationRow("ga4", { status: "connected", property_url: "properties/222222222", settings: { propertyId: "222222222", pulledOn: "2026-10-03" }, last_pull_at: "2026-10-03T06:00:00Z" });

function host(routes: Route[] = [], opts: Parameters<typeof seoHost>[0] = {}) {
  return seoHost({ routes: [...needsYouRoutes(), ...routes, ...sprintRoutes], ...opts });
}

async function connect(h: ReturnType<typeof host>, params: Record<string, unknown> = {}) {
  const info = await companyInfo(h.env, "co-1");
  const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
  return connectGa4(h.env, info, sprint, params);
}

describe("connect-ga4", () => {
  it("reads Analytics with its own read-only scope, probes the property, then pulls a quarter of weeks", async () => {
    const h = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4")]]], { google: google() });
    const result = await connect(h, { propertyId: "222222222" });
    expect(result).toMatchObject({ state: "connected", propertyId: "222222222", serviceAccountEmail: SA_EMAIL, weeksPulled: 13 });
    // Its own token, asking only for read-only Analytics (Search Console's token keeps its own, wider scopes).
    expect(h.googleCalls.find((c) => c.url.includes("/token"))!.scope).toBe("https://www.googleapis.com/auth/analytics.readonly");
    const dataCalls = h.googleCalls.filter((c) => c.url.includes("analyticsdata"));
    expect(dataCalls).toHaveLength(6); // the probe and the five reports
    expect(dataCalls.every((c) => c.url.includes("/properties/222222222:runReport") && c.method === "POST")).toBe(true);
    // Thirteen completed weeks before today, oldest first, in one date range.
    const weeks = completedWeeks("2026-10-03", 13);
    expect((dataCalls[1]!.body as { dateRanges: Array<{ startDate: string; endDate: string }> }).dateRanges[0]).toEqual({ startDate: weeks[0], endDate: "2026-09-27" });
    const writes = executed(h, /INSERT INTO plugin_seo_8099f8879a\.analytics_weeks/);
    expect(writes).toHaveLength(13);
    const lastWeek = writes.find((w) => w.params[3] === "2026-09-21")!;
    expect(lastWeek.params.slice(4, 13)).toEqual(["222222222", 620, 470, 520, 51, 260, 200, 220, 18]);
    const update = executed(h, /UPDATE plugin_seo_8099f8879a\.integrations SET/).pop()!;
    expect(update.sql).toContain("status = $");
    expect(update.params).toContain("connected");
    expect(update.params).toContain("properties/222222222");
    expect(executed(h, /UPDATE plugin_seo_8099f8879a\.integrations SET.*property_url/s).length).toBeGreaterThan(0);
  });

  it("finds the property by the site's address when none is given", async () => {
    const h = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4")]]], { google: google({ visible: ["111111111", "222222222"], streams: { "111111111": "https://other.com", "222222222": "https://www.acme.co.za" } }) });
    const result = await connect(h);
    expect(result).toMatchObject({ state: "connected", propertyId: "222222222" });
    expect(result.message).toMatch(/Matched Property 222222222/);
    expect(h.googleCalls.some((c) => c.url.includes("accountSummaries"))).toBe(true);
  });

  it("puts the one-time Viewer grant on Needs you when the service account cannot read the property, with the email and the steps", async () => {
    const h = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4")]]], { google: google({ dataError: DATA_ERR(403, "User does not have sufficient permissions for this property.") }) });
    const result = await connect(h, { propertyId: "222222222" });
    expect(result).toMatchObject({ state: "needs_access", propertyId: "222222222", needsYou: "ga4_access" });
    expect(result.message).toContain(SA_EMAIL);
    const item = savedNeedsYouItems(h).find((i) => i.key === "ga4_access")!;
    expect(item).toMatchObject({ kind: "message", optional: true, check: "ga4_access", status: "open" });
    expect(String(item.title)).toMatch(/Ask Acme Accounting \(Pty\) Ltd to add our service account in Google Analytics/);
    expect(String(item.copy)).toContain(SA_EMAIL);
    expect(String(item.copy)).toMatch(/Viewer/);
    expect(String(item.why)).toContain("Property 222222222");
    // The property id is remembered so the daily retry has something to retry.
    const remembered = executed(h, /UPDATE plugin_seo_8099f8879a\.integrations SET/).pop()!;
    expect(remembered.params).toContain("properties/222222222");
    expect(remembered.params).toContain("disconnected");
    expect(executed(h, /INSERT INTO plugin_seo_8099f8879a\.analytics_weeks/)).toHaveLength(0);
  });

  it("asks for the access grant of our own site as a grant for the owner, not an email", () => {
    const own = ga4AccessItem({ siteName: "Partners in Biz", siteUrl: "https://partnersinbiz.online", clientName: null }, SA_EMAIL, null);
    expect(own).toMatchObject({ kind: "grant", optional: true, check: "ga4_access" });
    expect(own.copy).toBeUndefined();
    expect(own.steps.join(" ")).toContain(SA_EMAIL);
    expect(own.steps.join(" ")).toMatch(/Property access management/);
    const api = ga4ApiItem();
    expect(api.links.map((l) => l.url).join(" ")).toMatch(/analyticsdata\.googleapis\.com.*analyticsadmin\.googleapis\.com/);
    expect(api).toMatchObject({ key: "ga4_api", optional: true });
  });

  it("asks for the one-time API switch when Google says the Analytics API is off, for the Data API and for the Admin API", async () => {
    const off = DATA_ERR(403, "Google Analytics Data API has not been used in project 1 before or it is disabled.", "SERVICE_DISABLED");
    const h = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4")]]], { google: google({ dataError: off }) });
    expect(await connect(h, { propertyId: "222222222" })).toMatchObject({ state: "needs_api", needsYou: "ga4_api" });
    expect(savedNeedsYouItems(h).map((i) => i.key)).toContain("ga4_api");
    const admin = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4")]]], { google: google({ adminError: DATA_ERR(403, "Google Analytics Admin API has not been used in project 1 before or it is disabled.", "SERVICE_DISABLED") }) });
    expect(await connect(admin)).toMatchObject({ state: "needs_api" });
    expect(savedNeedsYouItems(admin).map((i) => i.key)).toContain("ga4_api");
  });

  it("raises the access item when the service account reads no property at all, and lists candidates when none matches the site", async () => {
    const none = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4")]]], { google: google({ visible: [] }) });
    expect(await connect(none)).toMatchObject({ state: "needs_access", propertyId: null, needsYou: "ga4_access" });
    expect(savedNeedsYouItems(none).map((i) => i.key)).toContain("ga4_access");
    const other = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4")]]], { google: google({ visible: ["111111111"], streams: { "111111111": "https://other.com" } }) });
    const result = await connect(other);
    expect(result).toMatchObject({ state: "needs_property", propertyId: null });
    // The service account is a Viewer on other clients' properties too: they are never handed to the agent working this one.
    expect(result.candidates).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("111111111");
    expect(JSON.stringify(result)).not.toContain("Property 111111111");
    expect(result.message).toMatch(/None of the 1 readable property/);
  });

  it("lists as candidates only the properties that have a web stream for this site", async () => {
    const h = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4")]]], { google: google({ visible: ["111111111", "222222222", "333333333"], streams: { "111111111": "https://other.com", "222222222": "https://shop.acme.co.za", "333333333": "https://app.acme.co.za" } }) });
    const result = await connect(h);
    // Two properties for this site: not guessed at, and only those two are named (not the unrelated one).
    expect(result).toMatchObject({ state: "needs_property", propertyId: null });
    expect(result.candidates).toEqual([{ id: "222222222", displayName: "Property 222222222" }, { id: "333333333", displayName: "Property 333333333" }]);
    expect(JSON.stringify(result)).not.toContain("111111111");
  });

  it("tells a wrong property id from a missing grant", async () => {
    const h = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4")]]], { google: google({ streams: { "999999999": "https://acme.co.za" }, dataError: DATA_ERR(400, "Invalid property id") }) });
    const result = await connect(h, { propertyId: "999999999" });
    expect(result).toMatchObject({ state: "bad_property", needsYou: null });
    expect(savedNeedsYouItems(h)).toEqual([]);
  });

  it("does nothing on the network without the Google service account key", async () => {
    const h = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4")]]], { noServiceAccount: true });
    expect(await connect(h, { propertyId: "222222222" })).toMatchObject({ state: "no_service_account", serviceAccountEmail: null });
    expect(h.googleCalls).toHaveLength(0);
  });

  it("closes both Analytics grants once a pull works", async () => {
    const open = [
      { key: "ga4_access", kind: "message", title: "Ask", why: "", steps: [], links: [], after: "", check: "ga4_access", status: "open", addedAt: "2026-09-28T00:00:00Z" },
      { key: "ga4_api", kind: "grant", title: "Enable", why: "", steps: [], links: [], after: "", check: "ga4_access", status: "open", addedAt: "2026-09-28T00:00:00Z" },
    ];
    const h = seoHost({ routes: [...needsYouRoutes(open), [/FROM plugin_seo_8099f8879a\.integrations/, () => [connectedRow]], ...sprintRoutes], google: google() });
    // The Needs you check reads the integration: connected with a property means done.
    const info = await companyInfo(h.env, "co-1");
    const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
    expect(await checkNeedsYouItem(h.env, info, sprint, open[0] as never)).toBe(true);
    const h2 = seoHost({ routes: [...sprintRoutes, [/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4", { status: "disconnected", property_url: "properties/222222222" })]]] });
    expect(await checkNeedsYouItem(h2.env, await companyInfo(h2.env, "co-1"), sprint, open[0] as never)).toBe(false);
    await connect(h, { propertyId: "222222222" });
    // The fake database keeps no state, so each close is its own write: both items were closed by a plugin check.
    const closed = h.executes.filter((e) => /INSERT INTO plugin_seo_8099f8879a\.needs_you /.test(e.sql)).flatMap((e) => (JSON.parse(String(e.params[4])) as Array<Record<string, unknown>>).filter((i) => i.status === "done"));
    expect(closed.map((i) => i.key).sort()).toEqual(["ga4_access", "ga4_api"]);
    expect(closed.every((i) => i.doneBy === "the Google Analytics connection works")).toBe(true);
  });
});

describe("the connect-ga4 tool", () => {
  it("refuses a measurement id with the way to find the real one, and answers with the next step for each state", async () => {
    const h = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4")]]], { google: google({ dataError: DATA_ERR(403, "User does not have sufficient permissions for this property.") }) });
    await expect(connectGa4Tool(h.env, "co-1", agent, { sprintId: "sp-1", propertyId: "G-ABC123" })).rejects.toThrow(/measurement ID/);
    const result = (await connectGa4Tool(h.env, "co-1", agent, { sprintId: "sp-1", propertyId: "properties/222222222" })) as { state: string; next: string; propertyId: string };
    expect(result).toMatchObject({ state: "needs_access", propertyId: "222222222" });
    expect(result.next).toMatch(/Needs you digest \(ga4_access\)/);
    expect(result.next).toMatch(/retries every morning/);
  });

  it("answers a connected sprint with the summary line", async () => {
    const h = host([
      [/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4")]],
      [/FROM plugin_seo_8099f8879a\.analytics_weeks/, () => [{ week_start: "2026-09-21", property_id: "222222222", sessions: 500, engaged_sessions: 380, users: 410, key_events: 40, organic_sessions: 200, organic_engaged_sessions: 150, organic_users: 170, organic_key_events: 12, channels: [], landing_pages: [], sources: [], key_event_names: [], ai_referrals: [] }]],
    ], { google: google() });
    const result = (await connectGa4Tool(h.env, "co-1", agent, { sprintId: "sp-1", propertyId: "222222222" })) as { state: string; line: string; next: string };
    expect(result.state).toBe("connected");
    expect(result.line).toContain("200 sessions");
    expect(result.next).toMatch(/list-ga4-summary/);
  });
});

describe("the daily GA4 run", () => {
  it("does not call Google again for a sprint already pulled today", async () => {
    const h = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [connectedRow]]], { google: google() });
    const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
    expect(await ga4Daily(h.env, await companyInfo(h.env, "co-1"), sprint)).toBeNull();
    expect(h.googleCalls).toHaveLength(0);
  });

  it("refreshes only the last three weeks of a connected sprint pulled yesterday", async () => {
    const yesterday = integrationRow("ga4", { status: "connected", property_url: "properties/222222222", settings: { propertyId: "222222222", pulledOn: "2026-10-02" } });
    const weeks = (): Route => [/FROM plugin_seo_8099f8879a\.analytics_weeks/, () => [{ week_start: "2026-09-21", property_id: "222222222", sessions: 1, engaged_sessions: 1, users: 1, key_events: 0, organic_sessions: 1, organic_engaged_sessions: 1, organic_users: 1, organic_key_events: 0, channels: [], landing_pages: [], sources: [], key_event_names: [], ai_referrals: [] }]];
    const h = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [yesterday]], weeks()], { google: google() });
    const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
    expect(await ga4Daily(h.env, await companyInfo(h.env, "co-1"), sprint)).toBeNull();
    expect(executed(h, /INSERT INTO plugin_seo_8099f8879a\.analytics_weeks/)).toHaveLength(3);
  });

  it("looks for the property of an unconnected sprint only every few days, and never when there is no service account key", async () => {
    const never = integrationRow("ga4");
    const recent = integrationRow("ga4", { settings: { lastTryOn: "2026-10-02" } });
    const old = integrationRow("ga4", { settings: { lastTryOn: "2026-09-29" } });
    const run = async (row: Record<string, unknown>, opts: Parameters<typeof seoHost>[0] = {}) => {
      const h = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [row]]], { google: google({ visible: [] }), ...opts });
      const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
      const warning = await ga4Daily(h.env, await companyInfo(h.env, "co-1"), sprint);
      return { h, warning };
    };
    expect((await run(never)).h.googleCalls.some((c) => c.url.includes("accountSummaries"))).toBe(true);
    expect((await run(recent)).h.googleCalls).toHaveLength(0); // looked yesterday: not again for three days
    expect((await run(old)).h.googleCalls.some((c) => c.url.includes("accountSummaries"))).toBe(true);
    expect((await run(never, { noServiceAccount: true })).h.googleCalls).toHaveLength(0);
    // A grant waiting on a person is not a warning for the daily record: the Needs you item says it.
    expect((await run(never)).warning).toBeNull();
  });

  it("reports a failure it cannot explain as a warning", async () => {
    const h = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4", { property_url: "properties/222222222", settings: { propertyId: "222222222" } })]]], { google: google({ dataError: new Response("boom", { status: 500 }) }) });
    const sprint = (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
    expect(await ga4Daily(h.env, await companyInfo(h.env, "co-1"), sprint)).toMatch(/^GA4: /);
  });
});

describe("the GA4 summary", () => {
  const stored = { week_start: "2026-09-21", property_id: "222222222", sessions: 500, engaged_sessions: 380, users: 410, key_events: 40, organic_sessions: 200, organic_engaged_sessions: 150, organic_users: 170, organic_key_events: 12, channels: [], landing_pages: [{ path: "/blog/vat-guide", sessions: 120, engagedSessions: 100, keyEvents: 9 }, { path: "/", sessions: 50, engagedSessions: 30, keyEvents: 1 }], sources: [], key_event_names: [{ name: "generate_lead", count: 12 }], ai_referrals: [{ assistant: "ChatGPT", sessions: 14, keyEvents: 2 }] };
  const routes: Route[] = [
    [/FROM plugin_seo_8099f8879a\.integrations/, () => [connectedRow]],
    [/FROM plugin_seo_8099f8879a\.analytics_weeks/, () => [stored]],
    [/FROM plugin_seo_8099f8879a\.content/, () => [{ id: "c1", company_id: "co-1", sprint_id: "sp-1", title: "VAT guide", type: "post", status: "live", target_url: "https://acme.co.za/blog/vat-guide", published_on: "2026-09-20", social_post_ids: [], links_to_pillar_ids: [] }]],
  ];

  it("attributes the organic sessions of the last weeks to the sprint's own pages", async () => {
    const h = host(routes);
    const result = (await listGa4SummaryTool(h.env, "co-1", { sprintId: "sp-1" })) as Record<string, any>;
    expect(result).toMatchObject({ connected: true, propertyId: "222222222" });
    expect(result.attribution.sprintPages).toMatchObject({ count: 1, organicSessions: 120, organicKeyEvents: 9 });
    expect(result.attribution.otherPages).toEqual({ organicSessions: 80, organicKeyEvents: 3 });
    expect(result.attribution.top[0]).toMatchObject({ path: "/blog/vat-guide", sessions: 120 });
    expect(result.aiReferrals).toEqual([{ assistant: "ChatGPT", sessions: 14 }]);
    expect(result.line).toMatch(/Organic traffic \(GA4\) week of 2026-09-21: 200 sessions/);
    expect(result.howToRead).toMatch(/Never quote a number this tool did not return/);
  });

  it("says how to connect when nothing was pulled", async () => {
    const h = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4")]]]);
    const result = (await listGa4SummaryTool(h.env, "co-1", { sprintId: "sp-1" })) as Record<string, any>;
    expect(result).toMatchObject({ connected: false, weeks: [] });
    expect(result.next).toMatch(/connect-ga4/);
  });

  it("keeps a small copy on snapshots, empty without GA4", async () => {
    const withData = host(routes);
    const sprint = (await db.getSprint(withData.env.ctx.db, "co-1", "sp-1"))!;
    expect(await ga4ForSnapshot(withData.env, sprint)).toMatchObject({ propertyId: "222222222", organicSessions: 200, sprintPages: { count: 1, organicSessions: 120 } });
    const without = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => []]]);
    expect(await ga4ForSnapshot(without.env, sprint)).toEqual({});
    expect(await ga4Summary(without.env, sprint)).toBeNull();
    expect(propertyIdOf(null)).toBeNull();
    expect(propertyIdOf({ propertyUrl: "properties/222222222", settings: {} })).toBe("222222222");
    expect(propertyIdOf({ propertyUrl: null, settings: { propertyId: "333333333" } })).toBe("333333333");
    expect(propertyIdOf({ propertyUrl: "properties/not-a-number", settings: {} })).toBeNull();
  });
});

describe("one client's analytics never reach another client's sprint", () => {
  // The service account is a Viewer on every client's property. This sprint is acme.co.za; 111111111 is another client's.
  const both = { visible: ["111111111", "222222222"], streams: { "111111111": "https://other-client.example", "222222222": "https://www.acme.co.za" } };
  const fresh = (): Route => [/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("ga4")]];
  const dataCalls = (h: ReturnType<typeof host>) => h.googleCalls.filter((c) => c.url.includes("analyticsdata"));

  it("refuses a property id whose web streams are not this site, before reading any number or storing anything", async () => {
    const h = host([fresh()], { google: google(both) });
    const result = await connect(h, { propertyId: "111111111" });
    expect(result).toMatchObject({ state: "property_mismatch", propertyId: null, needsYou: null });
    expect(result.message).toMatch(/has no web data stream for acme\.co\.za/);
    expect(result.message).toMatch(/other clients' properties/);
    // Nothing of the other client leaks into the answer, and nothing was read or stored.
    expect(JSON.stringify(result)).not.toContain("other-client");
    expect(result).not.toHaveProperty("candidates");
    expect(dataCalls(h)).toHaveLength(0);
    expect(executed(h, /INSERT INTO plugin_seo_8099f8879a\.analytics_weeks/)).toHaveLength(0);
    expect(executed(h, /UPDATE plugin_seo_8099f8879a\.integrations SET.*property_url/s)).toHaveLength(0);
    expect(savedNeedsYouItems(h)).toEqual([]);
  });

  it("refuses a property that has no web stream at all", async () => {
    const h = host([fresh()], { google: google({ visible: ["444444444"], streams: {} }) });
    expect(await connect(h, { propertyId: "444444444" })).toMatchObject({ state: "property_mismatch" });
    expect(dataCalls(h)).toHaveLength(0);
  });

  it("connects an agent's property id when a web stream is the site's address (the site or a subdomain of it)", async () => {
    for (const stream of ["https://acme.co.za", "https://www.acme.co.za/", "https://shop.acme.co.za"]) {
      const h = host([fresh()], { google: google({ streams: { "222222222": stream } }) });
      expect(await connect(h, { propertyId: "222222222" })).toMatchObject({ state: "connected", propertyId: "222222222" });
    }
  });

  it("the tool refuses an agent and tells it to ask the owner; only a person can connect a property the streams do not show, and it is kept on the integration", async () => {
    const forAgent = host([fresh()], { google: google(both) });
    const refused = (await connectGa4Tool(forAgent.env, "co-1", agent, { sprintId: "sp-1", propertyId: "111111111" })) as { state: string; next: string };
    expect(refused.state).toBe("property_mismatch");
    expect(refused.next).toMatch(/ask the site's owner for the right property ID/);
    expect(refused.next).toMatch(/Do not try other ids/);
    expect(dataCalls(forAgent)).toHaveLength(0);

    // A system call is no person either.
    const forSystem = host([fresh()], { google: google(both) });
    expect(((await connectGa4Tool(forSystem.env, "co-1", { kind: "system" }, { sprintId: "sp-1", propertyId: "111111111" })) as { state: string }).state).toBe("property_mismatch");

    const forPerson = host([fresh()], { google: google(both) });
    const confirmed = (await connectGa4Tool(forPerson.env, "co-1", person, { sprintId: "sp-1", propertyId: "111111111" })) as { state: string; message: string };
    expect(confirmed.state).toBe("connected");
    expect(confirmed.message).toMatch(/user-1 confirmed it although none of its web streams is acme\.co\.za/);
    expect(dataCalls(forPerson).length).toBeGreaterThan(0);
    const update = executed(forPerson, /UPDATE plugin_seo_8099f8879a\.integrations SET/).pop()!;
    expect(update.params.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")).toContain("propertyConfirmedBy");
    expect(update.params.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")).toContain("user-1");
  });

  it("never lists properties that are not this site's as candidates, however many the service account can read", async () => {
    const h = host([fresh()], { google: google({ visible: ["111111111", "555555555", "666666666"], streams: { "111111111": "https://a.example", "555555555": "https://b.example", "666666666": "https://c.example" } }) });
    const result = (await connectGa4Tool(h.env, "co-1", agent, { sprintId: "sp-1" })) as Record<string, any>;
    expect(result.state).toBe("needs_property");
    expect(result.candidates).toBeUndefined();
    const text = JSON.stringify(result);
    for (const leaked of ["111111111", "555555555", "666666666", "a.example", "b.example", "c.example"]) expect(text).not.toContain(leaked);
    expect(result.message).toMatch(/None of the 3 readable properties/); // a count only
    expect(result.next).toMatch(/ask the owner \(or the client\) for the property ID/);
    // What is stored on the integration for the page is the same count, not a name.
    expect(executed(h, /UPDATE plugin_seo_8099f8879a\.integrations SET/).map((e) => JSON.stringify(e.params)).join(" ")).not.toMatch(/111111111|a\.example/);
  });

  it("does not knock over a sprint that already works when an agent tries another property id", async () => {
    const working = [/FROM plugin_seo_8099f8879a\.integrations/, () => [connectedRow]] as Route;
    // The other id is refused as not this site's ...
    const mismatch = host([working], { google: google(both) });
    expect(await connect(mismatch, { propertyId: "111111111" })).toMatchObject({ state: "property_mismatch" });
    expect(executed(mismatch, /UPDATE plugin_seo_8099f8879a\.integrations/)).toHaveLength(0);
    // ... or Google says the service account cannot read it: answered, but nothing is recorded and no grant is asked for.
    const unreadable = host([working], { google: google({ adminError: DATA_ERR(403, "The caller does not have permission") }) });
    const result = await connect(unreadable, { propertyId: "999999999" });
    expect(result).toMatchObject({ state: "needs_access", propertyId: "999999999", needsYou: null });
    expect(executed(unreadable, /UPDATE plugin_seo_8099f8879a\.integrations/)).toHaveLength(0);
    expect(savedNeedsYouItems(unreadable)).toEqual([]);
  });

  it("a one-off Google error keeps a connected sprint connected; a lost grant does not", async () => {
    const stale = integrationRow("ga4", { status: "connected", property_url: "properties/222222222", settings: { propertyId: "222222222", pulledOn: "2026-10-01" } });
    const blip = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [stale]]], { google: google({ dataError: new Response("{}", { status: 503 }) }) });
    expect(await connect(blip)).toMatchObject({ state: "error" });
    const blipUpdate = executed(blip, /UPDATE plugin_seo_8099f8879a\.integrations SET/).pop()!;
    expect(blipUpdate.params).not.toContain("disconnected");
    expect(blipUpdate.sql).toContain("last_error");
    const quota = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [stale]]], { google: google({ dataError: DATA_ERR(429, "Quota exceeded") }) });
    await connect(quota);
    expect(executed(quota, /UPDATE plugin_seo_8099f8879a\.integrations SET/).pop()!.params).not.toContain("disconnected");
    const lost = host([[/FROM plugin_seo_8099f8879a\.integrations/, () => [stale]]], { google: google({ dataError: DATA_ERR(403, "User does not have sufficient permissions for this property.") }) });
    expect(await connect(lost)).toMatchObject({ state: "needs_access" });
    expect(executed(lost, /UPDATE plugin_seo_8099f8879a\.integrations SET/).pop()!.params).toContain("disconnected");
  });
});

describe("the optional Google Analytics items do not nag", () => {
  const sprintOf = async (h: ReturnType<typeof host>) => (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
  const closedIssue = (h: ReturnType<typeof seoHost>) => {
    h.ctx.issues.get = (async (id: string) => ({ id, status: "done", identifier: "PIB-9" })) as never;
  };
  const loud = { key: "pr:acme", kind: "pr" as const, title: "Merge the PR", why: "A change needs a person.", steps: ["Merge it."], links: [], after: "Carries on.", check: "manual" as const, taskIds: [] };

  it("are quiet items: optional and flagged so they never open or reopen the digest issue", () => {
    expect(ga4ApiItem()).toMatchObject({ optional: true, quiet: true });
    expect(ga4AccessItem({ siteName: "A", siteUrl: "https://a.example", clientName: "A" }, SA_EMAIL, null)).toMatchObject({ optional: true, quiet: true });
  });

  it("do not open a Needs you issue on their own, but are on the digest", async () => {
    const h = seoHost({ routes: [...needsYouRoutes([], { issueId: null }), ...sprintRoutes] });
    await addNeedsYou(h.env, await companyInfo(h.env, "co-1"), await sprintOf(h), ga4ApiItem(), { reopen: true });
    expect(h.created).toHaveLength(0);
    expect(savedNeedsYouItems(h).map((i) => [i.key, i.status])).toEqual([["ga4_api", "open"]]);
    // A request that does need a person opens the issue, with the quiet item listed on it.
    const withLoud = seoHost({ routes: [...needsYouRoutes([], { issueId: null }), ...sprintRoutes] });
    await addNeedsYou(withLoud.env, await companyInfo(withLoud.env, "co-1"), await sprintOf(withLoud), loud, { reopen: true });
    expect(withLoud.created).toHaveLength(1);
    expect(withLoud.created[0]!.input).toMatchObject({ priority: "high" });
  });

  it("do not reopen a digest issue the owner already closed, and say nothing on it", async () => {
    const h = seoHost({ routes: [...needsYouRoutes([]), ...sprintRoutes] });
    closedIssue(h);
    await addNeedsYou(h.env, await companyInfo(h.env, "co-1"), await sprintOf(h), ga4AccessItem({ siteName: "Acme", siteUrl: "https://acme.co.za", clientName: "Acme" }, SA_EMAIL, null), { reopen: true });
    expect(savedNeedsYouItems(h).map((i) => i.key)).toEqual(["ga4_access"]);
    expect(h.updates.filter((u) => u.id === "ny-issue")).toEqual([]); // not reopened, not even edited (that would read as the owner closing it again)
    expect(h.comments.filter((c) => c.id === "ny-issue")).toEqual([]);
    // Anything that does need a person reopens it.
    const reopened = seoHost({ routes: [...needsYouRoutes([]), ...sprintRoutes] });
    closedIssue(reopened);
    await addNeedsYou(reopened.env, await companyInfo(reopened.env, "co-1"), await sprintOf(reopened), loud, { reopen: true });
    expect(reopened.updates.find((u) => u.id === "ny-issue")!.patch).toMatchObject({ status: "todo" });
  });

  it("still update the description of an issue that is open for another reason", async () => {
    const h = seoHost({ routes: [...needsYouRoutes([{ ...loud, status: "open", addedAt: "2026-09-29T00:00:00Z" }]), ...sprintRoutes] });
    await addNeedsYou(h.env, await companyInfo(h.env, "co-1"), await sprintOf(h), ga4ApiItem(), { reopen: true });
    const patch = h.updates.find((u) => u.id === "ny-issue")!.patch;
    expect(String(patch.description)).toContain("Enable the Google Analytics APIs");
    expect(patch).not.toHaveProperty("status");
  });
});
