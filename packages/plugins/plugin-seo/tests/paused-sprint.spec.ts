/**
 * A paused or archived sprint opens no task issue, however it is asked (PAR-14132: Tvisha's paused sprint got 11 task issues
 * on 22 Nov). Pausing parks the untouched task issues; resuming puts them back. The active sprint is each test's control.
 */
import { describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { companyInfo, type Actor } from "../src/service/common.js";
import { runDailyForSprint } from "../src/service/jobs.js";
import { setSprintStatus } from "../src/service/sprints.js";
import { materialiseDueTasks } from "../src/service/tasks.js";
import { planTasks, sprintFor, world } from "./helpers/rehearsal-world.js";
import { taskRow } from "./helpers/seo-host.js";

const user: Actor = { kind: "user", userId: "user-peet" };
const AGENT = { id: "agent-1", status: "idle" };
const opened = (w: ReturnType<typeof world>) => w.created.filter((c) => /:task$/.test(String(c.input.originKind)));

async function daily(w: ReturnType<typeof world>) {
  const info = await companyInfo(w.env, "co-1");
  return runDailyForSprint(w.env, info, (await db.getSprint(w.env.ctx.db, "co-1", "sp-real"))!, { agent: AGENT, projectId: "proj-seo" });
}

describe("a paused or archived sprint opens no task issue", () => {
  it.each(["paused", "archived"])("%s: the daily run (run-daily) across a week rollover opens nothing; active is the control", async (status) => {
    const frozen = world({ sprints: [sprintFor("real", { root_issue_id: "root-1", status })], tasks: planTasks("sp-real") });
    const result = await daily(frozen);
    expect(result.issuesOpened).toBe(0);
    expect(opened(frozen)).toEqual([]);
    expect(frozen.store.tasks.every((t) => t.issue_id == null)).toBe(true);
    const control = world({ sprints: [sprintFor("real", { root_issue_id: "root-1", status: "active" })], tasks: planTasks("sp-real") });
    expect((await daily(control)).issuesOpened).toBeGreaterThan(0);
  });

  it.each(["paused", "archived"])("%s: materialiseDueTasks opens nothing for any caller, even a task due at once", async (status) => {
    const w = world({ sprints: [sprintFor("real", { root_issue_id: "root-1", status })], tasks: planTasks("sp-real") });
    const info = await companyInfo(w.env, "co-1");
    const sprint = (await db.getSprint(w.env.ctx.db, "co-1", "sp-real"))!;
    expect(await materialiseDueTasks(w.env, { info, sprint, day: 99, agent: AGENT, projectId: "proj-seo" })).toEqual({ created: 0, remaining: 0, errors: [] });
    expect(w.created).toEqual([]);
  });
});

describe("pausing a sprint parks its task issues", () => {
  const tasks = () => [
    taskRow({ id: "t-todo", sprint_id: "sp-real", issue_id: "issue-1", issue_status: "todo", assignee_kind: "agent", status: "in_progress" }),
    taskRow({ id: "t-busy", sprint_id: "sp-real", issue_id: "issue-2", issue_status: "in_progress", assignee_kind: "agent", status: "in_progress" }),
  ];

  it("moves an untouched todo issue to backlog and back on resume, and leaves a running one alone", async () => {
    const w = world({ sprints: [sprintFor("real", { root_issue_id: "root-1" })], tasks: tasks(), issues: { "issue-2": "in_progress" } });
    const paused = (await setSprintStatus(w.env, "co-1", user, { sprintId: "sp-real" }, "paused")) as { tasksParked?: number };
    expect(paused.tasksParked).toBe(1);
    expect(w.updates.filter((u) => u.patch.status === "backlog").map((u) => u.id)).toEqual(["issue-1"]);
    expect(w.store.tasks.find((t) => t.id === "t-todo")!.evidence).toMatchObject({ parkedByPause: true });

    // The host reports the parked issue as backlog from now on.
    (w.ctx.issues as unknown as { get: unknown }).get = async (id: string) => ({ id, status: id === "issue-1" ? "backlog" : "in_progress", identifier: "PIB-1" });
    await setSprintStatus(w.env, "co-1", user, { sprintId: "sp-real" }, "resume");
    expect(w.updates.filter((u) => u.patch.status === "todo").map((u) => u.id)).toEqual(["issue-1"]);
    expect(w.wakeups).toContain("issue-1");
    expect(w.store.tasks.find((t) => t.id === "t-todo")!.evidence?.parkedByPause).toBeUndefined();
  });
});
