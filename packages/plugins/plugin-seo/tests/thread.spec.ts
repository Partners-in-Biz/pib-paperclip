/**
 * 0.22.0: a task thread that passes ~60 KB moves to a fresh continuation issue (PAR-528 and PAR-545 sat at ~103 KB
 * and every wake on them failed with spawn E2BIG). Covers the pure rules and the move itself, against a fake host
 * whose runtime SQL goes through the same guard the host applies.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { HANDLERS } from "../src/dispatch.js";
import { continuationStatus, continuationSummary, failureBackoffMs, moveHold, parseRollMark, plainText, rollableIssue, rollReason, THREAD_ROLL_BYTES } from "../src/engine/thread.js";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv } from "../src/service/common.js";
import { compactTaskThreads, compactTaskThreadTool, guardTaskThreads } from "../src/service/thread.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

describe("rules", () => {
  it("rollReason: size, E2BIG, or a named issue whose size is unknown", () => {
    expect(rollReason({ bytes: 103_000, e2big: false, explicit: false }, THREAD_ROLL_BYTES)).toBe("size");
    expect(rollReason({ bytes: THREAD_ROLL_BYTES, e2big: false, explicit: false }, THREAD_ROLL_BYTES)).toBe("size");
    expect(rollReason({ bytes: 59_999, e2big: false, explicit: false }, THREAD_ROLL_BYTES)).toBeNull();
    expect(rollReason({ bytes: 45_000, e2big: true, explicit: false }, THREAD_ROLL_BYTES)).toBe("e2big");
    // E2BIG on a small thread is some other cause: moving it would not help.
    expect(rollReason({ bytes: 4_000, e2big: true, explicit: false }, THREAD_ROLL_BYTES)).toBeNull();
    expect(rollReason({ bytes: null, e2big: true, explicit: false }, THREAD_ROLL_BYTES)).toBe("e2big");
    expect(rollReason({ bytes: null, e2big: false, explicit: true }, THREAD_ROLL_BYTES)).toBe("requested");
    expect(rollReason({ bytes: null, e2big: false, explicit: false }, THREAD_ROLL_BYTES)).toBeNull();
  });

  it("only an issue an agent can be woken on moves; waiting stays waiting", () => {
    expect(rollableIssue({ status: "in_progress", assigneeAgentId: "a" })).toEqual({ ok: true });
    expect(rollableIssue({ status: "blocked", assigneeAgentId: "a" })).toEqual({ ok: true });
    expect(rollableIssue({ status: "in_review", assigneeAgentId: "a" })).toMatchObject({ ok: false });
    expect(rollableIssue({ status: "done", assigneeAgentId: "a" })).toMatchObject({ ok: false });
    expect(rollableIssue({ status: "todo", assigneeAgentId: null })).toMatchObject({ ok: false });
    expect(continuationStatus("blocked")).toBe("blocked");
    expect(continuationStatus("in_progress")).toBe("todo");
    expect(continuationStatus("backlog")).toBe("todo");
  });

  it("the continuation summary says where the work stands in a bounded space", () => {
    const previews = Array.from({ length: 30 }, (_, i) => ({ pageUrl: `https://acme.co.za/p/${i}`, title: `Page ${i}`, status: "pending", reviewStatus: "changes_needed", reviewNote: "N".repeat(900), previewId: `pv-${i}` }));
    const text = continuationSummary({
      oldIdentifier: "PAR-528",
      bytes: 103_000,
      comments: 42,
      reason: "it passed the size the plugin allows",
      task: { title: "Rewrite the top 10 pages", status: "in_progress", blockerReason: null, humanAsk: null, startedAt: "2026-10-02T16:55:00Z", evidenceSummary: "S".repeat(2_000) },
      previews,
      lastComments: [1, 2, 3, 4].map((n) => ({ author: "agent", at: `2026-10-03T05:0${n}:00Z`, body: "B".repeat(2_000) })),
      sprintId: "sp-1",
    });
    expect(text).toContain("Continuation of PAR-528");
    expect(text).toContain("103 KB, 42 comments");
    expect(text).toContain("previewId `pv-0`");
    expect(text).toContain("…and 18 older ones.");
    expect(text).toContain("list-previews");
    expect(text).toMatch(/Review or build issues opened for this task before the move still name PAR-528 as their parent/);
    expect((text.match(/^- agent,/gm) ?? []).length).toBe(3);
    expect(text.length).toBeLessThan(9_000);
  });
});

describe("the move record (claim and backoff) rules", () => {
  const NOW = Date.parse("2026-10-03T08:00:00Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const MIN = 60_000;

  it("a failed move waits an hour, then two, four... at most a day", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map((n) => failureBackoffMs(n) / 3_600_000)).toEqual([1, 2, 4, 8, 16, 24, 24]);
    expect(failureBackoffMs(0)).toBe(3_600_000);
  });

  it("the automatic guard honours a recent move, an unfinished claim and a failure; a named request mostly does not", () => {
    expect(moveHold(null, NOW, false)).toBeNull();
    expect(moveHold({ at: ago(30 * MIN), state: "moved", failures: 0 }, NOW, false)).toMatch(/last 2 hours/);
    expect(moveHold({ at: ago(121 * MIN), state: "moved", failures: 0 }, NOW, false)).toBeNull();
    expect(moveHold({ at: ago(10 * MIN), state: "claimed", failures: 0 }, NOW, false)).toMatch(/did not finish/);
    expect(moveHold({ at: ago(61 * MIN), state: "claimed", failures: 0 }, NOW, false)).toBeNull();
    expect(moveHold({ at: ago(5 * MIN), state: "failed", failures: 1 }, NOW, false)).toMatch(/failed; it is tried again in about 55 minutes/);
    expect(moveHold({ at: ago(61 * MIN), state: "failed", failures: 1 }, NOW, false)).toBeNull();
    expect(moveHold({ at: ago(61 * MIN), state: "failed", failures: 2 }, NOW, false)).toMatch(/2 in a row.*about 59 minutes/);
    expect(moveHold({ at: ago(30 * MIN), state: "failed", failures: 6 }, NOW, false)).toMatch(/about 24 hours/);
    // A named request retries a failure or a recent move at once, but not a claim that may still be running.
    expect(moveHold({ at: ago(5 * MIN), state: "failed", failures: 3 }, NOW, true)).toBeNull();
    expect(moveHold({ at: ago(5 * MIN), state: "moved", failures: 0 }, NOW, true)).toBeNull();
    expect(moveHold({ at: ago(2 * MIN), state: "claimed", failures: 0 }, NOW, true)).toMatch(/under way/);
    expect(moveHold({ at: ago(6 * MIN), state: "claimed", failures: 0 }, NOW, true)).toBeNull();
  });

  it("reads a stored record, and an older bare timestamp as a move", () => {
    expect(parseRollMark({ at: "2026-10-03T08:00:00Z", state: "failed", failures: 2 })).toEqual({ at: "2026-10-03T08:00:00Z", state: "failed", failures: 2 });
    expect(parseRollMark("2026-10-03T08:00:00Z")).toEqual({ at: "2026-10-03T08:00:00Z", state: "moved", failures: 0 });
    expect(parseRollMark({ at: "2026-10-03T08:00:00Z", state: "claimed" })).toEqual({ at: "2026-10-03T08:00:00Z", state: "claimed", failures: 0 });
    for (const bad of [null, undefined, "yesterday", 5, {}, { at: "nope", state: "moved" }, { at: "2026-10-03T08:00:00Z", state: "paused" }]) expect(parseRollMark(bad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A fake host
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const ISSUE_PARENT = "root-1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Issues the fake host creates get ids 900+ (the fixtures use their PAR numbers). */
const isNew = (id: string) => Number(id.slice(-12)) >= 901;

interface Fixture {
  id: string;
  identifier: string;
  taskId: string;
  status?: string;
  assignee?: string | null;
  bytes: number;
  comments?: number;
  taskStatus?: string;
  e2big?: boolean;
  /** The agent's latest run on the issue is queued or running. */
  active?: boolean;
}

const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "Hunt and Gun", site_url: "https://huntandgun.co.za", site_name: "Hunt and Gun", client_ref: "crm-1", client_kind: "company", client_name: "Hunt and Gun",
  status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 4, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "proj-1", client_project_id: "proj-client", root_issue_id: ISSUE_PARENT, root_issue_identifier: "PAR-150", agent_id: "seo-1", site_access: "wordpress", site_id: "site-1",
  change_policy: "pr_only", notes: null, paused_reason: null, health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1,
  last_daily_on: null, last_weekly_on: null, audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

function taskRow(f: Fixture): Row {
  return {
    id: f.taskId, company_id: "co-1", sprint_id: "sp-1", template_key: "w3-homepage", week: 3, phase: 1, due_day: 20, focus: "Core Pages", title: `Task ${f.identifier}`, description: null,
    task_type: "page-write", owner: "agent", autopilot_eligible: true, playbook_key: "w3-homepage", status: f.taskStatus ?? "in_progress", source: "template", parent_optimization_id: null,
    context: null, issue_id: f.id, issue_identifier: f.identifier, issue_status: f.status ?? "in_progress", assignee_kind: "agent", blocker_reason: null, human_ask: null,
    evidence: { summary: "Drafted five category pages." }, started_at: "2026-10-02T16:55:00Z", completed_at: null, completed_by: null, created_at: null, updated_at: null, issue_project_id: "proj-client",
  };
}

interface HostOptions {
  sizesUnreadable?: boolean;
  failCancel?: boolean;
  /** Read at call time: a test can flip it between runs. */
  rejectAssignee?: boolean;
  modulesOff?: boolean;
  /** The host refuses to write the task row (so the move fails after the new issue exists). */
  failTaskWrite?: boolean;
  /** Writing / reading the plugin's state fails. */
  stateWriteFails?: boolean;
  stateReadFails?: boolean;
  /** Agents the host reports as terminated, by id. */
  terminated?: string[];
}

function host(fixtures: Fixture[], options: HostOptions = {}) {
  const tasks = new Map<string, Row>(fixtures.map((f) => [f.taskId, taskRow(f)]));
  const issues = new Map<string, Row>(
    fixtures.map((f) => [f.id, { id: f.id, companyId: "co-1", identifier: f.identifier, title: `Task ${f.identifier}`, status: f.status ?? "in_progress", assigneeAgentId: f.assignee === undefined ? "seo-1" : f.assignee, projectId: "proj-client", parentId: ISSUE_PARENT, priority: "medium", description: "old" }]),
  );
  const sizes = new Map<string, { comments: number; bytes: number }>(fixtures.map((f) => [f.id, { comments: f.comments ?? 40, bytes: f.bytes }]));
  const e2big = new Set(fixtures.filter((f) => f.e2big).map((f) => f.id));
  const active = new Set(fixtures.filter((f) => f.active).map((f) => f.id));
  const previews: Row[] = [
    { id: "pv-1", page_url: "https://huntandgun.co.za/category/rifle/", title: "Rifle", status: "pending", review_status: "changes_needed", review_note: "The listing grid loses its price column on the phone layout." },
  ];
  const log: string[] = [];
  const created: Row[] = [];
  const comments: Array<{ id: string; body: string }> = [];
  const wakes: string[] = [];
  const updates: Array<{ id: string; patch: Row }> = [];
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const state = new Map<string, unknown>();
  let clock = new Date("2026-10-03T08:00:00Z").getTime();
  let counter = 0;

  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs", "issue_comments"]);
        validateParams(sql, params);
        if (/FROM plugin_seo_\w+\.sprint_tasks\s+WHERE company_id = \$1 AND issue_id IS NOT NULL/.test(sql)) {
          // Paused and archived sprints are left out in SQL: a move would wake the agent on work that is meant to stand still.
          expect(sql).toMatch(/sprint_id IN \(SELECT id FROM plugin_seo_\w+\.sprints WHERE company_id = \$1 AND status NOT IN \('paused', 'archived'\)\)/);
          return [...tasks.values()].filter((t) => t.issue_id && ["in_progress", "not_started", "blocked"].includes(String(t.status)) && ["todo", "in_progress", "blocked", "backlog"].includes(String(t.issue_status)));
        }
        if (/FROM plugin_seo_\w+\.sprint_tasks WHERE id = \$1/.test(sql)) return [tasks.get(String(params[0]))].filter(Boolean) as Row[];
        if (/FROM plugin_seo_\w+\.sprints WHERE id = \$1/.test(sql)) return [SPRINT];
        if (/SELECT DISTINCT company_id/.test(sql)) return [{ company_id: "co-1" }];
        if (/count\(\*\)::int AS comments/.test(sql)) {
          if (options.sizesUnreadable) throw new Error("Plugin SQL references public.issue_comments, which is not whitelisted");
          const wanted = JSON.parse(String(params[1])) as string[];
          return wanted.filter((id) => sizes.has(id)).map((id) => ({ issue_id: id, comments: sizes.get(id)!.comments, bytes: sizes.get(id)!.bytes }));
        }
        if (/FROM public\.heartbeat_runs r/.test(sql)) {
          const wanted = JSON.parse(String(params[1])) as string[];
          expect(sql).toMatch(/AS active/);
          return wanted.filter((id) => e2big.has(id) || active.has(id)).map((id) => ({ issue_id: id, error: e2big.has(id) ? "spawn E2BIG" : null, at: "2026-10-03T05:13:45Z", active: active.has(id) }));
        }
        if (/FROM public\.issue_comments c\s+WHERE c\.company_id = \$1 AND c\.issue_id = \$2::uuid/.test(sql)) {
          return [{ author: "agent", at: "2026-10-03 05:07:00", body: "Rifle layout fix is in; waiting for the Reviewer." }];
        }
        if (/FROM plugin_seo_\w+\.previews\s+WHERE company_id = \$1 AND task_id = \$2/.test(sql)) return previews;
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        executes.push({ sql, params });
        const set = /UPDATE plugin_seo_\w+\.sprint_tasks SET (.*) WHERE id = \$(\d+) AND company_id = \$(\d+)/.exec(sql);
        if (set && options.failTaskWrite) throw new Error("the host refused the write");
        if (set) {
          log.push("task repointed");
          const row = tasks.get(String(params[Number(set[2]) - 1]));
          if (row) for (const m of set[1]!.matchAll(/(\w+) = \$(\d+)/g)) row[m[1]!] = params[Number(m[2]) - 1];
        }
        if (/UPDATE plugin_seo_\w+\.previews SET issue_id/.test(sql)) log.push("previews repointed");
        return { rowCount: 1 };
      },
    },
    config: { get: vi.fn(async () => ({})) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })), list: vi.fn(async () => [{ id: "co-1" }]) },
    agents: { get: vi.fn(async (id: string) => (id === "seo-1" || id.startsWith("gone-") ? { id, name: "SEO Specialist", status: options.terminated?.includes(id) ? "terminated" : "idle", role: "general" } : null)), managed: { get: vi.fn(async () => ({ agentId: null, agent: null })) } },
    state: {
      get: vi.fn(async (key: { stateKey: string; namespace?: string }) => {
        if (key.stateKey === "modules" && options.modulesOff) return { companyId: "co-1", modules: { seo: false }, updatedAt: "2026-09-01T00:00:00Z" };
        if (key.stateKey.startsWith("role:")) return { agentId: "seo-1", linkedAt: "2026-09-01T00:00:00Z", linkedBy: "manual", hire: null };
        if (options.stateReadFails && key.namespace === "seo-thread-roll") throw new Error("state down");
        return state.get(`${key.namespace}:${key.stateKey}`) ?? null;
      }),
      set: vi.fn(async (key: { stateKey: string; namespace?: string }, value: unknown) => {
        if (options.stateWriteFails && key.namespace === "seo-thread-roll") throw new Error("state down");
        state.set(`${key.namespace}:${key.stateKey}`, value);
      }),
    },
    issues: {
      get: vi.fn(async (id: string) => issues.get(id) ?? null),
      create: vi.fn(async (input: Row) => {
        if (options.rejectAssignee && input.assigneeAgentId) throw new Error("assignee rejected");
        counter += 1;
        const id = uuid(900 + counter);
        const issue = { id, companyId: "co-1", identifier: `PAR-${900 + counter}`, ...input };
        issues.set(id, issue);
        created.push(issue);
        log.push("issue created");
        return issue;
      }),
      update: vi.fn(async (id: string, patch: Row) => {
        if (options.failCancel && patch.status === "cancelled" && !isNew(String(id))) throw new Error("the host refused");
        updates.push({ id, patch });
        if (patch.status === "cancelled" && !isNew(String(id))) log.push("old cancelled");
        const issue = { ...(issues.get(id) ?? { id }), ...patch };
        issues.set(id, issue);
        return issue;
      }),
      createComment: vi.fn(async (id: string, body: string) => {
        comments.push({ id, body });
        return { id: "c" };
      }),
      requestWakeup: vi.fn(async (id: string) => {
        wakes.push(id);
        return { queued: true, runId: null };
      }),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
  const env = createEnv(ctx, { now: () => new Date(clock), fetch: vi.fn() as never, site: vi.fn() as never });
  return {
    env,
    ctx,
    tasks,
    issues,
    sizes,
    created,
    comments,
    wakes,
    updates,
    executes,
    log,
    state,
    active,
    advance: (ms: number) => void (clock += ms),
  };
}

const PAR528: Fixture = { id: uuid(528), identifier: "PAR-528", taskId: "t-528", bytes: 102_996, comments: 42 };
const PAR545: Fixture = { id: uuid(545), identifier: "PAR-545", taskId: "t-545", bytes: 103_916, comments: 46 };
const PAR130: Fixture = { id: uuid(130), identifier: "PAR-130", taskId: "t-130", bytes: 79_344, comments: 53, status: "blocked", taskStatus: "blocked" };
const SMALL: Fixture = { id: uuid(525), identifier: "PAR-525", taskId: "t-525", bytes: 352, comments: 1 };

describe("text copied into a continuation issue", () => {
  it("loses links and mentions, so an old @-mention cannot wake an agent from the new issue", () => {
    expect(plainText("[@SEO Specialist](agent://75e41a0f-354a-4af6-ac41-183ffb4d44e8): the Rifle layout fix is in")).toBe("SEO Specialist: the Rifle layout fix is in");
    expect(plainText("see [the review page](https://preview.partnersinbiz.online/p/hg/tok/review?key=k) and @Operator, agent://abc-123 too")).toBe("see the review page and Operator,  too");
    expect(plainText("mail me at peet@example.com or 5 @ 3pm")).toBe("mail me at peet@example.com or 5 @ 3pm");
    const summary = continuationSummary({
      oldIdentifier: "PAR-545", bytes: 103_000, comments: 46, reason: "x",
      task: { title: "T", status: "in_progress", blockerReason: null, humanAsk: "Ask [@Owner](user://u-1) to connect it", startedAt: null, evidenceSummary: null },
      previews: [], lastComments: [{ author: "plugin", at: "2026-10-03T05:08:00Z", body: "[@SEO Specialist](agent://75e41a0f) please look" }], sprintId: "sp-1",
    });
    expect(summary).not.toMatch(/agent:\/\/|user:\/\/|@Owner|@SEO/);
    expect(summary).toContain("SEO Specialist please look");
    expect(summary).toContain("Ask Owner to connect it");
  });
});

describe("compact-task-thread: dry run first", () => {
  it("reports the issues that would move and changes nothing", async () => {
    const h = host([PAR528, PAR545, PAR130, SMALL]);
    const out = await compactTaskThreadTool(h.env, "co-1", {});
    expect(out).toMatchObject({ dryRun: true, thresholdBytes: 60_000, sizesAvailable: true, checked: 4, rolled: 0 });
    expect(out.items.map((i) => [i.identifier, i.action, i.reason, i.bytes])).toEqual([
      ["PAR-528", "would_roll", "size", 102_996],
      ["PAR-545", "would_roll", "size", 103_916],
      ["PAR-130", "would_roll", "size", 79_344],
    ]);
    expect(out.next).toMatch(/dryRun false/);
    expect(h.created).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.comments).toEqual([]);
    expect(h.executes).toEqual([]);
    expect(h.wakes).toEqual([]);
  });

  it("is the tool's default, and dryRun false moves them", async () => {
    expect(HANDLERS["compact-task-thread"]).toBeDefined();
    const h = host([PAR528]);
    expect(((await HANDLERS["compact-task-thread"]!(h.env, "co-1", { kind: "system" }, {})) as { dryRun: boolean }).dryRun).toBe(true);
    expect(h.created).toHaveLength(0);
    const live = (await compactTaskThreadTool(h.env, "co-1", { dryRun: false })) as { rolled: number };
    expect(live.rolled).toBe(1);
    expect(h.created).toHaveLength(1);
  });
});

describe("moving a task thread", () => {
  it("opens a continuation issue, repoints the task and previews, closes the old issue with a pointer, wakes the agent on the new one", async () => {
    const h = host([PAR528, PAR545]);
    const out = await compactTaskThreads(h.env, "co-1", { dryRun: false, issue: "PAR-528" });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ identifier: "PAR-528", action: "rolled", newIdentifier: "PAR-901" });
    expect(out.rolled).toBe(1);

    const [fresh] = h.created;
    expect(fresh).toMatchObject({
      companyId: "co-1",
      status: "todo",
      originKind: "plugin:partnersinbiz.seo:task",
      originId: "seo:task:t-528",
      parentId: ISSUE_PARENT,
      projectId: "proj-client",
      assigneeAgentId: "seo-1",
      priority: "medium",
      title: "Task PAR-528",
      // The follow-up carries on in the old issue's checkout / worktree.
      inheritExecutionWorkspaceFromIssueId: PAR528.id,
    });
    const description = String(fresh!.description);
    expect(description).toContain("Continuation of PAR-528");
    expect(description).toContain("103 KB, 42 comments");
    expect(description).toContain("Drafted five category pages.");
    expect(description).toContain("https://huntandgun.co.za/category/rifle/");
    expect(description).toContain("Rifle layout fix is in; waiting for the Reviewer.");
    // The task's own description (steps, tools, ids) comes with it.
    expect(description).toContain("sprintId: `sp-1` · taskId: `t-528`");
    expect(description.length).toBeLessThan(30_000);

    // The task and its previews follow the new issue before the old one closes.
    expect(h.log).toEqual(["issue created", "task repointed", "previews repointed", "old cancelled"]);
    expect(h.tasks.get("t-528")).toMatchObject({ issue_id: uuid(901), issue_identifier: "PAR-901", issue_status: "todo" });
    expect(h.executes.find((e) => /UPDATE plugin_seo_\w+\.previews SET issue_id/.test(e.sql))!.params).toEqual(["co-1", PAR528.id, uuid(901)]);
    // A split task's page groups follow it to the new issue, finished ones too: the new issue still waits for them.
    const chunks = h.executes.find((e) => /UPDATE plugin_seo_\w+\.task_chunks SET parent_issue_id = \$3/.test(e.sql))!;
    expect(chunks.sql).toContain("WHERE company_id = $1 AND parent_issue_id = $2");
    expect(chunks.params).toEqual(["co-1", PAR528.id, uuid(901)]);

    const pointer = h.comments.find((c) => c.id === PAR528.id)!;
    expect(pointer.body).toContain("Moved to PAR-901");
    expect(pointer.body).toContain("103 KB");
    expect(h.updates.find((u) => u.id === PAR528.id)!.patch).toEqual({ status: "cancelled" });
    expect(h.wakes).toEqual([uuid(901)]);
    // The other task was not named, so it was not touched.
    expect(h.tasks.get("t-545")).toMatchObject({ issue_id: PAR545.id });
  });

  it("is idempotent: a second run finds nothing to move", async () => {
    const h = host([PAR528, PAR545]);
    h.sizes.set(uuid(901), { comments: 0, bytes: 0 });
    h.sizes.set(uuid(902), { comments: 0, bytes: 0 });
    const first = await compactTaskThreads(h.env, "co-1", { dryRun: false });
    expect(first.rolled).toBe(2);
    const second = await compactTaskThreads(h.env, "co-1", { dryRun: false });
    expect(second).toMatchObject({ rolled: 0, items: [] });
    expect(h.created).toHaveLength(2);
    expect(h.wakes).toEqual([uuid(901), uuid(902)]);
  });

  it("a waiting task keeps waiting: the continuation is blocked and nobody is woken", async () => {
    const h = host([PAR130]);
    const out = await compactTaskThreads(h.env, "co-1", { dryRun: false });
    expect(out.items[0]).toMatchObject({ identifier: "PAR-130", action: "rolled" });
    expect(h.updates.find((u) => u.id === uuid(901))!.patch).toEqual({ status: "blocked" });
    expect(h.tasks.get("t-130")).toMatchObject({ issue_id: uuid(901), issue_status: "blocked" });
    expect(h.wakes).toEqual([]);
  });

  it("leaves issues no agent can be woken on, and a task moved in the last two hours (unless named)", async () => {
    const review: Fixture = { id: uuid(526), identifier: "PAR-526", taskId: "t-526", bytes: 90_000 };
    const unassigned: Fixture = { id: uuid(527), identifier: "PAR-527", taskId: "t-527", bytes: 90_000, assignee: null };
    const h = host([review, unassigned, PAR528]);
    // The task row still says in progress; the host's issue has since gone to review.
    h.issues.get(review.id)!.status = "in_review";
    const first = await compactTaskThreads(h.env, "co-1", { dryRun: false });
    expect(first.items.map((i) => [i.identifier, i.action])).toEqual([["PAR-526", "skipped"], ["PAR-527", "skipped"], ["PAR-528", "rolled"]]);
    expect(first.items[0]!.detail).toMatch(/in review/);
    expect(first.items[1]!.detail).toMatch(/not assigned to an agent/);
    // The new issue is already big again: the guard does not churn it within two hours, a named request does.
    h.sizes.set(uuid(901), { comments: 90, bytes: 95_000 });
    const again = await compactTaskThreads(h.env, "co-1", { dryRun: false });
    expect(again.items.find((i) => i.identifier === "PAR-901")).toMatchObject({ action: "skipped", detail: expect.stringMatching(/last 2 hours/) });
    h.advance(2 * 3_600_000 + 1_000);
    expect((await compactTaskThreads(h.env, "co-1", { dryRun: true })).items.find((i) => i.identifier === "PAR-901")).toMatchObject({ action: "would_roll" });
  });

  it("says so when the named issue is not an open task issue (for example one already moved)", async () => {
    const h = host([PAR528]);
    await compactTaskThreads(h.env, "co-1", { dryRun: false, issue: "PAR-528" });
    const again = await compactTaskThreadTool(h.env, "co-1", { issueId: "PAR-528", dryRun: false });
    expect(again).toMatchObject({ checked: 0, rolled: 0, items: [] });
    expect(again.next).toMatch(/already have been moved/);
    expect(h.created).toHaveLength(1);
  });

  it("tells a person who names a small thread why nothing moves", async () => {
    const h = host([SMALL]);
    const out = await compactTaskThreads(h.env, "co-1", { dryRun: false, issue: "PAR-525" });
    expect(out.items).toEqual([expect.objectContaining({ identifier: "PAR-525", action: "skipped", detail: expect.stringMatching(/352 bytes, under the 60000/) })]);
    expect(h.created).toEqual([]);
    const lowered = await compactTaskThreads(h.env, "co-1", { dryRun: true, issue: "PAR-525", minBytes: 10_000 });
    expect(lowered.items[0]).toMatchObject({ action: "skipped" });
  });

  it("takes the agent off an old issue the host will not close, and does not move anything if the new one cannot be assigned", async () => {
    const stuck = host([PAR528], { failCancel: true });
    const out = await compactTaskThreads(stuck.env, "co-1", { dryRun: false });
    expect(out.items[0]).toMatchObject({ action: "rolled", detail: expect.stringMatching(/agent was taken off/) });
    expect(stuck.updates.find((u) => u.id === PAR528.id)!.patch).toEqual({ assigneeAgentId: null });

    const rejected = host([PAR545], { rejectAssignee: true });
    const failed = await compactTaskThreads(rejected.env, "co-1", { dryRun: false });
    expect(failed.items[0]).toMatchObject({ action: "failed", detail: expect.stringMatching(/nothing was moved/) });
    expect(rejected.tasks.get("t-545")).toMatchObject({ issue_id: PAR545.id });
    expect(rejected.updates.some((u) => u.id === uuid(901) && u.patch.status === "cancelled")).toBe(true);
    expect(rejected.wakes).toEqual([]);
  });
});

describe("a move that fails is not repeated every run (the claim)", () => {
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const junk = (h: ReturnType<typeof host>) => h.updates.filter((u) => u.patch.status === "cancelled" && isNew(u.id)).length;

  it("a host that rejects the assignee costs one junk issue per task, then waits an hour, two, four", async () => {
    const options: HostOptions = { rejectAssignee: true };
    const h = host([PAR528, PAR545], options);
    const first = await guardTaskThreads(h.env, ["co-1"]);
    expect(first).toEqual({ checked: 2, rolled: 0 });
    expect(h.created).toHaveLength(2);
    expect(junk(h)).toBe(2);
    expect(h.tasks.get("t-528")).toMatchObject({ issue_id: PAR528.id });
    expect(h.state.get("seo-thread-roll:t-528")).toMatchObject({ state: "failed", failures: 1 });

    // The 5-minute job runs again twice: nothing new is opened.
    h.advance(5 * MIN);
    await guardTaskThreads(h.env, ["co-1"]);
    h.advance(5 * MIN);
    const third = await compactTaskThreads(h.env, "co-1", { dryRun: false });
    expect(h.created).toHaveLength(2);
    expect(third.items.map((i) => [i.identifier, i.action])).toEqual([["PAR-528", "skipped"], ["PAR-545", "skipped"]]);
    expect(third.items[0]!.detail).toMatch(/failed; it is tried again in about 50 minutes/);

    // After an hour it tries once more per task; the second failure waits two hours.
    h.advance(HOUR);
    await guardTaskThreads(h.env, ["co-1"]);
    expect(h.created).toHaveLength(4);
    expect(h.state.get("seo-thread-roll:t-528")).toMatchObject({ state: "failed", failures: 2 });
    h.advance(HOUR);
    await guardTaskThreads(h.env, ["co-1"]);
    expect(h.created).toHaveLength(4);
    h.advance(HOUR + MIN);
    await guardTaskThreads(h.env, ["co-1"]);
    expect(h.created).toHaveLength(6);
    expect(junk(h)).toBe(6);

    // The host recovers: the next try (after four hours) moves them and clears the failures.
    options.rejectAssignee = false;
    h.advance(3 * HOUR);
    expect(await guardTaskThreads(h.env, ["co-1"])).toEqual({ checked: 2, rolled: 0 });
    h.advance(HOUR + MIN);
    expect(await guardTaskThreads(h.env, ["co-1"])).toEqual({ checked: 2, rolled: 2 });
    expect(h.tasks.get("t-528")).toMatchObject({ issue_id: expect.not.stringMatching(new RegExp(`${PAR528.id}`)) });
    expect(h.state.get("seo-thread-roll:t-528")).toMatchObject({ state: "moved", failures: 0 });
    expect(h.wakes).toHaveLength(2);
  });

  it("a person naming the issue retries at once, after the cause is fixed", async () => {
    const options: HostOptions = { rejectAssignee: true };
    const h = host([PAR528], options);
    await compactTaskThreads(h.env, "co-1", { dryRun: false, issue: "PAR-528" });
    expect(h.created).toHaveLength(1);
    options.rejectAssignee = false;
    h.advance(MIN);
    const out = await compactTaskThreads(h.env, "co-1", { dryRun: false, issue: "PAR-528" });
    expect(out.items[0]).toMatchObject({ action: "rolled" });
    expect(h.created).toHaveLength(2);
  });

  it("two jobs starting together move one task once", async () => {
    const h = host([PAR528]);
    const [a, b] = await Promise.all([guardTaskThreads(h.env, ["co-1"]), compactTaskThreads(h.env, "co-1", { dryRun: false })]);
    expect(a.rolled + b.rolled).toBe(1);
    expect(h.created).toHaveLength(1);
    expect(h.wakes).toEqual([uuid(901)]);
    expect(h.updates.filter((u) => u.id === PAR528.id && u.patch.status === "cancelled")).toHaveLength(1);
    expect(h.comments.filter((c) => c.id === PAR528.id)).toHaveLength(1);
  });

  it("two named requests for the same issue move it once", async () => {
    const h = host([PAR528]);
    const [a, b] = await Promise.all([compactTaskThreads(h.env, "co-1", { dryRun: false, issue: "PAR-528" }), compactTaskThreads(h.env, "co-1", { dryRun: false, issue: "PAR-528" })]);
    expect(a.rolled + b.rolled).toBe(1);
    expect(h.created).toHaveLength(1);
    expect(h.wakes).toHaveLength(1);
  });

  it("a claim another process left (fresh) holds the task: the guard for an hour, a named request for five minutes", async () => {
    const h = host([PAR528]);
    h.state.set("seo-thread-roll:t-528", { at: h.env.now().toISOString(), state: "claimed", failures: 0 });
    const auto = await compactTaskThreads(h.env, "co-1", { dryRun: false });
    expect(auto.items[0]).toMatchObject({ action: "skipped", detail: expect.stringMatching(/did not finish/) });
    const named = await compactTaskThreads(h.env, "co-1", { dryRun: false, issue: "PAR-528" });
    expect(named.items[0]).toMatchObject({ action: "skipped", detail: expect.stringMatching(/under way/) });
    expect(h.created).toEqual([]);
    h.advance(6 * MIN);
    expect((await compactTaskThreads(h.env, "co-1", { dryRun: false })).rolled).toBe(0);
    expect((await compactTaskThreads(h.env, "co-1", { dryRun: false, issue: "PAR-528" })).rolled).toBe(1);
  });

  it("the claim is written before anything is opened, and a dry run writes nothing", async () => {
    const h = host([PAR528]);
    await compactTaskThreads(h.env, "co-1", { dryRun: true });
    expect(h.state.size).toBe(0);
    const stateSet = h.ctx.state.set as unknown as ReturnType<typeof vi.fn>;
    const created = h.ctx.issues.create as unknown as ReturnType<typeof vi.fn>;
    await compactTaskThreads(h.env, "co-1", { dryRun: false });
    const claimCall = stateSet.mock.calls.findIndex(([key, value]) => key.namespace === "seo-thread-roll" && (value as { state: string }).state === "claimed");
    expect(claimCall).toBeGreaterThanOrEqual(0);
    expect(stateSet.mock.invocationCallOrder[claimCall]).toBeLessThan(created.mock.invocationCallOrder[0]!);
    expect(h.state.get("seo-thread-roll:t-528")).toMatchObject({ state: "moved", failures: 0 });
  });

  it("the automatic guard does nothing when it cannot record the claim; a named request still goes", async () => {
    const write = host([PAR528], { stateWriteFails: true });
    const out = await compactTaskThreads(write.env, "co-1", { dryRun: false });
    expect(out.items[0]).toMatchObject({ action: "skipped", detail: expect.stringMatching(/could not be recorded/) });
    expect(write.created).toEqual([]);
    expect((await compactTaskThreads(write.env, "co-1", { dryRun: false, issue: "PAR-528" })).rolled).toBe(1);
    const read = host([PAR545], { stateReadFails: true });
    const blind = await compactTaskThreads(read.env, "co-1", { dryRun: false });
    expect(blind.items[0]).toMatchObject({ action: "skipped", detail: expect.stringMatching(/could not be read/) });
    expect(read.created).toEqual([]);
  });

  it("a move that dies after the new issue exists cancels it, leaves the old issue alone, and backs off", async () => {
    const options: HostOptions = { failTaskWrite: true };
    const h = host([PAR528], options);
    const out = await compactTaskThreads(h.env, "co-1", { dryRun: false });
    expect(out.items[0]).toMatchObject({ action: "failed", detail: expect.stringMatching(/refused the write/) });
    expect(h.created).toHaveLength(1);
    expect(junk(h)).toBe(1);
    expect(h.issues.get(PAR528.id)!.status).toBe("in_progress");
    expect(h.tasks.get("t-528")).toMatchObject({ issue_id: PAR528.id });
    expect(h.wakes).toEqual([]);
    expect(h.state.get("seo-thread-roll:t-528")).toMatchObject({ state: "failed", failures: 1 });
    // The lock is released: once the cause is gone a named request moves it.
    options.failTaskWrite = false;
    expect((await compactTaskThreads(h.env, "co-1", { dryRun: false, issue: "PAR-528" })).rolled).toBe(1);
  });
});

describe("an issue an agent is working on is not moved under it", () => {
  it("waits for the run to end, then moves; a named request does not wait", async () => {
    const busy: Fixture = { ...PAR528, active: true };
    const h = host([busy]);
    const dry = await compactTaskThreads(h.env, "co-1", { dryRun: true });
    expect(dry.items[0]).toMatchObject({ action: "skipped", detail: expect.stringMatching(/run is working on it/) });
    expect((await compactTaskThreads(h.env, "co-1", { dryRun: false })).rolled).toBe(0);
    expect(h.created).toEqual([]);
    expect(h.state.size).toBe(0);
    h.active.delete(busy.id);
    expect((await guardTaskThreads(h.env, ["co-1"])).rolled).toBe(1);
    expect(h.created).toHaveLength(1);
    const forced = host([{ ...PAR545, active: true }]);
    expect((await compactTaskThreads(forced.env, "co-1", { dryRun: false, issue: "PAR-545" })).rolled).toBe(1);
  });

  it("an issue whose latest run failed with E2BIG is not busy, and moves", async () => {
    const h = host([{ ...PAR528, bytes: 45_000, e2big: true }]);
    const out = await compactTaskThreads(h.env, "co-1", { dryRun: false });
    expect(out.items[0]).toMatchObject({ action: "rolled", reason: "e2big" });
  });
});

describe("an issue whose agent can no longer be woken is left alone", () => {
  it("skips a terminated or missing agent without opening anything", async () => {
    const terminated = host([{ ...PAR528, assignee: "gone-1" }], { terminated: ["gone-1"] });
    const a = await compactTaskThreads(terminated.env, "co-1", { dryRun: false });
    expect(a.items[0]).toMatchObject({ action: "skipped", detail: expect.stringMatching(/terminated/) });
    expect(terminated.created).toEqual([]);
    const missing = host([{ ...PAR545, assignee: "nobody-1" }]);
    const b = await compactTaskThreads(missing.env, "co-1", { dryRun: false });
    expect(b.items[0]).toMatchObject({ action: "skipped", detail: expect.stringMatching(/no longer exists/) });
    expect(missing.created).toEqual([]);
    expect(missing.state.size).toBe(0);
  });
});

describe("without access to the host's comments", () => {
  it("finds issues whose runs failed with E2BIG, and a named one", async () => {
    const h = host([{ ...PAR528, e2big: true }, PAR545], { sizesUnreadable: true });
    const found = await compactTaskThreads(h.env, "co-1", { dryRun: true });
    expect(found.sizesAvailable).toBe(false);
    expect(found.items.map((i) => [i.identifier, i.reason, i.bytes])).toEqual([["PAR-528", "e2big", null]]);
    const named = await compactTaskThreads(h.env, "co-1", { dryRun: true, issue: "PAR-545" });
    expect(named.items.map((i) => [i.identifier, i.reason])).toEqual([["PAR-545", "requested"]]);
    const moved = await compactTaskThreads(h.env, "co-1", { dryRun: false, issue: "PAR-528" });
    expect(moved.rolled).toBe(1);
  });
});

describe("guardTaskThreads (the scheduled run)", () => {
  it("moves long threads for every SEO company, a few at a time", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: uuid(700 + i), identifier: `PAR-${700 + i}`, taskId: `t-${700 + i}`, bytes: 80_000 }));
    const h = host(many);
    const first = await guardTaskThreads(h.env, ["co-1"]);
    expect(first).toEqual({ checked: 8, rolled: 5 });
    h.sizes.set(uuid(901), { comments: 0, bytes: 0 });
    const second = await guardTaskThreads(h.env, ["co-1"]);
    expect(second.rolled).toBe(3);
    expect(h.created).toHaveLength(8);
  });

  it("skips a company that switched SEO off and never throws", async () => {
    const off = host([PAR528], { modulesOff: true });
    expect(await guardTaskThreads(off.env, ["co-1"])).toEqual({ checked: 0, rolled: 0 });
    expect(off.created).toEqual([]);
    const broken = host([PAR528]);
    broken.env.ctx.db.query = vi.fn(async () => {
      throw new Error("db down");
    }) as never;
    await expect(guardTaskThreads(broken.env, ["co-1"])).resolves.toEqual({ checked: 0, rolled: 0 });
  });
});
