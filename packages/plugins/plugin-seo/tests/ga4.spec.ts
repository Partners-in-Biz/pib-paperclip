import { describe, expect, it, vi } from "vitest";
import {
  aiAssistantOf,
  classifyGa4Error,
  discoverGa4Property,
  fetchGa4Weeks,
  Ga4Error,
  isoWeekMonday,
  listGa4Properties,
  parseGa4PropertyId,
  probeGa4Property,
  runReport,
} from "../src/integrations/ga4.js";
import { addDays } from "../src/engine/time.js";
import {
  analyticsLine,
  analyticsSnapshot,
  completedWeeks,
  mondayOf,
  normalisePath,
  sprintPages,
  summarizeAnalytics,
  type WeekRow,
} from "../src/engine/analytics.js";

type Req = { dateRanges: Array<{ startDate: string; endDate: string }>; dimensions?: Array<{ name: string }>; metrics: Array<{ name: string }>; dimensionFilter?: unknown; metricFilter?: unknown; limit?: number };

const rows = (list: Array<[string[], number[]]>) => list.map(([d, m]) => ({ dimensionValues: d.map((value) => ({ value })), metricValues: m.map((value) => ({ value: String(value) })) }));

/**
 * A mock GA4 Data API: answers each report by the dimensions it asks for, the way the real API shapes its response
 * (string metric values, dimension and metric headers). `calls` keeps every request body.
 */
function dataApi(tables: { totals?: Array<[string[], number[]]>; channels?: Array<[string[], number[]]>; pages?: Array<[string[], number[]]>; sources?: Array<[string[], number[]]>; events?: Array<[string[], number[]]> }, opts: { status?: number; error?: unknown } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Req }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Req;
    calls.push({ url, headers: init?.headers as Record<string, string>, body });
    if (opts.status && opts.status >= 400) return new Response(JSON.stringify({ error: opts.error }), { status: opts.status });
    const dims = (body.dimensions ?? []).map((d) => d.name);
    const pick = dims.length === 1 ? tables.totals : dims[1] === "sessionDefaultChannelGroup" ? tables.channels : dims[1] === "landingPage" ? tables.pages : dims[1] === "sessionSourceMedium" ? tables.sources : dims[1] === "eventName" ? tables.events : [];
    return new Response(JSON.stringify({ dimensionHeaders: dims.map((name) => ({ name })), metricHeaders: body.metrics.map((m) => ({ name: m.name, type: "TYPE_INTEGER" })), rows: rows(pick ?? []), rowCount: (pick ?? []).length }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as (url: string, init?: RequestInit) => Promise<Response>, calls };
}

describe("GA4 property id", () => {
  it("accepts the forms a person pastes and refuses what is not a property id", () => {
    expect(parseGa4PropertyId("123456789")).toEqual({ ok: true, id: "123456789" });
    expect(parseGa4PropertyId(" properties/123456789 ")).toEqual({ ok: true, id: "123456789" });
    expect(parseGa4PropertyId("p123456789")).toEqual({ ok: true, id: "123456789" });
    expect(parseGa4PropertyId("https://analytics.google.com/analytics/web/#/a98765432w1234p123456789/admin/property/settings")).toEqual({ ok: true, id: "123456789" });
    expect(parseGa4PropertyId("https://analytics.google.com/analytics/web/#/p123456789/reports/intelligenthome")).toEqual({ ok: true, id: "123456789" });
    const measurement = parseGa4PropertyId("G-ABC123XYZ");
    expect(measurement).toMatchObject({ ok: false });
    expect(measurement.ok === false && measurement.reason).toMatch(/measurement ID/);
    expect(parseGa4PropertyId("UA-12345-1")).toMatchObject({ ok: false });
    expect(parseGa4PropertyId("12")).toMatchObject({ ok: false });
    expect(parseGa4PropertyId("not a property")).toMatchObject({ ok: false });
  });
});

describe("GA4 errors", () => {
  it("sorts Google's answers into what a person has to do", () => {
    const api = classifyGa4Error(403, { error: { code: 403, message: "Google Analytics Data API has not been used in project 1 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } });
    expect(api.kind).toBe("api_disabled");
    expect(classifyGa4Error(403, { error: { message: "User does not have sufficient permissions for this property. To learn more...", status: "PERMISSION_DENIED" } }).kind).toBe("no_access");
    expect(classifyGa4Error(400, { error: { message: "Invalid property" } }).kind).toBe("bad_property");
    expect(classifyGa4Error(429, { error: { message: "Exhausted property tokens" } }).kind).toBe("quota");
    expect(classifyGa4Error(500, {}).kind).toBe("other");
  });
});

describe("ISO weeks", () => {
  it("turns an isoYearIsoWeek code into its Monday, across the year edges", () => {
    expect(isoWeekMonday("202641")).toBe("2026-10-05");
    expect(isoWeekMonday("202601")).toBe("2025-12-29"); // ISO week 1 of 2026 starts in 2025
    expect(isoWeekMonday("202053")).toBe("2020-12-28");
    expect(isoWeekMonday("2026")).toBeNull();
    expect(isoWeekMonday("202600")).toBeNull();
  });
  it("lists the last completed weeks, Monday first, oldest first", () => {
    // Saturday 2026-10-03: this week (Mon 28 Sep) is not complete, so the last complete week starts Mon 21 Sep.
    expect(completedWeeks("2026-10-03", 3)).toEqual(["2026-09-07", "2026-09-14", "2026-09-21"]);
    expect(completedWeeks("2026-10-05", 1)).toEqual(["2026-09-28"]); // a Monday: the week that ended yesterday
    expect(mondayOf("2026-10-04")).toBe("2026-09-28"); // a Sunday belongs to the week before
    expect(completedWeeks("2026-10-03", 0)).toEqual([]);
  });
});

describe("AI assistants in referral sources", () => {
  it("names the assistant of a source / medium and leaves other sources alone", () => {
    expect(aiAssistantOf("chatgpt.com / referral")).toBe("ChatGPT");
    expect(aiAssistantOf("perplexity.ai / referral")).toBe("Perplexity");
    expect(aiAssistantOf("gemini.google.com / referral")).toBe("Gemini");
    expect(aiAssistantOf("copilot.microsoft.com / referral")).toBe("Copilot");
    expect(aiAssistantOf("claude.ai / referral")).toBe("Claude");
    expect(aiAssistantOf("google / organic")).toBeNull();
    expect(aiAssistantOf("facebook.com / referral")).toBeNull();
  });
});

describe("GA4 Data API reports", () => {
  const WEEKS = ["2026-09-14", "2026-09-21"];
  const tables = {
    totals: [[["202638"], [500, 380, 40, 410]], [["202639"], [620, 470, 51, 520]]] as Array<[string[], number[]]>,
    channels: [
      [["202638", "Organic Search"], [200, 150, 12, 170]],
      [["202638", "Direct"], [300, 230, 28, 240]],
      [["202639", "Organic Search"], [260, 200, 18, 220]],
      [["202639", "Paid Search"], [360, 270, 33, 300]],
    ] as Array<[string[], number[]]>,
    pages: [
      [["202638", "/services"], [90, 70, 6]],
      [["202638", "/"], [60, 40, 2]],
      [["202639", "/blog/vat-guide"], [120, 100, 9]],
      [["202639", "/"], [70, 50, 3]],
    ] as Array<[string[], number[]]>,
    sources: [
      [["202638", "google / organic"], [200, 150, 12]],
      [["202639", "chatgpt.com / referral"], [14, 10, 2]],
      [["202639", "perplexity.ai / referral"], [6, 5, 1]],
      [["202639", "(direct) / (none)"], [300, 220, 20]],
    ] as Array<[string[], number[]]>,
    events: [
      [["202638", "generate_lead"], [10]],
      [["202639", "generate_lead"], [14]],
      [["202639", "purchase"], [4]],
    ] as Array<[string[], number[]]>,
  };

  it("asks five reports for the whole period, with the organic filter and the key-events metric", async () => {
    const { fetchImpl, calls } = dataApi(tables);
    await fetchGa4Weeks(fetchImpl, "tok", "123456789", WEEKS);
    expect(calls).toHaveLength(5);
    expect(calls.every((c) => c.url === "https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport")).toBe(true);
    expect(calls.every((c) => c.headers.Authorization === "Bearer tok")).toBe(true);
    // One date range for the whole period: from the first Monday to the Sunday after the last.
    expect(calls.every((c) => c.body.dateRanges[0]!.startDate === "2026-09-14" && c.body.dateRanges[0]!.endDate === "2026-09-27")).toBe(true);
    expect(calls.map((c) => c.body.dimensions!.map((d) => d.name))).toEqual([
      ["isoYearIsoWeek"],
      ["isoYearIsoWeek", "sessionDefaultChannelGroup"],
      ["isoYearIsoWeek", "landingPage"],
      ["isoYearIsoWeek", "sessionSourceMedium"],
      ["isoYearIsoWeek", "eventName"],
    ]);
    const pages = calls[2]!.body;
    expect(JSON.stringify(pages.dimensionFilter)).toContain("Organic Search");
    expect(pages.metrics.map((m) => m.name)).toEqual(["sessions", "engagedSessions", "keyEvents"]);
    expect(JSON.stringify(calls[4]!.body.metricFilter)).toContain("GREATER_THAN");
    expect(calls[4]!.body.metrics).toEqual([{ name: "keyEvents" }]);
  });

  it("builds one row per week with totals, the organic channel, landing pages, sources and AI referrals", async () => {
    const { fetchImpl } = dataApi(tables);
    const [w1, w2] = await fetchGa4Weeks(fetchImpl, "tok", "123456789", WEEKS);
    expect(w1).toMatchObject({ weekStart: "2026-09-14", sessions: 500, engagedSessions: 380, keyEvents: 40, users: 410, organic: { sessions: 200, engagedSessions: 150, keyEvents: 12, users: 170 } });
    expect(w2).toMatchObject({ weekStart: "2026-09-21", sessions: 620, organic: { sessions: 260, keyEvents: 18 } });
    expect(w1!.channels.map((c) => c.channel)).toEqual(["Organic Search", "Direct"]);
    expect(w1!.landingPages).toEqual([{ path: "/services", sessions: 90, engagedSessions: 70, keyEvents: 6 }, { path: "/", sessions: 60, engagedSessions: 40, keyEvents: 2 }]);
    expect(w2!.keyEventNames).toEqual([{ name: "generate_lead", count: 14 }, { name: "purchase", count: 4 }]);
    expect(w2!.aiReferrals).toEqual([{ assistant: "ChatGPT", sessions: 14, keyEvents: 2 }, { assistant: "Perplexity", sessions: 6, keyEvents: 1 }]);
    expect(w1!.aiReferrals).toEqual([]);
    expect(w2!.sources).toHaveLength(3);
  });

  it("keeps a week GA4 has no rows for as a week of zeros, and ignores weeks nobody asked for", async () => {
    const { fetchImpl } = dataApi({ ...tables, totals: [[["202638"], [500, 380, 40, 410]], [["202637"], [999, 999, 99, 999]]] });
    const weeks = await fetchGa4Weeks(fetchImpl, "tok", "123456789", WEEKS);
    expect(weeks.map((w) => w.weekStart)).toEqual(WEEKS);
    expect(weeks[1]).toMatchObject({ sessions: 0, keyEvents: 0, organic: { sessions: 260 } }); // no totals row; the channel row still counts
    expect(weeks.reduce((sum, w) => sum + w.sessions, 0)).toBe(500); // week 37 was not requested
    expect(await fetchGa4Weeks(fetchImpl, "tok", "123456789", [])).toEqual([]);
  });

  it("raises a typed error carrying what Google said", async () => {
    const { fetchImpl } = dataApi({}, { status: 403, error: { code: 403, message: "User does not have sufficient permissions for this property.", status: "PERMISSION_DENIED" } });
    const error = await runReport(fetchImpl, "tok", "1234567", { dateRanges: [{ startDate: "2026-09-01", endDate: "2026-09-07" }], metrics: [{ name: "sessions" }] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Ga4Error);
    expect((error as Ga4Error).kind).toBe("no_access");
    expect((error as Ga4Error).status).toBe(403);
    expect((error as Error).message).toMatch(/sufficient permissions/);
  });

  it("probes a property with the smallest report", async () => {
    const { fetchImpl, calls } = dataApi({});
    const fetchSessions = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ rows: rows([[[], [321]]]) }), { status: 200 });
    });
    expect(await probeGa4Property(fetchSessions as never, "tok", "123456789", "2026-10-03")).toEqual({ sessionsLast7Days: 321 });
    expect(calls[0]!.body).toMatchObject({ dateRanges: [{ startDate: "2026-09-26", endDate: "2026-10-02" }], metrics: [{ name: "sessions" }], limit: 1 });
    void fetchImpl;
  });
});

describe("finding the property (Admin API)", () => {
  const summaries = { accountSummaries: [{ account: "accounts/1", propertySummaries: [{ property: "properties/111111111", displayName: "Other business" }, { property: "properties/222222222", displayName: "Acme" }] }, { account: "accounts/2", propertySummaries: [{ property: "properties/333333333", displayName: "Acme (old)" }] }] };
  const STREAMS: Record<string, string[]> = { "111111111": ["https://other.com"], "222222222": ["https://app.acme.co.za"], "333333333": ["https://acme.co.za"] };
  const admin = (overrides: { visible?: unknown; streams?: Record<string, string[]> } = {}) =>
    vi.fn(async (url: string) => {
      if (url.includes("accountSummaries")) return new Response(JSON.stringify(overrides.visible ?? summaries), { status: 200 });
      const id = /properties\/(\d+)\/dataStreams/.exec(url)?.[1] ?? "";
      return new Response(JSON.stringify({ dataStreams: ((overrides.streams ?? STREAMS)[id] ?? []).map((defaultUri) => ({ type: "WEB_DATA_STREAM", webStreamData: { defaultUri } })) }), { status: 200 });
    });

  it("lists the properties the service account can read", async () => {
    const list = await listGa4Properties(admin() as never, "tok");
    expect(list).toEqual([{ id: "111111111", displayName: "Other business" }, { id: "222222222", displayName: "Acme" }, { id: "333333333", displayName: "Acme (old)" }]);
  });

  it("picks the property whose web stream is the site, preferring the exact host over a subdomain's", async () => {
    // Both Acme properties match the site (one is app.acme.co.za); only the other is the address the sprint uses.
    const result = await discoverGa4Property(admin() as never, "tok", "https://acme.co.za");
    expect(result.matches.map((m) => m.id)).toEqual(["222222222", "333333333"]);
    expect(result.propertyId).toBe("333333333");
    expect(result.reason).toMatch(/Matched Acme \(old\)/);
  });

  it("does not guess when two properties match equally, and says what it saw", async () => {
    const both = { accountSummaries: [{ propertySummaries: [{ property: "properties/222222222", displayName: "A" }, { property: "properties/444444444", displayName: "B" }] }] };
    const streams = { "222222222": ["https://acme.co.za"], "444444444": ["https://www.acme.co.za"] };
    const result = await discoverGa4Property(admin({ visible: both, streams }) as never, "tok", "https://www.acme.co.za");
    expect(result.propertyId).toBeNull();
    expect(result.reason).toMatch(/2 properties have a web stream for acme.co.za/);
    const none = await discoverGa4Property(admin() as never, "tok", "https://nobody.co.za");
    expect(none).toMatchObject({ propertyId: null, matches: [] });
    expect(none.reason).toMatch(/None of the 3 readable properties/);
  });

  it("says nobody has added the service account yet when it can read nothing", async () => {
    const result = await discoverGa4Property(admin({ visible: {} }) as never, "tok", "https://acme.co.za");
    expect(result).toMatchObject({ propertyId: null, visible: [] });
    expect(result.reason).toMatch(/nobody has added it as a viewer/);
  });

  it("reports a disabled Admin API as an error the caller can act on", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "Google Analytics Admin API has not been used in project 1 before or it is disabled.", details: [{ reason: "SERVICE_DISABLED" }] } }), { status: 403 }));
    const error = await discoverGa4Property(fetchImpl as never, "tok", "https://acme.co.za").catch((e: unknown) => e);
    expect((error as Ga4Error).kind).toBe("api_disabled");
  });
});

describe("analytics engine", () => {
  const week = (start: string, organic: number, keyEvents: number, pages: Array<[string, number, number]>, extra: Partial<WeekRow> = {}): WeekRow => ({
    weekStart: start,
    sessions: organic * 2,
    engagedSessions: organic,
    users: organic,
    keyEvents: keyEvents * 2,
    organic: { sessions: organic, engagedSessions: Math.round(organic * 0.8), users: organic, keyEvents },
    channels: [],
    landingPages: pages.map(([path, sessions, ke]) => ({ path, sessions, engagedSessions: sessions - 1, keyEvents: ke })),
    sources: [{ source: "google / organic", sessions: organic, engagedSessions: organic, keyEvents }],
    keyEventNames: [{ name: "generate_lead", count: keyEvents }],
    aiReferrals: [],
    ...extra,
  });

  it("compares paths the way GA4 reports them", () => {
    expect(normalisePath("https://acme.co.za/Blog/Post/?utm=x#top")).toBe("/Blog/Post");
    expect(normalisePath("/services/")).toBe("/services");
    expect(normalisePath("services//vat")).toBe("/services/vat");
    expect(normalisePath("https://acme.co.za")).toBe("/");
    expect(normalisePath("/")).toBe("/");
  });

  it("takes the sprint's pages from live content, keyword targets and approved optimizations, never the home page", () => {
    const pages = sprintPages({
      siteUrl: "https://acme.co.za",
      content: [
        { title: "VAT guide", targetUrl: "https://acme.co.za/blog/vat-guide/", status: "live", publishedOn: "2026-09-20" },
        { title: "Idea", targetUrl: "/blog/idea", status: "idea", publishedOn: null },
      ],
      keywords: [{ targetUrl: "/services" }, { targetUrl: "https://acme.co.za/" }, { targetUrl: null }, { targetUrl: "/blog/vat-guide" }],
      optimizations: [{ targetUrl: "/pricing", status: "approved", approvedAt: "2026-09-25T10:00:00Z" }, { targetUrl: "/rejected", status: "rejected" }],
    });
    expect(pages.map((p) => [p.path, p.reason, p.liveOn])).toEqual([["/blog/vat-guide", "content", "2026-09-20"], ["/services", "keyword", null], ["/pricing", "optimization", "2026-09-25"]]);
  });

  it("attributes organic traffic and key events to the sprint's pages and the rest to other pages", () => {
    const pages = sprintPages({ siteUrl: "https://acme.co.za", content: [{ title: "VAT guide", targetUrl: "/blog/vat-guide", status: "live", publishedOn: "2026-09-22" }], keywords: [{ targetUrl: "/services" }], optimizations: [] });
    const weeks = [
      week("2026-09-07", 100, 5, [["/services", 40, 2], ["/", 50, 1]]),
      week("2026-09-14", 200, 10, [["/services", 80, 4], ["/", 90, 2]]),
      week("2026-09-21", 300, 20, [["/blog/vat-guide", 150, 12], ["/services", 60, 3], ["/", 70, 2]], { aiReferrals: [{ assistant: "ChatGPT", sessions: 9, keyEvents: 1 }] }),
    ];
    const summary = summarizeAnalytics(weeks, pages, { propertyId: "123456789" });
    expect(summary.lastWeek).toMatchObject({ weekStart: "2026-09-21", organicSessions: 300, organicKeyEvents: 20, aiReferralSessions: 9 });
    expect(summary.change).toMatchObject({ organicSessionsPct: 50, organicKeyEventsPct: 100 });
    expect(summary.last4).toMatchObject({ weeks: 3, from: "2026-09-07", to: "2026-09-27", organicSessions: 600, organicKeyEvents: 35, aiReferralSessions: 9 });
    const sp = summary.attribution.sprintPages;
    expect(sp).toMatchObject({ count: 2, organicSessions: 40 + 80 + 150 + 60, organicKeyEvents: 2 + 4 + 12 + 3 });
    expect(sp.shareOfOrganicSessions).toBeCloseTo(330 / 600, 3);
    expect(summary.attribution.otherPages).toEqual({ organicSessions: 270, organicKeyEvents: 14 });
    expect(summary.attribution.top.map((p) => [p.path, p.sessions, p.keyEvents])).toEqual([["/blog/vat-guide", 150, 12], ["/services", 180, 9]].sort((a, b) => (b[1] as number) - (a[1] as number)));
    // The guide went live in the week of 21 Sep: only that week counts as since live.
    expect(summary.attribution.top.find((p) => p.path === "/blog/vat-guide")).toMatchObject({ sessionsSinceLive: 150, liveOn: "2026-09-22" });
    expect(summary.attribution.top.find((p) => p.path === "/services")!.sessionsSinceLive).toBeNull();
    expect(summary.attribution.landingCoverage).toBeCloseTo((90 + 170 + 280) / 600, 2);
    expect(summary.keyEvents).toEqual([{ name: "generate_lead", count: 35 }]);
    expect(summary.propertyId).toBe("123456789");
  });

  it("counts a landing page however GA4 spells it: query string, trailing slash, fragment and capital letters in the host are one page", () => {
    const pages = sprintPages({ siteUrl: "https://acme.co.za", content: [{ title: "VAT guide", targetUrl: "https://ACME.co.za/blog/vat-guide/", status: "live", publishedOn: "2026-09-20" }], keywords: [], optimizations: [] });
    const summary = summarizeAnalytics([week("2026-09-21", 300, 20, [["/blog/vat-guide", 100, 5], ["/blog/vat-guide/", 30, 2], ["/blog/vat-guide?utm_source=newsletter", 20, 1], ["/blog/vat-guide/#faq", 10, 0], ["/blog/other", 40, 1]])], pages);
    // The four spellings are one page: 160 sessions, 8 key events; the other page is not the sprint's.
    expect(summary.attribution.sprintPages).toMatchObject({ count: 1, organicSessions: 160, organicKeyEvents: 8 });
    expect(summary.attribution.top).toHaveLength(1);
    expect(summary.attribution.top[0]).toMatchObject({ path: "/blog/vat-guide", sessions: 160, keyEvents: 8 });
    // Everything else the week's organic traffic brought (300 in all) is other pages, the 40 listed and the unlisted long tail alike.
    expect(summary.attribution.otherPages.organicSessions).toBe(300 - 160);
  });

  it("reads only the last four weeks for the attribution and says nothing without data", () => {
    const many = Array.from({ length: 6 }, (_, i) => week(addDays("2026-08-10", i * 7), 100, 1, []));
    expect(summarizeAnalytics(many, []).last4.weeks).toBe(4);
    expect(summarizeAnalytics(many, []).weeks).toHaveLength(6);
    expect(analyticsLine(summarizeAnalytics([], []))).toBeNull();
    expect(analyticsSnapshot(null)).toEqual({});
    expect(analyticsSnapshot(summarizeAnalytics([], []))).toEqual({});
  });

  it("writes the line a digest carries, with real numbers and the sign of the change", () => {
    const pages = sprintPages({ siteUrl: "https://acme.co.za", content: [], keywords: [{ targetUrl: "/services" }], optimizations: [] });
    const summary = summarizeAnalytics([week("2026-09-14", 200, 10, [["/services", 80, 4]]), week("2026-09-21", 150, 1, [["/services", 60, 1]], { aiReferrals: [{ assistant: "Claude", sessions: 4, keyEvents: 0 }] })], pages);
    const line = analyticsLine(summary)!;
    expect(line).toContain("week of 2026-09-21: 150 sessions (-25% on the week before), 1 key event");
    expect(line).toContain("140 of the last 2 weeks' 350 organic sessions landed on the 1 page this sprint works on");
    expect(line).toContain("4 sessions came from AI assistants");
    expect(analyticsSnapshot(summary)).toMatchObject({ organicSessions: 350, organicKeyEvents: 11, sprintPages: { count: 1, organicSessions: 140 }, lastWeek: { weekStart: "2026-09-21", organicSessions: 150 } });
  });
});
