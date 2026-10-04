/**
 * Rehearsal sprints (wave 6 of the 2026-10-03 gap audit). The acceptance agent's seo-sprint-draft journey creates a sprint for the
 * fixture site https://canary.invalid on the canary client and archives it. Live, one run opened a root issue and nine "SEO W0"
 * issues for the owner and left them open. A rehearsal must be harmless: the sprint, its tasks and keywords exist (the journey reads
 * them), but no Paperclip issue is opened, no person is asked for anything and no agent is woken.
 *
 * Every test of "nothing is opened" has a control: the same fixture as a real client's sprint (https://agristudies.co.za,
 * company:<uuid>) opens what it always did, so a guard that is missing or too wide fails a test.
 */
import { describe, expect, it, vi } from "vitest";
import * as db from "../src/db.js";
import { CANARY_PREFIX, isCanaryRef, isRehearsalHost, isRehearsalSprint, REHEARSAL_NOTE, REHEARSAL_REFUSAL } from "../src/engine/rehearsal.js";
import { createEnv, companyInfo, SeoError, type Actor } from "../src/service/common.js";
import { dispatch } from "../src/dispatch.js";
import { adoptUnassignedAgentTasks } from "../src/service/agent.js";
import { addRedesign } from "../src/service/redesign.js";
import { contentWentLive } from "../src/service/handoff.js";
import { openIssue } from "../src/service/issues.js";
import { runDailyForSprint, runWeeklyForSprint, runWeeklyJob } from "../src/service/jobs.js";
import { addNeedsYou } from "../src/service/needs-you.js";
import { routePrReview } from "../src/service/review.js";
import { detectSignals } from "../src/service/optimize.js";
import { createSprint, setSprintStatus, sprintToday, sprintView, todayTool } from "../src/service/sprints.js";
import { createTaskIssue, materialiseDueTasks, startTasksNow } from "../src/service/tasks.js";
import { requestBuild } from "../src/service/build.js";
import { memoryAnnouncements } from "./helpers/announcements.js";
import { CANARY_ID, createdIssues, planTasks, REAL_ID, sprintFor, world, type World } from "./helpers/rehearsal-world.js";
import { executed, integrationRow, type Route, type Row } from "./helpers/seo-host.js";

const user: Actor = { kind: "user", userId: "user-peet" };
const AGENT = { id: "agent-1", status: "idle" };

const needsYouWrites = (w: World) => executed(w, /INSERT INTO plugin_seo_8099f8879a\.needs_you /);
const kinds = (w: Pick<World, "created">) => w.created.map((c) => String(c.input.originKind).split(":").at(-1));
const cancelled = (w: World) => w.updates.filter((u) => u.patch.status === "cancelled").map((u) => u.id);

// ---------------------------------------------------------------------------
// The test: what counts as a rehearsal
// ---------------------------------------------------------------------------

describe("isRehearsalSprint", () => {
  it.each([
    ["the canary's fixture site", { siteUrl: "https://canary.invalid", clientRef: null }],
    ["a fixture site with a www, a path and a port", { siteUrl: "http://www.shop.invalid:8443/start", clientRef: null }],
    ["a fixture site in capitals with a trailing dot", { siteUrl: "https://CANARY.INVALID.", clientRef: null }],
    ["a fixture host without a scheme", { siteUrl: "canary.invalid", clientRef: null }],
    ["the bare reserved name", { siteUrl: "https://invalid", clientRef: null }],
    ["the canary company's bare id (as stored on the sprint)", { siteUrl: "https://real.example.com", clientRef: CANARY_ID }],
    ["the canary company as a client param", { siteUrl: "https://real.example.com", clientRef: `company:${CANARY_ID}` }],
    ["the canary contact as a client param", { siteUrl: "https://real.example.com", clientRef: "contact:canary-contact-daf7b7d3" }],
  ])("is true for %s", (_name, subject) => {
    expect(isRehearsalSprint(subject)).toBe(true);
  });

  it.each([
    ["a real client's site and company", { siteUrl: "https://agristudies.co.za", clientRef: "company:6f1c2b9e-3a4d-4c1e-9b7a-2d5e8f0a1c33" }],
    ["a real client's bare uuid", { siteUrl: "https://agristudies.co.za", clientRef: REAL_ID }],
    ["one of our own sites (no client at all)", { siteUrl: "https://partnersinbiz.online", clientRef: null }],
    ["a host that only contains .invalid in the middle", { siteUrl: "https://notcanary.invalid.example.com", clientRef: null }],
    ["a host that only starts with invalid", { siteUrl: "https://invalid.example.com", clientRef: null }],
    ["a host that ends in invalid without the dot", { siteUrl: "https://myinvalid.com", clientRef: null }],
    ["a real host with .invalid in the path, query or fragment", { siteUrl: "https://real.example.com/canary.invalid?x=a.invalid#b.invalid", clientRef: null }],
    ["a real host with .invalid in the user part of the address", { siteUrl: "https://canary.invalid@real.example.com", clientRef: null }],
    ["a client ref that merely contains the word canary", { siteUrl: "https://real.example.com", clientRef: "company:acme-canary-1" }],
    ["a client ref that is the word canary", { siteUrl: "https://real.example.com", clientRef: "canary" }],
    ["a client ref that is only the prefix", { siteUrl: "https://real.example.com", clientRef: CANARY_PREFIX }],
    ["a client ref with canary after the kind", { siteUrl: "https://real.example.com", clientRef: "company:canary" }],
    ["a client ref that starts with something else", { siteUrl: "https://real.example.com", clientRef: "xcanary-daf7b7d3" }],
    ["a client ref in capitals (a real id never is)", { siteUrl: "https://real.example.com", clientRef: "CANARY-DAF7B7D3" }],
    ["a client ref with a space or a path after the id", { siteUrl: "https://real.example.com", clientRef: `${CANARY_PREFIX}daf7b7d3 ../x` }],
    ["a client ref of another kind", { siteUrl: "https://real.example.com", clientRef: "deal:canary-daf7b7d3" }],
    ["no site and no client", { siteUrl: undefined, clientRef: undefined }],
    ["an address that is not a site", { siteUrl: "not a url at all %%", clientRef: 42 }],
  ])("is false for %s", (_name, subject) => {
    expect(isRehearsalSprint(subject)).toBe(false);
  });

  it("is built from small checks that each say the same", () => {
    expect(isRehearsalHost("canary.invalid")).toBe(true);
    expect(isRehearsalHost("agristudies.co.za")).toBe(false);
    expect(isRehearsalHost(null)).toBe(false);
    expect(isCanaryRef(CANARY_ID)).toBe(true);
    expect(isCanaryRef(REAL_ID)).toBe(false);
    expect(isCanaryRef(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// create-sprint
// ---------------------------------------------------------------------------

describe("create-sprint", () => {
  it("for the canary and its fixture site seeds the plan and opens no issue at all", async () => {
    const w = world();
    const result = (await createSprint(w.env, "co-1", user, { siteUrl: "https://canary.invalid", client: `company:${CANARY_ID}` })) as Record<string, unknown>;
    expect(result).toMatchObject({ rehearsal: true, issuesOpened: 0, issuesPending: 0, rootIssueId: null, note: REHEARSAL_NOTE, warnings: [] });
    expect(result.seededTasks).toBeGreaterThan(30);
    expect(result.seededBacklinks).toBeGreaterThan(0);
    expect(result.next).toMatch(/archive-sprint/);
    // No issue, no wake, no Needs you line, no project made or linked, no comment.
    expect(w.created).toEqual([]);
    expect(w.updates).toEqual([]);
    expect(w.wakeups).toEqual([]);
    expect(w.comments).toEqual([]);
    expect(needsYouWrites(w)).toEqual([]);
    // Nothing is looked up to attach it to: no managed SEO project, no client project, no WordPress site in the CRM.
    expect(w.reconcile).not.toHaveBeenCalled();
    expect(w.projectsList).not.toHaveBeenCalled();
    expect(w.queries.filter((q) => /crm_sites/.test(q.sql))).toEqual([]);
    // The sprint and its tasks exist, so the journey's reads work.
    const sprint = (await db.getSprint(w.env.ctx.db, "co-1", result.sprintId as string))!;
    expect(sprint).toMatchObject({ siteUrl: "https://canary.invalid", clientRef: CANARY_ID, rootIssueId: null });
    expect(w.store.tasks.length).toBe(result.seededTasks);
    expect(w.store.tasks.every((t) => t.issue_id == null)).toBe(true);
  });

  it("is a rehearsal for the fixture site alone, and for the canary client alone", async () => {
    const siteOnly = world();
    const a = (await createSprint(siteOnly.env, "co-1", user, { siteUrl: "https://shop.invalid" })) as Record<string, unknown>;
    expect(a).toMatchObject({ rehearsal: true, issuesOpened: 0 });
    expect(siteOnly.created).toEqual([]);
    const clientOnly = world();
    const b = (await createSprint(clientOnly.env, "co-1", user, { siteUrl: "https://canary-shop.example.com", client: `company:${CANARY_ID}` })) as Record<string, unknown>;
    expect(b).toMatchObject({ rehearsal: true, issuesOpened: 0 });
    expect(clientOnly.created).toEqual([]);
  });

  it("for a real client still opens the root issue and the due tasks exactly as before (a snapshot of 0.23.1's issues)", async () => {
    const w = world();
    const result = (await createSprint(w.env, "co-1", user, { siteUrl: "https://agristudies.co.za", client: `company:${REAL_ID}`, businessType: "local" })) as Record<string, unknown>;
    expect(result).not.toHaveProperty("rehearsal");
    expect(result).not.toHaveProperty("note");
    expect(result.warnings).toEqual([]);
    expect(result.rootIssueId).toBe("issue-101");
    expect(result.issuesOpened).toBe(2);
    expect(result.seededTasks).toBe(46);
    // Every issue 0.23.1 opens for a new local client sprint on day 0, with the agent linked: the root issue for the owner, the
    // week-0 tasks that are agent work as issues (woken), and the weekly Needs you issue for what a person must do. Taken from a
    // run of the 0.23.1 source on this same fixture (the two outputs, the issues' full text included, were compared byte for byte).
    expect(createdIssues(w)).toEqual(REAL_CLIENT_ISSUES);
    expect(w.wakeups).toEqual(["issue-103", "issue-104"]);
    expect(w.created[0]!.input.description).toContain(result.sprintId as string);
    for (const issue of w.created) expect(String(issue.input.description).length).toBeGreaterThan(100);
    expect(needsYouWrites(w).length).toBeGreaterThan(0); // the person's tasks are on the Needs you list: a rehearsal has none
    // The managed SEO project, the client's own project and the client's WordPress sites are looked up for a real sprint, not for a rehearsal.
    expect(w.reconcile).toHaveBeenCalled();
    expect(w.projectsList).toHaveBeenCalled();
    expect(w.queries.filter((q) => /crm_sites/.test(q.sql)).length).toBeGreaterThan(0);
  });
});

/** The issues a real local client's new sprint gets: its root issue, the weekly Needs you issue, then the tasks for the agent. Snapshot of 0.23.1. */
const REAL_CLIENT_ISSUES: Array<Record<string, unknown>> = [
  { title: "SEO sprint: Agri Studies", originKind: "plugin:partnersinbiz.seo:sprint", assigneeAgentId: null, assigneeUserId: "user-peet", parentId: null, projectId: "proj-seo", status: "todo", priority: null },
  { title: "Needs you: SEO Agri Studies (week of 2026-09-28)", originKind: "plugin:partnersinbiz.seo:needs-you", assigneeAgentId: null, assigneeUserId: "user-peet", parentId: "issue-101", projectId: "proj-seo", status: "todo", priority: "high" },
  { title: "SEO W0 \u00b7 Submit the sitemap to Google Search Console \u2014 Agri Studies", originKind: "plugin:partnersinbiz.seo:task", assigneeAgentId: "agent-1", assigneeUserId: null, parentId: "issue-101", projectId: "proj-seo", status: "todo", priority: null },
  { title: "SEO W0 \u00b7 Claim and verify the Google Business Profile \u2014 Agri Studies", originKind: "plugin:partnersinbiz.seo:task", assigneeAgentId: "agent-1", assigneeUserId: null, parentId: "issue-101", projectId: "proj-seo", status: "todo", priority: null },
];

// ---------------------------------------------------------------------------
// The daily pass
// ---------------------------------------------------------------------------

describe("the daily pass", () => {
  async function daily(w: World, id: string) {
    const info = await companyInfo(w.env, "co-1");
    const sprint = (await db.getSprint(w.env.ctx.db, "co-1", id))!;
    return runDailyForSprint(w.env, info, sprint, { agent: AGENT, projectId: "proj-seo" });
  }

  it("on a rehearsal sprint creates nothing, wakes no one, raises no line, calls out to no one and keeps the clock", async () => {
    const w = world({ sprints: [sprintFor("rehearsal")], tasks: planTasks("sp-rehearsal") });
    const before = JSON.parse(JSON.stringify(w.store.tasks));
    const result = await daily(w, "sp-rehearsal");
    expect(result).toMatchObject({ sprintId: "sp-rehearsal", issuesOpened: 0, planUpgraded: false, needsYouResolved: 0, warnings: [] });
    expect(w.created).toEqual([]);
    expect(w.wakeups).toEqual([]);
    expect(w.updates).toEqual([]);
    expect(w.comments).toEqual([]);
    expect(needsYouWrites(w)).toEqual([]);
    expect(w.siteCalls).toEqual([]);
    expect(w.googleCalls).toEqual([]);
    expect(w.store.tasks).toEqual(before);
    // The day's record is kept, and says why nothing is due.
    const written = executed(w, /UPDATE plugin_seo_8099f8879a\.sprints SET/);
    expect(written.some((e) => /last_daily_on/.test(e.sql))).toBe(true);
    expect(written.map((e) => JSON.stringify(e.params)).join(" ")).toContain("Rehearsal sprint");
    expect(w.sprintRow("sp-rehearsal").root_issue_id).toBeNull();
  });

  it("on a real client's sprint with the same tasks opens the root issue and the due tasks (the control)", async () => {
    const w = world({ sprints: [sprintFor("real")], tasks: planTasks("sp-real") });
    const result = await daily(w, "sp-real");
    expect(result.issuesOpened).toBeGreaterThan(0);
    expect(kinds(w)).toEqual(["sprint", "task", "needs-you", "task"]);
    expect(w.created.filter((c) => /:task$/.test(String(c.input.originKind)))).toHaveLength(result.issuesOpened);
    expect(w.created[0]!.input.originKind).toBe("plugin:partnersinbiz.seo:sprint");
    expect(w.wakeups.length).toBeGreaterThan(0);
    expect(needsYouWrites(w).length).toBeGreaterThan(0);
  });

  it("a rehearsal sprint that still has an old root issue is not given a new one, and nothing is opened under it", async () => {
    const w = world({ sprints: [sprintFor("rehearsal", { root_issue_id: "old-root" })], tasks: planTasks("sp-rehearsal"), issues: { "old-root": "cancelled" } });
    const result = await daily(w, "sp-rehearsal");
    expect(result.issuesOpened).toBe(0);
    expect(w.created).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Every path that opens an issue for a sprint
// ---------------------------------------------------------------------------

describe("every path that opens an issue", () => {
  async function context(w: World, id: string) {
    const info = await companyInfo(w.env, "co-1");
    const sprint = (await db.getSprint(w.env.ctx.db, "co-1", id))!;
    return { info, sprint, day: 32, agent: AGENT, projectId: "proj-seo" };
  }

  it("materialiseDueTasks opens nothing for a rehearsal sprint, even one that has a root issue, and says nothing is wrong", async () => {
    const w = world({ sprints: [sprintFor("rehearsal", { root_issue_id: "old-root" })], tasks: planTasks("sp-rehearsal") });
    expect(await materialiseDueTasks(w.env, await context(w, "sp-rehearsal"))).toEqual({ created: 0, remaining: 0, errors: [] });
    expect(w.created).toEqual([]);
    // Without a root issue the real sprint says so; a rehearsal sprint never needs one.
    const noRoot = world({ sprints: [sprintFor("rehearsal")], tasks: planTasks("sp-rehearsal") });
    expect((await materialiseDueTasks(noRoot.env, await context(noRoot, "sp-rehearsal"))).errors).toEqual([]);
  });

  it("materialiseDueTasks opens the due tasks of a real sprint (the control)", async () => {
    const w = world({ sprints: [sprintFor("real", { root_issue_id: "root-1" })], tasks: planTasks("sp-real") });
    const result = await materialiseDueTasks(w.env, await context(w, "sp-real"));
    expect(result.created).toBeGreaterThan(0);
    expect(w.created.filter((c) => /:task$/.test(String(c.input.originKind)))).toHaveLength(result.created);
  });

  it("createTaskIssue opens no issue and no Needs you line for a task of a rehearsal sprint, a person's or the agent's", async () => {
    const w = world({ sprints: [sprintFor("rehearsal", { root_issue_id: "old-root" })], tasks: planTasks("sp-rehearsal") });
    const c = await context(w, "sp-rehearsal");
    for (const id of ["sp-rehearsal-meta", "sp-rehearsal-gbp", "sp-rehearsal-code"]) {
      expect(await createTaskIssue(w.env, c, (await db.getTask(w.env.ctx.db, "co-1", id))!)).toBeNull();
    }
    expect(w.created).toEqual([]);
    expect(needsYouWrites(w)).toEqual([]);
    expect(w.store.tasks.every((t) => t.issue_id == null && t.status === "not_started")).toBe(true);
  });

  it("a person's task and a task that waits for the repo link reach the Needs you list for a real sprint, not for a rehearsal (the control)", async () => {
    const real = world({ sprints: [sprintFor("real", { root_issue_id: "root-1" })], tasks: planTasks("sp-real") });
    const c = await context(real, "sp-real");
    await createTaskIssue(real.env, c, (await db.getTask(real.env.ctx.db, "co-1", "sp-real-gbp"))!);
    expect(needsYouWrites(real).length).toBeGreaterThan(0);
    const rehearsal = world({ sprints: [sprintFor("rehearsal", { root_issue_id: "old-root" })], tasks: planTasks("sp-rehearsal") });
    const r = await context(rehearsal, "sp-rehearsal");
    await createTaskIssue(rehearsal.env, r, (await db.getTask(rehearsal.env.ctx.db, "co-1", "sp-rehearsal-gbp"))!);
    expect(needsYouWrites(rehearsal)).toEqual([]);
  });

  it("addNeedsYou records nothing and opens no issue for a rehearsal sprint, whoever raises the line", async () => {
    const item = { key: "service_account", kind: "grant", title: "Add the Google key", why: "Search Console needs it", steps: [], links: [], after: "carries on", check: "manual" as const, taskIds: [] };
    const w = world({ sprints: [sprintFor("rehearsal")] });
    const info = await companyInfo(w.env, "co-1");
    const sprint = (await db.getSprint(w.env.ctx.db, "co-1", "sp-rehearsal"))!;
    expect(await addNeedsYou(w.env, info, sprint, item as never)).toEqual({ issueId: null, added: false, key: "service_account" });
    expect(needsYouWrites(w)).toEqual([]);
    expect(w.created).toEqual([]);
    // The control: the same line on a real sprint is recorded and opens the owner's weekly issue.
    const real = world({ sprints: [sprintFor("real")] });
    const realSprint = (await db.getSprint(real.env.ctx.db, "co-1", "sp-real"))!;
    const out = await addNeedsYou(real.env, info, realSprint, item as never);
    expect(out.added).toBe(true);
    expect(needsYouWrites(real).length).toBeGreaterThan(0);
    expect(real.created).toHaveLength(1);
    expect(real.created[0]!.input.originKind).toBe("plugin:partnersinbiz.seo:needs-you");
  });

  it("start-tasks-now, request-build and add-redesign refuse for a rehearsal sprint and open nothing", async () => {
    const w = world({ sprints: [sprintFor("rehearsal", { root_issue_id: "old-root" })], tasks: planTasks("sp-rehearsal") });
    await expect(startTasksNow(w.env, "co-1", user, { sprintId: "sp-rehearsal", week: 0 })).rejects.toThrow(REHEARSAL_REFUSAL);
    await expect(requestBuild(w.env, "co-1", user, { sprintId: "sp-rehearsal", taskId: "sp-rehearsal-code", summary: "s", changeSet: "c" })).rejects.toThrow(REHEARSAL_REFUSAL);
    await expect(addRedesign(w.env, "co-1", user, { sprintId: "sp-rehearsal", pageUrl: "/about", goal: "g" })).rejects.toThrow(REHEARSAL_REFUSAL);
    expect(w.created).toEqual([]);
    expect(w.wakeups).toEqual([]);
    expect(w.store.tasks.every((t) => t.issue_id == null)).toBe(true);
  });

  it("start-tasks-now still starts a real sprint's tasks (the control)", async () => {
    const w = world({ sprints: [sprintFor("real", { root_issue_id: "root-1" })], tasks: planTasks("sp-real") });
    const result = (await startTasksNow(w.env, "co-1", user, { sprintId: "sp-real", week: 12 })) as { started: number; issuesOpened: number };
    expect(result.started).toBe(1);
    expect(w.created.length).toBe(result.issuesOpened);
  });

  it("openIssue itself refuses a rehearsal sprint, so a path that was missed fails closed instead of opening it", async () => {
    const w = world();
    const base = { companyId: "co-1", title: "SEO W0: anything", description: "d", originKind: "plugin:partnersinbiz.seo:task" as const, originId: "seo:task:x", assigneeUserId: "user-peet" };
    await expect(openIssue(w.env, { ...base, sprint: { siteUrl: "https://canary.invalid", clientRef: null } })).rejects.toThrow(SeoError);
    await expect(openIssue(w.env, { ...base, sprint: { siteUrl: "https://agristudies.co.za", clientRef: CANARY_ID } })).rejects.toThrow(/rehearsal sprint/);
    expect(w.created).toEqual([]);
    const ok = await openIssue(w.env, { ...base, sprint: { siteUrl: "https://agristudies.co.za", clientRef: REAL_ID } });
    expect(ok).toMatchObject({ assigned: "user" });
    expect(w.created).toHaveLength(1);
  });
});

describe("an issue a rehearsal sprint was left with", () => {
  /** A sprint list answer and an unassigned agent task with an open issue, as a run before 0.23.2 left them. */
  const left = (kind: "rehearsal" | "real") => {
    const id = kind === "rehearsal" ? "sp-rehearsal" : "sp-real";
    const rows = [sprintFor(kind, { root_issue_id: "i-root" })];
    const w = world({
      sprints: rows,
      tasks: [{ ...planTasks(id)[0]!, issue_id: "i-1", issue_status: "todo", assignee_kind: "unassigned" }],
      routes: [[/FROM plugin_seo_8099f8879a\.sprints WHERE company_id = \$1/, () => rows]] as never,
      issues: { "i-1": "todo" },
    });
    w.ctx.issues.get = (async (issueId: string) => ({ id: issueId, status: "todo", identifier: "PIB-1", assigneeAgentId: null, assigneeUserId: null })) as never;
    return w;
  };

  it("is not handed to the SEO agent when one is linked, and not woken (a real sprint's is: the control)", async () => {
    const real = left("real");
    expect(await adoptUnassignedAgentTasks(real.env, "co-1", AGENT)).toBe(1);
    expect(real.updates).toEqual([{ id: "i-1", patch: { assigneeAgentId: "agent-1", status: "todo" } }]);
    expect(real.wakeups).toEqual(["i-1"]);
    const rehearsal = left("rehearsal");
    expect(await adoptUnassignedAgentTasks(rehearsal.env, "co-1", AGENT)).toBe(0);
    expect(rehearsal.updates).toEqual([]);
    expect(rehearsal.wakeups).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Weekly proposals and the Social hand-off
// ---------------------------------------------------------------------------

describe("the weekly review and the Social hand-off", () => {
  const LIVE_PAGE: Row = { id: "c1", company_id: "co-1", sprint_id: "sp-x", title: "VAT guide", type: "post", status: "live", target_url: "https://acme.co.za/blog/vat-guide", published_on: "2026-09-01", impressions: 0, social_post_ids: [], links_to_pillar_ids: [] };
  const GSC = [[/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("gsc", { status: "connected", last_pull_at: "2026-10-03T06:00:00Z" })]]] as Route[];
  const proposalRoutes = (sprintId: string) => [
    [/FROM plugin_seo_8099f8879a\.content/, () => [{ ...LIVE_PAGE, sprint_id: sprintId }]],
    [/count\(\*\)::int AS count FROM plugin_seo_8099f8879a\.optimizations/, () => [{ count: 0 }]],
    [/FROM plugin_seo_8099f8879a\.optimizations WHERE id = \$1 AND company_id = \$2/, (p: unknown[]) => [{ id: p[0], company_id: "co-1", sprint_id: sprintId, signal_type: "zero_impression_content", severity: "medium", subject: "c1", evidence: {}, hypothesis: "The page earned no impressions", hypothesis_type: "title", proposed_action: "Rewrite the title", proposed_tasks: [{ title: "Rewrite the title" }], target_keyword_ids: [], status: "proposed", approval_issue_id: null }]],
  ] as never;

  it("a real sprint with a page that earned nothing gets a proposal and an approval issue for the owner (the control)", async () => {
    const w = world({ sprints: [sprintFor("real", { root_issue_id: "root-1" })], routes: [...GSC, ...proposalRoutes("sp-real")] });
    const info = await companyInfo(w.env, "co-1");
    const result = await detectSignals(w.env, info, (await db.getSprint(w.env.ctx.db, "co-1", "sp-real"))!, { propose: true });
    expect(result.proposalsCreated).toHaveLength(1);
    expect(w.created).toHaveLength(1);
    expect(w.created[0]!.input.originKind).toBe("plugin:partnersinbiz.seo:approval");
  });

  it("a rehearsal sprint with the same page proposes nothing and opens no approval issue", async () => {
    const w = world({ sprints: [sprintFor("rehearsal", { root_issue_id: "root-1" })], routes: [...GSC, ...proposalRoutes("sp-rehearsal")] });
    const info = await companyInfo(w.env, "co-1");
    const result = await detectSignals(w.env, info, (await db.getSprint(w.env.ctx.db, "co-1", "sp-rehearsal"))!, { propose: true });
    expect(result.proposalsCreated).toEqual([]);
    expect(executed(w, /INSERT INTO plugin_seo_8099f8879a\.optimizations/)).toEqual([]);
    expect(w.created).toEqual([]);
    // The weekly run itself too.
    const weekly = await runWeeklyForSprint(w.env, info, (await db.getSprint(w.env.ctx.db, "co-1", "sp-rehearsal"))!);
    expect(weekly.proposalsCreated).toEqual([]);
    expect(w.created).toEqual([]);
  });

  it("the weekly job works a real sprint and skips a rehearsal sprint of the same company", async () => {
    const rows = [sprintFor("rehearsal", { root_issue_id: "root-1" }), sprintFor("real", { root_issue_id: "root-2" })];
    const w = world({
      sprints: rows,
      routes: [
        [/WHERE status IN \('pre_launch', 'active', 'compounding'\) AND seeded_at IS NOT NULL/, () => rows],
        ...GSC,
        ...proposalRoutes("sp-real"),
      ] as never,
    });
    const result = await runWeeklyJob(w.env, { force: true });
    expect(result).toEqual({ processed: 1, proposals: 1, errors: [] });
    expect(w.created).toHaveLength(1);
    expect(w.created[0]!.input.title).toMatch(/Agri Studies/);
  });

  async function handoff(kind: "rehearsal" | "real") {
    const id = kind === "rehearsal" ? "sp-rehearsal" : "sp-real";
    const w = world({ sprints: [sprintFor(kind)], routes: [[/FROM plugin_seo_8099f8879a\.content WHERE id = \$1/, (p: unknown[]) => [{ ...LIVE_PAGE, id: p[0], sprint_id: id, task_id: null }]]] as never });
    const emit = vi.fn(async () => undefined);
    (w.ctx.events as unknown as { emit: unknown }).emit = emit;
    const now = () => new Date("2026-10-03T08:00:00Z");
    const env = createEnv(w.ctx, { now, announcements: memoryAnnouncements(now), site: (async (url: string) => ({ status: 200, url, redirects: [], headers: {}, text: "<html><head><title>VAT guide</title><meta name=\"description\" content=\"What a small business needs to know about VAT in South Africa this year.\"></head><body></body></html>", ms: 1 })) as never });
    return { result: await contentWentLive(env, "co-1", "c1"), emit };
  }

  it("a live page of a real sprint is announced to Social once it answers 200 (the control)", async () => {
    const { result, emit } = await handoff("real");
    expect(result).toMatchObject({ status: "sent" });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("a live page of a rehearsal sprint is dropped: Social is never told", async () => {
    const { result, emit } = await handoff("rehearsal");
    expect(result).toMatchObject({ status: "dropped", reason: expect.stringContaining("rehearsal sprint") });
    expect(emit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// archive-sprint
// ---------------------------------------------------------------------------

describe("archive-sprint", () => {
  /** A sprint with an issue of every kind the plugin opens for one, as an older run left them. */
  function leftovers(kind: "rehearsal" | "real") {
    const id = kind === "rehearsal" ? "sp-rehearsal" : "sp-real";
    const task = (n: string, extra: Row) => ({ ...planTasks(id)[0]!, id: `${id}-${n}`, template_key: `k-${n}`, sprint_id: id, ...extra });
    return world({
      sprints: [sprintFor(kind, { root_issue_id: "i-root", root_issue_identifier: "PIB-1" })],
      tasks: [
        task("todo", { issue_id: "i-todo", issue_status: "todo", status: "not_started", assignee_kind: "user" }),
        task("busy", { issue_id: "i-busy", issue_status: "in_progress", status: "in_progress", assignee_kind: "agent" }),
        task("done", { issue_id: "i-done", issue_status: "done", status: "done" }),
        task("gone", { issue_id: "i-gone", issue_status: "cancelled", status: "skipped" }),
        task("build", { issue_id: "i-parent", issue_status: "todo", status: "in_progress", evidence: { builds: [{ issueId: "i-build", agentId: "agent-9", at: "2026-10-03T06:00:00Z" }] } }),
        task("none", { issue_id: null, status: "not_started" }),
      ],
      chunks: [{ id: "ch-1", company_id: "co-1", sprint_id: id, task_id: `${id}-busy`, parent_issue_id: "i-busy", seq: 1, total: 2, label: "Pages 1-20", urls: ["https://x/1"], status: "open", issue_id: "i-chunk", issue_identifier: "PIB-7", opened_at: "2026-10-03T06:00:00Z", done_at: null }],
      needsYouRecent: [{ id: "ny-1", company_id: "co-1", sprint_id: id, week_start: "2026-09-28", issue_id: "i-needs", issue_identifier: "PIB-9", items: [], status: "open" }],
      optimizations: [{ id: "o-1", company_id: "co-1", sprint_id: id, signal_type: "x", status: "proposed", approval_issue_id: "i-approval" }],
      previewReviews: ["i-review"],
      issues: { "i-root": "todo", "i-todo": "todo", "i-busy": "in_progress", "i-done": "done", "i-gone": "cancelled", "i-parent": "blocked", "i-build": "todo", "i-chunk": "todo", "i-needs": "todo", "i-approval": "in_review", "i-review": "todo" },
    });
  }

  it("on a rehearsal sprint closes every issue of it that is still open, the root last, and leaves finished ones alone", async () => {
    const w = leftovers("rehearsal");
    const result = (await setSprintStatus(w.env, "co-1", { kind: "agent", agentId: "agent-acc", runId: "r", responsibleUserId: null }, { sprintId: "sp-rehearsal" }, "archived")) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "archived", rehearsal: true, issuesCancelled: 9 });
    const closed = cancelled(w);
    expect([...closed].sort()).toEqual(["i-approval", "i-build", "i-busy", "i-chunk", "i-needs", "i-parent", "i-review", "i-root", "i-todo"]);
    expect(w.updates.every((u) => Object.keys(u.patch).join() === "status")).toBe(true);
    expect(closed).not.toContain("i-done");
    expect(closed).not.toContain("i-gone");
    // The sprint is archived, nothing is posted and nothing is created or woken.
    expect(executed(w, /UPDATE plugin_seo_8099f8879a\.sprints SET/).some((e) => e.params.includes("archived"))).toBe(true);
    expect(w.comments).toEqual([]);
    expect(w.created).toEqual([]);
    expect(w.wakeups).toEqual([]);
    // The rows follow their issues: an open task is skipped, a finished one stays, a task without an issue is untouched.
    const status = (n: string) => w.store.tasks.find((t) => t.id === `sp-rehearsal-${n}`)!;
    expect(status("todo")).toMatchObject({ status: "skipped", issue_status: "cancelled", blocker_reason: "Rehearsal sprint archived" });
    expect(status("busy")).toMatchObject({ status: "skipped", issue_status: "cancelled" });
    expect(status("done")).toMatchObject({ status: "done", issue_status: "done" });
    expect(status("none")).toMatchObject({ status: "not_started", issue_id: null });
    expect(w.store.chunks[0]).toMatchObject({ status: "cancelled" });
  });

  it("closes the children before the issue they hang under", async () => {
    const w = leftovers("rehearsal");
    await setSprintStatus(w.env, "co-1", user, { sprintId: "sp-rehearsal" }, "archived");
    const order = cancelled(w);
    expect(order.at(-1)).toBe("i-root");
    expect(order.indexOf("i-todo")).toBeLessThan(order.indexOf("i-root"));
    expect(new Set(order).size).toBe(order.length); // each issue once
  });

  it("is best effort: an issue the host will not close does not stop the others or the archive", async () => {
    const w = leftovers("rehearsal");
    const update = w.ctx.issues.update as unknown as ReturnType<typeof vi.fn>;
    update.mockImplementation(async (id: string, patch: Row) => {
      if (id === "i-todo") throw new Error("host says no");
      w.updates.push({ id, patch });
      return { id, ...patch };
    });
    const result = (await setSprintStatus(w.env, "co-1", user, { sprintId: "sp-rehearsal" }, "archived")) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "archived", rehearsal: true, issuesCancelled: 8 });
    expect(cancelled(w)).toContain("i-root");
    expect(cancelled(w)).not.toContain("i-todo");
  });

  it("is best effort when a list of issue ids cannot be read: the others are still closed and the archive stands", async () => {
    const w = leftovers("rehearsal");
    w.routes.unshift([/FROM plugin_seo_8099f8879a\.optimizations WHERE company_id = \$1 AND sprint_id = \$2/, () => { throw new Error("the database hiccuped"); }]);
    const result = (await setSprintStatus(w.env, "co-1", user, { sprintId: "sp-rehearsal" }, "archived")) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "archived", rehearsal: true, issuesCancelled: 8 });
    expect(cancelled(w)).not.toContain("i-approval");
    expect(cancelled(w)).toContain("i-review");
    expect(cancelled(w).at(-1)).toBe("i-root");
  });

  it("is best effort when a row cannot be written: the issue stays closed, the others are still closed and the count is right", async () => {
    const w = leftovers("rehearsal");
    const execute = w.ctx.db.execute.bind(w.ctx.db);
    w.ctx.db.execute = async (sql: string, params: unknown[] = []) => {
      if (/^UPDATE plugin_seo_8099f8879a\.(sprint_tasks|task_chunks) SET/.test(sql)) throw new Error("the database hiccuped");
      return execute(sql, params);
    };
    const result = (await setSprintStatus(w.env, "co-1", user, { sprintId: "sp-rehearsal" }, "archived")) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "archived", rehearsal: true, issuesCancelled: 9 });
    expect(cancelled(w).at(-1)).toBe("i-root");
  });

  it("on a real sprint is unchanged: a comment on the root issue, no issue closed, no task changed", async () => {
    const w = leftovers("real");
    const before = JSON.parse(JSON.stringify(w.store.tasks));
    const result = (await setSprintStatus(w.env, "co-1", user, { sprintId: "sp-real", reason: "contract ended" }, "archived")) as Record<string, unknown>;
    expect(result).toEqual({ sprintId: "sp-real", status: "archived", previous: "active" });
    expect(w.updates).toEqual([]);
    expect(w.comments).toEqual([{ id: "i-root", body: "Sprint archived by user user-peet: contract ended." }]);
    expect(w.store.tasks).toEqual(before);
    expect(w.store.chunks[0]).toMatchObject({ status: "open" });
  });

  it("pausing a rehearsal sprint is the same as pausing any sprint: nothing is cancelled", async () => {
    const w = leftovers("rehearsal");
    const result = (await setSprintStatus(w.env, "co-1", user, { sprintId: "sp-rehearsal" }, "paused")) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "paused", rehearsal: true });
    expect(result).not.toHaveProperty("issuesCancelled");
    expect(w.updates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// What the agent reads
// ---------------------------------------------------------------------------

describe("what the agent and the page read", () => {
  it("get-sprint and today say a sprint is a rehearsal, and a real sprint says nothing", async () => {
    const w = world({ sprints: [sprintFor("rehearsal"), sprintFor("real")], tasks: [...planTasks("sp-rehearsal"), ...planTasks("sp-real")] });
    const info = await companyInfo(w.env, "co-1");
    const rehearsal = (await db.getSprint(w.env.ctx.db, "co-1", "sp-rehearsal"))!;
    const real = (await db.getSprint(w.env.ctx.db, "co-1", "sp-real"))!;
    expect(sprintView(rehearsal, info.today)).toMatchObject({ rehearsal: true });
    expect(sprintView(real, info.today)).not.toHaveProperty("rehearsal");
    const asked = await sprintToday(w.env, info, rehearsal);
    expect(asked).toMatchObject({ rehearsal: true });
    expect(asked.next[0]).toBe(REHEARSAL_NOTE);
    expect(await sprintToday(w.env, info, real)).not.toHaveProperty("rehearsal");
  });

  it("today without a sprintId leaves a rehearsal sprint out of the plan the daily routine works from, and with its id shows it", async () => {
    const rows = [sprintFor("rehearsal"), sprintFor("real")];
    const w = world({ sprints: rows, tasks: [...planTasks("sp-rehearsal"), ...planTasks("sp-real")], routes: [[/FROM plugin_seo_8099f8879a\.sprints WHERE company_id = \$1/, () => rows]] as never });
    const all = (await todayTool(w.env, "co-1", {})) as { sprints: Array<{ sprintId: string }> };
    expect(all.sprints.map((s) => s.sprintId)).toEqual(["sp-real"]);
    const one = (await todayTool(w.env, "co-1", { sprintId: "sp-rehearsal" })) as { sprints: Array<{ sprintId: string; rehearsal?: boolean }> };
    expect(one.sprints.map((s) => s.sprintId)).toEqual(["sp-rehearsal"]);
    expect(one.sprints[0]!.rehearsal).toBe(true);
  });
});

describe("a pull request that needs the Reviewer", () => {
  const item = { key: "pr:1", title: "Merge the schema change", why: "It is outside the SEO scope", steps: ["Merge it"], links: [] };
  const withReviewer = (kind: "rehearsal" | "real") => {
    const w = world({ sprints: [sprintFor(kind)] });
    (w.state as Map<string, unknown>).set("roles", { companyId: "co-1", operatorAgentId: null, reviewerAgentId: "agent-reviewer", ownerUserId: "user-peet", reviewOutward: true, reviewerStatus: "idle", updatedAt: "" });
    return w;
  };

  it("opens a review issue for the Reviewer on a real sprint (the control) and none on a rehearsal sprint", async () => {
    const real = withReviewer("real");
    const id = await routePrReview(real.env, (await db.getSprint(real.env.ctx.db, "co-1", "sp-real"))!, item as never);
    expect(id).toBe("issue-101");
    expect(real.created[0]!.input).toMatchObject({ assigneeAgentId: "agent-reviewer", originKind: "plugin:partnersinbiz.seo:approval" });
    const rehearsal = withReviewer("rehearsal");
    expect(await routePrReview(rehearsal.env, (await db.getSprint(rehearsal.env.ctx.db, "co-1", "sp-rehearsal"))!, item as never)).toBeNull();
    expect(rehearsal.created).toEqual([]);
    expect(rehearsal.wakeups).toEqual([]);
  });
});

describe("the acceptance journey seo-sprint-draft, through the tool dispatcher", () => {
  const acceptance: Actor = { kind: "agent", agentId: "agent-acceptance", runId: "run-1", responsibleUserId: "user-peet" };

  it("creates the sprint, adds a keyword, reads the tasks and archives it: nothing is opened, nobody is woken, the reads work", async () => {
    const w = world();
    const made = (await dispatch(w.env, "co-1", acceptance, "create-sprint", {
      siteUrl: "https://canary.invalid",
      client: `company:${CANARY_ID}`,
      siteName: "PiB Canary Co",
      businessType: "professional",
      startDate: "2027-12-01",
      autopilotMode: "off",
      notes: "Acceptance run: fixture site, nothing is crawled or changed.",
    })) as { sprintId: string; issuesOpened: number; rehearsal: boolean; rootIssueId: string | null; warnings: string[] };
    expect(made).toMatchObject({ issuesOpened: 0, rehearsal: true, rootIssueId: null, warnings: [] });
    await dispatch(w.env, "co-1", acceptance, "add-keywords", { sprintId: made.sprintId, keywords: ["canary rehearsal"] });
    const tasks = (await dispatch(w.env, "co-1", acceptance, "list-tasks", { sprintId: made.sprintId })) as { tasks?: unknown[]; count?: number };
    expect(JSON.stringify(tasks).length).toBeGreaterThan(1000);
    expect((tasks.tasks ?? []).length).toBeGreaterThan(30);
    const archived = (await dispatch(w.env, "co-1", acceptance, "archive-sprint", { sprintId: made.sprintId })) as Record<string, unknown>;
    expect(archived).toMatchObject({ status: "archived", rehearsal: true, issuesCancelled: 0 });
    expect(w.created).toEqual([]);
    expect(w.updates).toEqual([]);
    expect(w.comments).toEqual([]);
    expect(w.wakeups).toEqual([]);
    expect(needsYouWrites(w)).toEqual([]);
    expect(w.siteCalls).toEqual([]);
    expect(w.googleCalls).toEqual([]);
  });

  it("the same calls for a real client open the root issue and the due tasks (the control)", async () => {
    const w = world();
    const made = (await dispatch(w.env, "co-1", acceptance, "create-sprint", { siteUrl: "https://agristudies.co.za", client: `company:${REAL_ID}`, businessType: "professional", autopilotMode: "off" })) as { issuesOpened: number; rootIssueId: string | null };
    expect(made.rootIssueId).toBe("issue-101");
    expect(made.issuesOpened).toBeGreaterThan(0);
    expect(made).not.toHaveProperty("rehearsal");
  });
});
