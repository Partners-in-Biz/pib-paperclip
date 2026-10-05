/**
 * Pacing (0.25.0). A sprint on manual pacing opens none of its plan tasks until a person presses Start on a week, while
 * everything else the daily and weekly runs do carries on. Each "nothing opens" test has the same sprint on automatic pacing
 * as its control, so a gate that is missing or too wide fails a test.
 */
import { describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { selectDueTasks } from "../src/engine/sprint.js";
import { isDueTask, taskState } from "../src/engine/due.js";
import { companyInfo, type Actor } from "../src/service/common.js";
import { dispatch, HANDLERS, UI_ONLY_HANDLERS } from "../src/dispatch.js";
import { runDailyForSprint, runWeeklyJob } from "../src/service/jobs.js";
import { createSprint, setPacing, sprintToday } from "../src/service/sprints.js";
import { materialiseDueTasks, openNextQueuedTask, startTasksNow } from "../src/service/tasks.js";
import { SEO_TOOLS } from "../src/tools.js";
import { planTasks, sprintFor, world } from "./helpers/rehearsal-world.js";
import { executed, integrationRow, taskRow, type Row } from "./helpers/seo-host.js";

const user: Actor = { kind: "user", userId: "user-peet" };
const agent: Actor = { kind: "agent", agentId: "agent-1", runId: "run-1", responsibleUserId: "user-peet" };
const AGENT = { id: "agent-1", status: "idle" };

const opened = (w: ReturnType<typeof world>) => w.created.filter((c) => /:task$/.test(String(c.input.originKind)));

async function context(w: ReturnType<typeof world>, id: string, day = 32) {
  const info = await companyInfo(w.env, "co-1");
  const sprint = (await db.getSprint(w.env.ctx.db, "co-1", id))!;
  return { info, sprint, day, agent: AGENT, projectId: "proj-seo" };
}

describe("held tasks in the pure rules", () => {
  it("a held task is never selected, never due and never late; the same task not held is", () => {
    const tasks = [{ id: "a", status: "not_started" as const, issueId: null, dueDay: 3, held: true }, { id: "b", status: "not_started" as const, issueId: null, dueDay: 3 }];
    expect(selectDueTasks(tasks, 40).map((t) => t.id)).toEqual(["b"]);
    expect(isDueTask({ status: "not_started", dueDay: 3, held: true }, 40)).toBe(false);
    expect(isDueTask({ status: "not_started", dueDay: 3, held: false }, 40)).toBe(true);
    expect(taskState({ status: "not_started", dueDay: 3, held: true, owner: "agent" }, 40)).toBe("upcoming");
  });
});

describe("manual pacing", () => {
  it("opens no plan task by the calendar (the automatic sprint is the control)", async () => {
    const manual = world({ sprints: [sprintFor("real", { root_issue_id: "root-1", pacing: "manual" })], tasks: planTasks("sp-real") });
    expect(await materialiseDueTasks(manual.env, await context(manual, "sp-real"))).toEqual({ created: 0, remaining: 0, errors: [] });
    expect(manual.created).toEqual([]);
    const auto = world({ sprints: [sprintFor("real", { root_issue_id: "root-1" })], tasks: planTasks("sp-real") });
    expect((await materialiseDueTasks(auto.env, await context(auto, "sp-real"))).created).toBeGreaterThan(0);
  });

  it("still opens a task that came from an approved proposal (it is not a plan task)", async () => {
    const w = world({
      sprints: [sprintFor("real", { root_issue_id: "root-1", pacing: "manual" })],
      tasks: [...planTasks("sp-real"), taskRow({ id: "opt-1", sprint_id: "sp-real", template_key: null, source: "optimization", title: "Rewrite the weak title", due_day: 32, week: 5 })],
    });
    const result = await materialiseDueTasks(w.env, await context(w, "sp-real"));
    expect(result.created).toBe(1);
    expect(w.store.tasks.find((t) => t.id === "opt-1")!.issue_id).toBeTruthy();
    expect(w.store.tasks.filter((t) => t.source === "template").every((t) => t.issue_id == null)).toBe(true);
  });

  it("does not hand the agent a held task as work today, and says why", async () => {
    const w = world({ sprints: [sprintFor("real", { root_issue_id: "root-1", pacing: "manual" })], tasks: planTasks("sp-real") });
    const info = await companyInfo(w.env, "co-1");
    const today = await sprintToday(w.env, info, (await db.getSprint(w.env.ctx.db, "co-1", "sp-real"))!);
    expect(today.due).toEqual([]);
    expect(today.next.join(" ")).toMatch(/Manual pacing/);
    const auto = world({ sprints: [sprintFor("real", { root_issue_id: "root-1" })], tasks: planTasks("sp-real") });
    const control = await sprintToday(auto.env, info, (await db.getSprint(auto.env.ctx.db, "co-1", "sp-real"))!);
    expect(control.due.length).toBeGreaterThan(0);
    expect(control.next.join(" ")).not.toMatch(/Manual pacing/);
  });

  it("the queue does not open a held task of a week nobody started", async () => {
    const tasks = [
      taskRow({ id: "done-1", sprint_id: "sp-real", template_key: "w0-meta-tags", status: "done", issue_id: "iss-9", week: 0, due_day: 1 }),
      taskRow({ id: "wait-1", sprint_id: "sp-real", template_key: "w0-schema", week: 0, due_day: 1 }),
    ];
    const manual = world({ sprints: [sprintFor("real", { root_issue_id: "root-1", pacing: "manual" })], tasks });
    expect(await openNextQueuedTask(manual.env, "co-1", { sprintId: "sp-real", week: 0, id: "done-1" })).toBeNull();
    const auto = world({ sprints: [sprintFor("real", { root_issue_id: "root-1" })], tasks: tasks.map((t) => ({ ...t })) });
    expect(await openNextQueuedTask(auto.env, "co-1", { sprintId: "sp-real", week: 0, id: "done-1" })).toBe("wait-1");
  });
});

describe("Start on a manual sprint", () => {
  it("releases the whole week, opens its first task and leaves the other weeks held", async () => {
    const w = world({ sprints: [sprintFor("real", { root_issue_id: "root-1", pacing: "manual" })], tasks: planTasks("sp-real") });
    const result = (await startTasksNow(w.env, "co-1", user, { sprintId: "sp-real", week: 0 })) as { started: number; issuesOpened: number };
    // Three week-0 tasks: all released although their day (none) had long passed; one opened now, two queue behind it.
    expect(result.started).toBe(3);
    expect(result.issuesOpened).toBe(1);
    const week0 = w.store.tasks.filter((t) => t.week === 0);
    expect(week0.every((t) => t.released_at != null)).toBe(true);
    expect(w.store.tasks.find((t) => t.week === 12)!.released_at ?? null).toBeNull();
    expect(opened(w)).toHaveLength(1);
    // The daily top-up now opens the rest of the released week's agent work and nothing of week 12.
    const next = await materialiseDueTasks(w.env, await context(w, "sp-real"));
    // (The person's task goes to Needs you, not to an issue, as it always did.)
    expect(next.created).toBe(1);
    expect(w.store.tasks.filter((t) => t.week === 0 && t.owner === "agent").every((t) => t.issue_id != null)).toBe(true);
    expect(w.store.tasks.find((t) => t.week === 12)!.issue_id ?? null).toBeNull();
  });

  it("starts a single task too", async () => {
    const w = world({ sprints: [sprintFor("real", { root_issue_id: "root-1", pacing: "manual" })], tasks: planTasks("sp-real") });
    const result = (await startTasksNow(w.env, "co-1", user, { sprintId: "sp-real", taskId: "sp-real-later" })) as { started: number; issuesOpened: number };
    expect(result).toMatchObject({ started: 1, issuesOpened: 1 });
    expect(w.store.tasks.find((t) => t.id === "sp-real-later")!.released_at).toBeTruthy();
  });

  it("is refused for an agent, even on full autopilot", async () => {
    const w = world({ sprints: [sprintFor("real", { root_issue_id: "root-1", pacing: "manual", autopilot_mode: "full" })], tasks: planTasks("sp-real") });
    await expect(startTasksNow(w.env, "co-1", agent, { sprintId: "sp-real", week: 0 })).rejects.toThrow(/manual pacing/);
    expect(w.created).toEqual([]);
    // The control: on an automatic sprint in full autopilot an agent may pull a week forward, as before.
    const auto = world({ sprints: [sprintFor("real", { root_issue_id: "root-1", autopilot_mode: "full" })], tasks: planTasks("sp-real") });
    await expect(startTasksNow(auto.env, "co-1", agent, { sprintId: "sp-real", week: 12 })).resolves.toMatchObject({ started: 1 });
  });
});

describe("set-pacing", () => {
  it("is a page-only action: an agent has no tool for it and is refused if it gets through", async () => {
    expect(UI_ONLY_HANDLERS["set-pacing"]).toBeTypeOf("function");
    expect(HANDLERS["set-pacing"]).toBeUndefined();
    expect(SEO_TOOLS.some((t) => t.name === "set-pacing")).toBe(false);
    const w = world({ sprints: [sprintFor("real", { root_issue_id: "root-1" })], tasks: planTasks("sp-real") });
    await expect(setPacing(w.env, "co-1", agent, { sprintId: "sp-real", pacing: "manual" })).rejects.toThrow(/signed-in person/);
    await expect(dispatch(w.env, "co-1", agent, "set-pacing", { sprintId: "sp-real", pacing: "manual" })).rejects.toThrow(/signed-in person/);
    expect(w.sprintRow("sp-real").pacing ?? "auto").toBe("auto");
  });

  it("switches to manual, lets a week already under way finish, and says so on the sprint issue; and back", async () => {
    const tasks = [
      taskRow({ id: "run-1", sprint_id: "sp-real", template_key: "w0-meta-tags", status: "in_progress", issue_id: "iss-1", week: 0, due_day: 1 }),
      taskRow({ id: "run-2", sprint_id: "sp-real", template_key: "w0-schema", week: 0, due_day: 1 }),
      taskRow({ id: "later-1", sprint_id: "sp-real", template_key: "w12-cluster-pick", week: 12, due_day: 80 }),
    ];
    const w = world({ sprints: [sprintFor("real", { root_issue_id: "root-1" })], tasks });
    const result = (await setPacing(w.env, "co-1", user, { sprintId: "sp-real", pacing: "manual" })) as { pacing: string };
    expect(result.pacing).toBe("manual");
    expect(w.sprintRow("sp-real").pacing).toBe("manual");
    expect(executed(w, /UPDATE plugin_seo_8099f8879a\.sprint_tasks q SET released_at = now\(\)/)).toHaveLength(1);
    expect(w.comments.at(-1)!.body).toMatch(/Pacing set to manual/);
    expect(await setPacing(w.env, "co-1", user, { sprintId: "sp-real", pacing: "manual" })).toMatchObject({ unchanged: true });
    expect(await setPacing(w.env, "co-1", user, { sprintId: "sp-real", pacing: "auto" })).toMatchObject({ pacing: "auto" });
    expect(w.sprintRow("sp-real").pacing).toBe("auto");
    expect(w.comments.at(-1)!.body).toMatch(/automatic/);
    await expect(setPacing(w.env, "co-1", user, { sprintId: "sp-real", pacing: "sideways" })).rejects.toThrow();
  });

  it("create-sprint with manual pacing opens no plan task at all", async () => {
    const w = world();
    const result = (await createSprint(w.env, "co-1", agent, { siteUrl: "https://agristudies.co.za", client: "company:6f1c2b9e-3a4d-4c1e-9b7a-2d5e8f0a1c33", pacing: "manual" })) as Record<string, unknown>;
    expect(result.seededTasks).toBeGreaterThan(30);
    expect(result.issuesOpened).toBe(0);
    expect(opened(w)).toEqual([]);
  });
});

describe("the daily run on a manual sprint", () => {
  const daily = async (w: ReturnType<typeof world>) => {
    const info = await companyInfo(w.env, "co-1");
    return runDailyForSprint(w.env, info, (await db.getSprint(w.env.ctx.db, "co-1", "sp-real"))!, { agent: AGENT, projectId: "proj-seo" });
  };

  it("keeps the housekeeping and the clock but opens no plan task; the automatic sprint is the control", async () => {
    const manual = world({ sprints: [sprintFor("real", { pacing: "manual" })], tasks: planTasks("sp-real") });
    const result = await daily(manual);
    expect(result.issuesOpened).toBe(0);
    // The data work ran: the Search Console pull reports that the fixture's service account has no access yet.
    expect(result.warnings.join(" ")).toMatch(/Search Console/);
    expect(opened(manual)).toEqual([]);
    // The sprint's own root issue and the day's record are still made.
    expect(manual.created[0]!.input.originKind).toBe("plugin:partnersinbiz.seo:sprint");
    expect(executed(manual, /UPDATE plugin_seo_8099f8879a\.sprints SET/).some((e) => /last_daily_on/.test(e.sql))).toBe(true);
    expect(manual.store.tasks.every((t) => t.issue_id == null)).toBe(true);
    const auto = world({ sprints: [sprintFor("real")], tasks: planTasks("sp-real") });
    expect((await daily(auto)).issuesOpened).toBeGreaterThan(0);
  });
});

describe("the weekly proposals keep running on a manual sprint", () => {
  const LIVE_PAGE = { id: "c1", company_id: "co-1", sprint_id: "sp-real", title: "VAT guide", type: "post", status: "live", target_url: "https://acme.co.za/blog/vat-guide", published_on: "2026-09-01", impressions: 0, social_post_ids: [], links_to_pillar_ids: [] };
  const routes = (rows: Row[]) => [
    [/WHERE status IN \('pre_launch', 'active', 'compounding'\) AND seeded_at IS NOT NULL/, () => rows],
    [/FROM plugin_seo_8099f8879a\.integrations/, () => [integrationRow("gsc", { status: "connected", last_pull_at: "2026-10-03T06:00:00Z" })]],
    [/FROM plugin_seo_8099f8879a\.content/, () => [LIVE_PAGE]],
    [/count\(\*\)::int AS count FROM plugin_seo_8099f8879a\.optimizations/, () => [{ count: 0 }]],
    [/FROM plugin_seo_8099f8879a\.optimizations WHERE id = \$1 AND company_id = \$2/, (p: unknown[]) => [{ id: p[0], company_id: "co-1", sprint_id: "sp-real", signal_type: "zero_impression_content", severity: "medium", subject: "c1", evidence: {}, hypothesis: "The page earned no impressions", hypothesis_type: "title", proposed_action: "Rewrite the title", proposed_tasks: [{ title: "Rewrite the title" }], target_keyword_ids: [], status: "proposed", approval_issue_id: null }]],
  ] as never;

  it.each(["manual", "auto"])("a %s sprint gets its weekly proposal and approval issue", async (pacing) => {
    const rows = [sprintFor("real", { root_issue_id: "root-1", pacing })];
    const w = world({ sprints: rows, tasks: planTasks("sp-real"), routes: routes(rows) });
    expect(await runWeeklyJob(w.env, { force: true })).toEqual({ processed: 1, proposals: 1, errors: [] });
    expect(w.created.map((c) => c.input.originKind)).toEqual(["plugin:partnersinbiz.seo:approval"]);
  });
});
