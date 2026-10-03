import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { cockpitSnapshot, healthTone, integrationChecks, publishCockpitSnapshots, sprintDayLabel, sprintHref, staleNeedsYou, stuckAnnouncementChecks } from "../src/cockpit.js";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv } from "../src/service/common.js";
import { announcementLine, contentPayload, contentWentLive, liveUrlFromEvidence, pageSummary, processAnnouncements, PUBLISH_TASK_TYPES, publishTaskDone, releaseAnnouncements } from "../src/service/handoff.js";
import { memoryAnnouncements } from "./helpers/announcements.js";
import { SEO_ROLE } from "../src/service/hire.js";
import { hireTaskDraft } from "@partnersinbiz/pib-plugin-kit";
import plugin from "../src/worker.js";
import { validateParams, validateRuntimeQuery } from "./helpers/sql-guard.js";
import { addDays, localDate } from "../src/engine/time.js";

type Row = Record<string, unknown>;
const T = (name: string) => `${NAMESPACE}.${name}`;
const DAY = 24 * 3600_000;

function fakeCtx(rows: (sql: string, params: unknown[]) => Row[], opts: { state?: Record<string, unknown>; config?: Row; emit?: ReturnType<typeof vi.fn> } = {}) {
  const queries: string[] = [];
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs"]);
        validateParams(sql, params);
        queries.push(sql);
        return rows(sql, params);
      },
      async execute() {
        throw new Error("the snapshot never writes");
      },
    },
    config: { get: vi.fn(async () => opts.config ?? {}) },
    state: {
      get: vi.fn(async (key: { namespace?: string; stateKey: string }) => opts.state?.[`${key.namespace}:${key.stateKey}`] ?? null),
      set: vi.fn(async () => undefined),
    },
    agents: { get: vi.fn(async (id: string) => ({ id, status: "idle", name: "SEO Specialist" })) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PIB" })), list: vi.fn(async () => []) },
    events: { emit: opts.emit ?? vi.fn(async () => undefined), on: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
  return { ctx, queries };
}

const SPRINT_ROW = { sprint_id: "sp-1", site_name: "Partners in Biz", client_kind: null, client_ref: null, client_name: null, status: "active", current_day: 34, health: { score: 62 }, autopilot_mode: "safe" };
const ACME_ROW = { sprint_id: "sp-2", site_name: "Acme", client_kind: "company", client_ref: "c1", client_name: "Acme", status: "active", current_day: 80, health: { score: 81 }, autopilot_mode: "safe" };

/** Sprint days count from the start date in the company's timezone, like the SEO page. */
const TODAY = localDate(new Date(), "Africa/Johannesburg");
const sprintDbRow = (row: Row, day: number): Row => ({
  id: row.sprint_id, company_id: "co-1", name: row.site_name, site_url: "https://site.co.za", site_name: row.site_name, client_kind: row.client_kind, client_ref: row.client_ref,
  client_name: row.client_name, status: row.status, start_date: addDays(TODAY, -day), template_id: "outrank-90", template_version: 4, autopilot_mode: row.autopilot_mode,
  health: row.health, scoreboard: {}, today: {}, audit_days_done: [], seeded_at: "2026-08-01T00:00:00Z", created_at: "2026-08-01T00:00:00Z",
});
/** Open tasks of sp-1 (day 34): three a week or more past their day (overdue), one due 4 days ago. */
const OPEN_TASKS: Row[] = [1, 20, 27, 30].map((due, i) => ({
  id: `ot-${i}`, company_id: "co-1", sprint_id: "sp-1", template_key: null, week: 1, phase: 1, due_day: due, focus: "", title: `Task ${i}`, task_type: "custom",
  owner: "agent", autopilot_eligible: true, status: i === 0 ? "in_progress" : "not_started", source: "manual", issue_id: `iss-${i}`, assignee_kind: "agent",
}));

describe("SEO cockpit snapshot (unconfigured)", () => {
  it("returns zero KPIs, jobs that have not run and nothing waiting, without writing", async () => {
    const { ctx } = fakeCtx(() => []);
    const snap = await cockpitSnapshot(ctx, "co-1");
    expect(snap).toMatchObject({ plugin: "partnersinbiz.seo", title: "SEO", waiting: [], activity: [] });
    // No Google Analytics numbers and no AI-search audit yet: those two KPIs are left out, not shown as zero.
    expect(snap.kpis.map((k) => [k.key, k.value])).toEqual([
      ["seo_active_sprints", "0"],
      ["seo_tasks_done_7d", "0"],
      ["seo_overdue_tasks", "0"],
      ["seo_keywords_top10", "0"],
    ]);
    expect(snap.health).toEqual([
      { key: "job:seo-daily", title: "Daily SEO run", status: "ok", detail: "Has not run yet." },
      { key: "job:seo-weekly", title: "Weekly SEO review", status: "ok", detail: "Has not run yet." },
    ]);
    expect(snap.quality.map((q) => q.key)).toEqual(["seo_optimization_win_rate_90d", "seo_tasks_reopened_30d", "seo_tasks_blocked"]);
  });

  it("one failing query never breaks the snapshot", async () => {
    const { ctx } = fakeCtx((sql) => {
      if (sql.includes("AS done_7d")) throw new Error("boom");
      return [];
    });
    const snap = await cockpitSnapshot(ctx, "co-1");
    expect(snap.kpis).toEqual([]);
    expect(snap.health).toHaveLength(2);
    expect(snap.quality).toHaveLength(3);
  });
});

describe("SEO cockpit snapshot (configured)", () => {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const state = {
    "pib-cockpit-jobs:job:seo-daily": { lastStartedAt: null, lastOkAt: iso(5 * 3600_000), lastErrorAt: iso(60_000), lastError: "GSC: 403", consecutiveFailures: 3 },
    "pib-cockpit-jobs:job:seo-weekly": { lastStartedAt: null, lastOkAt: iso(2 * DAY), lastErrorAt: null, lastError: null, consecutiveFailures: 0 },
  };
  const rows = (sql: string): Row[] => {
    if (sql.includes(`FROM ${T("sprints")} WHERE company_id = $1 ORDER BY`)) return [sprintDbRow(ACME_ROW, 80), sprintDbRow(SPRINT_ROW, 34)];
    if (sql.includes(`FROM ${T("sprint_tasks")}`) && sql.includes("WHERE company_id = $1 AND status IN")) return OPEN_TASKS;
    if (sql.includes("AS done_7d")) return [{ done_7d: "5", top10: "4", tracked: "30", clicks: "812.0", organic_visits: "1240", ai_readiness: "58" }];
    if (sql.includes(`FROM ${T("integrations")} i JOIN`) && sql.includes("ORDER BY s.created_at LIMIT 30")) {
      return [
        { ...SPRINT_ROW, provider: "gsc", status: "connected", last_error: "User does not have sufficient permission", last_pull_at: "2026-09-20T05:00:00Z", updated_at: "2026-09-26T05:00:00Z" },
        { ...ACME_ROW, provider: "gsc", status: "connected", last_error: null, last_pull_at: "2026-09-20T05:00:00Z", updated_at: null },
        { ...SPRINT_ROW, provider: "bing", status: "enabled", last_error: "401 Unauthorized", last_pull_at: null, updated_at: null },
      ];
    }
    if (sql.includes("AS n FROM")) return [{ n: "1" }];
    if (sql.includes(`FROM ${T("needs_you")} n JOIN`)) {
      return [{
        ...SPRINT_ROW,
        issue_id: "iss-ny",
        items: [
          { key: "service_account", kind: "grant", title: "Add the service account key", why: "Search Console needs it.", steps: [], links: [], after: "", check: "service_account", status: "open", addedAt: iso(10 * DAY) },
          { key: "review:t-9", kind: "review", title: "Sign off: Publish post 1", why: "Ready to publish.", steps: [], links: [], after: "", check: "task_done", taskIds: ["t-9"], status: "open", addedAt: iso(DAY) },
          { key: "optional-dm", kind: "message", title: "DM a partner", why: "Optional", steps: [], links: [], after: "", check: "manual", status: "open", optional: true, addedAt: iso(DAY) },
          { key: "old", kind: "task", title: "Done thing", why: "", steps: [], links: [], after: "", check: "manual", status: "done", addedAt: iso(20 * DAY) },
        ],
      }];
    }
    if (sql.includes(`FROM ${T("sprint_tasks")} WHERE company_id = $1 AND id IN`)) return [{ id: "t-9", issue_id: "iss-t9" }];
    if (sql.includes(`FROM ${T("optimizations")} o JOIN`) && sql.includes("o.status = 'proposed'")) {
      return [{ id: "o-1", subject: "/pricing stuck on page 2", proposed_action: "Rewrite the title and intro", approval_issue_id: "iss-opt", created_at: "2026-09-21T05:00:00Z", ...ACME_ROW }];
    }
    if (sql.includes("k.status = 'done' AND k.completed_at IS NOT NULL")) {
      return [
        { title: "Merge the approved PR: Publish post 1", completed_at: "2026-09-26T07:00:00Z", completed_by: "agent-1", by_kind: "agent", links: ["https://github.com/pib/site/pull/7"], ...SPRINT_ROW },
        { title: "Submit sitemap", completed_at: "2026-09-25T07:00:00Z", completed_by: "user-1", by_kind: "user", links: [], ...ACME_ROW },
      ];
    }
    if (sql.includes("o.measured_at IS NOT NULL")) return [{ subject: "Title rewrite on /services", result: "win", measured_at: "2026-09-24T07:00:00Z", ...SPRINT_ROW }];
    if (sql.includes("AS wins")) return [{ wins: "1", losses: "3", measured: "5", reopened: "3", blocked: "2" }];
    return [];
  };

  it("fills KPIs, health, waiting, activity and quality", async () => {
    const { ctx } = fakeCtx(rows, { state, config: { timezone: "Africa/Johannesburg" } });
    const snap = await cockpitSnapshot(ctx, "co-1");
    const kpi = Object.fromEntries(snap.kpis.map((k) => [k.key, k]));
    expect(kpi.seo_active_sprints).toMatchObject({ value: "2", delta: "days 34–80 of 90", group: "marketing" });
    expect(kpi.seo_tasks_done_7d).toMatchObject({ value: "5" });
    // The SEO page's definitions: due now = 4, overdue (a week or more past its day) = 3.
    expect(kpi.seo_overdue_tasks).toMatchObject({ value: "3", tone: "warn", delta: "4 due now; overdue = open a week after its day" });
    // No SEO agent is linked here, so the due agent work is stuck.
    expect(kpi.seo_stuck_tasks).toMatchObject({ value: "4", tone: "bad", delta: "No SEO agent is linked: fix in Setup → Team", href: "/setup?section=team#team-seo-specialist" });
    expect(kpi.seo_keywords_top10).toMatchObject({ value: "4", delta: "of 30 tracked" });
    expect(kpi.seo_clicks).toMatchObject({ value: "812", raw: 812 });
    // Google Analytics organic visits and AI-search readiness show only once there are numbers.
    expect(kpi.seo_organic_visits).toMatchObject({ value: "1,240", raw: 1240, label: "Organic visits (last 4 weeks, Google Analytics)", group: "marketing" });
    expect(kpi.seo_ai_readiness).toMatchObject({ value: "58/100", raw: 58, tone: "warn", label: "AI-search readiness (lowest sprint)" });
    expect(kpi.seo_health_score).toMatchObject({ value: "62/100", tone: "warn", label: "SEO health (lowest sprint)" });

    const health = Object.fromEntries(snap.health.map((h) => [h.key, h]));
    expect(health["job:seo-daily"]).toMatchObject({ status: "bad", detail: "Last error: GSC: 403" });
    expect(health["job:seo-weekly"]!.status).toBe("ok");
    expect(health["gsc:sp-1"]).toMatchObject({ status: "bad", title: "Search Console pull failing: Partners in Biz", href: "/seo?sprint=sp-1&tab=integrations" });
    expect(health["gsc:sp-2"]).toMatchObject({ status: "warn", title: "Search Console data is old: [Acme] Acme", href: "/seo?sprint=sp-2&tab=integrations&client=company%3Ac1" });
    expect(health["bing:sp-1"]).toMatchObject({ status: "warn", title: "Bing check failing: Partners in Biz", detail: "Bing turned down the API key. Check the Bing key in the SEO settings." });
    expect(health["service-account"]).toMatchObject({ status: "warn" });
    expect(health["needs-you:sp-1"]).toMatchObject({ status: "warn", detail: "1 item: Add the service account key" });

    expect(snap.waiting.map((w) => [w.key, w.kind, w.issueId])).toEqual([
      ["seo:needs-you:sp-1:service_account", "grant", "iss-ny"],
      ["seo:needs-you:sp-1:review:t-9", "review", "iss-t9"],
      ["seo:optimization:o-1", "judgement", "iss-opt"],
    ]);
    expect(snap.waiting[2]).toMatchObject({ title: "[Acme] Approve an SEO change: /pricing stuck on page 2", href: "/seo?sprint=sp-2&tab=optimizations&client=company%3Ac1" });

    expect(snap.activity.map((a) => a.text)).toEqual([
      'Merged the approved PR for "Publish post 1" (Partners in Biz)',
      '[Acme] Completed "Submit sitemap" (Acme)',
      'Measured "Title rewrite on /services": win',
    ]);
    expect(snap.activity[0]!.agentId).toBe("agent-1");
    expect(snap.activity[1]!.agentId).toBeNull();

    const quality = Object.fromEntries(snap.quality.map((q) => [q.key, q]));
    expect(quality.seo_optimization_win_rate_90d).toMatchObject({ value: "1 win, 3 losses of 5", raw: 0.2, tone: "warn" });
    expect(quality.seo_tasks_reopened_30d).toMatchObject({ value: "3", tone: "warn" });
    expect(quality.seo_tasks_blocked).toMatchObject({ value: "2", tone: "warn" });
  });

  it("a service account in the settings clears the warning", async () => {
    const { ctx } = fakeCtx(rows, { config: { google: { serviceAccountJson: { type: "secret_ref", secretId: "sa" } } } });
    const snap = await cockpitSnapshot(ctx, "co-1");
    expect(snap.health.find((h) => h.key === "service-account")).toMatchObject({ status: "ok" });
  });

  it("pure helpers", () => {
    expect(sprintDayLabel([34])).toBe("Day 34/90");
    expect(sprintDayLabel([-3])).toBe("Starts in 3d");
    expect(sprintDayLabel([])).toBeNull();
    expect(healthTone(30)).toBe("bad");
    expect(sprintHref({ sprint_id: "s", client_kind: "contact", client_ref: "ct1" })).toBe("/seo?sprint=s&client=contact%3Act1");
    expect(integrationChecks([])).toEqual([]);
    expect(staleNeedsYou([{ ...SPRINT_ROW, items: [] }], new Date())).toEqual([]);
  });
});

describe("hourly cockpit push", () => {
  it("skips companies with SEO off or settings never saved, and re-emits content", async () => {
    const emit = vi.fn(async (_name: string, _companyId: string, _payload: unknown) => undefined);
    const { ctx } = fakeCtx(() => [], { emit });
    (ctx.config.get as ReturnType<typeof vi.fn>).mockImplementation(async (companyId: string) => (companyId === "co-new" ? {} : { timezone: "Africa/Johannesburg" }));
    (ctx.state.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: { scopeId?: string; stateKey: string }) =>
      key.scopeId === "co-off" && key.stateKey === "modules" ? { companyId: "co-off", modules: { seo: false }, updatedAt: "2026-09-26T00:00:00Z" } : null,
    );
    const result = await publishCockpitSnapshots(createEnv(ctx), ["co-1", "co-new", "co-off"]);
    expect(result).toEqual({ published: 1, skipped: 2, content: 0 });
    expect(emit.mock.calls.map((c) => [c[0], c[1]])).toEqual([["cockpit.snapshot", "co-1"]]);
  });
});

describe("SEO → Social content hand-off (only once live)", () => {
  const sprintDb = { id: "sp-2", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_kind: "company", client_ref: "c1", client_name: "Acme", status: "active", start_date: "2026-08-01", template_id: "outrank-90", template_version: 4, autopilot_mode: "safe", health: {}, scoreboard: {}, today: {}, audit_days_done: [], site_access: "repo", default_branch: "main", change_policy: "merge_seo_scope", verification: {} };
  const content = { id: "ct-1", company_id: "co-1", sprint_id: "sp-2", title: "How much does a website cost?", type: "post", status: "live", target_keyword_id: "kw-1", target_url: "https://acme.co.za/blog/website-cost", published_on: "2026-09-26", social_post_ids: [], links_to_pillar_ids: [], task_id: "t-1" };
  const PAGE = `<html><head><title>Website cost</title><meta name="description" content="What a small business website costs in South Africa in 2026, and what drives the price."></head><body><p>Short.</p></body></html>`;

  function world(extra: { taskRows?: Row[]; pages?: Record<string, number> } = {}) {
    let now = new Date("2026-09-27T08:00:00Z");
    const emit = vi.fn(async (_name: string, _companyId: string, _payload: unknown) => undefined);
    const tasks = new Map((extra.taskRows ?? []).map((t) => [String(t.id), t]));
    const pages = { "https://acme.co.za/blog/website-cost": 200, ...(extra.pages ?? {}) } as Record<string, number>;
    const { ctx } = fakeCtx((sql, params) => {
      if (sql.includes(`FROM ${T("content")} WHERE id = $1`)) return params[0] === "ct-1" ? [content] : [];
      if (sql.includes(`FROM ${T("sprints")} WHERE id = $1`)) return [sprintDb];
      if (sql.includes(`FROM ${T("keywords")} WHERE id = $1`)) return [{ id: "kw-1", company_id: "co-1", sprint_id: "sp-2", phrase: "website cost south africa" }];
      if (sql.includes(`FROM ${T("sprint_tasks")} WHERE id = $1`)) return tasks.has(String(params[0])) ? [tasks.get(String(params[0]))!] : [];
      if (sql.includes("AND task_id = $3")) return params[2] === "t-1" ? [{ id: "ct-1" }] : [];
      return [];
    }, { emit });
    const site = vi.fn(async (url: string) => ({ status: pages[url] ?? 404, url, redirects: [], headers: {}, text: (pages[url] ?? 404) === 200 ? PAGE : "not found", ms: 5 }));
    const announcements = memoryAnnouncements(() => now);
    const env = createEnv(ctx, { now: () => now, site: site as never, announcements });
    return { env, emit, site, tasks, pages, announcements, later: (hours: number) => (now = new Date(now.getTime() + hours * 3600_000)) };
  }

  const task = (extra: Row = {}): Row => ({
    id: "t-2", company_id: "co-1", sprint_id: "sp-2", title: "Publish post 2 — use-case format", task_type: "post-publish", owner: "agent", status: "done", source: "template",
    week: 6, phase: 2, focus: "Content", autopilot_eligible: false, completed_at: "2026-09-26T09:00:00Z",
    evidence: { summary: "Live", links: ["https://github.com/acme/site/pull/3", "https://www.acme.co.za/blog/use-case"] }, ...extra,
  });

  it("a content row marked live goes out once the page answers 200, with the page's own summary", async () => {
    const w = world({ pages: { "https://acme.co.za/blog/website-cost": 404 } });
    expect(await contentWentLive(w.env, "co-1", "ct-1")).toMatchObject({ status: "waiting", reason: expect.stringContaining("answers 404") });
    expect(w.announcements.rows.get("seo:content:ct-1")).toMatchObject({ url: "https://acme.co.za/blog/website-cost", lastHttpStatus: 404 });
    expect(w.emit).not.toHaveBeenCalled();
    // Deployed: the next due check sends it.
    w.pages["https://acme.co.za/blog/website-cost"] = 200;
    w.later(1);
    expect(await processAnnouncements(w.env, "co-1")).toMatchObject({ sent: 1 });
    expect(w.emit).toHaveBeenCalledWith("content.published", "co-1", {
      key: "seo:content:ct-1",
      url: "https://acme.co.za/blog/website-cost",
      title: "How much does a website cost?",
      summary: "What a small business website costs in South Africa in 2026, and what drives the price.",
      keyword: "website cost south africa",
      clientKind: "company",
      clientRef: "c1",
      publishedAt: "2026-09-26T00:00:00.000Z",
    });
  });

  it("a sign-off approved with a PR is not announced until its merge task is done and the page answers 200", async () => {
    const w = world({ taskRows: [task({ evidence: { handoff: { review: true, links: ["https://github.com/acme/site/pull/3", "https://acme-preview.vercel.app/blog/use-case"] } } }), task({ id: "m-1", title: "Merge the approved PR: Publish post 2", task_type: "code-fix", status: "not_started", evidence: null })] });
    expect(await publishTaskDone(w.env, "co-1", "t-2", "m-1")).toMatchObject({ status: "waiting", reason: expect.stringContaining("approved PR to be merged") });
    expect(w.site).not.toHaveBeenCalled();
    expect(w.emit).not.toHaveBeenCalled();
    // The agent merges, the deploy is done, it completes the merge task with the live URL.
    w.tasks.set("m-1", { ...w.tasks.get("m-1")!, status: "done", evidence: { summary: "Merged", links: ["https://github.com/acme/site/pull/3", "https://www.acme.co.za/blog/use-case"] } });
    w.pages["https://www.acme.co.za/blog/use-case"] = 200;
    expect(await releaseAnnouncements(w.env, "co-1", "m-1")).toBe(1);
    expect(w.emit).toHaveBeenLastCalledWith("content.published", "co-1", expect.objectContaining({ key: "seo:content:task-t-2", url: "https://www.acme.co.za/blog/use-case", title: "Publish post 2 — use-case format" }));
  });

  it("a finished publish task uses its live URL (never the PR link); its content row wins when one points at it", async () => {
    const w = world({ taskRows: [task(), task({ id: "t-1", title: "Publish post 1" })], pages: { "https://www.acme.co.za/blog/use-case": 200 } });
    expect(await publishTaskDone(w.env, "co-1", "t-2")).toMatchObject({ status: "sent" });
    expect(w.emit).toHaveBeenLastCalledWith("content.published", "co-1", expect.objectContaining({ key: "seo:content:task-t-2", url: "https://www.acme.co.za/blog/use-case" }));
    expect(await publishTaskDone(w.env, "co-1", "t-1")).toMatchObject({ key: "seo:content:ct-1", status: "sent" });
  });

  it("ignores tasks that are not publish tasks, and waits (never guesses) without a live URL", async () => {
    const w = world({ taskRows: [task({ id: "t-3", task_type: "meta-tag-audit" }), task({ id: "t-4", evidence: { links: ["https://github.com/acme/site/pull/3"] } })] });
    expect(await publishTaskDone(w.env, "co-1", "t-3")).toBeNull();
    expect(await publishTaskDone(w.env, "co-1", "t-4")).toMatchObject({ status: "waiting", reason: expect.stringContaining("No live URL yet") });
    expect(w.emit).not.toHaveBeenCalled();
  });

  it("re-sends what went out in the last 24 hours (events arrive at most once)", async () => {
    const w = world();
    await contentWentLive(w.env, "co-1", "ct-1");
    expect(w.emit).toHaveBeenCalledTimes(1);
    w.later(1);
    expect(await processAnnouncements(w.env, "co-1")).toMatchObject({ sent: 0, resent: 1 });
    w.later(30);
    expect(await processAnnouncements(w.env, "co-1")).toMatchObject({ resent: 0 });
    // Marking it live again never makes a second repurpose task: the key is already sent.
    expect(await contentWentLive(w.env, "co-1", "ct-1")).toMatchObject({ status: "sent" });
  });

  it("three days without a 200 makes it stuck: the Cockpit and today say so, and it is still checked daily", async () => {
    const w = world({ pages: { "https://acme.co.za/blog/website-cost": 500 } });
    await contentWentLive(w.env, "co-1", "ct-1");
    w.later(80);
    expect(await processAnnouncements(w.env, "co-1")).toMatchObject({ stuck: 1 });
    const row = w.announcements.rows.get("seo:content:ct-1")!;
    expect(row).toMatchObject({ status: "stuck", lastHttpStatus: 500 });
    expect(announcementLine(row)).toContain("Social has not been told about https://acme.co.za/blog/website-cost");
    const checks = stuckAnnouncementChecks([{ key: row.key, url: row.url ?? "https://acme.co.za/blog/website-cost", status: "stuck", last_error: row.lastError, queued_at: row.queuedAt, sprint_id: "sp-2", site_name: "Acme", client_kind: "company", client_ref: "c1", client_name: "Acme" }]);
    expect(checks[0]).toMatchObject({ key: "social-handoff", status: "warn" });
    // Fixed later: the daily re-check sends it (once: not re-sent in the same run).
    w.pages["https://acme.co.za/blog/website-cost"] = 200;
    w.later(25);
    const before = w.emit.mock.calls.length;
    expect(await processAnnouncements(w.env, "co-1")).toMatchObject({ sent: 1, resent: 0 });
    expect(w.emit.mock.calls.length - before).toBe(1);
  });

  it("pure helpers", () => {
    expect(PUBLISH_TASK_TYPES.has("pillar-publish")).toBe(true);
    expect(liveUrlFromEvidence({ evidence: { handoff: { links: ["https://blog.acme.co.za/x"] } } }, "https://acme.co.za")).toBe("https://blog.acme.co.za/x");
    expect(liveUrlFromEvidence({ evidence: null }, "https://acme.co.za")).toBeNull();
    expect(contentPayload({ id: "x", title: "X", targetUrl: null, publishedOn: null }, { siteUrl: "https://a.b", clientKind: null, clientRef: null }, null)).toBeNull();
    expect(pageSummary(`<meta property="og:description" content="Open Graph summary of the page for sharing.">`)).toBe("Open Graph summary of the page for sharing.");
    expect(pageSummary(`<main><p>Hi</p><p>${"A long first paragraph about pricing websites in South Africa. ".repeat(3)}</p></main>`)).toMatch(/^A long first paragraph/);
    expect(pageSummary("<p>Too short</p>")).toBeNull();
    expect(stuckAnnouncementChecks([])).toEqual([{ key: "social-handoff", title: "Live pages handed to Social", status: "ok" }]);
  });
});

describe("hire budget", () => {
  it("asks for $40 a month and says the Cockpit alerts at 80%", () => {
    expect(SEO_ROLE.budgetMonthlyCents).toBe(4000);
    const draft = hireTaskDraft(SEO_ROLE).description;
    expect(draft).toContain("$40.00 per month");
    expect(draft).toContain("The Cockpit alerts at 80%");
  });
});

describe("cockpit route and job tracking (SDK harness)", () => {
  it("serves GET /cockpit and records the daily job run", async () => {
    const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg", publicBaseUrl: "https://paperclip.partnersinbiz.online" } });
    harness.seed({ companies: [{ id: "co-1", issuePrefix: "PIB", name: "PiB" } as never] });
    await plugin.definition.setup(harness.ctx);
    const res = await plugin.definition.onApiRequest!({ routeKey: "cockpit", method: "GET", path: "/cockpit", params: {}, query: { companyId: "co-1" }, body: null, headers: {}, companyId: "co-1", actor: { actorType: "user", actorId: "user-1", userId: "user-1" } } as never);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plugin: "partnersinbiz.seo", title: "SEO" });
    await harness.runJob("seo-daily");
    const record = await harness.ctx.state.get({ scopeKind: "instance", namespace: "pib-cockpit-jobs", stateKey: "job:seo-daily" });
    expect(record).toMatchObject({ consecutiveFailures: 0 });
    expect((record as { lastOkAt: string | null }).lastOkAt).toBeTruthy();
    expect(harness.logs.filter((l) => l.level === "error")).toEqual([]);
  });
});
