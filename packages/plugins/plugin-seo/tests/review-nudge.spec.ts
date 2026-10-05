/**
 * A preview that nobody has reviewed for 30 minutes is nudged (found on Agri Studies 2026-10-05: the Reviewer's run lost its tools
 * while the SEO plugin reloaded, handed the issue to another agent that also lacked them, and nothing ever retried).
 */
import { describe, expect, it } from "vitest";
import { nudgeStalledReviews, reviveOrphanedChanges, REVIEW_MAX_NUDGES } from "../src/service/preview.js";
import { sprintFor, world } from "./helpers/rehearsal-world.js";
import { executed, taskRow, type Route, type Row } from "./helpers/seo-host.js";

const row = (extra: Row = {}): Row => ({ id: "p1", company_id: "co-1", sprint_id: "sp-real", task_id: "t1", page_url: "https://agristudies.co.za/product/farm/", title: "Farm machinery", review_issue_id: "rev-1", stats: {}, ...extra });
const routes = (rows: Row[]): Route[] => [[/FROM plugin_seo_8099f8879a\.previews\s+WHERE review_status = 'pending' AND review_issue_id IS NOT NULL/, () => rows]];
const sprint = () => sprintFor("real", { root_issue_id: "root-1", status: "active" });

describe("stalled reviews", () => {
  it("reopens the review for the Reviewer, wakes it, comments once and counts the try", async () => {
    const w = world({ sprints: [sprint()], routes: routes([row()]) });
    expect(await nudgeStalledReviews(w.env)).toBe(1);
    expect(w.updates.some((u) => u.id === "rev-1" && u.patch.status === "todo")).toBe(true);
    expect(w.wakeups).toContain("rev-1");
    expect(w.comments.find((c) => c.id === "rev-1")!.body).toMatch(/attempt 1 of 3[\s\S]*review-preview/);
    expect(executed(w, /SET stats = stats \|\| \$2::jsonb/)[0]!.params[1]).toContain('"reviewNudges":1');
  });

  it("waits between tries and stops after the last one, asking the owner once", async () => {
    const recent = world({ sprints: [sprint()], routes: routes([row({ stats: { reviewNudges: 1, reviewNudgedAt: "2026-10-03T07:50:00Z" } })]) });
    expect(await nudgeStalledReviews(recent.env)).toBe(0);
    const done = world({ sprints: [sprint()], routes: routes([row({ stats: { reviewNudges: REVIEW_MAX_NUDGES, reviewNudgedAt: "2026-10-01T00:00:00Z" } })]) });
    expect(await nudgeStalledReviews(done.env)).toBe(0);
    const last = world({ sprints: [sprint()], routes: routes([row({ stats: { reviewNudges: REVIEW_MAX_NUDGES - 1, reviewNudgedAt: "2026-10-01T00:00:00Z" } })]) });
    expect(await nudgeStalledReviews(last.env)).toBe(1);
    expect(JSON.stringify(last.needsYou.at(-1)!.items)).toContain("has waited for the Reviewer through 3 tries");
  });

  it("leaves a paused sprint alone", async () => {
    const w = world({ sprints: [sprintFor("real", { root_issue_id: "root-1", status: "paused" })], routes: routes([row()]) });
    expect(await nudgeStalledReviews(w.env)).toBe(0);
    expect(w.wakeups).toEqual([]);
  });
});

describe("pages the Reviewer sent back with nobody on them", () => {
  const changed = (extra: Row = {}): Row => ({ id: "p9", company_id: "co-1", sprint_id: "sp-real", task_id: "t1", page_url: "https://agristudies.co.za/product/animal-health/", review_note: "Remove the unapproved claim.", stats: {}, ...extra });
  const orphanRoutes = (rows: Row[]): Route[] => [[/FROM \(\s*SELECT DISTINCT ON \(sprint_id, page_url\)/, () => rows]];
  const parked = (extra: Row = {}) => taskRow({ id: "t1", sprint_id: "sp-real", template_key: "w3-products", week: 3, status: "blocked", issue_id: "iss-1", assignee_kind: "client", due_day: 6, ...extra });

  it("takes a parked task back to the agent, lists the pages with the Reviewer's reasons and wakes the agent once", async () => {
    const w = world({ sprints: [sprint()], tasks: [parked()], routes: orphanRoutes([changed(), changed({ id: "p10", page_url: "https://agristudies.co.za/product/national-cert/", review_note: "Two H1s." })]) });
    expect(await reviveOrphanedChanges(w.env)).toBe(1);
    expect(w.store.tasks[0]).toMatchObject({ status: "in_progress", assignee_kind: "agent", blocker_reason: null });
    expect(w.wakeups).toEqual(["iss-1"]);
    const body = w.comments.find((c) => c.id === "iss-1")!.body;
    expect(body).toContain("animal-health");
    expect(body).toContain("Two H1s.");
    expect(body).toMatch(/pages that already passed stay as they are/);
    expect(executed(w, /SET stats = stats \|\| \$2::jsonb/)).toHaveLength(2);
  });

  it("leaves a page alone when the agent has the task, a developer fix of that page is open, or it was tried three times", async () => {
    const withAgent = world({ sprints: [sprint()], tasks: [parked({ status: "in_progress", assignee_kind: "agent" })], routes: orphanRoutes([changed()]) });
    expect(await reviveOrphanedChanges(withAgent.env)).toBe(0);
    const fix = { builds: [{ issueId: "fix-9", agentId: "dev-1", at: "x", kind: "preview-fix", level: "developer", pageUrl: "https://agristudies.co.za/product/animal-health/" }] };
    const fixing = world({ sprints: [sprint()], tasks: [parked({ evidence: fix })], routes: orphanRoutes([changed()]) });
    expect(await reviveOrphanedChanges(fixing.env)).toBe(0);
    const tired = world({ sprints: [sprint()], tasks: [parked()], routes: orphanRoutes([changed({ stats: { revivals: 3, revivedAt: "2026-10-01T00:00:00Z" } })]) });
    expect(await reviveOrphanedChanges(tired.env)).toBe(0);
    expect(tired.wakeups).toEqual([]);
  });
});

describe("a corrected preview made without a taskId", () => {
  it("belongs to the task the page's earlier preview belonged to (a developer's fix would otherwise detach from the task)", async () => {
    const { createPreview } = await import("../src/service/preview.js");
    const live = `<html><head><title>Old</title></head><body><h1>Old</h1><main><div class="entry-content">${"<p>course words here </p>".repeat(40)}</div></main></body></html>`;
    const w = world({
      sprints: [sprint()],
      tasks: [taskRow({ id: "t1", sprint_id: "sp-real", template_key: "w3-products", week: 3, status: "in_progress", issue_id: "iss-1", assignee_kind: "agent", due_day: 6 })],
      routes: [[/SELECT task_id FROM plugin_seo_8099f8879a\.previews WHERE company_id = \$1 AND sprint_id = \$2 AND page_url = \$3 AND task_id IS NOT NULL/, () => [{ task_id: "t1" }]]],
    });
    (w.env as unknown as { site: unknown }).site = async (url: string) => ({ status: 200, url, redirects: [], headers: {}, text: live, ms: 1 });
    await createPreview(w.env, "co-1", { kind: "agent", agentId: "dev-1", runId: "r", responsibleUserId: null }, { sprintId: "sp-real", pageUrl: "https://agristudies.co.za/product/beekeeping-course/", h1: "Beekeeping", bodyHtml: "<p>Learn how to keep bees through the seasons.</p>" });
    const insert = executed(w, /INSERT INTO plugin_seo_8099f8879a\.previews/)[0]!;
    expect(insert.params[3]).toBe("t1");
    expect(insert.params[4]).toBe("iss-1");
  });
});

describe("a task handed to the agent that nobody picks up", () => {
  it("wakes the agent again when the issue sits in todo with no run, at most four times, 25 minutes apart", async () => {
    const { nudgeIdleAgentTasks } = await import("../src/service/tasks.js");
    const idle = (evidence: Row | null = null): Row => ({ id: "t1", company_id: "co-1", issue_id: "iss-1", evidence });
    const route = (rows: Row[]): Route[] => [[/FROM plugin_seo_8099f8879a\.sprint_tasks t JOIN plugin_seo_8099f8879a\.sprints s ON s\.id = t\.sprint_id\s+WHERE s\.status = 'active' AND t\.status = 'in_progress' AND t\.assignee_kind = 'agent'/, () => rows]];
    const w = world({ sprints: [sprint()], tasks: [taskRow({ id: "t1", sprint_id: "sp-real", status: "in_progress", assignee_kind: "agent", issue_id: "iss-1", issue_status: "todo" })], routes: route([idle()]) });
    expect(await nudgeIdleAgentTasks(w.env)).toBe(1);
    expect(w.wakeups).toEqual(["iss-1"]);
    expect(executed(w, /UPDATE plugin_seo_8099f8879a\.sprint_tasks SET evidence/)[0]!.params[0]).toContain('"idleNudges":1');
    const recent = world({ sprints: [sprint()], routes: route([idle({ idleNudges: 1, idleNudgedAt: "2026-10-03T07:50:00Z" })]) });
    expect(await nudgeIdleAgentTasks(recent.env)).toBe(0);
    const tired = world({ sprints: [sprint()], routes: route([idle({ idleNudges: 4, idleNudgedAt: "2026-10-01T00:00:00Z" })]) });
    expect(await nudgeIdleAgentTasks(tired.env)).toBe(0);
    // A run is already queued or running on the issue: leave it alone.
    const running = world({ sprints: [sprint()], routes: [...route([idle()]), [/FROM public\.heartbeat_runs r\s+WHERE r\.company_id = \$1 AND r\.status IN \('queued', 'running'\)/, () => [{ issue_id: "iss-1" }]]] });
    expect(await nudgeIdleAgentTasks(running.env)).toBe(0);
    expect(running.wakeups).toEqual([]);
  });
});

describe("a parked task keeps its issue blocked", () => {
  it("puts an in-progress issue of a task parked on the Reviewer or the client back to blocked (the host re-wakes in-progress issues every 30 seconds)", async () => {
    const { reblockParkedTasks } = await import("../src/service/tasks.js");
    const route: Route[] = [[/FROM plugin_seo_8099f8879a\.sprint_tasks t JOIN plugin_seo_8099f8879a\.sprints s ON s\.id = t\.sprint_id\s+WHERE s\.status = 'active' AND t\.assignee_kind IN \('reviewer', 'client'\)/, () => [{ id: "t1", company_id: "co-1", issue_id: "iss-1" }]]];
    const w = world({ sprints: [sprint()], tasks: [taskRow({ id: "t1", sprint_id: "sp-real", status: "in_progress", assignee_kind: "client", issue_id: "iss-1", issue_status: "in_progress" })], routes: route });
    expect(await reblockParkedTasks(w.env)).toBe(1);
    expect(w.updates.some((u) => u.id === "iss-1" && u.patch.status === "blocked")).toBe(true);
    expect(w.store.tasks[0]).toMatchObject({ status: "blocked", issue_status: "blocked" });
  });
});

describe("previews that never reached the client go stale", () => {
  it("withdraws a passed preview older than 48 hours that is in no draft and sends its task back to the agent to rebuild it", async () => {
    const { refreshStalePreviews } = await import("../src/service/preview.js");
    const route: Route[] = [[/FROM \(\s*SELECT DISTINCT ON \(sprint_id, page_url\) id, company_id, sprint_id, task_id, page_url, review_status, status, draft_key, created_at/, () => [{ id: "p1", company_id: "co-1", sprint_id: "sp-real", task_id: "t1", page_url: "https://huntandgun.co.za/" }]]];
    const auto = () => sprintFor("real", { root_issue_id: "root-1", status: "active", site_access: "wordpress", site_id: "s1", change_policy: "pr_only", client_signoff: "auto" });
    const w = world({ sprints: [auto()], tasks: [taskRow({ id: "t1", sprint_id: "sp-real", status: "blocked", assignee_kind: "client", issue_id: "iss-1", issue_status: "blocked" })], routes: route });
    expect(await refreshStalePreviews(w.env)).toBe(1);
    expect(executed(w, /UPDATE plugin_seo_8099f8879a\.previews SET expires_at = now\(\) WHERE id = \$1 AND status = 'pending'/)).toHaveLength(1);
    expect(w.store.tasks[0]).toMatchObject({ status: "in_progress", assignee_kind: "agent" });
    expect(w.comments.at(-1)!.body).toMatch(/withdrawn[\s\S]*CURRENT live page/);
    expect(w.wakeups).toContain("iss-1");
    // A sprint with manual sign-off is left alone (the control).
    const manual = world({ sprints: [sprintFor("real", { root_issue_id: "root-1", status: "active", client_signoff: "manual" })], tasks: [taskRow({ id: "t1", sprint_id: "sp-real", status: "blocked", assignee_kind: "client", issue_id: "iss-1" })], routes: route });
    expect(await refreshStalePreviews(manual.env)).toBe(0);
  });
});

describe("a task the host will not start a run on gets a fresh issue", () => {
  it("after three wakes with no run, cancels the stuck issue and opens a new one for the task (at most twice)", async () => {
    const { nudgeIdleAgentTasks } = await import("../src/service/tasks.js");
    const route = (evidence: Row): Route[] => [[/FROM plugin_seo_8099f8879a\.sprint_tasks t JOIN plugin_seo_8099f8879a\.sprints s ON s\.id = t\.sprint_id\s+WHERE s\.status = 'active' AND t\.status = 'in_progress' AND t\.assignee_kind = 'agent'/, () => [{ id: "t1", company_id: "co-1", issue_id: "iss-old", evidence }]]];
    const stuck = (evidence: Row, extra: Row = {}) => world({ sprints: [sprintFor("real", { root_issue_id: "root-1", status: "active", client_signoff: "auto", ...extra })], tasks: [taskRow({ id: "t1", sprint_id: "sp-real", template_key: "w1-robots", week: 1, due_day: 6, status: "in_progress", assignee_kind: "agent", issue_id: "iss-old", issue_status: "todo", evidence })], routes: route(evidence) });
    const w = stuck({ idleNudges: 3, idleNudgedAt: "2026-10-01T00:00:00Z", idleNudgeAnswer: "not queued" });
    expect(await nudgeIdleAgentTasks(w.env)).toBe(1);
    expect(w.updates.some((u) => u.id === "iss-old" && u.patch.status === "cancelled")).toBe(true);
    expect(w.comments.find((c) => c.id === "iss-old")!.body).toMatch(/Stuck:[\s\S]*new issue is opened/);
    expect(w.created.some((c) => String(c.input.originKind).endsWith(":task"))).toBe(true);
    const evidence = w.store.tasks[0]!.evidence as Record<string, unknown>;
    expect(evidence).toMatchObject({ reissues: 1, idleNudges: 0, previousIssueId: "iss-old" });
    expect(w.store.tasks[0]!.issue_id).not.toBe("iss-old");
    // The third time it stays with the nudges instead of looping (the control).
    const capped = stuck({ idleNudges: 3, idleNudgedAt: "2026-10-01T00:00:00Z", reissues: 2 });
    await nudgeIdleAgentTasks(capped.env);
    expect(capped.updates.some((u) => u.patch.status === "cancelled")).toBe(false);
    // A sprint on manual sign-off is not touched either.
    const manual = stuck({ idleNudges: 3, idleNudgedAt: "2026-10-01T00:00:00Z" }, { client_signoff: "manual" });
    await nudgeIdleAgentTasks(manual.env);
    expect(manual.updates.some((u) => u.patch.status === "cancelled")).toBe(false);
  });
});
