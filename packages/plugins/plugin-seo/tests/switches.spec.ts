/**
 * AI search (GEO), Google Analytics (GA4) and page groups are extras a person switches on, per sprint. Until then a
 * sprint behaves exactly as it did before 0.23.0: the daily pass adds no task, fetches nothing from the client's site,
 * calls no Analytics API and writes nothing for them. These tests prove that on a sprint with live tasks (the same
 * fixture with the extras ON is the control: the test would fail if the gate were missing), that turning one on touches
 * that sprint only, and that an agent can read the switches but never change one.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";
import * as db from "../src/db.js";
import { dispatch, HANDLERS, UI_ONLY_HANDLERS } from "../src/dispatch.js";
import { completionBlocker } from "../src/engine/guards.js";
import { buildSetupChecklist, type SetupFacts } from "../src/engine/setup.js";
import { FEATURES, offMessage, parseSwitches, switchesOf } from "../src/engine/switches.js";
import type { Actor } from "../src/service/common.js";
import { companyInfo } from "../src/service/common.js";
import { runDailyForSprint } from "../src/service/jobs.js";
import { planChange } from "../src/service/plans.js";
import { createSprint } from "../src/service/sprints.js";
import { splitOnStart } from "../src/service/chunks.js";
import { auditSprint, ensureMonthlyGeoTask, scheduledGeo } from "../src/service/geo.js";
import { connectGa4, ga4Daily, ga4Line, ga4Summary } from "../src/service/analytics.js";
import { weeklyNumbers } from "../src/service/optimize.js";
import { captureSnapshot } from "../src/service/snapshots.js";
import { sprintToday } from "../src/service/sprints.js";
import { seoSetupStatus } from "../src/service/setup-status.js";
import { addGeoTasks, GEO_OFF_NOTE, setSwitchTool, signedInPerson } from "../src/service/switches.js";
import { GEO_TASK_KEYS } from "../src/templates/geo.js";
import { PLANS } from "../src/templates/plans.js";
import { SEO_TOOL_DECLARATIONS, SEO_TOOLS } from "../src/tools.js";
import { reply, site } from "./helpers/geo-site.js";
import { memTables } from "./helpers/mem-db.js";
import { executed, integrationRow, needsYouRoutes, SPRINT, SPRINT_OFF, seoHost, taskRow, type Route, type Row } from "./helpers/seo-host.js";

const user: Actor = { kind: "user", userId: "user-peet" };
const agent: Actor = { kind: "agent", agentId: "agent-1", runId: "run-1", responsibleUserId: "user-peet" };
const SEO_AGENT = { id: "agent-1", status: "idle" };

// A live sprint: on plan version 4 (all five running sprints are), every extra off.
const sprintRow = (id: string, extra: Row = {}): Row => ({ ...SPRINT_OFF, id, name: id, site_name: id, root_issue_id: `root-${id}`, template_version: 4, ...extra });

/**
 * A company's sprints with a small in-memory sprint_tasks table, a site that records every fetch and Google calls that are
 * recorded and answered empty. Updates of the three switch columns are applied, so a test can switch and then run the daily pass.
 */
function world(input: {
  sprints: Row[];
  tasks?: Row[];
  noServiceAccount?: boolean;
  ga4Row?: boolean;
  siteRoutes?: Parameters<typeof site>[0];
  /** The items of this week's Needs you digest (a digest with an issue); none: no digest. */
  needsYou?: unknown[];
  /** A company's default for new sprints, as the company_switches table holds it; a company without an entry has no row. */
  companyDefaults?: Record<string, Row>;
  /** Routes that answer before the standard ones. */
  extraRoutes?: Route[];
}) {
  const sprints = input.sprints.map((r) => ({ ...r }));
  const store = memTables({ sprint_tasks: input.tasks ?? [] });
  const web = site(input.siteRoutes);
  // A real sprint has a ga4 integration row only once Analytics was switched on (the switch inserts it).
  let ga4Row = Boolean(input.ga4Row);
  const routes: Route[] = [
    ...(input.extraRoutes ?? []),
    ...store.routes,
    ...needsYouRoutes(input.needsYou ?? []),
    [/FROM plugin_seo_8099f8879a\.integrations WHERE company_id = \$1 AND sprint_id = \$2 AND provider = \$3/, (p) => (p[2] === "ga4" && !ga4Row ? [] : [integrationRow(String(p[2]), { sprint_id: p[1] })])],
    [/FROM plugin_seo_8099f8879a\.sprints WHERE id = \$1 AND company_id = \$2/, (p) => sprints.filter((s) => s.id === p[0] && s.company_id === p[1])],
    [/FROM plugin_seo_8099f8879a\.company_switches/, (p) => (input.companyDefaults?.[String(p[0])] ? [input.companyDefaults[String(p[0])]!] : [])],
  ];
  const host = seoHost({
    routes,
    site: web.fetcher,
    noServiceAccount: input.noServiceAccount,
    google: (url) => {
      if (url.includes("analyticsadmin.googleapis.com") || url.includes("analyticsdata.googleapis.com")) return new Response(JSON.stringify({}), { status: 200 });
      if (url.includes("searchconsole") || url.includes("webmasters")) return new Response(JSON.stringify({ siteEntry: [] }), { status: 200 });
      return undefined;
    },
  });
  store.attach(host);
  // The switch columns of an UPDATE take effect on the sprint rows.
  const execute = host.ctx.db.execute.bind(host.ctx.db);
  // The issues the plugin reads back are in the state its task rows say, so the daily pass finds nothing to heal.
  host.ctx.issues.get = (async (id: string) => {
    const task = store.tasks.find((t) => t.issue_id === id);
    return { id, status: task ? String(task.issue_status ?? "todo") : "todo", identifier: `PIB-${id.replace(/\D/g, "") || "0"}` };
  }) as never;
  host.ctx.db.execute = async (sql: string, params: unknown[] = []) => {
    if (/^INSERT INTO plugin_seo_8099f8879a\.integrations /.test(sql) && params.includes("ga4")) ga4Row = true;
    // A sprint the plugin creates can be read back.
    if (/^INSERT INTO plugin_seo_8099f8879a\.sprints /.test(sql)) {
      const [id, company_id, name, site_url, site_name, client_kind, client_ref, client_name, status, start_date, template_id, template_version, autopilot_mode, owner_user_id, notes, geo_enabled, ga4_enabled, chunks_enabled] = params;
      sprints.push({ ...SPRINT_OFF, id, company_id, name, site_url, site_name, client_kind, client_ref, client_name, status, start_date, template_id, template_version, autopilot_mode, owner_user_id, notes, geo_enabled, ga4_enabled, chunks_enabled, seeded_at: null, root_issue_id: null, root_issue_identifier: null });
    }
    const m = /^UPDATE plugin_seo_8099f8879a\.sprints SET (.+?) WHERE id = \$(\d+) AND company_id = \$(\d+)/s.exec(sql);
    if (m) {
      const row = sprints.find((s) => s.id === params[Number(m[2]) - 1] && s.company_id === params[Number(m[3]) - 1]);
      if (row) for (const column of ["geo_enabled", "ga4_enabled", "chunks_enabled"]) { const a = new RegExp(`${column} = \\$(\\d+)`).exec(m[1]!); if (a) row[column] = params[Number(a[1]) - 1]; }
    }
    return execute(sql, params);
  };
  const getSprint = async (id: string, companyId = "co-1") => (await db.getSprint(host.env.ctx.db, companyId, id))!;
  return { ...host, sprints, store, siteCalls: web.calls, getSprint };
}
type World = ReturnType<typeof world>;

async function daily(w: World, sprintId: string, companyId = "co-1") {
  const info = await companyInfo(w.env, companyId);
  return runDailyForSprint(w.env, info, await w.getSprint(sprintId, companyId), { agent: SEO_AGENT, projectId: "proj-1" });
}

/** A sprint on day 32 with live work: done, open (with issues) and a later task. Nothing in it is due without an issue. */
const liveTasks = (sprintId: string): Row[] => [
  taskRow({ id: `${sprintId}-done`, sprint_id: sprintId, template_key: "w0-meta-tags", status: "done", due_day: null, issue_id: "issue-1", issue_identifier: "PIB-1", issue_status: "done", assignee_kind: "agent", completed_at: "2026-09-02T00:00:00Z" }),
  taskRow({ id: `${sprintId}-open`, sprint_id: sprintId, template_key: "w1-alt-text", task_type: "alt-text-audit", week: 1, status: "not_started", due_day: 7, issue_id: "issue-2", issue_identifier: "PIB-2", issue_status: "todo", assignee_kind: "agent" }),
  taskRow({ id: `${sprintId}-sitewide`, sprint_id: sprintId, template_key: "w1-canonical-check", task_type: "canonical-check", week: 1, status: "not_started", due_day: 7, issue_id: "issue-3", issue_identifier: "PIB-3", issue_status: "todo", assignee_kind: "agent" }),
  taskRow({ id: `${sprintId}-later`, sprint_id: sprintId, template_key: "w12-cluster-pick", task_type: "page-write", week: 12, status: "not_started", due_day: 80, issue_id: null, issue_status: null }),
];

const EXTRA_TABLES = /plugin_seo_8099f8879a\.(geo_audits|ai_mentions|analytics_weeks|task_chunks|switch_log|company_switches)\b/;

const writes = (w: World) => w.executes.map((e) => e.sql);

describe("the migration", () => {
  const sql = readFileSync(new URL("../migrations/021_seo.sql", import.meta.url), "utf8");

  it("adds the three switches to sprints as NOT NULL DEFAULT false, so every existing sprint starts with all of them off", () => {
    for (const column of ["geo_enabled", "ga4_enabled", "chunks_enabled"]) {
      expect(sql, column).toMatch(new RegExp(`ALTER TABLE plugin_seo_8099f8879a\\.sprints ADD COLUMN ${column} boolean NOT NULL DEFAULT false;`));
    }
    // No statement may turn anything on for rows that exist.
    expect(sql).not.toMatch(/UPDATE\s+plugin_seo_8099f8879a\.sprints/i);
    expect(sql).not.toMatch(/DEFAULT true/i);
    expect(sql).toMatch(/geo_default boolean NOT NULL DEFAULT false/);
    expect(sql).toMatch(/ga4_default boolean NOT NULL DEFAULT false/);
    expect(sql).toMatch(/chunks_default boolean NOT NULL DEFAULT false/);
  });

  it("keeps the audit trail without a foreign key, so it outlives a sprint row", () => {
    expect(sql).toMatch(/CREATE TABLE plugin_seo_8099f8879a\.switch_log/);
    expect(sql.slice(sql.indexOf("CREATE TABLE plugin_seo_8099f8879a.switch_log"))).not.toMatch(/REFERENCES/);
  });
});

describe("the daily pass with everything off", () => {
  it("adds no task, changes no task row and leaves every extras table alone (a sprint with live tasks)", async () => {
    const w = world({ sprints: [sprintRow("sp-1")], tasks: liveTasks("sp-1") });
    const before = JSON.parse(JSON.stringify(w.store.tasks));
    const result = await daily(w, "sp-1");
    expect(result.sprintId).toBe("sp-1");
    // Snapshot of the sprint's task rows before and after: identical, and not one task more.
    expect(w.store.tasks).toHaveLength(before.length);
    expect(w.store.tasks).toEqual(before);
    expect(w.store.chunks).toEqual([]);
    expect(executed(w, /INSERT INTO plugin_seo_8099f8879a\.sprint_tasks/)).toEqual([]);
    expect(writes(w).filter((sql) => EXTRA_TABLES.test(sql))).toEqual([]);
    // The sprint row: the daily record is written, the switches and the plan version are not.
    const sprintWrites = executed(w, /UPDATE plugin_seo_8099f8879a\.sprints SET/);
    expect(sprintWrites.length).toBeGreaterThan(0);
    for (const e of sprintWrites) expect(e.sql).not.toMatch(/geo_enabled|ga4_enabled|chunks_enabled|template_version/);
    // The plan stays on its version: nothing is "upgraded" for a sprint that is current.
    expect(result.planUpgraded).toBe(false);
  });

  it("fetches nothing from the client's site, calls no Analytics API, raises no Needs you line and opens no issue for them", async () => {
    const w = world({ sprints: [sprintRow("sp-1")], tasks: liveTasks("sp-1") });
    const result = await daily(w, "sp-1");
    expect(w.siteCalls).toEqual([]); // no robots.txt, llms.txt, sitemap, home page or bot probe
    expect(w.googleCalls.filter((c) => /analyticsadmin|analyticsdata/.test(c.url))).toEqual([]);
    expect(w.googleCalls.filter((c) => c.scope && /analytics/.test(c.scope))).toEqual([]); // not even a token for the Analytics scope
    expect(result.geoAudited).toBe(false);
    expect(result.warnings.filter((x) => /GA4|AI search/.test(x))).toEqual([]);
    const items = executed(w, /INSERT INTO plugin_seo_8099f8879a\.needs_you /).flatMap((e) => JSON.parse(String(e.params[4])) as Array<{ key: string }>);
    expect(items.filter((i) => /^(ga4_|geo_|chunk:)/.test(i.key))).toEqual([]);
    expect(w.created).toEqual([]); // no issue of any kind
    expect(w.wakeups).toEqual([]);
    // Nothing GEO or GA4 shows up in the stored plan for the day either.
    const today = executed(w, /UPDATE plugin_seo_8099f8879a\.sprints SET/).map((e) => JSON.stringify(e.params)).join(" ");
    expect(today).not.toMatch(/AI-search|Google Analytics|connect-ga4|geo-audit/);
  });

  it.each(["outrank-90", "outrank-90-professional", "outrank-90-ecommerce"])("a running sprint on plan version 4 (%s, as all five live sprints are) is not upgraded: no task, no template_version write, no comment, no Analytics row", async (templateId) => {
    const w = world({ sprints: [sprintRow("sp-1", { template_id: templateId, template_version: 4 })], tasks: liveTasks("sp-1") });
    const before = JSON.parse(JSON.stringify(w.store.tasks));
    const result = await daily(w, "sp-1");
    expect(result.planUpgraded).toBe(false);
    expect(w.store.tasks).toEqual(before);
    for (const e of executed(w, /UPDATE plugin_seo_8099f8879a\.sprints SET/)) expect(e.sql).not.toMatch(/template_version/);
    expect(w.comments.filter((c) => /Plan upgraded|AI search|GEO|Analytics/i.test(c.body))).toEqual([]);
    expect(executed(w, /INSERT INTO plugin_seo_8099f8879a\.integrations/).filter((e) => e.params.includes("ga4"))).toEqual([]);
  });

  it("opens a newly due site-wide task as ONE issue and wakes the agent on it, on a big site, exactly as 0.22.0 did (no sitemap read, no page groups)", async () => {
    const urls = Array.from({ length: 57 }, (_, i) => `<url><loc>https://acme.co.za/page-${i + 1}</loc></url>`).join("");
    const siteRoutes = { "https://acme.co.za/sitemap.xml": () => reply(200, `<urlset><url><loc>https://acme.co.za/</loc></url>${urls}</urlset>`) };
    const due = taskRow({ id: "sp-1-due", sprint_id: "sp-1", template_key: "w0-meta-tags", task_type: "meta-tag-audit", status: "not_started", due_day: null, issue_id: null, issue_status: null, assignee_kind: null });
    const off = world({ sprints: [sprintRow("sp-1")], tasks: [...liveTasks("sp-1"), due], siteRoutes });
    await daily(off, "sp-1");
    expect(off.created).toHaveLength(1); // the task's own issue and nothing else
    expect(String(off.created[0]!.input.description)).not.toMatch(/split into|page groups/i);
    expect(off.wakeups).toEqual([off.created[0]!.id]);
    expect(off.store.chunks).toEqual([]);
    expect(off.siteCalls).toEqual([]);
    // Control: the same sprint with page groups on splits that task, which is what 0.23.0 did to every sprint.
    const on = world({ sprints: [sprintRow("sp-1", { chunks_enabled: true })], tasks: [...liveTasks("sp-1"), due], siteRoutes });
    await daily(on, "sp-1");
    expect(on.store.chunks.length).toBeGreaterThan(1);
    expect(on.created.length).toBeGreaterThan(1);
  });

  it("is a real test: the same sprint with the extras ON does audit, call Analytics and add its work", async () => {
    const w = world({ sprints: [sprintRow("sp-1", { geo_enabled: true, ga4_enabled: true, chunks_enabled: true })], tasks: liveTasks("sp-1") });
    await daily(w, "sp-1");
    expect(w.siteCalls.length).toBeGreaterThan(0);
    expect(w.googleCalls.some((c) => /analyticsadmin/.test(c.url))).toBe(true);
    expect(executed(w, /INSERT INTO plugin_seo_8099f8879a\.geo_audits/).length).toBeGreaterThan(0);
    // The daily run also puts back the AI-search tasks a switch could not add (here: none had been added).
    expect(w.store.tasks.filter((t) => GEO_TASK_KEYS.includes(String(t.template_key)))).toHaveLength(8);
  });

  it("takes a day-30 snapshot without the AI-search and Analytics parts, and never fetches the site for it", async () => {
    const w = world({ sprints: [sprintRow("sp-1")], tasks: liveTasks("sp-1") });
    const result = await daily(w, "sp-1");
    expect(result.snapshotDay).toBe(30);
    const snapshot = executed(w, /INSERT INTO plugin_seo_8099f8879a\.audit_snapshots/)[0]!;
    // geo and analytics are the last two parameters: empty objects.
    expect(snapshot.params.slice(-2)).toEqual(["{}", "{}"]);
    expect(w.siteCalls).toEqual([]);
  });
});

describe("turning AI search on for one sprint", () => {
  it("adds its tasks to that sprint only; another sprint, another company and the company default are untouched", async () => {
    const w = world({
      sprints: [sprintRow("sp-1"), sprintRow("sp-2"), sprintRow("sp-3", { company_id: "co-2" })],
      tasks: [...liveTasks("sp-1"), ...liveTasks("sp-2"), ...liveTasks("sp-3").map((t) => ({ ...t, company_id: "co-2" }))],
    });
    const before2 = JSON.parse(JSON.stringify(w.store.tasks.filter((t) => t.sprint_id === "sp-2")));
    const before3 = JSON.parse(JSON.stringify(w.store.tasks.filter((t) => t.sprint_id === "sp-3")));
    const answer = (await setSwitchTool(w.env, "co-1", user, { sprintId: "sp-1", feature: "geo", enabled: true })) as unknown as { changed: boolean; effect: { tasksAdded: number } };
    expect(answer).toMatchObject({ changed: true, scope: "sprint", feature: "geo", enabled: true });
    // sp-1 got exactly the eight GEO tasks, none of them started.
    const added = w.store.tasks.filter((t) => t.sprint_id === "sp-1" && GEO_TASK_KEYS.includes(String(t.template_key)));
    expect(added.map((t) => t.template_key).sort()).toEqual([...GEO_TASK_KEYS].sort());
    expect(added.every((t) => t.status === "not_started" && t.issue_id == null && t.company_id === "co-1")).toBe(true);
    expect(w.store.tasks.filter((t) => t.sprint_id === "sp-1")).toHaveLength(4 + 8);
    // The sprint next to it and the one in the other company: not one row changed.
    expect(w.store.tasks.filter((t) => t.sprint_id === "sp-2")).toEqual(before2);
    expect(w.store.tasks.filter((t) => t.sprint_id === "sp-3")).toEqual(before3);
    // Every write names sp-1 and co-1 only.
    const text = JSON.stringify(w.executes.map((e) => e.params));
    expect(text).not.toContain("sp-2");
    expect(text).not.toContain("sp-3");
    expect(text).not.toContain("co-2");
    // Only the sprint's own switch moved; the company default was not written and no other switch was.
    const sprintUpdate = executed(w, /UPDATE plugin_seo_8099f8879a\.sprints SET/);
    expect(sprintUpdate).toHaveLength(1);
    expect(sprintUpdate[0]!.sql).toMatch(/SET geo_enabled = \$1::boolean/);
    expect(sprintUpdate[0]!.sql).not.toMatch(/ga4_enabled|chunks_enabled/);
    expect(executed(w, /company_switches/)).toEqual([]);
    expect(switchesOf(await w.getSprint("sp-1"))).toEqual({ geo: true, ga4: false, chunks: false });
    expect(switchesOf(await w.getSprint("sp-2"))).toEqual({ geo: false, ga4: false, chunks: false });
  });

  it("makes the next daily pass of that sprint audit it, while the sprint beside it still does nothing new", async () => {
    const w = world({ sprints: [sprintRow("sp-1"), sprintRow("sp-2")], tasks: [...liveTasks("sp-1"), ...liveTasks("sp-2")] });
    await setSwitchTool(w.env, "co-1", user, { sprintId: "sp-1", feature: "geo", enabled: true });
    const callsBefore = w.siteCalls.length;
    const one = await daily(w, "sp-1");
    expect(one.geoAudited).toBe(true);
    expect(w.siteCalls.length).toBeGreaterThan(callsBefore);
    const callsAfterOne = w.siteCalls.length;
    const two = await daily(w, "sp-2");
    expect(two.geoAudited).toBe(false);
    expect(w.siteCalls.length).toBe(callsAfterOne); // sp-2 fetched nothing
    expect(executed(w, /INSERT INTO plugin_seo_8099f8879a\.geo_audits/).every((e) => e.params.includes("sp-1") && !e.params.includes("sp-2"))).toBe(true);
    // The Analytics and page-group switches of sp-1 are still off: no Analytics call.
    expect(w.googleCalls.filter((c) => /analyticsadmin|analyticsdata/.test(c.url))).toEqual([]);
  });

  it("records who did it and what it did in the audit trail, and says in plain words what was added", async () => {
    const w = world({ sprints: [sprintRow("sp-1")], tasks: liveTasks("sp-1") });
    const answer = (await setSwitchTool(w.env, "co-1", user, { sprintId: "sp-1", feature: "geo", enabled: true })) as { note: string };
    expect(answer.note).toMatch(/AI search is on: 8 tasks added to this sprint/);
    const [log] = executed(w, /INSERT INTO plugin_seo_8099f8879a\.switch_log/);
    expect(log!.params.slice(1, 7)).toEqual(["co-1", "sp-1", "geo", "sprint", true, "user-peet"]);
    expect(JSON.parse(String(log!.params[7]))).toEqual({ tasksAdded: 8, tasksRevived: 0 });
    // The sprint's root issue says so too (one short line).
    expect(w.comments.find((c) => c.id === "root-sp-1")!.body).toContain("AI search (GEO) was switched on for this sprint by user user-peet");
  });

  it("does nothing, and logs nothing, when it is already in the state asked for", async () => {
    const w = world({ sprints: [sprintRow("sp-1", { geo_enabled: true })], tasks: liveTasks("sp-1") });
    expect(await setSwitchTool(w.env, "co-1", user, { sprintId: "sp-1", feature: "geo", enabled: true })).toMatchObject({ changed: false });
    expect(w.executes).toEqual([]);
  });

  it("another company's sprint is not found, so it cannot be switched from here", async () => {
    const w = world({ sprints: [sprintRow("sp-3", { company_id: "co-2" })] });
    await expect(setSwitchTool(w.env, "co-1", user, { sprintId: "sp-3", feature: "geo", enabled: true })).rejects.toThrow(/was not found in this company/);
    expect(w.executes).toEqual([]);
  });
});

describe("turning AI search off again", () => {
  it("marks the unfinished GEO tasks not needed and cancels their open issues, and leaves finished work and other sprints alone", async () => {
    const geoTasks = GEO_TASK_KEYS.map((key, i) => taskRow({ id: `g-${i}`, sprint_id: "sp-1", template_key: key, task_type: key.startsWith("w2") ? "geo-mention-check" : "geo-crawler-access", status: i === 0 ? "in_progress" : i === 1 ? "done" : "not_started", issue_id: i === 0 ? "issue-9" : null, issue_status: i === 0 ? "todo" : null }));
    const w = world({ sprints: [sprintRow("sp-1", { geo_enabled: true })], tasks: [...liveTasks("sp-1"), ...geoTasks] });
    const answer = (await setSwitchTool(w.env, "co-1", user, { sprintId: "sp-1", feature: "geo", enabled: false })) as unknown as { effect: { tasksClosed: number; issuesCancelled: number }; note: string };
    expect(answer.effect).toMatchObject({ tasksClosed: 7, issuesCancelled: 1 });
    // A pull request a cancelled task already opened is the person's to close: the answer and the confirmation both say so.
    expect(answer.note).toMatch(/A pull request one of those tasks already opened is not closed for you/);
    expect(FEATURES.geo.off).toMatch(/pull request .* is not closed for you/);
    const byKey = (key: string) => w.store.tasks.find((t) => t.template_key === key)!;
    expect(byKey(GEO_TASK_KEYS[0]!)).toMatchObject({ status: "na", blocker_reason: GEO_OFF_NOTE, issue_status: "cancelled" });
    expect(byKey(GEO_TASK_KEYS[1]!).status).toBe("done"); // finished work is kept
    expect(byKey(GEO_TASK_KEYS[2]!)).toMatchObject({ status: "na", blocker_reason: GEO_OFF_NOTE });
    expect(w.updates).toEqual([{ id: "issue-9", patch: { status: "cancelled" } }]);
    expect(w.store.tasks.filter((t) => !GEO_TASK_KEYS.includes(String(t.template_key)))).toEqual(liveTasks("sp-1")); // the plan's own tasks are untouched
    expect(switchesOf(await w.getSprint("sp-1")).geo).toBe(false);
  });

  it("brings exactly those tasks back when it is switched on again, and adds only what is missing", async () => {
    const retired = GEO_TASK_KEYS.slice(0, 2).map((key, i) => taskRow({ id: `g-${i}`, sprint_id: "sp-1", template_key: key, status: "na", blocker_reason: GEO_OFF_NOTE, issue_id: "issue-9", issue_status: "cancelled" }));
    const skippedByHand = taskRow({ id: "g-hand", sprint_id: "sp-1", template_key: GEO_TASK_KEYS[2]!, status: "skipped", blocker_reason: "not relevant" });
    const w = world({ sprints: [sprintRow("sp-1")], tasks: [...retired, skippedByHand] });
    const result = await addGeoTasks(w.env, await w.getSprint("sp-1"));
    expect(result).toMatchObject({ revived: 2 });
    expect(w.store.tasks.find((t) => t.id === "g-0")).toMatchObject({ status: "not_started", blocker_reason: null, issue_id: null, issue_status: null });
    expect(w.store.tasks.find((t) => t.id === "g-hand")).toMatchObject({ status: "skipped" }); // a person's own skip stays skipped
    expect(w.store.tasks.filter((t) => GEO_TASK_KEYS.includes(String(t.template_key)))).toHaveLength(8);
  });

  it("a plan change never retires them (they belong to no plan)", () => {
    const tasks = GEO_TASK_KEYS.map((key, i) => db_task(key, i));
    const change = planChange({ sprint: { id: "sp-1", companyId: "co-1" }, plan: PLANS.local, tasks, backlinks: [] });
    expect(change.drop).toEqual([]);
    expect(change.keep).toEqual([]);
    expect(change.add.some((t) => GEO_TASK_KEYS.includes(String(t.templateKey)))).toBe(false);
  });

  it("a GEO task left open after it was switched off can be completed or skipped: the audit it asks for cannot be made", () => {
    const facts = { activeKeywords: 9, keywordsWithoutIntent: 0, priorityKeywords: 3, directoriesNotStarted: 0, latestSnapshotDay: 90, geoAuditAgeDays: null, aiSamplesRecent: 0 };
    expect(completionBlocker("geo-crawler-access", facts)).toMatch(/No geo-audit/); // on: the rule stands
    expect(completionBlocker("geo-crawler-access", { ...facts, geoOff: true })).toBeNull();
    expect(completionBlocker("geo-mention-check", { ...facts, geoOff: true })).toBeNull();
    expect(completionBlocker("directory-submit", { ...facts, geoOff: true, directoriesNotStarted: 2 })).toBeNull();
  });
});

function db_task(key: string, i: number): db.SprintTask {
  return {
    id: `t-${i}`, companyId: "co-1", sprintId: "sp-1", templateKey: key, week: 0, phase: 0, dueDay: null, focus: "AI search", title: key, description: null, taskType: "geo-crawler-access", owner: "agent",
    autopilotEligible: true, playbookKey: key, status: "not_started", source: "template", parentOptimizationId: null, context: null, issueId: null, issueIdentifier: null, issueStatus: null,
    assigneeKind: null, blockerReason: null, humanAsk: null, evidence: null, startedAt: null, completedAt: null, completedBy: null, createdAt: null, updatedAt: null,
  } as unknown as db.SprintTask;
}

describe("only a person can flip a switch", () => {
  it("is refused for an agent, in the service and through the dispatcher, and nothing is written", async () => {
    const w = world({ sprints: [sprintRow("sp-1")], tasks: liveTasks("sp-1") });
    await expect(setSwitchTool(w.env, "co-1", agent, { sprintId: "sp-1", feature: "geo", enabled: true })).rejects.toThrow(/Only a signed-in person/);
    await expect(dispatch(w.env, "co-1", agent, "set-switch", { sprintId: "sp-1", feature: "ga4", enabled: true })).rejects.toThrow(/Only a signed-in person/);
    await expect(setSwitchTool(w.env, "co-1", agent, { scope: "company", feature: "chunks", enabled: true })).rejects.toThrow(/Only a signed-in person/);
    await expect(setSwitchTool(w.env, "co-1", { kind: "system" }, { sprintId: "sp-1", feature: "geo", enabled: true })).rejects.toThrow(/Only a signed-in person/);
    await expect(setSwitchTool(w.env, "co-1", { kind: "user", userId: null }, { sprintId: "sp-1", feature: "geo", enabled: true })).rejects.toThrow(/Only a signed-in person/);
    await expect(setSwitchTool(w.env, "co-1", { kind: "user", userId: "  " }, { sprintId: "sp-1", feature: "geo", enabled: true })).rejects.toThrow(/Only a signed-in person/);
    // An agent actor that happens to carry a user id is still an agent: the kind decides, not the id.
    await expect(setSwitchTool(w.env, "co-1", { ...agent, userId: "user-peet" } as Actor, { sprintId: "sp-1", feature: "geo", enabled: true })).rejects.toThrow(/Only a signed-in person/);
    expect(() => signedInPerson({ ...agent, userId: "user-peet" } as Actor)).toThrow(/Only a signed-in person/);
    expect(signedInPerson(user)).toBe("user-peet");
    expect(w.executes).toEqual([]);
    expect(switchesOf(await w.getSprint("sp-1"))).toEqual({ geo: false, ga4: false, chunks: false });
  });

  it("is not an agent tool at all: no declared tool or tool handler changes a switch; the only one is a page action", () => {
    expect(SEO_TOOLS.map((t) => t.name)).not.toContain("set-switch");
    expect(SEO_TOOL_DECLARATIONS.map((t) => t.name)).toContain("get-switches");
    expect(Object.keys(HANDLERS)).not.toContain("set-switch");
    expect(Object.keys(UI_ONLY_HANDLERS)).toContain("set-switch");
    // The tools of the extras say so up front.
    for (const name of ["geo-audit", "record-ai-mentions", "connect-ga4", "split-task"]) {
      expect(SEO_TOOL_DECLARATIONS.find((t) => t.name === name)!.description, name).toMatch(/switched .* on for/);
    }
  });

  it("takes who made the change from the host's actor, never from the request", async () => {
    const w = world({ sprints: [sprintRow("sp-1")], tasks: liveTasks("sp-1") });
    await setSwitchTool(w.env, "co-1", user, { sprintId: "sp-1", feature: "chunks", enabled: true, by: "someone-else", userId: "someone-else", changedBy: "someone-else", actor: { kind: "user", userId: "someone-else" } });
    const [log] = executed(w, /INSERT INTO plugin_seo_8099f8879a\.switch_log/);
    expect(log!.params[6]).toBe("user-peet");
    expect(JSON.stringify(w.executes.map((e) => e.params))).not.toContain("someone-else");
  });

  it("takes only a real true or false, so a string can never turn an extra on", async () => {
    const w = world({ sprints: [sprintRow("sp-1")] });
    for (const enabled of ["true", "yes", 1, "on", null, undefined]) {
      await expect(setSwitchTool(w.env, "co-1", user, { sprintId: "sp-1", feature: "geo", enabled })).rejects.toThrow(/enabled must be true or false/);
    }
    await expect(setSwitchTool(w.env, "co-1", user, { sprintId: "sp-1", feature: "everything", enabled: true })).rejects.toThrow(/feature must be one of/);
    expect(w.executes).toEqual([]);
    expect(parseSwitches({ geo: "true" }).errors).toHaveLength(1);
    expect(parseSwitches({ nope: true }).errors[0]).toMatch(/Unknown extra/);
  });

  it("an agent cannot choose the extras when it creates a sprint, and the sprint starts with them off", async () => {
    const w = world({ sprints: [], tasks: [] });
    await expect(createSprint(w.env, "co-1", agent, { siteUrl: "https://acme.co.za", switches: { geo: true } })).rejects.toThrow(/Only a person can choose the extras/);
    expect(executed(w, /INSERT INTO plugin_seo_8099f8879a\.sprints/)).toEqual([]);
  });

  it("creating a sprint with every extra left off needs no signed-in person; turning one on does", async () => {
    const w = world({ sprints: [], tasks: [] });
    const result = (await createSprint(w.env, "co-1", { kind: "user", userId: null }, { siteUrl: "https://acme.co.za", switches: { geo: false, ga4: false, chunks: false } })) as { switches: Record<string, boolean> };
    expect(result.switches).toEqual({ geo: false, ga4: false, chunks: false });
    await expect(createSprint(w.env, "co-1", { kind: "user", userId: null }, { siteUrl: "https://acme.co.za", switches: { geo: true } })).rejects.toThrow(/Only a signed-in person/);
  });

  it("reads the state for an agent without writing anything", async () => {
    const w = world({ sprints: [sprintRow("sp-1", { geo_enabled: true }), sprintRow("sp-2")] });
    const one = (await dispatch(w.env, "co-1", agent, "get-switches", { sprintId: "sp-1" })) as { switches: Record<string, boolean>; newSprintsStartWith: Record<string, boolean>; note: string };
    expect(one.switches).toEqual({ geo: true, ga4: false, chunks: false });
    expect(one.newSprintsStartWith).toEqual({ geo: false, ga4: false, chunks: false });
    expect(one.note).toMatch(/You can read this but never change it/);
    expect(w.executes).toEqual([]);
  });
});

describe("the tools of an extra that is off", () => {
  it("geo-audit, record-ai-mentions and connect-ga4 refuse an agent, read nothing and change nothing", async () => {
    const w = world({ sprints: [sprintRow("sp-1")], tasks: liveTasks("sp-1") });
    await expect(dispatch(w.env, "co-1", agent, "geo-audit", { sprintId: "sp-1" })).rejects.toThrow(offMessage("geo"));
    await expect(dispatch(w.env, "co-1", agent, "geo-audit", { sprintId: "sp-1", dryRun: true })).rejects.toThrow(/AI search \(GEO\) is off for this sprint/);
    await expect(dispatch(w.env, "co-1", agent, "record-ai-mentions", { sprintId: "sp-1", samples: [{ query: "q", engine: "chatgpt", mentioned: false }] })).rejects.toThrow(/AI search \(GEO\) is off/);
    await expect(dispatch(w.env, "co-1", agent, "connect-ga4", { sprintId: "sp-1" })).rejects.toThrow(/Google Analytics \(GA4\) is off for this sprint/);
    await expect(dispatch(w.env, "co-1", agent, "split-task", { taskId: "sp-1-open", dryRun: true })).rejects.toThrow(/Page groups is off/);
    expect(w.siteCalls).toEqual([]);
    expect(w.googleCalls).toEqual([]);
    expect(w.executes).toEqual([]);
  });

  it("the read tools say they are off instead of answering with data", async () => {
    const w = world({ sprints: [sprintRow("sp-1")] });
    expect(await dispatch(w.env, "co-1", agent, "list-ai-mentions", { sprintId: "sp-1" })).toMatchObject({ enabled: false, next: offMessage("geo") });
    expect(await dispatch(w.env, "co-1", agent, "list-ga4-summary", { sprintId: "sp-1" })).toMatchObject({ enabled: false, connected: false, weeks: [] });
    expect(w.executes).toEqual([]);
  });

  it("an audit of any other site by address only (no sprint) still reads that site and records nothing", async () => {
    const w = world({ sprints: [sprintRow("sp-1")] });
    const result = (await dispatch(w.env, "co-1", agent, "geo-audit", { url: "https://acme.co.za" })) as { stored: { dryRun: boolean } };
    expect(result.stored).toEqual({ dryRun: true });
    expect(executed(w, /INSERT|UPDATE/)).toEqual([]);
  });

  it("a site-wide task started by its agent is worked whole: nothing is split and the sitemap is not read", async () => {
    const w = world({ sprints: [sprintRow("sp-1")], tasks: liveTasks("sp-1") });
    const task = await db.getTask(w.env.ctx.db, "co-1", "sp-1-sitewide");
    expect(await splitOnStart(w.env, task!)).toBeNull();
    expect(w.siteCalls).toEqual([]);
    expect(w.store.chunks).toEqual([]);
    // Control: with page groups on, the same call reads the site (the sitemap).
    const on = world({ sprints: [sprintRow("sp-1", { chunks_enabled: true })], tasks: liveTasks("sp-1") });
    await splitOnStart(on.env, (await db.getTask(on.env.ctx.db, "co-1", "sp-1-sitewide"))!);
    expect(on.siteCalls.length).toBeGreaterThan(0);
  });
});

describe("every place that reaches out for an extra checks the switch itself", () => {
  it("auditSprint refuses a sprint with AI search off before it fetches anything", async () => {
    const w = world({ sprints: [sprintRow("sp-1")] });
    const info = await companyInfo(w.env, "co-1");
    await expect(auditSprint(w.env, info, await w.getSprint("sp-1"), { source: "tool" })).rejects.toThrow(/AI search \(GEO\) is off/);
    expect(w.siteCalls).toEqual([]);
    expect(w.executes).toEqual([]);
  });

  it("the scheduled audit and the monthly re-check do nothing for a sprint with AI search off, and do their work with it on", async () => {
    const compounding = { start_date: "2026-05-01", seeded_at: "2026-05-01T00:00:00Z" };
    const off = world({ sprints: [sprintRow("sp-1", compounding)] });
    const info = await companyInfo(off.env, "co-1");
    expect(await scheduledGeo(off.env, info, await off.getSprint("sp-1"), 120)).toEqual({ audited: false, change: null });
    expect(await ensureMonthlyGeoTask(off.env, info, await off.getSprint("sp-1"))).toBeNull();
    expect(off.siteCalls).toEqual([]);
    expect(off.executes).toEqual([]);
    const on = world({ sprints: [sprintRow("sp-1", { ...compounding, geo_enabled: true })] });
    expect(await ensureMonthlyGeoTask(on.env, info, await on.getSprint("sp-1"))).toEqual(expect.any(String));
    expect(executed(on, /INSERT INTO plugin_seo_8099f8879a\.sprint_tasks/)).toHaveLength(1);
  });

  it("connectGa4 and the daily look-up make no Google call for a sprint with Analytics off", async () => {
    const w = world({ sprints: [sprintRow("sp-1")], ga4Row: true });
    const info = await companyInfo(w.env, "co-1");
    const sprint = await w.getSprint("sp-1");
    await expect(connectGa4(w.env, info, sprint)).rejects.toThrow(/Google Analytics \(GA4\) is off/);
    expect(await ga4Daily(w.env, info, sprint)).toBeNull();
    expect(await ga4Summary(w.env, sprint)).toBeNull();
    expect(await ga4Line(w.env, sprint)).toBeNull();
    expect(w.googleCalls).toEqual([]);
    expect(w.executes).toEqual([]);
  });

  it("the weekly review's numbers leave out an extra that is off, even when numbers were stored while it was on", async () => {
    const audit = { id: "g-1", sprint_id: "sp-1", audited_on: "2026-10-01", audited_at: "2026-10-01T06:00:00Z", score: 71, band: "good", complete: true, breakdown: {}, sections: {}, finding_count: 0, source: "scheduled" };
    const withData = (extra: Row) => world({ sprints: [sprintRow("sp-1", extra)] });
    const off = withData({});
    off.routes.push([/FROM plugin_seo_8099f8879a\.geo_audits/, () => [audit]]);
    expect(await weeklyNumbers(off.env, await off.getSprint("sp-1"))).toEqual([]);
    const on = withData({ geo_enabled: true });
    on.routes.push([/FROM plugin_seo_8099f8879a\.geo_audits/, () => [audit]]);
    expect((await weeklyNumbers(on.env, await on.getSprint("sp-1"))).join(" ")).toMatch(/AI-search readiness 71\/100/);
  });
});

describe("numbers stored while an extra was on are not shown while it is off", () => {
  const audit = { id: "g-1", sprint_id: "sp-1", audited_on: "2026-10-01", audited_at: "2026-10-01T06:00:00Z", score: 71, band: "good", complete: true, breakdown: {}, sections: {}, finding_count: 0, source: "scheduled" };
  const week = { week_start: "2026-09-21", property_id: "222222222", sessions: 500, engaged_sessions: 380, users: 410, key_events: 40, organic_sessions: 200, organic_engaged_sessions: 150, organic_users: 170, organic_key_events: 12, channels: [], landing_pages: [], sources: [], key_event_names: [], ai_referrals: [] };
  const stored = (extra: Row) => {
    const w = world({ sprints: [sprintRow("sp-1", extra)] });
    w.routes.push([/FROM plugin_seo_8099f8879a\.geo_audits/, () => [audit]], [/FROM plugin_seo_8099f8879a\.analytics_weeks/, () => [week]]);
    return w;
  };

  it("the Analytics summary and the weekly line are empty with Analytics off, and there with it on", async () => {
    const off = stored({});
    expect(await ga4Summary(off.env, await off.getSprint("sp-1"))).toBeNull();
    expect(await ga4Line(off.env, await off.getSprint("sp-1"))).toBeNull();
    const on = stored({ ga4_enabled: true });
    expect(await ga4Summary(on.env, await on.getSprint("sp-1"))).not.toBeNull();
    expect(await ga4Line(on.env, await on.getSprint("sp-1"))).toMatch(/Organic traffic \(GA4\)/);
  });

  it("a snapshot carries neither part for an extra that is off, and both for one that is on (no site fetch for the audit it reuses)", async () => {
    const off = stored({});
    const info = await companyInfo(off.env, "co-1");
    await captureSnapshot(off.env, info, await off.getSprint("sp-1"), { day: 30, kind: "manual" });
    expect(executed(off, /INSERT INTO plugin_seo_8099f8879a\.audit_snapshots/)[0]!.params.slice(-2)).toEqual(["{}", "{}"]);
    const on = stored({ geo_enabled: true, ga4_enabled: true });
    await captureSnapshot(on.env, info, await on.getSprint("sp-1"), { day: 30, kind: "manual" });
    const [geo, analytics] = executed(on, /INSERT INTO plugin_seo_8099f8879a\.audit_snapshots/)[0]!.params.slice(-2).map((x) => JSON.parse(String(x)) as Record<string, unknown>);
    expect(geo).toMatchObject({ score: 71 });
    expect(analytics).toMatchObject({ organicSessions: 200 });
  });

  it("today and get-sprint hide a stale Analytics connection and its numbers while Analytics is off", async () => {
    const connected = integrationRow("ga4", { status: "connected", property_url: "properties/222222222", settings: { propertyId: "222222222", pulledOn: "2026-10-03" }, last_pull_at: "2026-10-03T06:00:00Z" });
    const withStaleConnection = (extra: Row) => {
      const w = stored(extra);
      w.routes.unshift([/FROM plugin_seo_8099f8879a\.integrations WHERE company_id = \$1 AND sprint_id = \$2 ORDER BY provider/, () => [integrationRow("gsc", { status: "connected", property_url: "sc-domain:acme.co.za" }), connected]]);
      w.routes.unshift([/FROM plugin_seo_8099f8879a\.integrations WHERE company_id = \$1 AND sprint_id = \$2 AND provider = \$3/, (p) => [p[2] === "ga4" ? connected : integrationRow(String(p[2]))]]);
      return w;
    };
    const off = withStaleConnection({});
    const info = await companyInfo(off.env, "co-1");
    const offToday = await sprintToday(off.env, info, await off.getSprint("sp-1"));
    expect(offToday.integrations.map((i) => i.provider)).toEqual(["gsc"]);
    expect(offToday.next.join(" ")).not.toMatch(/Organic traffic|Google Analytics/);
    const offSprint = (await dispatch(off.env, "co-1", agent, "get-sprint", { sprintId: "sp-1" })) as { integrations: Array<{ provider: string }>; geo?: unknown; snapshots: Array<Record<string, unknown>> };
    expect(offSprint.integrations.map((i) => i.provider)).toEqual(["gsc"]);
    expect(offSprint).not.toHaveProperty("geo");
    const on = withStaleConnection({ ga4_enabled: true });
    const onToday = await sprintToday(on.env, info, await on.getSprint("sp-1"));
    expect(onToday.integrations.map((i) => i.provider)).toEqual(["gsc", "ga4"]);
    expect(onToday.next.join(" ")).toMatch(/Organic traffic \(GA4\)/);
  });

  it("today leaves the AI-search and Analytics lines out of the next steps for a sprint with them off", async () => {
    const off = stored({});
    const info = await companyInfo(off.env, "co-1");
    const offToday = await sprintToday(off.env, info, await off.getSprint("sp-1"));
    expect(offToday.switches).toEqual({ geo: false, ga4: false, chunks: false });
    expect(offToday.next.join(" ")).not.toMatch(/AI-search|Google Analytics|Organic traffic/);
    const on = stored({ geo_enabled: true });
    const onToday = await sprintToday(on.env, info, await on.getSprint("sp-1"));
    expect(onToday.next.join(" ")).toMatch(/AI-search readiness 71\/100/);
  });
});

describe("Google Analytics stays disabled until it is configured", () => {
  const facts = (ga4: NonNullable<SetupFacts["sprint"]>["ga4"], email: string | null = "paperclip-seo@example.iam.gserviceaccount.com"): SetupFacts => ({
    prefix: "PIB",
    settingsPath: null,
    settingsSaved: true,
    serviceAccount: { configured: Boolean(email), email, error: null },
    agent: { id: "a1", status: "idle" },
    pagespeedKey: true,
    bingKey: true,
    sprint: { siteName: "Acme", siteUrl: "https://acme.co.za", isClient: true, siteAccess: "repo", siteProjectId: "p1", repoUrl: "https://github.com/pib/acme", changePolicy: "merge_seo_scope", autopilotMode: "safe", property: "sc-domain:acme.co.za", gscVia: "service_account", bingVerified: true, ga4 },
  });
  const item = (f: SetupFacts) => buildSetupChecklist(f).find((i) => i.key === "ga4_property")!;

  it("says it is off, optional and not set up, with the exact Google steps, while the switch is off", () => {
    const off = item(facts({ enabled: false, propertyId: null, connected: false, lastError: null, lastPullOn: null }));
    expect(off.status).toBe("warn"); // reaches Setup as optional, never as a required step
    expect(off.detail).toMatch(/^Off for this sprint: nothing is read from Google Analytics until a person turns it on/);
    expect(off.detail).toMatch(/not set up yet either/);
    expect(off.detail).toContain("paperclip-seo@example.iam.gserviceaccount.com");
    expect(off.steps.join(" ")).toMatch(/Property access management/);
    expect(off.steps.join(" ")).toMatch(/Google Analytics Data API/);
    expect(off.links.map((l) => l.url).join(" ")).toMatch(/analyticsdata\.googleapis\.com/);
    expect(item(facts({ enabled: false, propertyId: null, connected: false, lastError: null, lastPullOn: null }, null)).detail).toMatch(/needs the Google service account key/);
  });

  it("is not reported as connected once switched off, even if a property was connected before", () => {
    const off = item(facts({ enabled: false, propertyId: "222222222", connected: true, lastError: null, lastPullOn: "2026-10-03" }));
    expect(off.status).toBe("warn");
    expect(off.detail).toMatch(/^Off for this sprint/);
    const on = item(facts({ enabled: true, propertyId: "222222222", connected: true, lastError: null, lastPullOn: "2026-10-03" }));
    expect(on.status).toBe("done");
    expect(item(facts({ enabled: true, propertyId: null, connected: false, lastError: null, lastPullOn: null })).detail).toMatch(/^On, not connected yet/);
  });

  it("reaches the company checklist as an optional item that says it is off", async () => {
    const w = world({ sprints: [sprintRow("sp-1", { status: "active", seeded_at: "2026-09-01T00:00:00Z" })] });
    w.routes.push([/FROM plugin_seo_8099f8879a\.sprints WHERE company_id = \$1 ORDER BY/, () => w.sprints]);
    const status = await seoSetupStatus(w.env, "co-1");
    const ga4 = status.items.find((i) => i.key === "ga4_property")!;
    expect(ga4).toMatchObject({ status: "optional", required: false });
    expect(ga4.detail).toMatch(/Off for this sprint/);
  });

  it("cannot be turned on without the Google service account key, by a person or at creation", async () => {
    const w = world({ sprints: [sprintRow("sp-1")], noServiceAccount: true });
    await expect(setSwitchTool(w.env, "co-1", user, { sprintId: "sp-1", feature: "ga4", enabled: true })).rejects.toThrow(/needs the Google service account key first/);
    await expect(setSwitchTool(w.env, "co-1", user, { scope: "company", feature: "ga4", enabled: true })).rejects.toThrow(/needs the Google service account key first/);
    await expect(createSprint(w.env, "co-1", user, { siteUrl: "https://acme.co.za", switches: { ga4: true } })).rejects.toThrow(/needs the Google service account key first/);
    expect(w.executes).toEqual([]);
  });

  it("turning it on makes the next daily pass look for the property, and turning it off closes its optional lines", async () => {
    const w = world({ sprints: [sprintRow("sp-1")], tasks: liveTasks("sp-1") });
    await setSwitchTool(w.env, "co-1", user, { sprintId: "sp-1", feature: "ga4", enabled: true });
    expect(executed(w, /INSERT INTO plugin_seo_8099f8879a\.integrations/).some((e) => e.params.includes("ga4"))).toBe(true);
    expect(w.googleCalls).toEqual([]); // the switch itself calls no Google API
    await daily(w, "sp-1");
    expect(w.googleCalls.some((c) => /analyticsadmin/.test(c.url))).toBe(true);
    const off = (await setSwitchTool(w.env, "co-1", user, { sprintId: "sp-1", feature: "ga4", enabled: false })) as { note: string };
    expect(off.note).toMatch(/nothing is looked up or pulled any more/);
  });
});

describe("new sprints start off", () => {
  it("a person's sprint with no choice made starts with all three off, seeds only the plan and no Analytics row", async () => {
    const w = world({ sprints: [], tasks: [] });
    const result = (await createSprint(w.env, "co-1", user, { siteUrl: "https://acme.co.za", businessType: "local" })) as { seededTasks: number; switches: Record<string, boolean> };
    expect(result.seededTasks).toBe(PLANS.local.tasks.length);
    expect(result.switches).toEqual({ geo: false, ga4: false, chunks: false });
    const insert = executed(w, /INSERT INTO plugin_seo_8099f8879a\.sprints /)[0]!;
    expect(insert.params.slice(-3)).toEqual([false, false, false]);
    expect(executed(w, /INSERT INTO plugin_seo_8099f8879a\.integrations/).some((e) => e.params.includes("ga4"))).toBe(false);
    expect(w.created.every((c) => !/AI search|GEO/i.test(String(c.input.title)))).toBe(true);
    expect(executed(w, /switch_log/)).toEqual([]);
  });

  it("a person can switch them on at creation: AI search seeds its tasks, Analytics gets its row, and the trail says who", async () => {
    const w = world({ sprints: [], tasks: [] });
    const result = (await createSprint(w.env, "co-1", user, { siteUrl: "https://acme.co.za", businessType: "local", switches: { geo: true, ga4: true, chunks: false } })) as { switches: Record<string, boolean>; seededTasks: number };
    expect(result.switches).toEqual({ geo: true, ga4: true, chunks: false });
    expect(result.seededTasks).toBe(PLANS.local.tasks.length + 8);
    expect(executed(w, /INSERT INTO plugin_seo_8099f8879a\.integrations/).some((e) => e.params.includes("ga4"))).toBe(true);
    const log = executed(w, /INSERT INTO plugin_seo_8099f8879a\.switch_log/).map((e) => [e.params[3], e.params[4], e.params[5], e.params[6]]);
    expect(log).toEqual([["geo", "sprint", true, "user-peet"], ["ga4", "sprint", true, "user-peet"]]);
  });

  it("the company default is only what NEW sprints start with: setting it writes one row and touches no running sprint", async () => {
    const w = world({ sprints: [sprintRow("sp-1"), sprintRow("sp-2")], tasks: [...liveTasks("sp-1"), ...liveTasks("sp-2")] });
    const before = JSON.parse(JSON.stringify(w.store.tasks));
    const answer = (await setSwitchTool(w.env, "co-1", user, { scope: "company", feature: "chunks", enabled: true })) as { note: string };
    expect(answer.note).toMatch(/for sprints created from now on. Running sprints keep their own setting/);
    expect(executed(w, /UPDATE plugin_seo_8099f8879a\.sprints/)).toEqual([]);
    expect(w.store.tasks).toEqual(before);
    const [upsert] = executed(w, /INSERT INTO plugin_seo_8099f8879a\.company_switches/);
    expect(upsert!.sql).toContain("chunks_default");
    expect(upsert!.sql).not.toMatch(/geo_default|ga4_default/);
    expect(upsert!.params).toEqual(["co-1", true, "user-peet"]);
    expect(switchesOf(await w.getSprint("sp-1"))).toEqual({ geo: false, ga4: false, chunks: false });
    const [log] = executed(w, /INSERT INTO plugin_seo_8099f8879a\.switch_log/);
    expect(log!.params.slice(1, 7)).toEqual(["co-1", null, "chunks", "company", true, "user-peet"]);
  });
});

/** The real worker: its page actions and agent tools, with a small sprint table behind them. */
async function bootWorker(initial: Row[], routes: Route[] = []) {
  const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg", publicBaseUrl: "https://paperclip.partnersinbiz.online" } });
  harness.seed({ companies: [{ id: "co-1", issuePrefix: "PIB", name: "PiB" } as never] });
  const sprints = initial.map((r) => ({ ...r }));
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const db = harness.ctx.db as { query: (sql: string, params?: unknown[]) => Promise<Row[]>; execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> };
  db.query = async (sql, params = []) => {
    validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs", "issue_comments"]);
    validateParams(sql, params);
    for (const [pattern, handler] of routes) if (pattern.test(sql)) return handler(params, sql);
    if (/\.sprints WHERE id = \$1/.test(sql)) return sprints.filter((r) => r.id === params[0] && r.company_id === params[1]);
    if (/\.sprints WHERE company_id = \$1/.test(sql)) return sprints.filter((r) => r.company_id === params[0]);
    return [];
  };
  db.execute = async (sql, params = []) => {
    validateRuntimeExecute(sql, NAMESPACE);
    validateParams(sql, params);
    executes.push({ sql, params });
    const m = /^UPDATE plugin_seo_8099f8879a\.sprints SET (\w+) = \$1::boolean/.exec(sql);
    if (m) {
      const row = sprints.find((r) => r.id === params[1] && r.company_id === params[2]);
      if (row) row[m[1]!] = params[0];
    }
    return { rowCount: 1 };
  };
  await plugin.definition.setup(harness.ctx);
  return { harness, sprints, executes };
}

describe("through the real worker: the page action and the agent tools", () => {
  const person = { companyId: "co-1", actor: { type: "user" as const, userId: "user-peet" } };
  const bot = { companyId: "co-1", actor: { type: "agent" as const, agentId: "agent-1", runId: "run-1" } };
  const set = { tool: "set-switch", params: { sprintId: "sp-1", feature: "geo", enabled: true } };

  it("the page action turns an extra on for a signed-in person, and the sprint then reads as on", async () => {
    const w = await bootWorker([sprintRow("sp-1", { seeded_at: null })]);
    const result = await w.harness.performAction<{ changed: boolean; feature: string }>("seo.call", set, person);
    expect(result).toMatchObject({ changed: true, feature: "geo" });
    expect(w.executes.some((e) => /UPDATE plugin_seo_8099f8879a\.sprints SET geo_enabled = \$1::boolean/.test(e.sql) && e.params[0] === true && e.params[1] === "sp-1")).toBe(true);
    const read = await w.harness.executeTool<{ data?: { switches: Record<string, boolean> } }>("get-switches", { sprintId: "sp-1" }, { companyId: "co-1" });
    expect(read.data?.switches).toEqual({ geo: true, ga4: false, chunks: false });
  });

  it("the same page action is refused for an agent, whatever it passes, and nothing is written", async () => {
    const w = await bootWorker([sprintRow("sp-1")]);
    await expect(w.harness.performAction("seo.call", set, bot)).rejects.toThrow(/This action is for board users/);
    await expect(w.harness.performAction("seo.call", { tool: "set-switch", params: { ...set.params, by: "user-peet", userId: "user-peet" } }, bot)).rejects.toThrow(/This action is for board users/);
    expect(w.executes).toEqual([]);
    expect(w.sprints[0]!.geo_enabled).toBe(false);
  });

  it("there is no agent tool that changes a switch: set-switch is not callable as a tool", async () => {
    const w = await bootWorker([sprintRow("sp-1")]);
    await expect(w.harness.executeTool("set-switch", set.params, { companyId: "co-1" })).rejects.toThrow();
    expect(w.executes).toEqual([]);
    expect(w.sprints[0]!.geo_enabled).toBe(false);
  });

  it("the tools of an extra that is off answer an agent with a refusal and leave the sprint alone", async () => {
    const w = await bootWorker([sprintRow("sp-1")]);
    for (const [tool, params] of [["geo-audit", { sprintId: "sp-1" }], ["connect-ga4", { sprintId: "sp-1" }], ["record-ai-mentions", { sprintId: "sp-1", samples: [{ query: "q", engine: "chatgpt", mentioned: false }] }]] as const) {
      const answer = await w.harness.executeTool<{ error?: string; data?: unknown }>(tool, params, { companyId: "co-1" });
      expect(answer.error, tool).toMatch(/is off for this sprint/);
    }
    expect(w.executes).toEqual([]);
  });

  it("creating a sprint as an agent with the extras chosen is refused, and the page action creates one with them off", async () => {
    const w = await bootWorker([]);
    const refused = await w.harness.executeTool<{ error?: string }>("create-sprint", { siteUrl: "https://acme.co.za", switches: { geo: true } }, { companyId: "co-1" });
    expect(refused.error).toBeTruthy();
    expect(w.executes.filter((e) => /INSERT INTO plugin_seo_8099f8879a\.sprints /.test(e.sql))).toEqual([]);
  });
});

describe("the Cockpit and the weekly numbers", () => {
  it("count only the sprints a person switched the extra on for", () => {
    const source = readFileSync(new URL("../src/cockpit.ts", import.meta.url), "utf8");
    expect(source).toMatch(/s\.ga4_enabled AND w\.week_start/);
    expect(source).toMatch(/s\.status IN \$\{RUNNING\} AND s\.geo_enabled/);
  });
});

describe("the extras in plain words", () => {
  it("each says what turning it on adds, and the AI-search one names the number of tasks", () => {
    expect(FEATURES.geo.adds).toMatch(/^Adds up to 8 AI-search \(GEO\) tasks to this sprint/);
    expect(FEATURES.ga4.needs).toMatch(/Two one-time Google steps first \(not done yet\)/);
    expect(FEATURES.ga4.adds).toMatch(/read only/);
    expect(FEATURES.chunks.adds).toMatch(/Splits big site-wide tasks/);
    for (const feature of Object.values(FEATURES)) expect(feature.off.length, feature.key).toBeGreaterThan(20);
  });
});


// ---------------------------------------------------------------------------
// Turning an extra off closes only that extra's own Needs you lines
// ---------------------------------------------------------------------------

describe("turning an extra off closes its own Needs you lines and no others", () => {
  const line = (key: string, check: string, extra: Row = {}): Row => ({
    key, kind: "grant", title: `Line ${key}`, why: "A person has to do this.", steps: [], links: [], after: "The agent carries on.", check, taskIds: ["sp-1-open"],
    status: "open", addedAt: "2026-09-29T00:00:00Z", doneAt: null, doneBy: null, ...extra,
  });
  const digest = (): Row[] => [
    line("geo_firewall", "geo_firewall"),
    line("ga4_access", "ga4_access", { optional: true, quiet: true }),
    line("ga4_api", "ga4_access", { optional: true, quiet: true }),
    line("service_account", "service_account"),
    line("github_token", "github_token"),
    line("pr:acme", "manual", { kind: "pr" }),
  ];
  const OWN: Record<string, string[]> = { geo: ["geo_firewall"], ga4: ["ga4_access", "ga4_api"] };

  async function switchOff(feature: "geo" | "ga4", items: Row[] = digest()) {
    const w = world({ sprints: [sprintRow("sp-1", { geo_enabled: true, ga4_enabled: true })], tasks: liveTasks("sp-1"), needsYou: items });
    const tasksBefore = JSON.parse(JSON.stringify(w.store.tasks));
    const answer = (await setSwitchTool(w.env, "co-1", user, { sprintId: "sp-1", feature, enabled: false })) as unknown as { effect: { needsYouClosed: number } };
    const saved = executed(w, /INSERT INTO plugin_seo_8099f8879a\.needs_you /);
    return { w, tasksBefore, answer, saved, items: saved.length ? (JSON.parse(String(saved[saved.length - 1]!.params[4])) as Array<Record<string, unknown>>) : null };
  }

  it.each(["geo", "ga4"] as const)("%s off: its own lines are done, with who and why; every other line stays open exactly as it was", async (feature) => {
    const original = digest();
    const { w, tasksBefore, answer, saved, items } = await switchOff(feature, original);
    expect(saved).toHaveLength(1); // one write of the digest
    expect(items).toHaveLength(original.length);
    for (const key of OWN[feature]!) {
      expect(items!.find((i) => i.key === key), key).toMatchObject({ status: "done", doneBy: "user-peet", note: feature === "geo" ? "AI search was switched off for this sprint." : "Google Analytics was switched off for this sprint." });
      expect(items!.find((i) => i.key === key)!.doneAt, key).toEqual(expect.any(String));
    }
    // Everything else (the other extra's lines, the grants and the review that have nothing to do with it) is untouched.
    for (const item of original.filter((i) => !OWN[feature]!.includes(String(i.key)))) {
      expect(items!.find((i) => i.key === item.key), String(item.key)).toEqual(item);
    }
    expect(items!.filter((i) => i.status === "open").map((i) => i.key).sort()).toEqual(original.map((i) => String(i.key)).filter((k) => !OWN[feature]!.includes(k)).sort());
    expect(answer.effect.needsYouClosed).toBe(OWN[feature]!.length);
    // Closing a line hands no task back: no task is continued, no issue is touched, nobody is woken.
    expect(w.wakeups).toEqual([]);
    expect(w.store.tasks).toEqual(tasksBefore);
    expect(w.updates.filter((u) => u.id !== "ny-issue")).toEqual([]);
    // The digest's issue is rewritten (its description) but not closed: other lines are still open on it.
    const issueUpdate = w.updates.find((u) => u.id === "ny-issue");
    expect(issueUpdate).toBeTruthy();
    expect(issueUpdate!.patch).not.toHaveProperty("status");
    expect(w.comments.filter((c) => c.id === "ny-issue")).toEqual([]);
  });

  it("leaves a line that is already done alone: who closed it and when stay as they were", async () => {
    const original = digest().map((i) => (i.key === "ga4_api" ? { ...i, status: "done", doneAt: "2026-09-30T05:00:00Z", doneBy: "checked by the SEO plugin", note: "The Analytics Data API answers." } : i));
    const { items } = await switchOff("ga4", original);
    expect(items!.find((i) => i.key === "ga4_api")).toEqual(original.find((i) => i.key === "ga4_api"));
    expect(items!.find((i) => i.key === "ga4_access")).toMatchObject({ status: "done", doneBy: "user-peet" });
  });

  it("writes nothing and touches no issue when none of its own lines is open", async () => {
    const original = digest().filter((i) => i.key !== "geo_firewall" && i.key !== "ga4_access" && i.key !== "ga4_api");
    for (const feature of ["geo", "ga4"] as const) {
      const { w, saved, answer } = await switchOff(feature, original);
      expect(saved, feature).toEqual([]);
      expect(answer.effect.needsYouClosed, feature).toBe(0);
      expect(w.updates.filter((u) => u.id === "ny-issue"), feature).toEqual([]);
      expect(w.wakeups, feature).toEqual([]);
    }
  });

  it("the last open line of the digest closing ends the digest issue as usual, but still hands nothing back", async () => {
    const { w, items } = await switchOff("geo", [line("geo_firewall", "geo_firewall")]);
    expect(items!.map((i) => [i.key, i.status])).toEqual([["geo_firewall", "done"]]);
    expect(w.wakeups).toEqual([]);
    expect(w.updates.filter((u) => u.id !== "ny-issue")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// What an off extra shows on the page and to agents, even from numbers stored while it was on
// ---------------------------------------------------------------------------

const STORED_AUDIT = { id: "g-1", sprint_id: "sp-1", audited_on: "2026-10-01", audited_at: "2026-10-01T06:00:00Z", score: 71, band: "good", complete: true, breakdown: {}, sections: {}, finding_count: 0, source: "scheduled" };
const STORED_WEEK = { week_start: "2026-09-21", property_id: "222222222", sessions: 500, engaged_sessions: 380, users: 410, key_events: 40, organic_sessions: 200, organic_engaged_sessions: 150, organic_users: 170, organic_key_events: 12, channels: [], landing_pages: [], sources: [], key_event_names: [], ai_referrals: [] };
const STORED_SNAPSHOT = {
  id: "snap-1", sprint_id: "sp-1", day: 30, kind: "scheduled", captured_on: "2026-10-01", captured_at: "2026-10-01T06:00:00Z", traffic: { impressions: 1000, clicks: 40 }, rankings: {}, authority: {}, content: {}, cwv: {}, tasks: {},
  geo: { score: 71, band: "good" }, analytics: { organicSessions: 200 }, source: "gsc", notes: null,
};
const STORED_GA4 = () => integrationRow("ga4", { status: "connected", property_url: "properties/222222222", settings: { propertyId: "222222222", pulledOn: "2026-10-03" }, last_pull_at: "2026-10-03T06:00:00Z" });

/** A sprint that has numbers stored for both extras and a connected Analytics integration, as one that had them on earlier would. */
const storedRoutes = (): Route[] => [
  [/FROM plugin_seo_8099f8879a\.audit_snapshots WHERE company_id = \$1 AND sprint_id = \$2/, () => [STORED_SNAPSHOT]],
  [/FROM plugin_seo_8099f8879a\.geo_audits/, () => [STORED_AUDIT]],
  [/FROM plugin_seo_8099f8879a\.analytics_weeks/, () => [STORED_WEEK]],
  [/FROM plugin_seo_8099f8879a\.integrations WHERE company_id = \$1 AND sprint_id = \$2 ORDER BY provider/, () => [integrationRow("gsc", { status: "connected", property_url: "sc-domain:acme.co.za" }), STORED_GA4()]],
  [/FROM plugin_seo_8099f8879a\.integrations WHERE company_id = \$1 AND sprint_id = \$2 AND provider = \$3/, (p) => [p[2] === "ga4" ? STORED_GA4() : integrationRow(String(p[2]))]],
];

describe("the SEO page's sprint bundle shows nothing of an extra that is off", () => {
  type Bundle = {
    sprint: { switches: Record<string, boolean> };
    geo: { score?: number } | null;
    analytics?: { summary: unknown };
    integrations: Array<{ provider: string }>;
    snapshots: Array<{ geo: unknown; analytics: unknown }>;
    extras: Array<{ key: string; enabled: boolean }>;
  };
  const person = { companyId: "co-1", actor: { type: "user" as const, userId: "user-peet" } };
  const open = async (extra: Row) => {
    const w = await bootWorker([sprintRow("sp-1", extra)], storedRoutes());
    return w.harness.performAction<Bundle>("seo.sprint", { sprintId: "sp-1" }, person);
  };

  it("with every extra off: no Analytics section, no AI-search numbers, no Analytics integration, empty snapshot parts, all three switches off", async () => {
    const bundle = await open({});
    expect(bundle.sprint.switches).toEqual({ geo: false, ga4: false, chunks: false });
    expect(bundle).not.toHaveProperty("analytics");
    expect(bundle.geo).toBeNull();
    expect(bundle.integrations.map((i) => i.provider)).toEqual(["gsc"]);
    expect(bundle.snapshots).toHaveLength(1);
    expect(bundle.snapshots[0]!.geo).toEqual({});
    expect(bundle.snapshots[0]!.analytics).toEqual({});
    expect(bundle.extras.map((e) => [e.key, e.enabled])).toEqual([["geo", false], ["ga4", false], ["chunks", false]]);
  });

  it("is a real test: the same stored numbers do show once the extras are on (the control)", async () => {
    const bundle = await open({ geo_enabled: true, ga4_enabled: true });
    expect(bundle.sprint.switches).toEqual({ geo: true, ga4: true, chunks: false });
    expect(bundle.analytics).toBeTruthy();
    expect(bundle.analytics!.summary).not.toBeNull();
    expect(bundle.geo).toMatchObject({ score: 71 });
    expect(bundle.integrations.map((i) => i.provider)).toEqual(["gsc", "ga4"]);
    expect(bundle.snapshots[0]!.geo).toEqual({ score: 71, band: "good" });
    expect(bundle.snapshots[0]!.analytics).toEqual({ organicSessions: 200 });
    expect(bundle.extras.map((e) => [e.key, e.enabled])).toEqual([["geo", true], ["ga4", true], ["chunks", false]]);
  });

  it("each extra is hidden on its own: AI search on shows only AI search, Analytics on shows only Analytics", async () => {
    const geoOnly = await open({ geo_enabled: true });
    expect(geoOnly.geo).toMatchObject({ score: 71 });
    expect(geoOnly).not.toHaveProperty("analytics");
    expect(geoOnly.integrations.map((i) => i.provider)).toEqual(["gsc"]);
    expect(geoOnly.snapshots[0]).toMatchObject({ geo: { score: 71, band: "good" }, analytics: {} });
    const ga4Only = await open({ ga4_enabled: true });
    expect(ga4Only.geo).toBeNull();
    expect(ga4Only.analytics).toBeTruthy();
    expect(ga4Only.integrations.map((i) => i.provider)).toEqual(["gsc", "ga4"]);
    expect(ga4Only.snapshots[0]).toMatchObject({ geo: {}, analytics: { organicSessions: 200 } });
  });
});

describe("get-sprint and audit-summary show nothing of an extra that is off", () => {
  type Snaps = { snapshots: Array<Record<string, unknown>>; geo?: unknown };
  const read = async (tool: "get-sprint" | "audit-summary", extra: Row) => {
    const w = world({ sprints: [sprintRow("sp-1", extra)], extraRoutes: storedRoutes() });
    return (await dispatch(w.env, "co-1", agent, tool, { sprintId: "sp-1" })) as unknown as Snaps;
  };

  it.each(["get-sprint", "audit-summary"] as const)("%s: the snapshots carry no AI-search or Analytics part, and no top-level AI-search summary, while they are off", async (tool) => {
    const off = await read(tool, {});
    expect(off.snapshots).toHaveLength(1);
    expect(off.snapshots[0]).not.toHaveProperty("geo");
    expect(off.snapshots[0]).not.toHaveProperty("analytics");
    expect(off.snapshots[0]).toMatchObject({ day: 30, traffic: { impressions: 1000, clicks: 40 } }); // the rest of the snapshot is there
    expect(off).not.toHaveProperty("geo");
  });

  it.each(["get-sprint", "audit-summary"] as const)("%s: with the extras on the same snapshot carries both parts (the control)", async (tool) => {
    const on = await read(tool, { geo_enabled: true, ga4_enabled: true });
    expect(on.snapshots[0]).toMatchObject({ geo: { score: 71, band: "good" }, analytics: { organicSessions: 200 } });
    if (tool === "get-sprint") expect(on.geo).toMatchObject({ score: 71 });
  });

  it.each(["get-sprint", "audit-summary"] as const)("%s: one extra on shows only its own part", async (tool) => {
    const geoOnly = await read(tool, { geo_enabled: true });
    expect(geoOnly.snapshots[0]).toMatchObject({ geo: { score: 71, band: "good" } });
    expect(geoOnly.snapshots[0]).not.toHaveProperty("analytics");
    const ga4Only = await read(tool, { ga4_enabled: true });
    expect(ga4Only.snapshots[0]).toMatchObject({ analytics: { organicSessions: 200 } });
    expect(ga4Only.snapshots[0]).not.toHaveProperty("geo");
  });
});

// ---------------------------------------------------------------------------
// The company default for new sprints, and the scope of the queries behind the switches
// ---------------------------------------------------------------------------

describe("the company default is read back when a sprint is created", () => {
  const DEFAULTS = { "co-1": { geo_default: true, ga4_default: false, chunks_default: true, updated_by: "user-boss", updated_at: "2026-10-01T06:00:00Z" } };

  it("a company whose default is on starts its new sprint with AI search and page groups on, seeds the GEO tasks and says in the trail that the default did it", async () => {
    const w = world({ sprints: [], tasks: [], companyDefaults: DEFAULTS });
    // Even an agent creating the sprint gets the person's default: it chooses nothing, the company's setting applies.
    const result = (await createSprint(w.env, "co-1", agent, { siteUrl: "https://acme.co.za", businessType: "local" })) as { switches: Record<string, boolean>; seededTasks: number };
    expect(result.switches).toEqual({ geo: true, ga4: false, chunks: true });
    expect(result.seededTasks).toBe(PLANS.local.tasks.length + 8);
    const insert = executed(w, /INSERT INTO plugin_seo_8099f8879a\.sprints /)[0]!;
    expect(insert.params.slice(-3)).toEqual([true, false, true]);
    const log = executed(w, /INSERT INTO plugin_seo_8099f8879a\.switch_log/).map((e) => [e.params[3], e.params[4], e.params[5], e.params[6]]);
    expect(log).toEqual([["geo", "sprint", true, "the company default (set by user-boss)"], ["chunks", "sprint", true, "the company default (set by user-boss)"]]);
    // Analytics default is off: no Analytics row.
    expect(executed(w, /INSERT INTO plugin_seo_8099f8879a\.integrations/).some((e) => e.params.includes("ga4"))).toBe(false);
  });

  it("another company, with no default of its own, starts its new sprint with everything off", async () => {
    const w = world({ sprints: [], tasks: [], companyDefaults: DEFAULTS });
    const result = (await createSprint(w.env, "co-2", agent, { siteUrl: "https://other.co.za", businessType: "local" })) as { switches: Record<string, boolean>; seededTasks: number };
    expect(result.switches).toEqual({ geo: false, ga4: false, chunks: false });
    expect(result.seededTasks).toBe(PLANS.local.tasks.length);
    expect(executed(w, /INSERT INTO plugin_seo_8099f8879a\.sprints /)[0]!.params.slice(-3)).toEqual([false, false, false]);
    expect(executed(w, /switch_log/)).toEqual([]);
    // The company_switches read asked for co-2's row, not co-1's.
    expect(w.queries.filter((q) => /FROM plugin_seo_8099f8879a\.company_switches/.test(q.sql)).every((q) => q.params[0] === "co-2")).toBe(true);
  });

  it("a person's own choice at creation wins over the default, in both directions", async () => {
    const w = world({ sprints: [], tasks: [], companyDefaults: DEFAULTS });
    const result = (await createSprint(w.env, "co-1", user, { siteUrl: "https://acme.co.za", businessType: "local", switches: { geo: false, ga4: false, chunks: false } })) as { switches: Record<string, boolean>; seededTasks: number };
    expect(result.switches).toEqual({ geo: false, ga4: false, chunks: false });
    expect(result.seededTasks).toBe(PLANS.local.tasks.length);
    expect(executed(w, /switch_log/)).toEqual([]);
  });

  it("running sprints do not follow it: a sprint that exists keeps its own switches whatever the default says", async () => {
    const w = world({ sprints: [sprintRow("sp-1")], tasks: liveTasks("sp-1"), companyDefaults: DEFAULTS });
    expect(switchesOf(await w.getSprint("sp-1"))).toEqual({ geo: false, ga4: false, chunks: false });
    const view = (await dispatch(w.env, "co-1", agent, "get-switches", { sprintId: "sp-1" })) as { switches: Record<string, boolean>; newSprintsStartWith: Record<string, boolean> };
    expect(view.switches).toEqual({ geo: false, ga4: false, chunks: false });
    expect(view.newSprintsStartWith).toEqual({ geo: true, ga4: false, chunks: true });
  });
});

describe("every new query is scoped to its company", () => {
  type Call = { sql: string; params: unknown[] };
  /** A database that only records what it is asked and answers with nothing. */
  function recorder() {
    const calls: Call[] = [];
    const database = {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) { calls.push({ sql, params }); return []; },
      async execute(sql: string, params: unknown[] = []) { calls.push({ sql, params }); return { rowCount: 1 }; },
    } as unknown as db.SeoDb;
    return { database, calls };
  }

  it("getCompanySwitches reads one company's row: WHERE company_id = $1 with the company id first", async () => {
    const r = recorder();
    await db.getCompanySwitches(r.database, "co-1");
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.sql).toMatch(/FROM plugin_seo_8099f8879a\.company_switches WHERE company_id = \$1\b/);
    expect(r.calls[0]!.params).toEqual(["co-1"]);
  });

  it("latestSwitchChanges reads one sprint's trail (company and sprint) or one company's defaults (company, scope company)", async () => {
    const r = recorder();
    await db.latestSwitchChanges(r.database, "co-1", "sp-1");
    await db.latestSwitchChanges(r.database, "co-1", null);
    expect(r.calls[0]!.sql).toMatch(/FROM plugin_seo_8099f8879a\.switch_log\s+WHERE company_id = \$1 AND sprint_id = \$2\b/);
    expect(r.calls[0]!.params).toEqual(["co-1", "sp-1"]);
    expect(r.calls[1]!.sql).toMatch(/FROM plugin_seo_8099f8879a\.switch_log\s+WHERE company_id = \$1 AND scope = 'company'/);
    expect(r.calls[1]!.params).toEqual(["co-1"]);
  });

  it("getSprintSwitches reads one sprint of one company", async () => {
    const r = recorder();
    expect(await db.getSprintSwitches(r.database, "co-1", "sp-1")).toBeNull();
    expect(r.calls[0]!.sql).toMatch(/FROM plugin_seo_8099f8879a\.sprints WHERE id = \$1 AND company_id = \$2\b/);
    expect(r.calls[0]!.params).toEqual(["sp-1", "co-1"]);
  });

  it("setCompanySwitch writes the one row of its company and only the one default's column, and never another company's", async () => {
    const r = recorder();
    await db.setCompanySwitch(r.database, "co-1", "geo", true, "user-peet");
    const { sql, params } = r.calls[0]!;
    expect(sql).toMatch(/^INSERT INTO plugin_seo_8099f8879a\.company_switches \(company_id, geo_default, updated_by\) VALUES \(\$1, \$2::boolean, \$3\)/);
    expect(sql).toMatch(/ON CONFLICT \(company_id\) DO UPDATE SET geo_default = EXCLUDED\.geo_default/);
    expect(sql).not.toMatch(/ga4_default|chunks_default/);
    expect(params).toEqual(["co-1", true, "user-peet"]);
  });

  it("insertSwitchLog writes the company id with the row, and a sprint's switch is updated only with its own id and company", async () => {
    const r = recorder();
    await db.insertSwitchLog(r.database, { id: "log-1", companyId: "co-1", sprintId: "sp-1", feature: "geo", scope: "sprint", enabled: true, changedBy: "user-peet", effect: {} });
    expect(r.calls[0]!.sql).toMatch(/INSERT INTO plugin_seo_8099f8879a\.switch_log \(id, company_id, sprint_id, feature, scope, enabled, changed_by, effect\)/);
    expect(r.calls[0]!.params.slice(0, 3)).toEqual(["log-1", "co-1", "sp-1"]);
    await db.updateSprint(r.database, "co-1", "sp-1", { geo_enabled: true });
    const update = r.calls[1]!;
    expect(update.sql).toMatch(/^UPDATE plugin_seo_8099f8879a\.sprints SET geo_enabled = \$1::boolean, updated_at = now\(\) WHERE id = \$2 AND company_id = \$3$/);
    expect(update.params).toEqual([true, "sp-1", "co-1"]);
  });

  it("insertSprint starts a sprint with every extra off unless it is told otherwise (an omitted choice is never on)", async () => {
    const base = { id: "sp-9", companyId: "co-1", name: "Acme", siteUrl: "https://acme.co.za", siteName: "Acme", clientKind: null, clientRef: null, clientName: null, status: "pre_launch" as const, startDate: "2026-10-04", templateId: "outrank-90", templateVersion: 4, autopilotMode: "safe" as const, ownerUserId: null, notes: null };
    const r = recorder();
    await db.insertSprint(r.database, base);
    await db.insertSprint(r.database, { ...base, switches: { geo: true, ga4: false, chunks: true } });
    expect(r.calls[0]!.sql).toMatch(/geo_enabled, ga4_enabled, chunks_enabled\)/);
    expect(r.calls[0]!.params.slice(-3)).toEqual([false, false, false]);
    expect(r.calls[1]!.params.slice(-3)).toEqual([true, false, true]);
  });
});

// ---------------------------------------------------------------------------
// A switch flipped while a sprint waits in the daily queue
// ---------------------------------------------------------------------------

describe("the daily run follows a switch a person flipped while the sprint waited its turn", () => {
  const retired = () => GEO_TASK_KEYS.slice(0, 2).map((key, i) => taskRow({ id: `g-${i}`, sprint_id: "sp-1", template_key: key, status: "na", blocker_reason: GEO_OFF_NOTE, issue_id: "issue-9", issue_status: "cancelled" }));
  /** The run gets the sprint as the job listed it earlier (`listed`) while the table holds what it is now (`current`). */
  async function run(listed: Row, current: Row) {
    const w = world({ sprints: [sprintRow("sp-1", current)], tasks: [...liveTasks("sp-1"), ...retired()] });
    const stale = { ...(await w.getSprint("sp-1")), ...listed } as db.Sprint;
    const before = JSON.parse(JSON.stringify(w.store.tasks));
    const result = await runDailyForSprint(w.env, await companyInfo(w.env, "co-1"), stale, { agent: SEO_AGENT, projectId: "proj-1" });
    return { w, before, result };
  }

  it("switched OFF after the job listed it: the tasks the switch retired stay retired, nothing is audited, fetched or pulled", async () => {
    const { w, before, result } = await run({ geoEnabled: true, ga4Enabled: true, chunksEnabled: true }, {});
    expect(w.store.tasks).toEqual(before);
    expect(w.store.tasks.filter((t) => GEO_TASK_KEYS.includes(String(t.template_key)))).toHaveLength(2);
    expect(w.store.tasks.filter((t) => t.status === "na" && t.blocker_reason === GEO_OFF_NOTE)).toHaveLength(2);
    expect(result.geoAudited).toBe(false);
    expect(w.siteCalls).toEqual([]);
    expect(w.googleCalls.filter((c) => /analyticsadmin|analyticsdata/.test(c.url))).toEqual([]);
    expect(executed(w, /geo_audits|analytics_weeks|task_chunks/)).toEqual([]);
  });

  it("switched ON after the job listed it: the run picks the switch up (it brings back the tasks and audits)", async () => {
    const { w, result } = await run({ geoEnabled: false, ga4Enabled: false, chunksEnabled: false }, { geo_enabled: true });
    expect(result.geoAudited).toBe(true);
    expect(w.store.tasks.filter((t) => t.status === "na" && t.blocker_reason === GEO_OFF_NOTE)).toEqual([]);
    expect(w.store.tasks.filter((t) => GEO_TASK_KEYS.includes(String(t.template_key)))).toHaveLength(8);
    // The other two were not switched: still nothing from Analytics.
    expect(w.googleCalls.filter((c) => /analyticsadmin|analyticsdata/.test(c.url))).toEqual([]);
  });

  it("reads the switches of the sprint's own company and id only", async () => {
    const { w } = await run({}, {});
    const reads = w.queries.filter((q) => /SELECT geo_enabled, ga4_enabled, chunks_enabled FROM/.test(q.sql));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read.params).toEqual(["sp-1", "co-1"]);
  });
});

describe("an AI-search task left over on a sprint with AI search off is never opened", () => {
  const leftOver = () => taskRow({ id: "g-left", sprint_id: "sp-1", template_key: GEO_TASK_KEYS[0], task_type: "geo-crawler-access", week: 0, status: "not_started", due_day: null, issue_id: null, issue_status: null, assignee_kind: null });

  it("the daily pass opens the plan's due work but not that task; with AI search on it is opened", async () => {
    const off = world({ sprints: [sprintRow("sp-1")], tasks: [...liveTasks("sp-1"), leftOver(), taskRow({ id: "own-due", sprint_id: "sp-1", template_key: "w0-robots", task_type: "robots-check", status: "not_started", due_day: null, issue_id: null, issue_status: null, assignee_kind: null })] });
    await daily(off, "sp-1");
    expect(off.store.tasks.find((t) => t.id === "g-left")).toMatchObject({ status: "not_started", issue_id: null });
    expect(off.store.tasks.find((t) => t.id === "own-due")!.issue_id).toBeTruthy(); // the plan's own task is opened as always
    const on = world({ sprints: [sprintRow("sp-1", { geo_enabled: true })], tasks: [...liveTasks("sp-1"), leftOver()] });
    await daily(on, "sp-1");
    expect(on.store.tasks.find((t) => t.id === "g-left")!.issue_id).toBeTruthy();
  });
});
