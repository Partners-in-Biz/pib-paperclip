/**
 * 0.9.0 graph round: the company-graph stages SEO reports (seo.tasks,
 * seo.signoff), the done-check on sprint task issues, stable task origin ids,
 * and the workspace fault (runs that stop at the host's workspace check).
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { DONE_CHECK_MAX_REOPENS, flowStagesFor, PIB_PLUGINS, runDoneCheck } from "@partnersinbiz/pib-plugin-kit";
import { cockpitSnapshot, runsChecks, signoffFlow, tasksFlow, type WaitingData } from "../src/cockpit.js";
import { TASK_ORIGIN_PREFIX, taskIdFromOrigin, taskOriginId } from "../src/constants.js";
import * as db from "../src/db.js";
import {
  DUE_TERMS,
  isWaitingTask,
  projectFixPath,
  RUNS_TROUBLE,
  stuckCause,
  stuckText,
  tallyTasks,
  taskState,
  WORKSPACE_FAILURE_CODE,
  type TimedTask,
} from "../src/engine/due.js";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv } from "../src/service/common.js";
import { checkAgentClose, SEO_DONE_CHECKS, taskCloseResult } from "../src/service/done-checks.js";
import { activeTotals, overviewFor, sprintOverviews, withRunFailures, type SprintOverview } from "../src/service/overview.js";
import { stuckLabel } from "../src/service/summary.js";
import { upgradeTaskOrigin } from "../src/service/tasks.js";
import { SKILL_BODY } from "../src/skills.js";
import plugin from "../src/worker.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

type Row = Record<string, unknown>;
const T = (name: string) => `${NAMESPACE}.${name}`;
const DAY = 24 * 3600_000;

const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "PiB", site_url: "https://partnersinbiz.online", site_name: "Partners in Biz", client_kind: null, client_ref: null, client_name: null,
  status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 4, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "seo-proj", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", notes: null, paused_reason: null,
  health: {}, scoreboard: {}, today: {}, current_day: 0, current_week: 0, current_phase: 0, last_daily_on: null, last_weekly_on: null,
  audit_days_done: [], seeded_at: "2026-09-01T00:00:00Z", site_project_id: "site-proj", site_access: "repo", repo_url: "https://github.com/pib/site", default_branch: "main",
  framework: null, hosting: null, change_policy: "merge_seo_scope", verification: {}, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

function taskRow(extra: Row = {}): Row {
  return {
    id: "t-1", company_id: "co-1", sprint_id: "sp-1", template_key: "w5-repurpose-1", week: 5, phase: 2, due_day: 30, focus: "Content",
    title: "Hand post 1 to Social", description: null, task_type: "post-repurpose", owner: "agent", autopilot_eligible: true,
    playbook_key: "w5-repurpose-1", status: "in_progress", source: "template", parent_optimization_id: null, context: null, issue_id: "iss-1", issue_identifier: "PIB-9",
    issue_status: "in_progress", issue_project_id: "seo-proj", assignee_kind: "agent", blocker_reason: null, human_ask: null, evidence: null, started_at: null, completed_at: null,
    completed_by: null, created_at: null, updated_at: null, ...extra,
  };
}

/** A fake host: SQL goes through the host guard copy; tasks and issues are kept in memory so writes are visible. */
function world(input: { task?: Row; issue?: Row; sprint?: Row; facts?: Row; runs?: Row[]; agentStatus?: string } = {}) {
  const sprint: Row = { ...SPRINT, ...input.sprint };
  const task = taskRow(input.task);
  const tasks = new Map<string, Row>([[String(task.id), task]]);
  const issue: Row = { id: "iss-1", identifier: "PIB-9", title: "Hand post 1 to Social", status: "done", originKind: "plugin:partnersinbiz.seo:task", originId: "seo:task:t-1", assigneeAgentId: "agent-1", createdAt: "2026-09-20T00:00:00Z", ...input.issue };
  const issues = new Map<string, Row>([[String(issue.id), issue]]);
  const updates: Array<{ id: string; patch: Row }> = [];
  const comments: Array<{ id: string; body: string }> = [];
  const wakes: string[] = [];
  const emits: unknown[][] = [];
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const queries: string[] = [];
  // The SEO agent is linked (kit hire state), so due work is stuck only for the reasons a test sets up.
  const state = new Map<string, unknown>([["pib-hire:role:seo-specialist", { agentId: "agent-1" }]]);
  const handlers: Array<{ name: string; fn: (event: PluginEvent) => Promise<void> }> = [];
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs"]);
        validateParams(sql, params);
        queries.push(sql);
        if (sql.includes("public.heartbeat_runs")) return input.runs ?? [];
        if (sql.includes(`FROM ${T("sprint_tasks")} WHERE id = $1`)) return tasks.has(String(params[0])) ? [tasks.get(String(params[0]))] : [];
        if (sql.includes(`FROM ${T("sprint_tasks")} WHERE issue_id = $1`)) return [...tasks.values()].filter((t) => t.issue_id === params[0]);
        if (sql.includes(`FROM ${T("sprints")} WHERE id = $1`)) return [sprint];
        if (sql.includes("AS active_keywords")) return [{ active_keywords: 0, no_intent: 0, priority: 0, dirs: 0, latest_day: null, live_social: 0, ...input.facts }];
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        executes.push({ sql, params });
        if (sql.startsWith(`UPDATE ${T("sprint_tasks")} SET`)) {
          const row = tasks.get(String(params[params.length - 2]));
          if (row) for (const m of sql.matchAll(/([a-z_]+) = \$(\d+)/g)) if (m[1] !== "id" && m[1] !== "company_id") row[m[1]!] = params[Number(m[2]) - 1];
        }
        return { rowCount: 1 };
      },
    },
    issues: {
      get: vi.fn(async (id: string) => issues.get(id) ?? null),
      update: vi.fn(async (id: string, patch: Row) => {
        updates.push({ id, patch });
        issues.set(id, { ...(issues.get(id) ?? { id }), ...patch });
        return issues.get(id);
      }),
      createComment: vi.fn(async (id: string, body: string) => {
        comments.push({ id, body });
        return { id: "c-1" };
      }),
      requestWakeup: vi.fn(async (id: string) => {
        wakes.push(id);
        return { queued: true };
      }),
    },
    state: {
      get: vi.fn(async (key: { namespace?: string; stateKey: string }) => state.get(`${key.namespace}:${key.stateKey}`) ?? null),
      set: vi.fn(async (key: { namespace?: string; stateKey: string }, value: unknown) => void state.set(`${key.namespace}:${key.stateKey}`, value)),
    },
    events: {
      on: vi.fn((name: string, fn: (event: PluginEvent) => Promise<void>) => void handlers.push({ name, fn })),
      emit: vi.fn(async (...args: unknown[]) => void emits.push(args)),
    },
    tools: { register: vi.fn() },
    actions: { register: vi.fn() },
    jobs: { register: vi.fn() },
    agents: { get: vi.fn(async (id: string) => ({ id, name: "Sam", status: input.agentStatus ?? "active" })), managed: { get: vi.fn(async () => ({ agentId: null, agent: null })) } },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PIB" })) },
    config: { get: vi.fn(async () => ({ timezone: "Africa/Johannesburg" })) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
  const agentClose = { eventType: "issue.updated", entityId: "iss-1", companyId: "co-1", actorType: "agent" } as unknown as PluginEvent;
  return { ctx, sprint, tasks, issues, updates, comments, wakes, emits, executes, queries, handlers, agentClose };
}

const timed = (extra: Partial<TimedTask> = {}): TimedTask => ({ status: "in_progress", dueDay: 18, owner: "agent", issueId: "i", issueStatus: "in_progress", assigneeKind: "agent", ...extra });

// ---------------------------------------------------------------------------

describe("stuck: one definition, now with runs that stop at the workspace check", () => {
  it("a failing run makes due agent work stuck, and beats the host's blocked status", () => {
    expect(stuckCause(timed({ runsFailing: true }), 20, true)).toBe("runs");
    expect(stuckCause(timed({ runsFailing: true }), 20, false)).toBe("agent");
    expect(stuckCause(timed(), 20, true)).toBeNull();
    // The host blocks an issue whose run failed the workspace check: that is stuck, not "waiting on you".
    const hostBlocked = timed({ status: "blocked", issueStatus: "blocked", runsFailing: true });
    expect(isWaitingTask(hostBlocked)).toBe(false);
    expect(taskState(hostBlocked, 20)).toBe("stuck");
    expect(taskState(timed({ status: "blocked", issueStatus: "blocked" }), 20)).toBe("waiting");
    // Not due yet, or a person's work: never stuck.
    expect(stuckCause(timed({ status: "not_started", dueDay: 30, runsFailing: true }), 20, true)).toBeNull();
  });

  it("tallies stuck, stuck by runs, and stuck-or-overdue once per task", () => {
    const tally = tallyTasks([timed({ runsFailing: true, dueDay: 5 }), timed({ dueDay: 10 }), timed({ dueDay: 19 })], 20, true);
    expect(tally).toMatchObject({ due: 3, overdue: 2, stuck: 1, stuckRuns: 1, attention: 2, mostDaysLate: 15 });
    const agentDown = tallyTasks([timed({ runsFailing: true, dueDay: 5 }), timed({ dueDay: 19 })], 20, false);
    expect(agentDown).toMatchObject({ stuck: 2, stuckRuns: 0, attention: 2 });
  });

  it("says why in plain words, and where it is fixed", () => {
    const sam = { name: "Sam", status: "error" };
    expect(stuckText({ stuck: 2, stuckRuns: 0 }, sam)).toBe("Sam is in error");
    expect(stuckText({ stuck: 2, stuckRuns: 2 }, sam)).toBe("The site repo has no checkout on the server (the workspace check fails)");
    expect(stuckText({ stuck: 3, stuckRuns: 1 }, sam)).toBe(`Sam is in error, and ${RUNS_TROUBLE}`);
    expect(projectFixPath(["site-proj"])).toBe("/projects/site-proj/configuration");
    expect(projectFixPath([])).toBe("/seo");
    expect(DUE_TERMS.stuck).toContain("no checkout of the site repo on the server");
    expect(stuckLabel({ stuck: 2, stuckRuns: 0 })).toBe("Stuck (agent needs attention)");
    expect(stuckLabel({ stuck: 2, stuckRuns: 2 })).toBe("Stuck (no repo checkout on the server)");
  });
});

describe("workspace fault detection (public.heartbeat_runs)", () => {
  it("marks open tasks whose latest run stopped at the workspace check; later good runs clear it", async () => {
    const w = world({ runs: [{ issue_id: "iss-1", error_code: WORKSPACE_FAILURE_CODE, at: "2026-09-27T10:00:00Z" }, { issue_id: "iss-2", error_code: null, at: "2026-09-27T11:00:00Z" }] });
    const t1 = (await db.getTask(w.ctx.db, "co-1", "t-1"))!;
    const marked = await withRunFailures(w.ctx.db, "co-1", [t1, { ...t1, id: "t-2", issueId: "iss-2" }, { ...t1, id: "t-3", status: "done" as const }]);
    expect(marked.map((t) => [t.id, t.runsFailing])).toEqual([["t-1", true], ["t-2", false], ["t-3", false]]);
    const sql = w.queries.find((q) => q.includes("public.heartbeat_runs"))!;
    expect(sql).toContain("DISTINCT ON");
    expect(sql).toContain("interval '30 days'");
  });

  it("never throws: an unreadable run table means no fault", async () => {
    const w = world();
    (w.ctx.db as { query: unknown }).query = async () => {
      throw new Error("permission denied");
    };
    const task = taskRow();
    const marked = await withRunFailures(w.ctx.db, "co-1", [{ ...(task as unknown as db.SprintTask), issueId: "iss-1", status: "in_progress" }]);
    expect(marked[0]!.runsFailing).toBe(false);
  });

  it("feeds the sprint numbers with the projects to fix; a paused sprint is never stuck", () => {
    const sprint = { id: "sp-1", status: "active", startDate: "2026-09-01", autopilotMode: "safe", templateId: "outrank-90" } as unknown as db.Sprint;
    const open = [{ ...(taskRow() as unknown as db.SprintTask), id: "t-1", issueId: "iss-1", issueProjectId: "site-proj", status: "in_progress" as const, dueDay: 10, assigneeKind: "agent", runsFailing: true }];
    const numbers = overviewFor(sprint, { today: "2026-09-21", openTasks: open, agent: { status: "active" } }).numbers;
    expect(numbers).toMatchObject({ stuck: 1, stuckRuns: 1, runsProjectIds: ["site-proj"] });
    const paused = overviewFor({ ...sprint, status: "paused" } as db.Sprint, { today: "2026-09-21", openTasks: open, agent: { status: "active" } }).numbers;
    expect(paused).toMatchObject({ stuck: 0, stuckRuns: 0, runsProjectIds: [] });
  });

  it("puts the fault on System health with the fix and the project link", () => {
    const sprint = { id: "sp-1", siteName: "Partners in Biz", repoUrl: "https://github.com/pib/site", clientRef: null, clientName: null } as unknown as db.Sprint;
    const n = (stuckRuns: number): SprintOverview => ({ numbers: { stuckRuns, runsProjectIds: stuckRuns ? ["site-proj"] : [] } as SprintOverview["numbers"], next: null });
    expect(runsChecks([sprint], new Map([["sp-1", n(0)]]))).toEqual([{ key: "seo-runs", title: "SEO task runs", status: "ok" }]);
    const [check] = runsChecks([sprint], new Map([["sp-1", n(3)]]));
    expect(check).toMatchObject({ key: "seo-runs", status: "bad", href: "/projects/site-proj/configuration", title: "SEO tasks can't start: no checkout of the site repo on the server" });
    expect(check!.detail).toContain("3 tasks stopped at the workspace check");
    expect(check!.detail).toContain("Partners in Biz (https://github.com/pib/site)");
    expect(check!.fix).toContain("set its local folder");
  });
});

describe("company graph: the stages SEO reports", () => {
  it("owns seo.tasks and seo.signoff", () => {
    expect(flowStagesFor(PIB_PLUGINS.seo).map((s) => s.key)).toEqual(["seo.tasks", "seo.signoff"]);
  });

  it("seo.tasks: due now, stuck = stuck or overdue once, with the reason", () => {
    const totals = { active: 1, due: 6, overdue: 3, stuck: 4, stuckRuns: 2, attention: 5, mostDaysLate: 12, waitingOnYou: 0, runsProjectIds: ["site-proj"] };
    expect(tasksFlow(totals, { id: "a", name: "Sam", status: "paused" })).toEqual({
      stage: "seo.tasks",
      count: 6,
      stuck: 5,
      stuckReason: `Sam is paused: 2 tasks can't move; 2 tasks can't start: ${RUNS_TROUBLE}; 1 task open a week or more past its day`,
      oldestDays: 12,
    });
    expect(tasksFlow({ ...totals, due: 0, overdue: 0, stuck: 0, stuckRuns: 0, attention: 0, mostDaysLate: 0 }, null)).toEqual({ stage: "seo.tasks", count: 0, stuck: 0, stuckReason: null, oldestDays: null });
  });

  it("seo.signoff: sign-off and PR items plus proposals, stuck after a week", () => {
    const now = new Date("2026-09-28T08:00:00Z");
    const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
    const item = (key: string, kind: string, days: number) => ({ item: { key, kind, title: key, why: "", steps: [], links: [], after: "", check: "manual", status: "open", addedAt: ago(days) }, digest: {} });
    const data = {
      pending: [item("review:t-1", "review", 9), item("pr-1", "pr", 1), item("service_account", "grant", 20)],
      proposals: [{ id: "o-1", created_at: ago(2) }],
    } as unknown as WaitingData;
    expect(signoffFlow(data, now)).toEqual({ stage: "seo.signoff", count: 3, stuck: 1, stuckReason: "1 sign-off waiting over a week", oldestDays: 9 });
    expect(signoffFlow({ pending: [], proposals: [] }, now)).toMatchObject({ count: 0, stuck: 0, stuckReason: null, oldestDays: null });
  });

  it("the Cockpit snapshot reports both stages from the same numbers as the KPIs", async () => {
    const w = world({ runs: [{ issue_id: "iss-1", error_code: WORKSPACE_FAILURE_CODE, at: "2026-09-27T10:00:00Z" }] });
    const open = [taskRow({ due_day: 1, status: "blocked", issue_status: "blocked", issue_project_id: "site-proj", blocker_reason: "Blocked in Paperclip" })];
    (w.ctx.db as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
      validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs"]);
      validateParams(sql, params);
      if (sql.includes("public.heartbeat_runs")) return [{ issue_id: "iss-1", error_code: WORKSPACE_FAILURE_CODE, at: "2026-09-27T10:00:00Z" }];
      if (sql.includes(`FROM ${T("sprints")} WHERE company_id = $1 ORDER BY`)) return [{ ...SPRINT, start_date: "2026-09-01" }];
      if (sql.includes(`FROM ${T("sprint_tasks")}`) && sql.includes("WHERE company_id = $1 AND status IN")) return open;
      return [];
    };
    const snap = await cockpitSnapshot(w.ctx, "co-1");
    const stuck = snap.kpis.find((k) => k.key === "seo_stuck_tasks");
    expect(stuck).toMatchObject({ value: "1", href: "/projects/site-proj/configuration" });
    expect(stuck!.delta).toContain("no checkout on the server");
    expect(snap.flows).toEqual([
      { stage: "seo.tasks", count: 1, stuck: 1, stuckReason: `1 task can't start: ${RUNS_TROUBLE}`, oldestDays: expect.any(Number) },
      { stage: "seo.signoff", count: 0, stuck: 0, stuckReason: null, oldestDays: null },
    ]);
    expect(snap.health.find((h) => h.key === "seo-runs")).toMatchObject({ status: "bad" });
  });

  it("a stage whose numbers failed to load reports nothing (never a false zero)", async () => {
    const w = world();
    (w.ctx.db as { query: unknown }).query = async () => {
      throw new Error("db down");
    };
    const snap = await cockpitSnapshot(w.ctx, "co-1");
    expect(snap.flows).toEqual([]);
  });
});

describe("task issue origin ids", () => {
  it("are seo:task:<taskId>", () => {
    expect(taskOriginId("t-1")).toBe("seo:task:t-1");
    expect(taskIdFromOrigin("seo:task:t-1")).toBe("t-1");
    expect(taskIdFromOrigin("t-1")).toBeNull();
    expect(SEO_DONE_CHECKS.map((r) => r.originPrefix)).toEqual([TASK_ORIGIN_PREFIX]);
  });

  it("the daily heal moves an open issue from before 0.9.0 to the new origin id, once", async () => {
    const w = world();
    const env = createEnv(w.ctx);
    const task = { id: "t-1", companyId: "co-1" };
    expect(await upgradeTaskOrigin(env, task, { id: "iss-1", status: "todo", originKind: "plugin:partnersinbiz.seo:task", originId: "t-1" })).toBe(true);
    expect(w.updates).toEqual([{ id: "iss-1", patch: { originId: "seo:task:t-1" } }]);
    expect(await upgradeTaskOrigin(env, task, { id: "iss-1", status: "todo", originKind: "plugin:partnersinbiz.seo:task", originId: "seo:task:t-1" })).toBe(false);
    expect(await upgradeTaskOrigin(env, task, { id: "iss-1", status: "done", originKind: "plugin:partnersinbiz.seo:task", originId: "t-1" })).toBe(false);
    expect(await upgradeTaskOrigin(env, task, { id: "iss-2", status: "todo", originKind: "plugin:partnersinbiz.seo:sprint", originId: "t-1" })).toBe(false);
  });
});

describe("done-check: sprint task issues an agent closes", () => {
  const safe = { mode: "safe" as const, blocker: null };
  const base = { id: "t-1", status: "in_progress" as const, owner: "agent" as const, autopilotEligible: true, playbookKey: "w0-meta-tags", issueId: "iss-1", evidence: null, blockerReason: null };

  it("passes when the sprint data shows the work: done with complete-task, skipped with a reason, or not needed", () => {
    for (const status of ["done", "skipped", "na"] as const) expect(taskCloseResult({ ...base, status }, "iss-1", safe)).toEqual({ done: true });
  });

  it("passes when the task is gone or moved to another issue (finished another way)", () => {
    expect(taskCloseResult(null, "iss-1", safe)).toEqual({ done: true });
    expect(taskCloseResult({ ...base, issueId: "iss-new" }, "iss-1", safe)).toEqual({ done: true });
  });

  it("asks for complete-task with the playbook's evidence, and the completion rule that still fails", () => {
    const result = taskCloseResult(base, "iss-1", { mode: "safe", blocker: "Only 2 keywords are tracked." });
    expect(result.done).toBe(false);
    expect(result.missing).toEqual([
      'Record the result with `complete-task` (`taskId: "t-1"`; evidence: pages checked, the before/after titles and descriptions, and the PR/commit or the handoff issue).',
      "Only 2 keywords are tracked.",
    ]);
  });

  it("a sign-off stays the owner's: never asks the agent to complete it", () => {
    const waiting = taskCloseResult({ ...base, evidence: { handoff: { review: true } } }, "iss-1", safe);
    expect(waiting.missing![0]).toContain("only a person approves it");
    const needs = taskCloseResult({ ...base, autopilotEligible: false }, "iss-1", safe);
    expect(needs.missing![0]).toContain("`block-task`");
    expect(needs.missing![0]).toContain("`review: true`");
    expect(taskCloseResult({ ...base, autopilotEligible: false }, "iss-1", { mode: "full", blocker: null }).missing![0]).toContain("complete-task");
  });

  it("a task still blocked on a person says so", () => {
    expect(taskCloseResult({ ...base, status: "blocked", blockerReason: "Needs the GSC grant" }, "iss-1", safe).missing![0]).toContain("It still waits on a person (Needs the GSC grant)");
  });

  it("reopens an agent's early close with what is missing and wakes the agent (w5: posts not linked)", async () => {
    const w = world();
    expect(await runDoneCheck(w.ctx, SEO_DONE_CHECKS, w.agentClose)).toBe("reopened");
    expect(w.updates).toEqual([{ id: "iss-1", patch: { status: "todo" } }]);
    expect(w.comments[0]!.body).toContain("Record the result with `complete-task`");
    expect(w.comments[0]!.body).toContain("the content row id, the live URL and the linked social post ids");
    expect(w.comments[0]!.body).toContain("link-social-post");
    expect(w.wakes).toEqual(["iss-1"]);
  });

  it("passes a close after complete-task, ignores people, and hands the third early close to the Operator", async () => {
    const done = world({ task: { status: "done", evidence: { summary: "Linked", at: "2026-09-27T00:00:00Z" } } });
    expect(await runDoneCheck(done.ctx, SEO_DONE_CHECKS, done.agentClose)).toBe("passed");
    expect(done.updates).toEqual([]);
    const person = world();
    expect(await runDoneCheck(person.ctx, SEO_DONE_CHECKS, { ...person.agentClose, actorType: "user" })).toBe("skipped");
    const loop = world();
    const closeAgain = () => void loop.issues.set("iss-1", { ...loop.issues.get("iss-1"), status: "done" });
    for (let i = 1; i < DONE_CHECK_MAX_REOPENS; i += 1) {
      closeAgain();
      expect(await runDoneCheck(loop.ctx, SEO_DONE_CHECKS, loop.agentClose)).toBe("reopened");
    }
    closeAgain();
    expect(await runDoneCheck(loop.ctx, SEO_DONE_CHECKS, loop.agentClose)).toBe("escalated");
  });

  it("falls back to the task on the issue when the origin id names an unknown task", async () => {
    const w = world({ issue: { originId: "seo:task:t-unknown" } });
    expect(await runDoneCheck(w.ctx, SEO_DONE_CHECKS, w.agentClose)).toBe("reopened");
  });
});

describe("worker: the check runs before the task syncs from the issue", () => {
  it("has one issue.updated subscription (a second would deliver every event twice)", async () => {
    const w = world();
    await plugin.definition.setup(w.ctx);
    expect(w.handlers.filter((h) => h.name === "issue.updated")).toHaveLength(1);
  });

  it("an agent's early close is reopened and never marks the task done or tells Social", async () => {
    const w = world({ task: { template_key: "w5-post-1", playbook_key: "w5-post-1", task_type: "post-publish", title: "Publish post 1" } });
    await plugin.definition.setup(w.ctx);
    await w.handlers.find((h) => h.name === "issue.updated")!.fn(w.agentClose);
    expect(w.updates).toEqual([{ id: "iss-1", patch: { status: "todo" } }]);
    expect(w.tasks.get("t-1")!.status).toBe("in_progress");
    expect(w.emits.filter((e) => String(e[0]).includes("content.published"))).toEqual([]);
    expect(await checkAgentClose(w.ctx, { ...w.agentClose, actorType: "user" })).toBe(false);
  });

  it("never reads other issues from the host: only sprint task issues are checked", async () => {
    const w = world();
    expect(await checkAgentClose(w.ctx, { ...w.agentClose, entityId: "someone-elses-issue" })).toBe(false);
    expect(w.ctx.issues.get).not.toHaveBeenCalled();
  });

  it("a person's close (the owner's sign-off) still completes the task", async () => {
    const w = world({ task: { evidence: { handoff: { review: true } } } });
    await plugin.definition.setup(w.ctx);
    await w.handlers.find((h) => h.name === "issue.updated")!.fn({ ...w.agentClose, actorType: "user" } as PluginEvent);
    expect(w.updates).toEqual([]);
    expect(w.tasks.get("t-1")!.status).toBe("done");
  });
});

describe("skill", () => {
  it("tells the agent the close is checked", () => {
    expect(SKILL_BODY).toContain("When you close an issue this module opened, it checks the work; if it reopens, it lists what's missing: finish those.");
  });
});

describe("totals", () => {
  it("sum the new numbers across active sprints", async () => {
    const w = world();
    const sprints = [await db.getSprint(w.ctx.db, "co-1", "sp-1")].filter((s): s is db.Sprint => Boolean(s));
    const overviews = await sprintOverviews(w.ctx.db, "co-1", sprints, "2026-09-21", { status: "active" });
    expect(activeTotals(sprints, overviews)).toMatchObject({ active: 1, stuckRuns: 0, runsProjectIds: [] });
  });
});
