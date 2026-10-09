/**
 * The UI polish round: failing runs first, plain errors with Details, one
 * setup count, waiting items listed once, calm numbers, the system health
 * list, the Memory tab's plain words, and loading once.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit/cockpit";
import { PLUGIN_KEY } from "../src/constants.js";
import { onSetupSummary, parseSetupSummary, readSetupSummary, waitingFrom } from "../src/brief.js";
import { healthIssueContent } from "../src/health.js";
import { agentRows, type AgentLite, type HealthGroup, type KpiEntry, type RunLite } from "../src/merge.js";
import { plainDetail, rawErrorAt } from "../src/plain.js";
import { createEnv } from "../src/register.js";
import { buildView, type LoadResult } from "../src/view.js";
import { ActivityList, AgentsTable, HealthList, TodayHero, WaitingRow, agentRunHref, agentStatusLabel } from "../src/ui/components.js";
import { clearSidebarCache, livePluginKeys, loadRawData, setupCount, sharedSidebarView } from "../src/ui/data.js";
import { Overview, prefixFromPath, withCompanyPrefix } from "../src/ui/index.js";
import { dedupeKpis, isQuietKpi, kpiParts, readableDates, visibleKpis } from "../src/ui/kpis.js";
import { clientOptions, listParams, plainMemoryMessage, refsFor, DEFAULT_FILTERS } from "../src/ui/memory-model.js";
import { LegalCopiesNote } from "../src/ui/profile.js";
import { runAlert, runStats } from "../src/ui/series.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const NOW = new Date("2026-09-27T21:00:00.000Z");
const linkFor = (href: string) => ({ href: `/PIB${href}` });
const snap = (plugin: string, extra: Partial<CockpitSnapshot> = {}): CockpitSnapshot => ({ plugin, title: plugin.split(".")[1]!, checkedAt: NOW.toISOString(), kpis: [], health: [], waiting: [], activity: [], quality: [], ...extra });
const kpi = (extra: Partial<KpiEntry>): KpiEntry => ({ key: "k", label: "Label", value: "1", group: "money", plugin: "partnersinbiz.billing", pluginTitle: "Billing", tone: "neutral", ...extra });
const agent = (id: string, extra: Partial<AgentLite> = {}): AgentLite => ({ id, name: id.toUpperCase(), status: "active", budgetMonthlyCents: 0, spentMonthlyCents: 0, ...extra });
const failedRuns = (agentId: string, count: number, from = "2026-09-27T04:00:00.000Z"): RunLite[] =>
  Array.from({ length: count }, (_, i) => ({ id: `run-${agentId}-${i}`, agentId, status: "failed", startedAt: new Date(Date.parse(from) + i * 1000).toISOString(), error: "Hermes exited with code 1" }));

const load: LoadResult = { roles: null, rolesSavedAt: null, settingsSaved: true, snapshots: {}, setupStatuses: {}, own: null, team: null, healthIssueId: null };

describe("raw errors in plain words", () => {
  it("explains a Google quota error and keeps the raw text for Details", () => {
    const raw = "PageSpeed Insights failed for https://example.com/: Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'pagespeedonline.googleapis.com' for consumer 'project_number:583797351490'.";
    expect(plainDetail(raw)).toEqual({
      text: "PageSpeed Insights failed for https://example.com/: Google's free PageSpeed limit ran out; checks resume tomorrow.",
      raw: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'pagespeedonline.googleapis.com' for consumer 'project_number:583797351490'.",
    });
  });

  it("says a job's last run failed, adapters stopped, keys were refused, services unreachable", () => {
    expect(plainDetail("Last error: request to https://api.x failed, reason: ECONNRESET")).toEqual({ text: "The last run failed. Could not reach the service. It tries again on its own.", raw: "request to https://api.x failed, reason: ECONNRESET" });
    expect(plainDetail("Last error: relation \"x\" does not exist")).toEqual({ text: "The last run failed.", raw: "relation \"x\" does not exist" });
    expect(plainDetail("Hermes exited with code 1")).toEqual({ text: "Stopped with an error.", raw: "Hermes exited with code 1" });
    expect(plainDetail("Gmail sync failed: HTTP 401 Unauthorized")!.text).toBe("Gmail sync failed: The service turned down the key or sign-in. Check the key, or connect it again.");
    expect(plainDetail("Bing: status code 503")!.text).toBe("Bing: The service had a problem on its side. It tries again on its own.");
  });

  it("leaves sentences plugins wrote for people alone", () => {
    for (const text of ["No opening balances posted, so balances only cover what was posted here.", "Last report 3 hours ago.", "503 contacts synced.", "4 journals checked.", "2 delivery(ies) failed permanently."]) {
      expect(plainDetail(text)).toEqual({ text, raw: null });
      expect(rawErrorAt(text)).toBe(-1);
    }
    expect(plainDetail(null)).toBeNull();
  });

  it("the System health issue says it plainly and puts the raw error under Details", () => {
    const content = healthIssueContent([{ key: "psi", title: "PageSpeed errors", status: "bad", detail: "PageSpeed Insights failed for https://x.com/: Quota exceeded for quota metric 'Queries' of service 'pagespeedonline.googleapis.com'", plugin: "partnersinbiz.seo", pluginTitle: "SEO" }], "PIB")!;
    expect(content.description).toContain("— PageSpeed Insights failed for https://x.com/: Google's free PageSpeed limit ran out; checks resume tomorrow.");
    expect(content.description).toContain("  - Details: Quota exceeded for quota metric 'Queries' of service 'pagespeedonline.googleapis.com'");
  });
});

describe("failing agent runs come first", () => {
  it("counts runs in the page's period and words the Today line", () => {
    const runs = [...failedRuns("sam", 15), { id: "old", agentId: "sam", status: "failed", startedAt: "2026-09-20T00:00:00.000Z" }];
    const stats = runStats(runs, NOW, 24 * 3_600_000);
    expect(stats).toEqual({ total: 15, failed: 15, succeeded: 0 });
    expect(runAlert(stats, 24)).toEqual({ text: "All 15 runs in the last 24 hours failed", tone: "bad" });
    expect(runAlert({ total: 20, failed: 4, succeeded: 16 }, 168)).toEqual({ text: "4 of 20 runs in the last 7 days failed", tone: "warn" });
    expect(runAlert({ total: 1, failed: 1, succeeded: 0 }, 24)!.text).toBe("The only run in the last 24 hours failed");
    expect(runAlert({ total: 5, failed: 0, succeeded: 5 }, 24)).toBeNull();
  });

  it("the Today card says so first, links the run log, and the tiles fill their row", () => {
    const html = renderToStaticMarkup(createElement(TodayHero, { health: "warn", today: "3 things wait on you.", waiting: [], problems: 0, warnings: 7, agentAlerts: 2, activeAgents: 0, runAlert: { text: "All 51 runs in the last 7 days failed", tone: "bad" }, linkFor }));
    expect(html.indexOf("All 51 runs in the last 7 days failed")).toBeLessThan(html.indexOf("3 things wait on you."));
    expect(html).toMatch(/<a href="\/PIB\/activity\/runs"[^>]*data-run-alert="bad"/);
    expect(html).toContain("Open run log →");
    // Problems and warnings, linked to System health.
    expect(html).toContain("0 problems");
    expect(html).toContain("7 warnings");
    expect(html).toContain('href="#health"');
    expect(html).toContain("repeat(auto-fit, minmax(min(150px, 100%), 1fr))");
    const calm = renderToStaticMarkup(createElement(TodayHero, { health: "ok", today: "Nothing waiting on you.", waiting: [], problems: 0, warnings: 0, agentAlerts: 0, activeAgents: 2 }));
    expect(calm).not.toContain("Open run log");
    expect(calm).toContain("All ok");
  });

  it("drops 'nothing notable logged' when the runs failed", () => {
    const view = buildView({ load, installed: null, modules: null, live: {}, runs: failedRuns("sam", 3), agents: [agent("sam", { status: "error" })], now: NOW, windowMs: 86_400_000 });
    const html = renderToStaticMarkup(createElement(ActivityList, { groups: view.activity, linkFor, now: NOW, runs: failedRuns("sam", 3) }));
    expect(html).toContain("SAM: all 3 runs failed");
    expect(html).not.toContain("nothing notable");
    const ok = buildView({ load, installed: null, modules: null, live: {}, runs: [{ id: "r", agentId: "sam", status: "succeeded", startedAt: "2026-09-27T20:00:00.000Z" }], agents: [agent("sam")], now: NOW, windowMs: 86_400_000 });
    expect(renderToStaticMarkup(createElement(ActivityList, { groups: ok.activity, linkFor, now: NOW }))).toContain("nothing notable was logged");
  });

  it("an agent in error: one pill, plain words, a link to its failed run, the adapter's text under Details", () => {
    const rows = agentRows([agent("sam", { status: "error", errorReason: "Hermes exited with code 1", urlKey: "sam" })], { runs: failedRuns("sam", 3), since: new Date(NOW.getTime() - 7 * 86_400_000) });
    expect(rows[0]).toMatchObject({ alert: "error", alertText: "Stopped with an error.", alertRaw: "Hermes exited with code 1", lastFailedRunId: "run-sam-2" });
    expect(agentRunHref(rows[0]!)).toBe("/agents/sam/runs/run-sam-2");
    const html = renderToStaticMarkup(createElement(AgentsTable, { rows, linkFor, now: NOW }));
    expect(html).toContain("Stopped with an error.");
    expect(html).toContain('href="/PIB/agents/sam/runs/run-sam-2"');
    expect(html).toContain("Open run →");
    expect(html).toMatch(/<summary[^>]*>Details<\/summary><code[^>]*>Hermes exited with code 1/);
    expect(html).not.toContain("In error:");
    // One status pill, no second "Error" chip.
    expect(html.match(/>Error</g)).toHaveLength(1);
    expect(agentStatusLabel("pending_approval")).toBe("Awaiting approval");
  });
});

describe("Waiting on you: once each, the whole row tappable", () => {
  it("lists the Finish setup issue once, with Setup's own count", () => {
    const view = buildView({
      load: { ...load, unassigned: { count: 2, items: [{ id: "iss-approve", identifier: "PIB-1", title: "Approve sending invoice INV-9F0D9A85", createdAt: "2026-09-25T15:09:53.836Z" }, { id: "iss-2", identifier: "PIB-2", title: "Fix the title tag", createdAt: "2026-09-25T15:09:53.836Z" }] } },
      installed: null,
      modules: null,
      live: { "partnersinbiz.billing": snap("partnersinbiz.billing", { waiting: [{ key: "approval:1", title: "Approve sending invoice INV-9F0D9A85", why: "w", kind: "review", issueId: "iss-approve", href: "/issues/PIB-1" }] }) },
      myIssues: [{ id: "iss-finish", identifier: "PIB-25", title: "Finish setup: 29 steps left", status: "todo" }],
      setupMissing: 29,
      setupIssueId: "iss-finish",
      now: NOW,
      windowMs: 86_400_000,
    });
    expect(view.waiting.map((w) => w.title)).toEqual(expect.arrayContaining(["Finish setup: 29 steps left", "Approve sending invoice INV-9F0D9A85", "1 open issue has nobody assigned"]));
    expect(view.waiting.filter((w) => /Finish setup/.test(w.title))).toHaveLength(1);
    expect(view.waiting.find((w) => w.key === "unassigned-issues")!.examples!.map((e) => e.title)).toEqual(["PIB-2 Fix the title tag"]);
  });

  it("the whole row is one link with the arrow on the right", () => {
    const item = { key: "setup:missing", title: "Finish setup: 16 steps left", why: "Agents cannot run these parts on their own.", href: "/setup", issueId: null, kind: "grant" as const, since: null, source: "host", sourceTitle: "Paperclip" };
    const html = renderToStaticMarkup(createElement(WaitingRow, { item, linkFor, now: NOW, first: true }));
    expect(html.startsWith('<a href="/PIB/setup"')).toBe(true);
    expect(html).toContain("grid-template-columns:3px minmax(0, 1fr) auto");
    expect(html).toContain("Open →");
    // A count with examples opens each example instead (no nested links).
    const withExamples = renderToStaticMarkup(createElement(WaitingRow, { item: { ...item, key: "unassigned-issues", href: null, examples: [{ title: "PIB-2 Fix the title tag", href: "/issues/PIB-2" }] }, linkFor, now: NOW, first: true }));
    expect(withExamples.startsWith("<div")).toBe(true);
    expect(withExamples).toContain('href="/PIB/issues/PIB-2"');
  });

  it("the Operator's brief lists it once too (Setup's count, sent as an event)", async () => {
    const fake = fakeCtx();
    const env = createEnv(fake.ctx, fixedClock("2026-09-27T21:00:00.000Z").now);
    expect(parseSetupSummary({ requiredLeft: -1 })).toBeNull();
    expect(await onSetupSummary(env, "co", { companyId: "co", requiredLeft: 29, requiredDone: 16, requiredTotal: 45, optionalLeft: 24, finishIssueId: "iss-finish", updatedAt: "2026-09-27T20:00:00.000Z" })).toBe(true);
    // An older count arriving late is ignored.
    expect(await onSetupSummary(env, "co", { requiredLeft: 3, updatedAt: "2026-09-27T10:00:00.000Z" })).toBe(false);
    expect(await readSetupSummary(env, "co")).toMatchObject({ requiredLeft: 29, finishIssueId: "iss-finish" });
    const waiting = waitingFrom({ snapshots: [], approvals: [], ownerIssues: [{ id: "iss-finish", identifier: "PIB-25", title: "Finish setup: 29 steps left", status: "todo" }], setupMissing: 29, setupIssueId: "iss-finish" });
    expect(waiting.map((w) => w.title)).toEqual(["Finish setup: 29 steps left"]);
  });
});

describe("calm numbers", () => {
  it("splits a packed money value into the amount and a plain hint", () => {
    expect(kpiParts({ label: "Drafts to send", value: "1 · R 11,500.00 (1 over a day)" })).toEqual({ value: "R 11,500.00", hint: "1 invoice, over a day old" });
    expect(kpiParts({ label: "Drafts to send", value: "3 · R 2,000.00 (1 over a day)" })).toEqual({ value: "R 2,000.00", hint: "3 invoices, 1 over a day old" });
    expect(kpiParts({ label: "Open quotes", value: "2 · R 5,000.00" })).toEqual({ value: "R 5,000.00", hint: "2 quotes" });
    expect(kpiParts({ label: "Next pay date", value: "2026-10-25" }, NOW)).toEqual({ value: "25 Oct", hint: null });
    expect(readableDates("VAT due (2026-09-01 to 2026-10-31)", NOW)).toBe("VAT due (1 Sep to 31 Oct)");
  });

  it("shows the numbers that are not zero or need attention, never a repeat", () => {
    expect(isQuietKpi({ value: "None", raw: 0, tone: "ok" })).toBe(true);
    expect(isQuietKpi({ value: "R 0.00", raw: null, tone: "neutral" })).toBe(true);
    expect(isQuietKpi({ value: "–", raw: null, tone: "neutral" })).toBe(true);
    expect(isQuietKpi({ value: "0", raw: 0, tone: "warn" })).toBe(false);
    expect(isQuietKpi({ value: "2", raw: 2, tone: "ok" })).toBe(false);
    const mail = [
      kpi({ key: "today", label: "Mail sent today", value: "0", raw: 0, delta: "0 in the last 7 days", plugin: "partnersinbiz.mailbox", group: "delivery" }),
      kpi({ key: "7d", label: "Mail sent (7 days)", value: "0", raw: 0, plugin: "partnersinbiz.mailbox", group: "delivery" }),
      kpi({ key: "fail", label: "Send failures (7 days)", value: "0", raw: 0, plugin: "partnersinbiz.mailbox", group: "delivery" }),
    ];
    expect(dedupeKpis(mail).map((k) => k.key)).toEqual(["today", "fail"]);
    expect(visibleKpis(mail, false)).toEqual([]);
    expect(visibleKpis(mail, true).map((k) => k.key)).toEqual(["today", "fail"]);
  });

  it("the page hides quiet groups, offers every number, and a money tile keeps its amount on one line", () => {
    const view = buildView({
      load,
      installed: null,
      modules: null,
      live: {
        "partnersinbiz.billing": snap("partnersinbiz.billing", { title: "Billing", kpis: [
          { key: "drafts", label: "Drafts to send", value: "1 · R 11,500.00 (1 over a day)", raw: 1, tone: "warn", group: "pipeline" },
          { key: "overdue", label: "Overdue", value: "None", raw: 0, tone: "ok", group: "money" },
        ] }),
        "partnersinbiz.mailbox": snap("partnersinbiz.mailbox", { title: "Mailbox", kpis: [{ key: "sent", label: "Mail sent today", value: "0", raw: 0, tone: "neutral", group: "delivery" }] }),
      },
      now: NOW,
      windowMs: 86_400_000,
    });
    const html = renderToStaticMarkup(createElement(Overview, { view, load, linkFor, windowHours: 24, onWindow: () => undefined, now: NOW }));
    expect(html).toContain("R 11,500.00");
    expect(html).toContain("1 invoice, over a day old");
    expect(html).not.toContain("1 · R 11,500.00");
    expect(html).toContain("Pipeline");
    expect(html).not.toContain(">Delivery<");
    expect(html).toContain("2 more numbers are at zero (nothing to report in Money, Delivery).");
    expect(html).toContain("Show all numbers");
    // Tiles in a half-width panel: two to a row, filling it.
    expect(html).toContain("repeat(auto-fit, minmax(min(190px, 100%), 1fr))");
  });
});

describe("System health lists what needs attention", () => {
  const groups: HealthGroup[] = [
    { plugin: "partnersinbiz.seo", title: "SEO", status: "warn", checks: [
      { key: "psi", title: "PageSpeed errors", status: "warn", detail: "PageSpeed Insights failed for https://x.com/: Quota exceeded for quota metric 'Queries' for consumer 'project_number:583797351490'.", plugin: "partnersinbiz.seo", pluginTitle: "SEO" },
      { key: "daily", title: "Daily SEO run", status: "ok", plugin: "partnersinbiz.seo", pluginTitle: "SEO" },
    ] },
    { plugin: "partnersinbiz.crm", title: "CRM", status: "ok", checks: [{ key: "share", title: "Share clients", status: "ok", plugin: "partnersinbiz.crm", pluginTitle: "CRM" }] },
  ];

  it("hides the ok checks behind Show all and says raw errors plainly", () => {
    const html = renderToStaticMarkup(createElement(HealthList, { groups, linkFor, now: NOW, backup: { at: null, ageHours: 0.5, status: "ok", text: "Less than an hour ago." } }));
    expect(html).toContain("PageSpeed errors");
    expect(html).toContain("Google&#x27;s free PageSpeed limit ran out; checks resume tomorrow.");
    expect(html).toMatch(/Details<\/summary><code[^>]*>Quota exceeded/);
    for (const hidden of ["Daily SEO run", "Share clients", "Last database backup"]) expect(html, hidden).not.toContain(hidden);
    const all = renderToStaticMarkup(createElement(HealthList, { groups, linkFor, now: NOW, backup: { at: null, ageHours: 0.5, status: "ok", text: "Less than an hour ago." }, showAll: true }));
    for (const shown of ["Daily SEO run", "Share clients", "Last database backup"]) expect(all, shown).toContain(shown);
  });
});

describe("loading once", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    clearSidebarCache();
  });

  it("asks only PiB plugins for live snapshots: never the LLM Wiki (no such route) or the Cockpit itself", async () => {
    const keys = await livePluginKeys({ installed: null, modules: null }, async () => [{ pluginKey: "partnersinbiz.crm" }, { pluginKey: "paperclipai.plugin-llm-wiki" }, { pluginKey: PLUGIN_KEY }]);
    expect(keys).toEqual(["partnersinbiz.crm"]);
    const all = await livePluginKeys({ installed: null, modules: { seo: false } }, async () => null);
    expect(all).not.toContain("paperclipai.plugin-llm-wiki");
    expect(all).not.toContain(PLUGIN_KEY);
    expect(all).not.toContain("partnersinbiz.seo");
    expect(await livePluginKeys({ installed: { "partnersinbiz.crm": { id: "c", status: "ready" }, "partnersinbiz.billing": { id: "b", status: "error" } }, modules: null })).toEqual(["partnersinbiz.crm"]);
  });

  it("a second page mount and the sidebar reuse the page's load", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    let loads = 0;
    const loadAction = async () => {
      loads += 1;
      return load;
    };
    const [a, b] = await Promise.all([loadRawData("co-1", loadAction, false), loadRawData("co-1", loadAction, false)]);
    expect(a).toBe(b);
    expect(loads).toBe(1);
    expect(urls.filter((u) => u.includes("/heartbeat-runs"))).toHaveLength(1);
    await sharedSidebarView("co-1", loadAction);
    expect(loads).toBe(1);
    // Refresh asks again.
    await loadRawData("co-1", loadAction, false, { fresh: true });
    expect(loads).toBe(2);
  });

  it("the light load (widget, sidebar) reads live snapshots, not only the stored ones", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      const body = String(url) === "/api/plugins" ? JSON.stringify([{ pluginKey: "partnersinbiz.billing", id: "b1", status: "ready" }]) : "[]";
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    await loadRawData("co-live", async () => load, true);
    expect(urls.some((u) => u.includes("/api/plugins/partnersinbiz.billing/api/cockpit?companyId=co-live"))).toBe(true);
    expect(urls.filter((u) => u.includes("/heartbeat-runs"))).toHaveLength(0);
  });

  it("prefixes widget links with the company prefix once", () => {
    expect(prefixFromPath("/PAR/dashboard")).toBe("PAR");
    expect(prefixFromPath("/dashboard")).toBeNull();
    expect(withCompanyPrefix("/cockpit", "PAR")).toBe("/PAR/cockpit");
    expect(withCompanyPrefix("/billing?tab=invoices", "PAR")).toBe("/PAR/billing?tab=invoices");
    expect(withCompanyPrefix("/PAR/billing", "PAR")).toBe("/PAR/billing");
    expect(withCompanyPrefix("https://x.test/a", "PAR")).toBe("https://x.test/a");
    expect(withCompanyPrefix("/cockpit", null)).toBe("/cockpit");
  });

  it("uses Setup's own count when it sends one", () => {
    expect(setupCount({ modules: null, statuses: {}, summary: { requiredDone: 16, requiredTotal: 45, requiredLeft: 29, optionalLeft: 24 }, finishIssueId: "x" }, null)).toBe(29);
    expect(setupCount({ modules: null, statuses: { "partnersinbiz.crm": { status: { plugin: "partnersinbiz.crm", module: "crm", title: "CRM", checkedAt: "x", items: [{ key: "a", title: "a", status: "missing", required: true }, { key: "b", title: "b", status: "missing", required: false }] } } }, summary: null, finishIssueId: null }, null)).toBe(1);
    expect(setupCount(null, null)).toBeNull();
  });
});

describe("Memory tab in plain words", () => {
  const clients = [
    { clientRef: "company:3347ba94", clientName: "Northwind" },
    { clientRef: "company:northwind-test", clientName: "Northwind" },
    { clientRef: "contact:1c98", clientName: "Test Sequence Contact" },
  ];

  it("lists each client once and filters on every ref it has", () => {
    expect(clientOptions(clients)).toEqual([
      { value: "company:3347ba94", label: "Northwind", refs: ["company:3347ba94", "company:northwind-test"] },
      { value: "contact:1c98", label: "Test Sequence Contact", refs: ["contact:1c98"] },
    ]);
    expect(refsFor("company:northwind-test", clients)).toEqual(["company:3347ba94", "company:northwind-test"]);
    expect(listParams({ ...DEFAULT_FILTERS, client: "company:3347ba94" }, 0, 25, clients)).toMatchObject({ clients: ["company:3347ba94", "company:northwind-test"] });
    expect(listParams({ ...DEFAULT_FILTERS, client: "contact:1c98" }, 0, 25, clients)).toMatchObject({ client: "contact:1c98" });
    expect(listParams({ ...DEFAULT_FILTERS, client: "own" }, 0, 25, clients)).toMatchObject({ client: "own" });
  });

  it("drops fact ids and tool hints from action messages", () => {
    expect(plainMemoryMessage("Saved [m3eay4fxyc] for Northwind (client), area general. It may contradict [m0yg46sec83] \"x\". If the new fact replaces it, call memory-update with {id: \"m0yg46sec83\", status: \"superseded\"}.")).toBe("Saved for Northwind (client), area general. It may contradict \"x\".");
    expect(plainMemoryMessage("Updated [m3eay4fxyc] (archived).")).toBeUndefined();
    expect(plainMemoryMessage("Already known as [m3eay4fxyc].")).toBe("Already known.");
    expect(plainMemoryMessage("Saved [m1aaaaaaaa] for the whole company, area general. It replaces [m2bbbbbbbb].")).toBe("Saved for the whole company, area general. It replaces an older fact.");
    expect(plainMemoryMessage(null)).toBeUndefined();
  });
});

describe("Profile", () => {
  it("points to Billing and Accounting's own legal details in one line", () => {
    const html = renderToStaticMarkup(createElement(LegalCopiesNote, { linkFor, billingSettingsHref: "/company/settings/instance/plugins/b1", accountingSettingsHref: "/company/settings/instance/plugins/a1" }));
    expect(html).toContain("Billing and Accounting keep their own legal name and VAT number");
    expect(html).toContain('href="/PIB/company/settings/instance/plugins/b1"');
    expect(html).toContain('href="/PIB/company/settings/instance/plugins/a1"');
  });
});
