import { describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { companyInfo } from "../src/service/common.js";
import { auditSprint, ensureMonthlyGeoTask, geoAuditTool, geoForSnapshot, geoSummary, listAiMentionsTool, recordAiMentionsTool, scheduledGeo, SCHEDULED_AUDIT_DAYS, SNAPSHOT_REUSE_DAYS } from "../src/service/geo.js";
import { recordCheckFindings } from "../src/service/checks.js";
import { checkNeedsYouItem, needsYouResolveTool, onNeedsYouIssueUpdated, resolveNeedsYou } from "../src/service/needs-you.js";
import { captureSnapshot } from "../src/service/snapshots.js";
import { GEO_TASKS, monthlyGeoKey } from "../src/templates/geo.js";
import { reply, site, GOOD_HOME, page } from "./helpers/geo-site.js";
import { executed, needsYouRoutes, savedNeedsYouItems, seoHost, SPRINT, sprintRoutes, type Route, type Row } from "./helpers/seo-host.js";

const agent = { kind: "agent" as const, agentId: "agent-1", runId: "run-1", responsibleUserId: null };
const person = { kind: "user" as const, userId: "user-1" };
const GEO_AUDIT_ROW = (extra: Row = {}): Row => ({ id: "g-1", sprint_id: "sp-1", audited_on: "2026-10-01", audited_at: "2026-10-01T06:00:00Z", score: 72, band: "good", complete: true, breakdown: { crawlers: { earned: 30, possible: 30, evaluated: true } }, sections: { crawlers: [{ token: "OAI-SearchBot", kind: "search", state: "allowed", via: "no-rule" }], serverProbes: [{ token: "PerplexityBot", status: 200, blocked: false }], llms: { quality: "good", links: 3, problems: [] } }, finding_count: 2, source: "tool", ...extra });
const MENTION_ROW = (query: string, engine: string, on: string, mentioned: boolean, extra: Row = {}): Row => ({ id: `m-${query}-${engine}-${on}`, sprint_id: "sp-1", query, engine, sampled_on: on, mentioned, cited: false, position: null, cited_urls: [], competitors: [], evidence: mentioned ? "quote" : null, note: null, method: null, recorded_by: "agent-1", ...extra });

function host(routes: Route[], opts: Parameters<typeof seoHost>[0] = {}) {
  return seoHost({ routes: [...needsYouRoutes(), ...routes, ...sprintRoutes], ...opts });
}

async function sprintOf(h: ReturnType<typeof host>) {
  return (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;
}

const healthy = () => site();
const firewalled = () => site({ "https://acme.co.za/": (ua) => (/PerplexityBot/.test(ua) ? reply(403, "Forbidden") : reply(200, GOOD_HOME, {}, "https://acme.co.za/")) });

describe("auditing a sprint's site", () => {
  it("records the audit, its findings and what changed, and closes what the site no longer shows", async () => {
    const { fetcher } = healthy();
    const h = host([[/FROM plugin_seo_8099f8879a\.geo_audits/, () => [GEO_AUDIT_ROW({ score: 60 })]]], { site: fetcher });
    const outcome = await auditSprint(h.env, await companyInfo(h.env, "co-1"), await sprintOf(h), { source: "tool" });
    expect(outcome.result.score).toBeGreaterThan(80);
    expect(outcome.previous?.score).toBe(60);
    const [insert] = executed(h, /INSERT INTO plugin_seo_8099f8879a\.geo_audits/);
    expect(insert!.params).toEqual(expect.arrayContaining(["sp-1", "2026-10-03", outcome.result.score, outcome.result.band, "tool"]));
    // Evidence, not pages: the stored sections are small.
    const sections = JSON.parse(String(insert!.params[8])) as { crawlers: unknown[]; entity: { found: boolean } };
    expect(sections.crawlers.length).toBeGreaterThan(10);
    expect(sections.entity.found).toBe(true);
    expect(String(insert!.params[8]).length).toBeLessThan(6_000);
    // A re-run closes what it no longer reports: stale findings are resolved per covered resource.
    expect(executed(h, /UPDATE plugin_seo_8099f8879a\.audits/).length).toBeGreaterThan(0);
    expect(outcome.stored).toMatchObject({ resolved: expect.any(Number) });
  });

  it("stores each finding under the geo category with the page it is about", async () => {
    const { fetcher } = site({ "https://acme.co.za/robots.txt": () => reply(200, "User-agent: OAI-SearchBot\nDisallow: /\n"), "https://acme.co.za/llms.txt": () => reply(404) });
    const h = host([], { site: fetcher });
    await auditSprint(h.env, await companyInfo(h.env, "co-1"), await sprintOf(h), { source: "tool" });
    const findings = executed(h, /INSERT INTO plugin_seo_8099f8879a\.audits/);
    expect(findings.length).toBeGreaterThan(1);
    const text = findings.map((f) => f.params.map(String).join(" | "));
    expect(text.some((t) => /OAI-SearchBot/.test(t) && /geo/.test(t) && /robots\.txt/.test(t))).toBe(true);
    expect(text.some((t) => /No llms\.txt/.test(t))).toBe(true);
    // The client's choice to block a training crawler would be info, which is never stored as a finding.
    expect(text.some((t) => /GPTBot/.test(t))).toBe(false);
  });

  it("asks the site's owner to open the firewall when it refuses an AI search bot, and closes the item once the bots get through", async () => {
    const refused = host([], { site: firewalled().fetcher });
    await auditSprint(refused.env, await companyInfo(refused.env, "co-1"), await sprintOf(refused), { source: "tool" });
    const item = savedNeedsYouItems(refused).find((i) => i.key === "geo_firewall")!;
    expect(item).toMatchObject({ kind: "grant", check: "geo_firewall", status: "open" });
    expect(String(item.title)).toContain("acme.co.za");
    expect(String(item.why)).toContain("PerplexityBot");
    expect(String(item.why)).toMatch(/blocks by address range/);
    expect((item.steps as string[]).join(" ")).toMatch(/Cloudflare/);

    const open = [{ ...item, status: "open", addedAt: "2026-10-01T00:00:00Z" }];
    const passing = seoHost({ routes: [...needsYouRoutes(open), ...sprintRoutes], site: healthy().fetcher });
    await auditSprint(passing.env, await companyInfo(passing.env, "co-1"), await sprintOf(passing), { source: "tool" });
    expect(savedNeedsYouItems(passing).find((i) => i.key === "geo_firewall")).toMatchObject({ status: "done", doneBy: "checked by the SEO plugin" });
  });

  it("closes the firewall item by reading the latest audit, and does not guess before there is one", async () => {
    const info = { key: "geo_firewall", kind: "grant", title: "t", why: "w", steps: [], links: [], after: "a", check: "geo_firewall", status: "open", addedAt: "2026-10-01T00:00:00Z" } as never;
    const clean = host([[/FROM plugin_seo_8099f8879a\.geo_audits/, () => [GEO_AUDIT_ROW()]]]);
    expect(await checkNeedsYouItem(clean.env, await companyInfo(clean.env, "co-1"), await sprintOf(clean), info)).toBe(true);
    const refusedRow = GEO_AUDIT_ROW({ sections: { serverProbes: [{ token: "PerplexityBot", status: 403, blocked: true }] } });
    const refused = host([[/FROM plugin_seo_8099f8879a\.geo_audits/, () => [refusedRow]]]);
    expect(await checkNeedsYouItem(refused.env, await companyInfo(refused.env, "co-1"), await sprintOf(refused), info)).toBe(false);
    const none = host([]);
    expect(await checkNeedsYouItem(none.env, await companyInfo(none.env, "co-1"), await sprintOf(none), info)).toBeNull();
  });

  it("does not record an audit of a site that did not answer, and says what happened", async () => {
    const down = host([], { site: (async () => { throw new Error("connection refused"); }) as never });
    const outcome = await auditSprint(down.env, await companyInfo(down.env, "co-1"), await sprintOf(down), { source: "scheduled" });
    expect(outcome.audit).toBeNull();
    expect(outcome.result.notes.length).toBeGreaterThan(0);
    expect(executed(down, /INSERT INTO plugin_seo_8099f8879a\.geo_audits/)).toHaveLength(0);
  });

  it("checks the sprint's live directory listings against the name and phone the site shows", async () => {
    const routes: Route[] = [[/FROM plugin_seo_8099f8879a\.backlinks/, () => [
      { id: "b1", company_id: "co-1", sprint_id: "sp-1", source: "Yell", domain: "yell.co.za", url: "https://yell.example/acme", type: "directory", status: "live" },
      { id: "b2", company_id: "co-1", sprint_id: "sp-1", source: "Brabys", domain: "brabys.com", url: "https://brabys.example/acme", type: "directory", status: "live" },
      { id: "b3", company_id: "co-1", sprint_id: "sp-1", source: "Press", domain: "news.example", url: "https://news.example/story", type: "guest_post", status: "live" },
    ]]];
    const { fetcher, calls } = site({
      "https://yell.example/acme": () => reply(200, `<html><body>Acme Accounting Pty Ltd 031 555 0100 ${"x ".repeat(80)}</body></html>`),
      "https://brabys.example/acme": () => reply(200, `<html><body>Some other firm 031 555 0199 ${"x ".repeat(80)}</body></html>`),
    });
    const h = host(routes, { site: fetcher });
    const outcome = await auditSprint(h.env, await companyInfo(h.env, "co-1"), await sprintOf(h), { source: "tool" });
    expect(outcome.result.directories.map((d) => [d.source, d.nameFound, d.phoneFound])).toEqual([["Yell", true, true], ["Brabys", false, false]]);
    // Only directories and citations are cross-checked, never a guest post.
    expect(calls.some((c) => c.includes("news.example"))).toBe(false);
  });
});

describe("the geo-audit tool", () => {
  it("answers with the score, what it means, the crawler table by kind and the next steps", async () => {
    const h = host([], { site: firewalled().fetcher });
    const result = (await geoAuditTool(h.env, "co-1", agent, { sprintId: "sp-1" })) as Record<string, any>;
    expect(result.meaning).toMatch(/does not say how often AI assistants mention the business/);
    expect(result.crawlers.search.map((c: { token: string }) => c.token)).toEqual(expect.arrayContaining(["OAI-SearchBot", "PerplexityBot", "Googlebot"]));
    expect(result.crawlers.training.length).toBeGreaterThan(5);
    expect(result.crawlers.note).toMatch(/client's policy choice/);
    expect(result.serverProbes.find((p: { token: string }) => p.token === "PerplexityBot")).toMatchObject({ blocked: true, status: 403 });
    expect(result.next.join(" ")).toMatch(/server refuses PerplexityBot/);
    expect(result.next.join(" ")).toMatch(/No AI answers sampled yet/);
    expect(result.stored).toMatchObject({ auditId: expect.any(String) });
    expect(JSON.stringify(result).length).toBeLessThan(12_000);
  });

  it("records nothing on a dry run, refuses another site's address, and audits any site without a sprint", async () => {
    const dry = host([], { site: healthy().fetcher });
    const result = (await geoAuditTool(dry.env, "co-1", agent, { sprintId: "sp-1", dryRun: true })) as Record<string, any>;
    expect(result.stored).toEqual({ dryRun: true });
    expect(executed(dry, /INSERT INTO plugin_seo_8099f8879a\.(geo_audits|audits)/)).toHaveLength(0);
    await expect(geoAuditTool(dry.env, "co-1", agent, { sprintId: "sp-1", url: "https://evil.example/" })).rejects.toThrow(/must be on the sprint's own site/);
    await expect(geoAuditTool(dry.env, "co-1", agent, {})).rejects.toThrow(/Pass sprintId/);
    const loose = (await geoAuditTool(dry.env, "co-1", agent, { url: "https://acme.co.za", brand: "Acme Accounting" })) as Record<string, any>;
    expect(loose).toMatchObject({ siteUrl: "https://acme.co.za", stored: { dryRun: true } });
    expect(loose.sprintId).toBeUndefined();
  });

  it("samples the pages it is told to", async () => {
    const { fetcher, calls } = healthy();
    const h = host([], { site: fetcher });
    const result = (await geoAuditTool(h.env, "co-1", agent, { sprintId: "sp-1", pages: ["/about", "https://acme.co.za/contact"] })) as Record<string, any>;
    expect(result.answers.map((a: { url: string }) => a.url).sort()).toEqual(["https://acme.co.za/", "https://acme.co.za/about", "https://acme.co.za/contact"]);
    expect(calls.some((c) => c.includes("sitemap.xml"))).toBe(false);
  });
});

describe("record-ai-mentions and list-ai-mentions", () => {
  it("records what the agent got, refuses what it cannot show, and answers with the rate", async () => {
    const h = host([[/FROM plugin_seo_8099f8879a\.ai_mentions/, () => [MENTION_ROW("best accountant in durban", "search_tool", "2026-10-03", true), MENTION_ROW("vat returns", "search_tool", "2026-10-03", false)]]]);
    const result = (await recordAiMentionsTool(h.env, "co-1", agent, {
      sprintId: "sp-1",
      samples: [
        { query: "Best accountant in Durban", engine: "search_tool", mentioned: true, evidence: "Acme Accounting is recommended", competitors: ["Rival & Co"], method: "web search" },
        { query: "vat returns", engine: "search_tool", mentioned: false },
        { query: "payroll durban", engine: "chatgpt", mentioned: true },
      ],
    })) as Record<string, any>;
    expect(result.recorded).toBe(2);
    expect(result.rejected).toEqual([expect.stringContaining("Sample 3: a mention or citation needs evidence")]);
    expect(result.stats).toMatchObject({ sampled: 2, visible: 1, rate: 0.5 });
    expect(result.next).toMatch(/Fix the rejected samples/);
    const inserts = executed(h, /INSERT INTO plugin_seo_8099f8879a\.ai_mentions/);
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.sql).toMatch(/ON CONFLICT \(sprint_id, query_key, engine, sampled_on\) DO UPDATE/);
    // The question is stored as asked and as a key; who recorded it is the agent.
    expect(inserts[0]!.params.slice(3, 7)).toEqual(["Best accountant in Durban", "best accountant in durban", "search_tool", "2026-10-03"]);
    expect(inserts[0]!.params).toContain("agent-1");
    expect(inserts[0]!.params).toContain(JSON.stringify(["Rival & Co"]));
  });

  it("throws when nothing in the call can be recorded", async () => {
    const h = host([]);
    await expect(recordAiMentionsTool(h.env, "co-1", agent, { sprintId: "sp-1", samples: [{ query: "payroll durban", engine: "chatgpt", mentioned: true }] })).rejects.toThrow(/Nothing was recorded.*needs evidence/);
    await expect(recordAiMentionsTool(h.env, "co-1", agent, { sprintId: "sp-1", samples: [] })).rejects.toThrow(/at least one sampled answer/);
    expect(executed(h, /INSERT INTO plugin_seo_8099f8879a\.ai_mentions/)).toHaveLength(0);
  });

  it("lists the questions with the rate and the trend, and suggests questions until about ten are sampled", async () => {
    const rows = [
      MENTION_ROW("best accountant in durban", "chatgpt", "2026-09-10", false),
      MENTION_ROW("best accountant in durban", "chatgpt", "2026-10-02", true),
      MENTION_ROW("vat returns", "chatgpt", "2026-09-10", false),
      MENTION_ROW("vat returns", "chatgpt", "2026-10-02", false, { competitors: ["Tax Hub"] }),
      MENTION_ROW("payroll durban", "chatgpt", "2026-09-10", false),
      MENTION_ROW("payroll durban", "chatgpt", "2026-10-02", true, { cited: true }),
    ];
    const keywords: Row = { id: "k1", company_id: "co-1", sprint_id: "sp-1", phrase: "tax help durban", is_priority: true, intent: "solution", status: "ranking" };
    const h = host([[/FROM plugin_seo_8099f8879a\.ai_mentions/, () => rows], [/FROM plugin_seo_8099f8879a\.keywords/, () => [keywords]]]);
    const result = (await listAiMentionsTool(h.env, "co-1", { sprintId: "sp-1" })) as Record<string, any>;
    expect(result.stats).toMatchObject({ sampled: 3, visible: 2 });
    expect(result.trend).toMatchObject({ baseline: { on: "2026-09-10", rate: 0 }, latest: { on: "2026-10-02" }, changePoints: 66.7 });
    expect(result.questions).toHaveLength(3);
    expect(result.suggestedQuestions[0]).toBe("tax help durban");
    expect(result.note).toMatch(/signal from a handful of samples, not a measurement/);
    expect(result.engines.map((e: { engine: string }) => e.engine)).toContain("search_tool");
  });
});

describe("the score on snapshots and in summaries", () => {
  it("reuses an audit under a week old and audits again when it is older or missing", async () => {
    const fresh = host([[/FROM plugin_seo_8099f8879a\.geo_audits/, () => [GEO_AUDIT_ROW({ audited_on: "2026-09-30" })]]], { site: healthy().fetcher });
    const snap = await geoForSnapshot(fresh.env, await companyInfo(fresh.env, "co-1"), await sprintOf(fresh));
    expect(snap).toMatchObject({ score: 72, checkedOn: "2026-09-30" });
    expect(executed(fresh, /INSERT INTO plugin_seo_8099f8879a\.geo_audits/)).toHaveLength(0);
    const stale = host([[/FROM plugin_seo_8099f8879a\.geo_audits/, () => [GEO_AUDIT_ROW({ audited_on: "2026-09-20" })]]], { site: healthy().fetcher });
    await geoForSnapshot(stale.env, await companyInfo(stale.env, "co-1"), await sprintOf(stale));
    expect(executed(stale, /INSERT INTO plugin_seo_8099f8879a\.geo_audits/)).toHaveLength(1);
    const none = host([], { site: healthy().fetcher });
    await geoForSnapshot(none.env, await companyInfo(none.env, "co-1"), await sprintOf(none));
    expect(executed(none, /INSERT INTO plugin_seo_8099f8879a\.geo_audits/)).toHaveLength(1);
  });

  it("never fails a snapshot because the site did not answer", async () => {
    const down = host([], { site: (async () => { throw new Error("down"); }) as never });
    const snap = await geoForSnapshot(down.env, await companyInfo(down.env, "co-1"), await sprintOf(down));
    expect(snap).toMatchObject({ score: null, mentions: null });
  });

  it("combines the latest audit with the sampled answers", async () => {
    const h = host([[/FROM plugin_seo_8099f8879a\.geo_audits/, () => [GEO_AUDIT_ROW()]], [/FROM plugin_seo_8099f8879a\.ai_mentions/, () => [MENTION_ROW("q1", "chatgpt", "2026-10-01", true), MENTION_ROW("q2", "chatgpt", "2026-10-01", false)]]]);
    expect(await geoSummary(h.env, await sprintOf(h))).toMatchObject({ score: 72, band: "good", mentions: { sampled: 2, visible: 1, rate: 0.5 } });
  });
});

describe("the snapshot carries both new parts", () => {
  it("stores the AI-search score and the GA4 organic numbers with the day's traffic and rankings", async () => {
    const week = { week_start: "2026-09-21", property_id: "222222222", sessions: 500, engaged_sessions: 380, users: 410, key_events: 40, organic_sessions: 200, organic_engaged_sessions: 150, organic_users: 170, organic_key_events: 12, channels: [], landing_pages: [], sources: [], key_event_names: [], ai_referrals: [] };
    const h = host([
      [/FROM plugin_seo_8099f8879a\.geo_audits/, () => [GEO_AUDIT_ROW({ audited_on: "2026-10-02" })]],
      [/FROM plugin_seo_8099f8879a\.ai_mentions/, () => [MENTION_ROW("q1", "chatgpt", "2026-10-01", true), MENTION_ROW("q2", "chatgpt", "2026-10-01", false)]],
      [/FROM plugin_seo_8099f8879a\.analytics_weeks/, () => [week]],
      [/FROM plugin_seo_8099f8879a\.integrations/, () => [{ id: "i-ga4", company_id: "co-1", sprint_id: "sp-1", provider: "ga4", status: "connected", property_url: "properties/222222222", settings: { propertyId: "222222222" } }]],
    ], { site: healthy().fetcher });
    const info = await companyInfo(h.env, "co-1");
    await captureSnapshot(h.env, info, await sprintOf(h), { day: 30, kind: "manual" });
    const [insert] = executed(h, /INSERT INTO plugin_seo_8099f8879a\.audit_snapshots/);
    expect(insert!.sql).toContain("geo, analytics");
    const geo = JSON.parse(String(insert!.params[14]));
    const analytics = JSON.parse(String(insert!.params[15]));
    expect(geo).toMatchObject({ score: 72, band: "good", checkedOn: "2026-10-02", mentions: { sampled: 2, visible: 1, rate: 0.5 } });
    expect(analytics).toMatchObject({ propertyId: "222222222", organicSessions: 200, organicKeyEvents: 12, lastWeek: { weekStart: "2026-09-21" } });
    // The audit was a day old, so the snapshot reused it and did not fetch the site.
    expect(executed(h, /INSERT INTO plugin_seo_8099f8879a\.geo_audits/)).toHaveLength(0);
  });

  it("stores empty parts, not a failure, when the site never answered and GA4 is not connected", async () => {
    const h = host([], { site: (async () => { throw new Error("down"); }) as never });
    await captureSnapshot(h.env, await companyInfo(h.env, "co-1"), await sprintOf(h), { day: 30, kind: "manual" });
    const [insert] = executed(h, /INSERT INTO plugin_seo_8099f8879a\.audit_snapshots/);
    expect(JSON.parse(String(insert!.params[14]))).toMatchObject({ score: null, mentions: null });
    expect(JSON.parse(String(insert!.params[15]))).toEqual({});
  });
});

describe("the scheduled audit", () => {
  const run = async (routes: Route[], opts: { day?: number; status?: string } = {}) => {
    const h = host(routes, { site: healthy().fetcher });
    const sprint = { ...(await sprintOf(h)), ...(opts.status ? { status: opts.status as never } : {}) };
    const result = await scheduledGeo(h.env, await companyInfo(h.env, "co-1"), sprint, opts.day ?? 32);
    return { h, result };
  };
  const audit = (days: number) => [/FROM plugin_seo_8099f8879a\.geo_audits/, () => [GEO_AUDIT_ROW({ audited_on: new Date(Date.parse("2026-10-03") - days * 86_400_000).toISOString().slice(0, 10) })]] as Route;

  it("refreshes a snapshot's audit after a week and the scheduled one after four weeks (the numbers themselves, not the constants)", () => {
    expect(SNAPSHOT_REUSE_DAYS).toBe(7);
    expect(SCHEDULED_AUDIT_DAYS).toBe(28);
  });

  it("audits a sprint that never was, leaves a recent audit alone, and refreshes one older than four weeks", async () => {
    expect((await run([])).result.audited).toBe(true);
    expect((await run([audit(3)])).result.audited).toBe(false);
    expect((await run([audit(SCHEDULED_AUDIT_DAYS - 1)])).result.audited).toBe(false);
    expect((await run([audit(SCHEDULED_AUDIT_DAYS)])).result.audited).toBe(true);
  });

  it("re-checks every day while the firewall item is open", async () => {
    const open = [{ key: "geo_firewall", kind: "grant", title: "t", why: "w", steps: [], links: [], after: "a", check: "geo_firewall", status: "open", addedAt: "2026-10-01T00:00:00Z" }];
    const openDigest: Route = [/SELECT n\.sprint_id, n\.items FROM plugin_seo_8099f8879a\.needs_you n/, () => [{ sprint_id: "sp-1", items: open }]];
    const { result } = await run([openDigest, audit(1)]);
    expect(result.audited).toBe(true);
    // Audited today already: not twice in a day.
    expect((await run([openDigest, audit(0)])).result.audited).toBe(false);
  });

  it("does nothing before the sprint starts or while it is paused", async () => {
    expect((await run([], { day: -2 })).result.audited).toBe(false);
    expect((await run([], { status: "paused" })).result.audited).toBe(false);
  });
});

describe("the monthly re-check after day 90", () => {
  const compounding = { now: "2026-12-03T08:00:00Z" }; // day 93 of a sprint that started 2026-09-01: week 14

  it("opens one agent task a month, due at once, with the week-8 playbook", async () => {
    const h = host([], compounding);
    const created = await ensureMonthlyGeoTask(h.env, await companyInfo(h.env, "co-1"), await sprintOf(h));
    expect(created).toEqual(expect.any(String));
    const [insert] = executed(h, /INSERT INTO plugin_seo_8099f8879a\.sprint_tasks/);
    expect(insert!.sql).toContain("ON CONFLICT (sprint_id, template_key)");
    expect(insert!.params).toEqual(expect.arrayContaining([monthlyGeoKey("2026-12"), "geo-mention-check", "w8-geo-recheck", "template", "agent"]));
    expect(insert!.params).toContain(14); // the week
    expect(insert!.params).toContain(93); // due today
    expect(insert!.params.find((p) => typeof p === "string" && p.startsWith("Monthly AI search check"))).toContain("2026-12");
  });

  it("opens none while the plan is still running, and none for a sprint that is paused or archived", async () => {
    const active = host([]);
    expect(await ensureMonthlyGeoTask(active.env, await companyInfo(active.env, "co-1"), await sprintOf(active))).toBeNull();
    const paused = host([], compounding);
    expect(await ensureMonthlyGeoTask(paused.env, await companyInfo(paused.env, "co-1"), { ...(await sprintOf(paused)), status: "paused" })).toBeNull();
    expect(executed(active, /INSERT INTO plugin_seo_8099f8879a\.sprint_tasks/)).toHaveLength(0);
    expect(executed(paused, /INSERT INTO plugin_seo_8099f8879a\.sprint_tasks/)).toHaveLength(0);
  });

  it("is the same task key within a month (the database refuses a second one) and a new key next month", () => {
    expect(monthlyGeoKey("2026-12")).toBe("geo-recheck:2026-12");
    expect(monthlyGeoKey("2027-01")).not.toBe(monthlyGeoKey("2026-12"));
    expect(GEO_TASKS.some((t) => t.templateKey === monthlyGeoKey("2026-12"))).toBe(false);
    expect(SPRINT.start_date).toBe("2026-09-01");
  });
});

describe("an audit that could not check something does not close what it found there", () => {
  const openFindings = (texts: string[]): Route => [/SELECT finding FROM plugin_seo_8099f8879a\.audits WHERE sprint_id = \$1/, () => texts.map((finding) => ({ finding }))];
  /** The resources each re-run closed findings for: [url, the findings it kept open]. */
  const closed = (h: ReturnType<typeof host>) => new Map(executed(h, /UPDATE plugin_seo_8099f8879a\.audits SET status = 'resolved'/).map((e) => [String(e.params[2]), JSON.parse(String(e.params[4])) as string[]]));
  const audit = async (h: ReturnType<typeof host>) => auditSprint(h.env, await companyInfo(h.env, "co-1"), await sprintOf(h), { source: "scheduled" });

  it("a home page and robots.txt that fail with a server error leave their findings open", async () => {
    const healthyRun = host([], { site: healthy().fetcher });
    await audit(healthyRun);
    // The healthy site closes what it no longer reports on both: the baseline that makes the next assertion mean something.
    expect([...closed(healthyRun).keys()]).toEqual(expect.arrayContaining(["https://acme.co.za/", "https://acme.co.za/robots.txt"]));

    const { fetcher } = site({ "https://acme.co.za/robots.txt": () => reply(503), "https://acme.co.za/": () => reply(503) });
    const down = host([], { site: fetcher });
    const outcome = await audit(down);
    expect(outcome.audit).not.toBeNull(); // the pages from the sitemap answered: the audit is stored
    const urls = [...closed(down).keys()];
    expect(urls).not.toContain("https://acme.co.za/");
    expect(urls).not.toContain("https://acme.co.za/robots.txt");
    expect(urls).toEqual(expect.arrayContaining(["https://acme.co.za/about", "https://acme.co.za/llms.txt"]));
  });

  it("an llms.txt that fails with a server error is neither reported missing nor closed", async () => {
    const down = host([], { site: site({ "https://acme.co.za/llms.txt": () => reply(503) }).fetcher });
    await audit(down);
    expect([...closed(down).keys()]).not.toContain("https://acme.co.za/llms.txt");
    expect(executed(down, /INSERT INTO plugin_seo_8099f8879a\.audits/).some((e) => e.params.map(String).join(" ").includes("No llms.txt"))).toBe(false);
  });

  it("keeps what an earlier audit said about a bot this run could not judge (rate limiting), and closes the rest", async () => {
    let plain = 0;
    const { fetcher } = site({
      "https://acme.co.za/llms.txt": () => reply(404),
      "https://acme.co.za/": (ua) => {
        if (/PerplexityBot/.test(ua)) return reply(403, "Forbidden");
        if (!ua && ++plain >= 2) return reply(429, "Too many requests"); // the ordinary request after the burst
        return reply(200, GOOD_HOME, {}, "https://acme.co.za/");
      },
    });
    const earlier = ["The server refuses PerplexityBot (HTTP 403) although robots.txt may allow it: AI search cannot read the site.", "Organization data: logo is missing"];
    const h = host([openFindings(earlier)], { site: fetcher });
    const outcome = await audit(h);
    const kept = closed(h).get("https://acme.co.za/")!;
    expect(kept).toContain(earlier[0]); // not judged: stays open
    expect(kept).not.toContain(earlier[1]); // judged (the page now has complete organisation data): closed
    expect(outcome.result.notes.join(" ")).toMatch(/looks like rate limiting/);
    // A refusal that could not be confirmed raises nothing.
    expect(savedNeedsYouItems(h).find((i) => i.key === "geo_firewall")).toBeUndefined();
  });

  it("keeps the unjudged bot's finding open even when the same page has findings of its own this run", async () => {
    let plain = 0;
    const { fetcher } = site({
      "https://acme.co.za/llms.txt": () => reply(404),
      "https://acme.co.za/": (ua) => {
        if (/PerplexityBot/.test(ua)) return reply(403, "Forbidden");
        if (!ua && ++plain >= 2) return reply(429, "Too many requests");
        return reply(200, page(""), {}, "https://acme.co.za/"); // no organisation data: a finding of this run on the home page
      },
    });
    const refusal = "The server refuses PerplexityBot (HTTP 403) although robots.txt may allow it: AI search cannot read the site.";
    const h = host([openFindings([refusal, "Organization data: logo is missing"])], { site: fetcher });
    await audit(h);
    const kept = closed(h).get("https://acme.co.za/")!;
    expect(kept.some((f) => /^No Organization or LocalBusiness data on the home page/.test(f))).toBe(true); // this run's own finding
    expect(kept).toContain(refusal); // still held open
    expect(kept).not.toContain("Organization data: logo is missing");
  });

  it("holds open what either listing of the same resource could not judge", async () => {
    const h = host([openFindings(["a", "b", "c"])]);
    const sprint = await sprintOf(h);
    await recordCheckFindings(h.env, sprint, "geo-audit", [], [
      { category: "geo", url: "https://acme.co.za/", keepOpen: (f) => f === "a" },
      { category: "geo", url: "https://acme.co.za/", keepOpen: (f) => f === "b" },
      { category: "geo", url: "https://acme.co.za/about" }, // listed once, without a hold
      { category: "geo", url: "https://acme.co.za/about", keepOpen: (f) => f === "c" }, // a later listing adds one
    ]);
    expect(closed(h).get("https://acme.co.za/")!.sort()).toEqual(["a", "b"]);
    expect(closed(h).get("https://acme.co.za/about")).toEqual(["c"]);
  });

  it("a judged run keeps nothing: every earlier finding the page no longer shows is closed", async () => {
    const earlier = ["The server refuses PerplexityBot (HTTP 403) although robots.txt may allow it: AI search cannot read the site."];
    const h = host([openFindings(earlier)], { site: healthy().fetcher });
    await audit(h);
    expect(closed(h).get("https://acme.co.za/")).not.toContain(earlier[0]);
  });
});

describe("the firewall item", () => {
  const item = (extra: Record<string, unknown> = {}) => ({ key: "geo_firewall", kind: "grant", title: "t", why: "The server of acme.co.za refused PerplexityBot (HTTP 403) twice", steps: [], links: [], after: "a", check: "geo_firewall", status: "open", addedAt: "2026-10-01T00:00:00Z", optional: true, ...extra });
  const digest = (items: unknown[]): Row => ({ id: "ny-0", company_id: "co-1", sprint_id: "sp-1", week_start: "2026-09-21", issue_id: "ny-issue", issue_identifier: "PIB-9", items, status: "done", updated_at: "2026-09-24T00:00:00Z" });
  const hostWith = (ny: ReturnType<typeof needsYouRoutes>, siteFetcher: ReturnType<typeof site>["fetcher"]) => seoHost({ routes: [...ny, ...sprintRoutes], site: siteFetcher });
  const audit = async (h: ReturnType<typeof seoHost>) => auditSprint(h.env, await companyInfo(h.env, "co-1"), (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!, { source: "scheduled" });
  const flaky = () => {
    let first = true;
    return site({ "https://acme.co.za/": (ua) => { if (/PerplexityBot/.test(ua) && first) { first = false; return reply(403, "Forbidden"); } return reply(200, GOOD_HOME, {}, "https://acme.co.za/"); } }).fetcher;
  };
  const training = () => site({ "https://acme.co.za/": (ua) => (/GPTBot|ClaudeBot/.test(ua) ? reply(403, "Forbidden") : reply(200, GOOD_HOME, {}, "https://acme.co.za/")) }).fetcher;

  it("is advice, not a blocker: optional, so it neither parks the crawler task nor counts as waiting on the owner", async () => {
    const h = hostWith(needsYouRoutes(), firewalled().fetcher);
    await audit(h);
    expect(savedNeedsYouItems(h).find((i) => i.key === "geo_firewall")).toMatchObject({ optional: true, check: "geo_firewall", status: "open" });
  });

  it("is not raised for a refusal that was a blip, nor for a refused training crawler", async () => {
    const blip = hostWith(needsYouRoutes(), flaky());
    await audit(blip);
    expect(savedNeedsYouItems(blip).find((i) => i.key === "geo_firewall")).toBeUndefined();
    const training_ = hostWith(needsYouRoutes(), training());
    const outcome = await audit(training_);
    expect(outcome.result.serverProbes.filter((p) => p.blocked).map((p) => p.token).sort()).toEqual(["ClaudeBot", "GPTBot"]);
    expect(savedNeedsYouItems(training_).find((i) => i.key === "geo_firewall")).toBeUndefined();
  });

  it("is not raised again for the same bots once the owner marked it done as a false alarm", async () => {
    const dismissed = hostWith(needsYouRoutes([], { recent: [digest([item({ status: "done", doneBy: "user user-1", doneAt: "2026-09-24T00:00:00Z" })])] }), firewalled().fetcher);
    await audit(dismissed);
    expect(savedNeedsYouItems(dismissed).find((i) => i.key === "geo_firewall")).toBeUndefined();
    // A different bot refused now: the owner's answer was about PerplexityBot only.
    const widened = hostWith(needsYouRoutes([], { recent: [digest([item({ status: "done", doneBy: "user user-1", why: "The server of acme.co.za refused OAI-SearchBot (HTTP 403) twice" })])] }), firewalled().fetcher);
    await audit(widened);
    expect(savedNeedsYouItems(widened).find((i) => i.key === "geo_firewall")).toMatchObject({ status: "open" });
  });

  it("is raised again when one more bot is refused than the owner answered for", async () => {
    const two = site({ "https://acme.co.za/": (ua) => (/PerplexityBot|OAI-SearchBot/.test(ua) ? reply(403, "Forbidden") : reply(200, GOOD_HOME, {}, "https://acme.co.za/")) }).fetcher;
    // The owner said "fine" about PerplexityBot only (its name is the only one in the item's text).
    const h = hostWith(needsYouRoutes([], { recent: [digest([item({ status: "done", doneBy: "user user-1" })])] }), two);
    await audit(h);
    const raised = savedNeedsYouItems(h).find((i) => i.key === "geo_firewall")!;
    expect(raised).toMatchObject({ status: "open" });
    expect(String(raised.why)).toContain("OAI-SearchBot");
  });

  it("is raised again when the plugin (not a person) closed it earlier and the refusal came back", async () => {
    const h = hostWith(needsYouRoutes([], { recent: [digest([item({ status: "done", doneBy: "checked by the SEO plugin" })])] }), firewalled().fetcher);
    await audit(h);
    expect(savedNeedsYouItems(h).find((i) => i.key === "geo_firewall")).toMatchObject({ status: "open" });
  });

  it("reopens an item the plugin closed earlier this week when the refusal comes back, but leaves one a person closed this week alone", async () => {
    const thisWeek = (doneBy: string) => digest([item({ status: "done", doneBy })]);
    const byPlugin = hostWith(needsYouRoutes([item({ status: "done", doneBy: "checked by the SEO plugin" })], { recent: [thisWeek("checked by the SEO plugin")] }), firewalled().fetcher);
    await audit(byPlugin);
    expect(savedNeedsYouItems(byPlugin).find((i) => i.key === "geo_firewall")).toMatchObject({ status: "open", doneBy: null });
    const byPerson = hostWith(needsYouRoutes([item({ status: "done", doneBy: "user user-1" })], { recent: [thisWeek("user user-1")] }), firewalled().fetcher);
    await audit(byPerson);
    expect(savedNeedsYouItems(byPerson).find((i) => i.key === "geo_firewall")).toBeUndefined(); // nothing was written: still done
  });

  it("closes only when no search bot is refused: a refused training crawler does not keep it open", async () => {
    const open = item();
    const run = async (probes: unknown[]) => {
      const h = hostWith(needsYouRoutes(), healthy().fetcher);
      h.routes.unshift([/FROM plugin_seo_8099f8879a\.geo_audits/, () => [GEO_AUDIT_ROW({ sections: { serverProbes: probes } })]]);
      return checkNeedsYouItem(h.env, await companyInfo(h.env, "co-1"), (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!, open as never);
    };
    expect(await run([{ token: "GPTBot", kind: "training", status: 403, blocked: true }, { token: "PerplexityBot", kind: "search", status: 200, blocked: false }])).toBe(true);
    expect(await run([{ token: "GPTBot", status: 403, blocked: true }])).toBe(true); // stored before the kind was kept: looked up by name
    expect(await run([{ token: "PerplexityBot", kind: "search", status: 403, blocked: true }, { token: "GPTBot", kind: "training", status: 403, blocked: true }])).toBe(false);
  });

  it("can be closed by a person who says it is fine, but not by an agent while the probe still sees a refusal", async () => {
    const refusedAudit: Route = [/FROM plugin_seo_8099f8879a\.geo_audits/, () => [GEO_AUDIT_ROW({ sections: { serverProbes: [{ token: "PerplexityBot", kind: "search", status: 403, blocked: true }] } })]];
    const open = item();
    const asPerson = host([refusedAudit]);
    asPerson.routes.unshift(...needsYouRoutes([open]));
    expect(await needsYouResolveTool(asPerson.env, "co-1", person, { sprintId: "sp-1", key: "geo_firewall", note: "Cloudflare verifies the bots by address" })).toMatchObject({ resolved: true });
    expect(savedNeedsYouItems(asPerson).find((i) => i.key === "geo_firewall")).toMatchObject({ status: "done", doneBy: "user user-1" });
    const asAgent = host([refusedAudit]);
    asAgent.routes.unshift(...needsYouRoutes([open]));
    expect(await needsYouResolveTool(asAgent.env, "co-1", agent, { sprintId: "sp-1", key: "geo_firewall" })).toMatchObject({ resolved: false, stillOpen: expect.stringContaining("does not see") });
    // Closing the digest issue is a person's act too.
    // The owner closes the digest issue: that is a person's word too (the plugin's probe still sees the refusal).
    const closedByOwner = host([refusedAudit, [/FROM plugin_seo_8099f8879a\.needs_you WHERE company_id = \$1 AND issue_id = \$2/, () => [{ id: "ny-1", company_id: "co-1", sprint_id: "sp-1", week_start: "2026-09-28", issue_id: "ny-issue", issue_identifier: "PIB-9", items: [open], status: "open" }]]]);
    closedByOwner.routes.unshift(...needsYouRoutes([open]));
    closedByOwner.ctx.issues.get = (async (id: string) => ({ id, status: "done", identifier: "PIB-9" })) as never;
    expect(await onNeedsYouIssueUpdated(closedByOwner.env, "co-1", "ny-issue")).toBe(true);
    expect(savedNeedsYouItems(closedByOwner).find((i) => i.key === "geo_firewall")).toMatchObject({ status: "done", doneBy: "the sprint owner (closed the Needs you issue)" });
    const direct = host([refusedAudit]);
    direct.routes.unshift(...needsYouRoutes([open]));
    const info = await companyInfo(direct.env, "co-1");
    const sprint = await sprintOf(direct);
    expect((await resolveNeedsYou(direct.env, info, sprint, "geo_firewall", "the sprint owner (closed the Needs you issue)", null, { person: true })).resolved).toBe(true);
    expect((await resolveNeedsYou(direct.env, info, sprint, "geo_firewall", "agent agent-1")).resolved).toBe(false);
  });
});

describe("what the audit sends to a site", () => {
  const botCalls = (calls: string[]) => calls.filter((c) => /\[(OAI-SearchBot|Claude-SearchBot|PerplexityBot|GPTBot|ClaudeBot)\]/.test(c));

  it("probes with the bots' user agents only on the sprint's own site, never on another address", async () => {
    const own = site();
    const h = host([], { site: own.fetcher });
    await geoAuditTool(h.env, "co-1", agent, { sprintId: "sp-1", dryRun: true });
    expect(botCalls(own.calls)).toHaveLength(5);
    const other = site();
    const loose = host([], { site: other.fetcher });
    const result = (await geoAuditTool(loose.env, "co-1", agent, { url: "https://acme.co.za" })) as Record<string, any>;
    expect(botCalls(other.calls)).toEqual([]);
    expect(result.serverProbes).toEqual([]);
  });
});
