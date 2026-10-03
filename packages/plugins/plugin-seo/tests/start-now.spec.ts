import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { inPlanOrder, startTasksNow } from "../src/service/tasks.js";
import { withStartedWork } from "../src/service/overview.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

type Row = Record<string, unknown>;
type Route = [RegExp, (params: unknown[]) => Row[]];

const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_ref: null, client_name: "Acme Ltd",
  status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "proj-1", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", notes: null, paused_reason: null,
  health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1, last_daily_on: null, last_weekly_on: null,
  audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

function taskRow(extra: Row = {}): Row {
  return {
    id: "t-1", company_id: "co-1", sprint_id: "sp-1", template_key: "w5-post-1", week: 5, phase: 2, due_day: 29, focus: "Content",
    title: "Publish post 1", description: null, task_type: "post-publish", owner: "agent", autopilot_eligible: false, playbook_key: "w5-post-1",
    status: "in_progress", source: "template", parent_optimization_id: null, context: null, issue_id: "iss-1", issue_identifier: "PIB-9",
    issue_status: "in_progress", assignee_kind: "agent", blocker_reason: null, human_ask: null, evidence: null, started_at: null,
    completed_at: null, completed_by: null, created_at: null, updated_at: null, ...extra,
  };
}

function fakeHost(routes: Route[], config: Row = {}) {
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const issueUpdates: Array<{ id: string; patch: Row }> = [];
  const comments: Array<{ id: string; body: string }> = [];
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs"]);
        validateParams(sql, params);
        for (const [pattern, handler] of routes) if (pattern.test(sql)) return handler(params);
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        executes.push({ sql, params });
        return { rowCount: 1 };
      },
    },
    config: { get: vi.fn(async () => config) },
    secrets: { resolve: vi.fn(async (_ref: unknown, opts?: { configPath?: string }) => `resolved:${opts?.configPath}`) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PIB" })) },
    issues: {
      get: vi.fn(async (id: string) => ({ id, status: "todo", identifier: "PIB-3" })),
      update: vi.fn(async (id: string, patch: Row) => {
        issueUpdates.push({ id, patch });
        return { id, ...patch };
      }),
      createComment: vi.fn(async (id: string, body: string) => {
        comments.push({ id, body });
        return { id: "c" };
      }),
      create: vi.fn(async () => ({ id: "new-issue" })),
      requestWakeup: vi.fn(async () => ({ queued: true, runId: null })),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    skills: { managed: { reconcile: vi.fn(), reset: vi.fn() } },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => (key.stateKey === "plugin-ui-base" ? "/_plugins/051bbf0b-aeb5-42d7-b0b6-c4cabd271cdc/ui/" : null)),
      set: vi.fn(),
    },
  } as unknown as PluginContext;
  const env = createEnv(ctx, { now: () => new Date("2026-09-26T08:00:00Z"), fetch: vi.fn() as never, site: vi.fn() as never });
  return { env, ctx, executes, issueUpdates, comments };
}

const agent: Actor = { kind: "agent", agentId: "agent-1", runId: "run-1", responsibleUserId: null };
const person: Actor = { kind: "user", userId: "user-1" } as unknown as Actor;

describe("start-tasks-now", () => {
  const upcoming = (id: string, week: number, extra: Row = {}) =>
    taskRow({ id, week, due_day: 40, status: "not_started", issue_id: null, issue_identifier: null, issue_status: null, assignee_kind: null, template_key: `w${week}-${id}`, task_type: "custom", autopilot_eligible: true, ...extra });
  // The fake database keeps no state, so due_day updates are replayed onto the rows it returns.
  const hostFor = (tasks: Row[], sprint: Row = SPRINT) => {
    const box: { executes: Array<{ sql: string; params: unknown[] }> } = { executes: [] };
    const current = (): Row[] =>
      tasks.map((t) => {
        const update = box.executes.find((e) => /UPDATE plugin_seo_8099f8879a\.sprint_tasks SET/.test(e.sql) && /due_day/.test(e.sql) && e.params.includes(t.id));
        return update ? { ...t, due_day: update.params.find((v) => typeof v === "number") } : t;
      });
    const routes: Route[] = [
      [/FROM plugin_seo_8099f8879a\.sprints WHERE id = \$1/, () => [sprint]],
      [/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE id = \$1/, (p) => current().filter((t) => t.id === p[0])],
      [/FROM plugin_seo_8099f8879a\.sprint_tasks/, (p) => {
        const wanted = typeof p[2] === "string" && p[2].startsWith("[") ? (JSON.parse(p[2]) as string[]) : null;
        return wanted ? current().filter((t) => wanted.includes(String(t.status))) : current();
      }],
    ];
    const host = fakeHost(routes);
    box.executes = host.executes;
    return host;
  };

  it("refuses an agent unless autopilot is full", async () => {
    const { env } = hostFor([upcoming("t-9", 5)]);
    await expect(startTasksNow(env, "co-1", agent, { sprintId: "sp-1", taskId: "t-9" })).rejects.toThrow(/autopilot is full/);
  });

  it("needs exactly one of taskId or week", async () => {
    const { env } = hostFor([upcoming("t-9", 5)]);
    await expect(startTasksNow(env, "co-1", person, { sprintId: "sp-1" })).rejects.toThrow(/taskId .* or week/);
    await expect(startTasksNow(env, "co-1", person, { sprintId: "sp-1", taskId: "t-9", week: 5 })).rejects.toThrow(/not both/);
  });

  it("makes an upcoming task due today and opens its issue", async () => {
    const { env, executes, ctx } = hostFor([upcoming("t-9", 5)]);
    const result = await startTasksNow(env, "co-1", person, { sprintId: "sp-1", taskId: "t-9" });
    expect(result).toMatchObject({ started: 1, tasks: [{ taskId: "t-9", week: 5 }] });
    const dueUpdate = executes.find((e) => /UPDATE plugin_seo_8099f8879a\.sprint_tasks SET/.test(e.sql) && /due_day/.test(e.sql));
    expect(dueUpdate).toBeDefined();
    expect(dueUpdate!.params).toContain(25); // the sprint is on day 25 on 2026-09-26
    expect((ctx.issues.create as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("starts only the upcoming, not-started tasks of the week and leaves tasks that are already due", async () => {
    const tasks = [upcoming("t-a", 5), upcoming("t-b", 5), upcoming("t-c", 6), upcoming("t-d", 5, { due_day: 10 })];
    const { env, executes } = hostFor(tasks);
    const result = (await startTasksNow(env, "co-1", person, { sprintId: "sp-1", week: 5 })) as { started: number; alreadyDue?: number; tasks: Array<{ taskId: string }> };
    expect(result.started).toBe(2);
    expect(result.alreadyDue).toBe(1);
    expect(result.tasks.map((t) => t.taskId).sort()).toEqual(["t-a", "t-b"]);
    expect(executes.filter((e) => /due_day/.test(e.sql) && /UPDATE/.test(e.sql))).toHaveLength(2);
  });

  it("says so when a task has already started and refuses a paused sprint", async () => {
    const started = taskRow({ id: "t-s", status: "in_progress", due_day: 40 });
    const a = hostFor([started]);
    await expect(startTasksNow(a.env, "co-1", person, { sprintId: "sp-1", taskId: "t-s" })).rejects.toThrow(/already in progress/);
    const b = hostFor([upcoming("t-9", 5)], { ...SPRINT, status: "paused" });
    await expect(startTasksNow(b.env, "co-1", person, { sprintId: "sp-1", taskId: "t-9" })).rejects.toThrow(/paused/);
  });

  it("lets an agent do it when the sprint's autopilot is full", async () => {
    const { env } = hostFor([upcoming("t-9", 5)], { ...SPRINT, autopilot_mode: "full" });
    await expect(startTasksNow(env, "co-1", agent, { sprintId: "sp-1", taskId: "t-9" })).resolves.toMatchObject({ started: 1 });
  });

  it("opens a week one task at a time, in plan order", async () => {
    const keys = ["w2-keyword-record", "w2-keyword-prioritize", "w2-keyword-bucket", "w2-keyword-discover"];
    const tasks = keys.map((key, i) => upcoming(`t-${i}`, 2, { template_key: key, title: key }));
    const { env, ctx } = hostFor(tasks);
    const result = (await startTasksNow(env, "co-1", person, { sprintId: "sp-1", week: 2 })) as { started: number; queued?: number; tasks: Array<{ taskId: string }> };
    expect(result.started).toBe(4);
    expect(result.queued).toBe(3);
    expect(result.tasks.map((t) => t.taskId)).toEqual(["t-3", "t-2", "t-1", "t-0"]); // discover, bucket, prioritize, record
    const created = (ctx.issues.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(created).toHaveLength(1);
    expect(JSON.stringify(created[0])).toContain("w2-keyword-discover");
  });

  it("sorts by the template's order, hand-added tasks last", () => {
    const sorted = inPlanOrder([
      { templateKey: null, createdAt: "2026-09-01", title: "Extra" },
      { templateKey: "w2-keyword-record", createdAt: "2026-09-01", title: "R" },
      { templateKey: "w2-keyword-discover", createdAt: "2026-09-01", title: "Z" },
    ]);
    expect(sorted.map((t) => t.title)).toEqual(["Z", "R", "Extra"]);
  });

  it("marks a not-started task in progress once an agent run has started on its issue", async () => {
    const task = (id: string, issue: string) => ({ ...(taskRow({ id, status: "not_started", issue_id: issue }) as Row) });
    const rows = [task("t-1", "iss-1"), task("t-2", "iss-2")];
    const host = fakeHost([[/FROM public\.heartbeat_runs/, () => [{ issue_id: "iss-1", at: "2026-10-02T12:16:19Z" }]]]);
    const mapped = rows.map((r) => ({ id: r.id, companyId: "co-1", status: "not_started", issueId: r.issue_id, assigneeKind: "agent", startedAt: null }));
    const out = await withStartedWork(host.env.ctx.db as never, "co-1", mapped as never);
    expect(out.map((t) => t.status)).toEqual(["in_progress", "not_started"]);
    expect(host.executes.some((e) => /UPDATE plugin_seo_8099f8879a\.sprint_tasks SET/.test(e.sql) && e.params.includes("t-1"))).toBe(true);
  });
});
