/**
 * UI polish round: one definition of due, overdue, stuck and waiting; plan
 * variants by business type; plain words for errors and terms.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import * as db from "../src/db.js";
import { integrationChecks } from "../src/cockpit.js";
import { suggestBusinessType } from "../src/engine/business-type.js";
import {
  DUE_TERMS,
  OVERDUE_AFTER_DAYS,
  agentCanWork,
  agentTrouble,
  dueDateOf,
  isDueTask,
  isOverdueTask,
  nextTask,
  tallyTasks,
  taskState,
  type TimedTask,
} from "../src/engine/due.js";
import { countOpenNeedsYou, type NeedsYouItem } from "../src/engine/needs-you.js";
import { fixPlurals, lowerFirst, plainError, plainTerms, plainWarning } from "../src/engine/plain.js";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { activeTotals, displayTitle, isActiveSprint, overviewFor } from "../src/service/overview.js";
import { changePlan, planChange } from "../src/service/plans.js";
import { OUTRANK_DOC, SKILL_BODY } from "../src/skills.js";
import { DEFAULT_DIRECTORIES, OUTRANK_90, TEMPLATE_ID, phaseForWeek } from "../src/templates/outrank-90.js";
import { BUSINESS_TYPES, PLANS, PLAN_TEMPLATE_IDS, allPlanTasks, businessTypeOf, defaultBusinessType, planOf, planTask } from "../src/templates/plans.js";
import { PLAYBOOKS } from "../src/templates/playbooks.js";
import { GEO_TASK_KEYS } from "../src/templates/geo.js";
import { SEO_TOOLS, SEO_TOOL_DECLARATIONS } from "../src/tools.js";
import { parseCrmWorkspace } from "../src/ui/crm-profile.js";
import { nextLine, sprintBadge, sprintStatusText, tabsForPhone, tasksLine } from "../src/ui/words.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

type Row = Record<string, unknown>;

const task = (extra: Partial<TimedTask> = {}): TimedTask => ({ status: "not_started", dueDay: 8, owner: "agent", issueId: null, issueStatus: null, assigneeKind: null, ...extra });

describe("due, overdue, stuck and waiting: one definition", () => {
  it("is due from its day, and overdue a week after it", () => {
    expect(isDueTask(task({ dueDay: 8 }), 7)).toBe(false);
    expect(isDueTask(task({ dueDay: 8 }), 8)).toBe(true);
    expect(isOverdueTask(task({ dueDay: 8 }), 8 + OVERDUE_AFTER_DAYS - 1)).toBe(false);
    expect(isOverdueTask(task({ dueDay: 8 }), 8 + OVERDUE_AFTER_DAYS)).toBe(true);
    // A pre-launch task (no day) is due at once and overdue a week after launch day.
    expect(isDueTask(task({ dueDay: null }), -5)).toBe(true);
    expect(isOverdueTask(task({ dueDay: null }), 6)).toBe(false);
    expect(isOverdueTask(task({ dueDay: null }), 7)).toBe(true);
    // Work that started early counts as due.
    expect(isDueTask(task({ dueDay: 30, status: "in_progress" }), 10)).toBe(true);
  });

  it("puts one state on each task, most urgent first", () => {
    expect(taskState(task({ status: "done" }), 20)).toBe("done");
    expect(taskState(task({ status: "na" }), 20)).toBe("skipped");
    expect(taskState(task({ status: "blocked" }), 20)).toBe("waiting");
    expect(taskState(task({ status: "in_progress", issueStatus: "in_review", assigneeKind: "user" }), 20)).toBe("waiting");
    expect(taskState(task({ status: "in_progress", assigneeKind: "needs_you" }), 20)).toBe("waiting");
    expect(taskState(task({ dueDay: 30 }), 20)).toBe("upcoming");
    expect(taskState(task({ dueDay: 8 }), 20)).toBe("overdue");
    expect(taskState(task({ dueDay: 18, status: "in_progress", assigneeKind: "agent", issueId: "i" }), 20)).toBe("in_progress");
    expect(taskState(task({ dueDay: 18 }), 20)).toBe("due");
    // The agent cannot work: its due work is stuck, a person's work is not.
    expect(taskState(task({ dueDay: 8, status: "in_progress", assigneeKind: "agent", issueId: "i" }), 20, false)).toBe("stuck");
    expect(taskState(task({ dueDay: 8, assigneeKind: "unassigned", issueId: "i" }), 20, false)).toBe("stuck");
    expect(taskState(task({ dueDay: 8 }), 20, false)).toBe("stuck");
    expect(taskState(task({ dueDay: 8, status: "blocked", assigneeKind: "agent" }), 20, false)).toBe("waiting");
    expect(taskState(task({ dueDay: 30 }), 20, false)).toBe("upcoming");
  });

  it("counts them the same way everywhere", () => {
    const tasks = [
      task({ status: "done" }),
      task({ status: "skipped" }),
      task({ dueDay: 1, status: "in_progress", assigneeKind: "agent", issueId: "a" }),
      task({ dueDay: 18, assigneeKind: "agent", issueId: "b" }),
      task({ dueDay: 3, status: "blocked", assigneeKind: "agent", issueId: "c" }),
      task({ dueDay: 50 }),
    ];
    expect(tallyTasks(tasks, 20)).toEqual({ total: 6, done: 1, skipped: 1, open: 4, due: 2, overdue: 1, stuck: 0, stuckRuns: 0, attention: 1, mostDaysLate: 19, waiting: 1, upcoming: 1 });
    expect(tallyTasks(tasks, 20, false)).toMatchObject({ due: 2, overdue: 1, stuck: 2, stuckRuns: 0, attention: 2, waiting: 1 });
  });

  it("knows when the SEO agent can work, and says why not", () => {
    expect(agentCanWork({ status: "idle" })).toBe(true);
    expect(agentCanWork({ status: "running" })).toBe(true);
    for (const status of ["error", "paused", "pending_approval", "terminated"]) expect(agentCanWork({ status }), status).toBe(false);
    expect(agentCanWork(null)).toBe(false);
    expect(agentTrouble({ name: "Sam", status: "error" })).toBe("Sam is in error");
    expect(agentTrouble({ name: "Sam", status: "paused" })).toBe("Sam is paused");
    expect(agentTrouble(null)).toBe("No SEO agent is linked");
    expect(DUE_TERMS.overdue).toContain(`${OVERDUE_AFTER_DAYS} or more days`);
  });

  it("picks the next thing due, with its date", () => {
    const tasks = [
      { ...task({ dueDay: 50 }), id: "later", title: "Later", week: 8 },
      { ...task({ dueDay: 15 }), id: "due", title: "Due now", week: 3 },
      { ...task({ dueDay: 1 }), id: "late", title: "Late", week: 1 },
    ];
    expect(nextTask(tasks, 16, "2026-09-01")).toMatchObject({ taskId: "late", state: "overdue", dueDate: "2026-09-02" });
    expect(nextTask(tasks.filter((t) => t.id !== "late"), 16, "2026-09-01")).toMatchObject({ taskId: "due", state: "due", dueDate: "2026-09-16" });
    expect(nextTask(tasks, 16, "2026-09-01", false)).toMatchObject({ taskId: "late", state: "stuck" });
    expect(nextTask([], 16, "2026-09-01")).toBeNull();
    expect(dueDateOf("2026-09-23", null)).toBe("2026-09-23");
  });

  it("counts open Needs you items once per sprint, like the Cockpit", () => {
    const item = (key: string, extra: Partial<NeedsYouItem> = {}): NeedsYouItem => ({ key, kind: "grant", title: key, why: "", steps: [], links: [], after: "", check: "manual", status: "open", addedAt: "2026-09-01T00:00:00Z", ...extra });
    const counts = countOpenNeedsYou([
      { sprintId: "s1", items: [item("a"), item("b", { optional: true }), item("c", { status: "done" })] },
      { sprintId: "s1", items: [item("a")] },
      { sprintId: "s2", items: [item("a")] },
    ]);
    expect(Object.fromEntries(counts)).toEqual({ s1: 1, s2: 1 });
  });
});

function sprint(extra: Partial<db.Sprint> = {}): db.Sprint {
  return {
    id: "s1", companyId: "co-1", name: "Acme", siteUrl: "https://acme.co.za", siteName: "Acme", clientKind: "company", clientRef: "c1", clientName: "Acme", legacyClientName: null,
    status: "active", startDate: "2026-09-01", templateId: TEMPLATE_ID, templateVersion: 4, autopilotMode: "safe", ownerUserId: null, projectId: null, rootIssueId: null,
    rootIssueIdentifier: null, agentId: null, notes: null, pausedReason: null, health: {}, scoreboard: {}, today: {}, currentDay: 0, currentWeek: 0, currentPhase: 0,
    lastDailyOn: null, lastWeeklyOn: null, auditDaysDone: [], seededAt: "2026-09-01T00:00:00Z", siteProjectId: null, clientProjectId: null, siteAccess: "unlinked", siteId: null, repoUrl: null,
    defaultBranch: "main", framework: null, hosting: null, changePolicy: "merge_seo_scope", verification: {}, geoEnabled: false, ga4Enabled: false, chunksEnabled: false, pacing: "auto", clientSignoff: "manual", createdAt: null, updatedAt: null, ...extra,
  };
}

function sprintTask(extra: Partial<db.SprintTask> = {}): db.SprintTask {
  return {
    id: "t", companyId: "co-1", sprintId: "s1", templateKey: null, week: 1, phase: 1, dueDay: 1, focus: "", title: "Task", description: null, taskType: "custom", owner: "agent",
    autopilotEligible: true, playbookKey: null, status: "not_started", source: "manual", parentOptimizationId: null, context: null, issueId: null, issueIdentifier: null,
    issueStatus: null, issueProjectId: null, assigneeKind: null, blockerReason: null, humanAsk: null, evidence: null, startedAt: null, completedAt: null, completedBy: null,
    releasedAt: null, held: false, createdAt: null, updatedAt: null, ...extra,
  };
}

describe("sprint overviews (service/overview.ts)", () => {
  it("adds proposals to what waits on a person unless autopilot is full, and never calls a paused sprint stuck", () => {
    const open = [sprintTask({ id: "a", dueDay: 1, status: "in_progress", assigneeKind: "agent", issueId: "i" })];
    const totals = { total: 42, done: 3, skipped: 1, openIssues: 1, proposals: 2 };
    const safe = overviewFor(sprint(), { today: "2026-09-21", openTasks: open, totals, needsYou: 1, agent: { status: "error" } });
    expect(safe.numbers).toMatchObject({ total: 42, done: 3, due: 1, overdue: 1, stuck: 1, needsYou: 1, waitingOnYou: 3 });
    expect(safe.next).toMatchObject({ taskId: "a", state: "stuck" });
    expect(overviewFor(sprint({ autopilotMode: "full" }), { today: "2026-09-21", openTasks: open, totals, needsYou: 1, agent: { status: "idle" } }).numbers).toMatchObject({ stuck: 0, waitingOnYou: 1 });
    expect(overviewFor(sprint({ status: "paused" }), { today: "2026-09-21", openTasks: open, totals, agent: { status: "error" } }).numbers.stuck).toBe(0);
  });

  it("sums only active sprints (running, with a plan): the SEO home, Setup and the Cockpit agree", () => {
    const sprints = [sprint({ id: "a" }), sprint({ id: "b", seededAt: null }), sprint({ id: "c", status: "paused" })];
    const n = (due: number) => ({ numbers: { total: 0, done: 0, skipped: 0, open: due, due, overdue: 1, stuck: 0, stuckRuns: 0, attention: 1, mostDaysLate: 8, waiting: 0, upcoming: 0, openIssues: 0, proposals: 0, needsYou: 0, waitingOnYou: 2, runsProjectIds: [] }, next: null });
    const overviews = new Map([["a", n(5)], ["b", n(7)], ["c", n(9)]]);
    expect(activeTotals(sprints, overviews)).toEqual({ active: 1, due: 5, overdue: 1, stuck: 0, stuckRuns: 0, attention: 1, mostDaysLate: 8, waitingOnYou: 2, runsProjectIds: [] });
    expect(isActiveSprint(sprints[1]!)).toBe(false);
  });

  it("shows template tasks in their plan's current wording", () => {
    expect(displayTitle({ title: "Submit sitemap.xml to GSC", templateKey: "w0-sitemap-submit", source: "template" }, TEMPLATE_ID)).toBe("Submit the sitemap to Google Search Console");
    expect(displayTitle({ title: "Add SoftwareApplication + FAQ schema (structured data)", templateKey: "w0-schema", source: "template" }, PLAN_TEMPLATE_IDS.local)).toBe("Add LocalBusiness + FAQ schema (structured data)");
    expect(displayTitle({ title: "My own task", templateKey: null, source: "manual" }, TEMPLATE_ID)).toBe("My own task");
  });
});

describe("plan variants by business type", () => {
  const tools = new Set(SEO_TOOL_DECLARATIONS.map((t) => t.name));

  it("keeps the software plan exactly as it was, under the original template id (the AI-search tasks are in no plan)", () => {
    expect(PLANS.saas.id).toBe("outrank-90");
    expect(PLANS.saas.tasks).toEqual(OUTRANK_90.tasks);
    for (const plan of Object.values(PLANS)) expect(plan.tasks.filter((t) => GEO_TASK_KEYS.includes(t.templateKey)), plan.id).toEqual([]);
    expect(PLANS.saas.sources).toEqual(DEFAULT_DIRECTORIES);
    expect(businessTypeOf("outrank-90")).toBe("saas");
    expect(businessTypeOf(null)).toBe("saas");
    expect(businessTypeOf("something-else")).toBe("saas");
    for (const type of BUSINESS_TYPES) expect(businessTypeOf(PLAN_TEMPLATE_IDS[type])).toBe(type);
    expect(new Set(Object.values(PLAN_TEMPLATE_IDS)).size).toBe(4);
  });

  for (const type of BUSINESS_TYPES) {
    it(`${type}: a sound 13-week plan with playbooks and real tools`, () => {
      const plan = PLANS[type];
      const keys = plan.tasks.map((t) => t.templateKey);
      expect(new Set(keys).size).toBe(keys.length);
      expect(plan.tasks.length).toBeGreaterThanOrEqual(42);
      expect(new Set(plan.tasks.map((t) => t.week)).size).toBe(14);
      for (const t of plan.tasks) {
        expect(t.templateKey.startsWith(`w${t.week}-`), t.templateKey).toBe(true);
        expect(t.phase, t.templateKey).toBe(phaseForWeek(t.week));
        expect(t.owner, t.templateKey).toBe("agent");
        const playbook = PLAYBOOKS[t.playbook];
        expect(playbook, t.templateKey).toBeDefined();
        for (const tool of playbook!.tools) if (!tool.includes(":")) expect(tools.has(tool), `${t.templateKey} → ${tool}`).toBe(true);
        // Plain words for people: no GSC, DR or LCP shorthand in a title.
        expect(t.title, t.templateKey).not.toMatch(/\bGSC\b|\bDR\b|\bLCP\b/);
      }
      // Weeks in order, as the plan grid and the seeding expect.
      expect(plan.tasks.map((t) => t.week)).toEqual([...plan.tasks.map((t) => t.week)].sort((a, b) => a - b));
      const domains = plan.sources.map((s) => s.domain);
      expect(new Set(domains).size).toBe(domains.length);
      expect(plan.summary.length).toBeGreaterThan(20);
    });
  }

  it("fits South African service businesses: no SaaS directories or launch sites outside the software plan", () => {
    for (const type of ["local", "professional", "ecommerce"] as const) {
      const plan = PLANS[type];
      const domains = plan.sources.map((s) => s.domain);
      for (const saas of ["g2.com", "producthunt.com", "capterra.com", "indiehackers.com"]) expect(domains, `${type} ${saas}`).not.toContain(saas);
      expect(plan.tasks.map((t) => t.title).join(" "), type).not.toMatch(/IndieHackers|Product Hunt|\bG2\b|SoftwareApplication/);
      // A domain rating is only ever from a real source: new sources start without one.
      for (const s of plan.sources) expect(s.dr, `${type} ${s.domain}`).toBeNull();
    }
    const local = PLANS.local;
    expect(local.sources.map((s) => s.domain)).toEqual(expect.arrayContaining(["business.google.com", "yellowpages.co.za", "yell.co.za", "snupit.co.za", "cylex.net.za", "brabys.com", "hellopeter.com"]));
    expect(local.tasks.map((t) => t.templateKey)).toEqual(expect.arrayContaining(["w0-gbp-claim", "w0-nap", "w3-service-pages", "w4-gbp-complete", "w6-reviews", "w8-area-pages", "w8-industry-listings", "w9-partner-links", "w10-local-press"]));
    expect(PLANS.professional.tasks.map((t) => t.templateKey)).toEqual(expect.arrayContaining(["w3-team-page", "w4-case-studies", "w8-industry-listings"]));
    expect(PLANS.ecommerce.tasks.map((t) => t.templateKey)).toEqual(expect.arrayContaining(["w0-merchant-center", "w3-category-pages", "w3-product-pages", "w4-product-reviews", "w8-collection-pages"]));
    expect(PLANS.ecommerce.sources.map((s) => s.domain)).toEqual(expect.arrayContaining(["merchants.google.com", "pricecheck.co.za"]));
    expect(planTask(PLAN_TEMPLATE_IDS.local, "w0-schema")?.title).toBe("Add LocalBusiness + FAQ schema (structured data)");
    expect(planOf(PLAN_TEMPLATE_IDS.professional).label).toBe("Professional services");
  });

  it("defaults a client to a local service business and our own sites to software", () => {
    expect(defaultBusinessType(true)).toBe("local");
    expect(defaultBusinessType(false)).toBe("saas");
  });

  it("has one playbook per task key across all plans", () => {
    const keys = allPlanTasks().map((t) => t.templateKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(PLAYBOOKS[key], key).toBeDefined();
  });
});

describe("the plan a client's CRM profile points to", () => {
  it("reads services, audience, website and name", () => {
    expect(suggestBusinessType({ services: ["Conveyancing", "Family law"] })).toMatchObject({ type: "professional" });
    expect(suggestBusinessType({ services: ["Luxury guest house accommodation", "Weddings"] })).toMatchObject({ type: "local" });
    expect(suggestBusinessType({ services: ["Biokinetics", "Sports injury rehab"], name: "Deidre Ras Biokinetics" })).toMatchObject({ type: "local" });
    expect(suggestBusinessType({ services: ["Junior wrestling classes"], name: "Vikings Wrestling Club" })).toMatchObject({ type: "local" });
    expect(suggestBusinessType({ services: ["Business consulting", "Strategy workshops"] })).toMatchObject({ type: "professional", word: "consulting" });
    expect(suggestBusinessType({ services: ["Online store for pet food", "Nationwide delivery"] })).toMatchObject({ type: "ecommerce" });
    expect(suggestBusinessType({ services: ["Loyalty software for retailers"], audience: "Retail chains" })).toMatchObject({ type: "saas" });
    expect(suggestBusinessType({ website: "https://smith-attorneys.co.za" })).toMatchObject({ type: "professional", word: "attorneys" });
    expect(suggestBusinessType({ website: "acme.myshopify.com" })).toMatchObject({ type: "ecommerce" });
    expect(suggestBusinessType({ services: [], website: "https://northwind.test", name: "Northwind" })).toBeNull();
    expect(suggestBusinessType({})).toBeNull();
    // "law practice": the more specific plan wins a tie.
    expect(suggestBusinessType({ services: ["A law practice in Durban"] })).toMatchObject({ type: "professional" });
  });

  it("parses the CRM workspace answer the page reads", () => {
    const body = { data: { found: true, company: { name: "AHS Law", domain: "ahslaw.co.za" }, profile: { services: ["Litigation", 7], audience: "Families", website: null } } };
    expect(parseCrmWorkspace(body)).toEqual({ services: ["Litigation"], audience: "Families", website: "ahslaw.co.za", name: "AHS Law" });
    expect(parseCrmWorkspace({ data: { found: false } })).toBeNull();
    expect(parseCrmWorkspace(null)).toBeNull();
    expect(parseCrmWorkspace({ found: true, contact: { name: "Jo Soap" }, profile: null })).toEqual({ services: [], audience: null, website: null, name: "Jo Soap" });
  });
});

describe("plain words (engine/plain.ts)", () => {
  const QUOTA = "PageSpeed Insights failed for https://example.com/: Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'pagespeedonline.googleapis.com' for consumer 'project_number:583797351490'.";

  it("turns Google and Bing errors into one plain sentence and keeps the raw text for Details", () => {
    expect(plainError(QUOTA, "pagespeed")).toEqual({ text: "Google's free PageSpeed limit ran out; checks resume tomorrow.", tone: "info", needsPerson: false, raw: QUOTA });
    expect(plainError("PageSpeed Insights took too long for https://a.co.za/; try again later")?.text).toBe("PageSpeed took too long to answer; the next daily run tries again.");
    expect(plainError("User does not have sufficient permission for site 'https://a.co.za/'.", "gsc")).toMatchObject({ needsPerson: true, tone: "warn" });
    expect(plainError("The service account (x@y.iam.gserviceaccount.com) has no access to https://a.co.za in Search Console yet.")).toMatchObject({ needsPerson: true });
    expect(plainError("invalid_grant: Token has been expired or revoked.", "gsc")).toMatchObject({ tone: "bad", needsPerson: true });
    expect(plainError("401 Unauthorized", "bing")).toMatchObject({ text: "Bing turned down the API key. Check the Bing key in the SEO settings.", needsPerson: true });
    expect(plainError("Bing API key is not set in the SEO settings", "bing")?.text).toBe("The Bing API key is not set yet (see Setup).");
    expect(plainError("fetch failed")?.text).toBe("The site or the service could not be reached; the next run tries again.");
    expect(plainError(null)).toBeNull();
    for (const raw of [QUOTA, "401 Unauthorized", "boom"]) expect(plainError(raw)!.text).not.toMatch(/project_number|googleapis|401/);
  });

  it("reads the daily run's warnings by area, pointing Google and Bing ones to the Integrations tab", () => {
    expect(plainWarning(`PageSpeed: ${QUOTA}`)).toMatchObject({ area: "Page speed", tab: "integrations", tone: "info", text: "Google's free PageSpeed limit ran out; checks resume tomorrow." });
    expect(plainWarning("Snapshot: disk full")).toMatchObject({ area: "Audit snapshot", tab: null, raw: "Snapshot: disk full" });
    expect(plainWarning("Search Console is not set up for this sprint. With the service account key …")).toMatchObject({ tab: null, text: "Search Console waits for the Google service account key (see Setup)." });
  });

  it("fixes old plurals and spells out abbreviations", () => {
    expect(fixPlurals("Finish the 13 task(s) in progress first. 1 item(s) wait.")).toBe("Finish the 13 tasks in progress first. 1 item wait.");
    expect(plainTerms("Submit sitemap.xml to GSC; DR 40+ blogs")).toBe("Submit sitemap.xml to Google Search Console; domain rating 40+ blogs");
    expect(lowerFirst("Software (SaaS)")).toBe("software (SaaS)");
  });

  it("keeps a problem that clears on its own out of the Cockpit's System health", () => {
    const row = { sprint_id: "s1", site_name: "Acme", client_kind: "company", client_ref: "c1", client_name: "Acme", provider: "pagespeed", status: "enabled", last_error: QUOTA, last_pull_at: null, updated_at: null };
    expect(integrationChecks([row])).toEqual([]);
    const broken = integrationChecks([{ ...row, last_error: "PageSpeed Insights failed for https://a/: API key not valid. Please pass a valid API key." }]);
    expect(broken[0]).toMatchObject({ status: "warn", detail: "Google turned down the PageSpeed API key. Check it in the SEO settings." });
  });
});

describe("page words (ui/words.ts)", () => {
  const base = { legacy: false, status: "active", day: 4, phaseName: "Foundation", tasks: { due: 13, overdue: 0, stuck: 13, waitingOnYou: 2 } };
  it("names a sprint's status and what needs attention first", () => {
    expect(sprintStatusText(base)).toBe("Day 4 of 90 · Foundation");
    expect(sprintStatusText({ ...base, day: -3 })).toBe("Starts in 3 days");
    expect(sprintStatusText({ ...base, legacy: true })).toBe("No 90-day plan yet");
    expect(sprintBadge(base)).toEqual({ label: "Stuck", tone: "bad" });
    expect(sprintBadge({ ...base, tasks: { ...base.tasks, stuck: 0 } })).toEqual({ label: "Needs you", tone: "warn" });
    expect(sprintBadge({ ...base, tasks: { due: 1, overdue: 0, stuck: 0, waitingOnYou: 0 } })).toEqual({ label: "On track", tone: "ok" });
    expect(sprintBadge({ ...base, status: "paused" }).label).toBe("Paused");
    expect(tasksLine(base.tasks)).toBe("13 due · 2 need you");
    expect(tasksLine({ due: 0, overdue: 0, waitingOnYou: 1 })).toBe("1 needs you");
    expect(tasksLine(null)).toBe("Nothing due");
    expect(nextLine({ taskId: "t", title: "Claim the profile", state: "upcoming", week: 0, dueDay: null, dueDate: "2026-09-23", issueId: null, issueIdentifier: null })).toMatchObject({ label: "Next", tone: "neutral" });
  });

  it("puts tabs that need you first on a phone, keeping the rest reachable in order", () => {
    const tabs = [{ id: "plan" }, { id: "keywords", countTone: undefined }, { id: "optimizations", countTone: "warn" }, { id: "integrations", countTone: "bad" }];
    expect(tabsForPhone(tabs, true).map((t) => t.id)).toEqual(["optimizations", "integrations", "plan", "keywords"]);
    expect(tabsForPhone(tabs, false).map((t) => t.id)).toEqual(["plan", "keywords", "optimizations", "integrations"]);
  });
});

describe("change-plan", () => {
  const saasTasks = PLANS.saas.tasks.map((t, i) => sprintTask({ id: `t${i}`, templateKey: t.templateKey, title: t.title, taskType: t.taskType, autopilotEligible: t.autopilotEligible, week: t.week, source: "template" }));
  const backlink = (domain: string, extra: Partial<db.Backlink> = {}): db.Backlink => ({ id: domain, companyId: "co-1", sprintId: "s1", source: domain, domain, url: null, submitUrl: null, type: "directory", dr: 50, status: "not_started", submittedAt: null, liveAt: null, notes: null, evidence: null, discoveredVia: "template", createdAt: null, updatedAt: null, ...extra });

  it("adds the new plan's tasks, rewords shared ones, drops unstarted ones and keeps started work", () => {
    const tasks = saasTasks.map((t) => (t.templateKey === "w3-comparison-page" ? { ...t, status: "in_progress" as const, issueId: "i1" } : t.templateKey === "w0-meta-tags" ? { ...t, status: "done" as const } : t));
    const backlinks = [backlink("g2.com"), backlink("producthunt.com", { status: "live" }), backlink("mysite.co.za", { discoveredVia: "manual" })];
    const change = planChange({ sprint: { id: "s1", companyId: "co-1" }, plan: PLANS.local, tasks, backlinks });
    const addedKeys = change.add.map((t) => t.templateKey);
    expect(addedKeys).toEqual(expect.arrayContaining(["w0-gbp-claim", "w0-nap", "w3-service-pages", "w6-reviews"]));
    expect(addedKeys).not.toContain("w0-meta-tags");
    expect(change.retitle.find((r) => r.task.templateKey === "w0-schema")).toMatchObject({ title: "Add LocalBusiness + FAQ schema (structured data)" });
    expect(change.drop.map((t) => t.templateKey)).toEqual(expect.arrayContaining(["w3-use-case-page", "w8-pseo-feature", "w9-link-trade-dm"]));
    expect(change.drop.map((t) => t.templateKey)).not.toContain("w3-comparison-page");
    expect(change.keep.map((t) => t.templateKey)).toEqual(["w3-comparison-page"]);
    // Only unstarted seeded directories are marked not relevant: live links and our own finds stay.
    expect(change.rejectSources.map((b) => b.domain)).toEqual(["g2.com"]);
    expect(change.addSources.map((s) => s.domain)).toEqual(expect.arrayContaining(["business.google.com", "snupit.co.za"]));
    expect(change.addSources.every((s) => s.dr === null && s.discoveredVia === "template")).toBe(true);
  });

  function fakeCtx(rows: { sprint: Row; tasks: Row[]; backlinks: Row[] }) {
    const executes: Array<{ sql: string; params: unknown[] }> = [];
    const comments: string[] = [];
    const ctx = {
      db: {
        namespace: NAMESPACE,
        async query(sql: string, params: unknown[] = []) {
          validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs"]);
          validateParams(sql, params);
          if (/\.sprints WHERE id = \$1/.test(sql)) return [rows.sprint];
          if (/\.sprint_tasks WHERE company_id = \$1 AND sprint_id = \$2/.test(sql)) return rows.tasks;
          if (/\.backlinks WHERE company_id = \$1 AND sprint_id = \$2/.test(sql)) return rows.backlinks;
          return [];
        },
        async execute(sql: string, params: unknown[] = []) {
          validateRuntimeExecute(sql, NAMESPACE);
          validateParams(sql, params);
          executes.push({ sql, params });
          return { rowCount: 1 };
        },
      },
      config: { get: vi.fn(async () => ({ timezone: "Africa/Johannesburg" })) },
      companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PIB" })) },
      issues: {
        update: vi.fn(async (id: string, patch: Row) => ({ id, ...patch })),
        createComment: vi.fn(async (_id: string, body: string) => {
          comments.push(body);
          return { id: "c" };
        }),
      },
      state: { get: vi.fn(async () => null), set: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext;
    return { env: createEnv(ctx, { now: () => new Date("2026-09-28T08:00:00Z"), fetch: vi.fn() as never, site: vi.fn() as never }), executes, comments };
  }

  const sprintRow: Row = { id: "s1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_kind: "company", client_ref: "c1", client_name: "Acme", status: "active", start_date: "2026-09-20", template_id: "outrank-90", template_version: 4, autopilot_mode: "safe", seeded_at: "2026-09-20T00:00:00Z", root_issue_id: null };
  const taskRow = (t: (typeof PLANS.saas.tasks)[number], i: number): Row => ({ id: `t${i}`, company_id: "co-1", sprint_id: "s1", template_key: t.templateKey, week: t.week, phase: t.phase, due_day: null, focus: t.focus, title: t.title, task_type: t.taskType, owner: "agent", autopilot_eligible: t.autopilotEligible, playbook_key: t.playbook, status: "not_started", source: "template", issue_id: t.templateKey === "w3-use-case-page" ? "iss-uc" : null });
  const person: Actor = { kind: "user", userId: "user-1" };

  it("moves a software sprint to the local plan and says what changed", async () => {
    const { env, executes } = fakeCtx({ sprint: sprintRow, tasks: PLANS.saas.tasks.map(taskRow), backlinks: [{ id: "b1", company_id: "co-1", sprint_id: "s1", source: "g2.com", domain: "g2.com", type: "directory", dr: 90, status: "not_started", discovered_via: "template" }] });
    const result = await changePlan(env, "co-1", person, { sprintId: "s1", businessType: "local", reason: "A guest house" });
    expect(result).toMatchObject({ sprintId: "s1", businessType: "local", plan: "Local service business", previous: "saas", sourcesNotRelevant: ["g2.com"] });
    const setPlan = executes.find((e) => e.sql.startsWith(`UPDATE ${NAMESPACE}.sprints SET`) && e.params.includes("outrank-90-local"));
    expect(setPlan).toBeDefined();
    expect(executes.some((e) => e.sql.startsWith(`INSERT INTO ${NAMESPACE}.sprint_tasks`))).toBe(true);
    expect(executes.some((e) => e.sql.startsWith(`INSERT INTO ${NAMESPACE}.backlinks`) && e.params.includes("snupit.co.za"))).toBe(true);
    // A software-only task nobody started is not needed any more; its open issue is cancelled too.
    expect(result).toMatchObject({ tasksNotNeeded: expect.arrayContaining(["Write the main use-case page"]) });
    expect((env.ctx.issues.update as ReturnType<typeof vi.fn>).mock.calls.some(([id, patch]) => id === "iss-uc" && (patch as Row).status === "cancelled")).toBe(true);
    expect(executes.some((e) => e.sql.startsWith(`UPDATE ${NAMESPACE}.sprint_tasks SET`) && e.params.includes("na"))).toBe(true);
    expect(await changePlan(env, "co-1", person, { sprintId: "s1", businessType: "saas" })).toMatchObject({ unchanged: true });
  });

  it("refuses a sprint without a plan and an unknown business type", async () => {
    const { env } = fakeCtx({ sprint: { ...sprintRow, seeded_at: null }, tasks: [], backlinks: [] });
    await expect(changePlan(env, "co-1", person, { sprintId: "s1", businessType: "local" })).rejects.toThrow(/no 90-day plan yet/);
    const seeded = fakeCtx({ sprint: sprintRow, tasks: [], backlinks: [] });
    await expect(changePlan(seeded.env, "co-1", person, { sprintId: "s1", businessType: "bakery" })).rejects.toThrow(/businessType must be one of/);
  });
});

describe("the agent knows the plans", () => {
  it("documents the plans, how to choose one, change-plan and the shared words", () => {
    expect(SKILL_BODY).toContain("## The plan fits the business");
    expect(SKILL_BODY).toContain("partnersinbiz.crm:get-client-profile");
    expect(SKILL_BODY).toContain("`change-plan`");
    for (const term of Object.values(DUE_TERMS)) expect(SKILL_BODY).toContain(term);
    for (const type of BUSINESS_TYPES) expect(OUTRANK_DOC).toContain(`plan (\`${type}\`)`);
    for (const t of allPlanTasks()) expect(OUTRANK_DOC, t.templateKey).toContain(`\`${t.templateKey}\``);
  });

  it("exposes businessType on create-sprint and the change-plan tool", () => {
    const create = SEO_TOOLS.find((t) => t.name === "create-sprint")!.parametersSchema as { properties: Record<string, { enum?: string[] }> };
    expect(create.properties.businessType!.enum).toEqual([...BUSINESS_TYPES]);
    const change = SEO_TOOLS.find((t) => t.name === "change-plan")!.parametersSchema as { required: string[]; properties: Record<string, { enum?: string[] }> };
    expect(change.required).toEqual(["sprintId", "businessType"]);
    expect(change.properties.businessType!.enum).toEqual([...BUSINESS_TYPES]);
  });
});
