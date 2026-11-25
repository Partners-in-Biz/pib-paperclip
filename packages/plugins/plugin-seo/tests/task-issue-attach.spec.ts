import { describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { attachTaskIssue, startTask } from "../src/service/tasks.js";
import { memTables } from "./helpers/mem-db.js";
import { seoHost, sprintRoutes, taskRow, type Row } from "./helpers/seo-host.js";

const agent = { kind: "agent" as const, agentId: "agent-1", runId: "run-1", responsibleUserId: null };
const person = { kind: "user" as const, userId: "user-1" };

function host(tasks: Row[], issues: Record<string, Row> = {}) {
  const mem = memTables({ sprint_tasks: tasks });
  const h = seoHost({ routes: [...mem.routes, ...sprintRoutes] });
  mem.attach(h);
  h.ctx.issues.get = (async (id: string) => issues[id] ?? null) as never;
  return { ...h, mem };
}
const noIssue = (extra: Row = {}) => taskRow({ id: "t-1", issue_id: null, issue_identifier: null, issue_status: null, status: "not_started", ...extra });

describe("a task whose issue never opened (PAR-13216)", () => {
  it("start-task opens the missing issue and stores its id on the task", async () => {
    const h = host([noIssue()]);
    const result = (await startTask(h.env, "co-1", agent, { taskId: "t-1" })) as Record<string, any>;
    expect(h.created).toHaveLength(1);
    expect(result.issueId).toBe(h.created[0]!.id);
    expect(h.mem.tasks[0]).toMatchObject({ issue_id: h.created[0]!.id, status: "in_progress" });
  });

  it("start-task leaves an existing issue alone", async () => {
    const h = host([noIssue({ issue_id: "issue-9" })]);
    await startTask(h.env, "co-1", agent, { taskId: "t-1" });
    expect(h.created).toHaveLength(0);
    expect(h.mem.tasks[0]).toMatchObject({ issue_id: "issue-9" });
  });

  it("attach-task-issue gives the task an existing issue", async () => {
    const h = host([noIssue()], { "iss-1": { id: "iss-1", identifier: "PAR-1", status: "todo", projectId: "p-1", assigneeAgentId: "someone-else" } });
    const result = (await attachTaskIssue(h.env, "co-1", agent, { taskId: "t-1", issueId: "iss-1" })) as Record<string, any>;
    expect(result.attached).toBe(true);
    expect(h.mem.tasks[0]).toMatchObject({ issue_id: "iss-1", issue_identifier: "PAR-1", issue_status: "todo", issue_project_id: "p-1" });
  });

  it("attach-task-issue refuses a missing issue, a replacement, another task's issue, and an agent's own issue", async () => {
    await expect(attachTaskIssue(host([noIssue()]).env, "co-1", person, { taskId: "t-1", issueId: "nope" })).rejects.toThrow(/not found/);
    const has = host([noIssue({ issue_id: "issue-9" })], { "iss-1": { id: "iss-1", status: "todo" } });
    await expect(attachTaskIssue(has.env, "co-1", person, { taskId: "t-1", issueId: "iss-1" })).rejects.toThrow(/already has an issue/);
    const taken = host([noIssue(), taskRow({ id: "t-2", issue_id: "iss-1" })], { "iss-1": { id: "iss-1", status: "todo" } });
    await expect(attachTaskIssue(taken.env, "co-1", person, { taskId: "t-1", issueId: "iss-1" })).rejects.toThrow(/belongs to task/);
    const own = host([noIssue()], { "iss-1": { id: "iss-1", status: "todo", assigneeAgentId: "agent-1" } });
    await expect(attachTaskIssue(own.env, "co-1", agent, { taskId: "t-1", issueId: "iss-1" })).rejects.toThrow(/assignee/);
    expect((await db.getTask(own.env.ctx.db, "co-1", "t-1"))!.issueId).toBeNull();
  });
});
