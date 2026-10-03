import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { buildBrief, findBuilders, onBuildIssueUpdated, requestBuild } from "../src/service/build.js";
import { ORIGIN } from "../src/constants.js";

type Row = Record<string, unknown>;

const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_ref: null, client_name: "Acme Ltd",
  status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "proj-1", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", site_access: "wordpress", site_id: "site-1",
  change_policy: "pr_only", notes: null, paused_reason: null, health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1,
  last_daily_on: null, last_weekly_on: null, audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};
const TASK: Row = {
  id: "t-1", company_id: "co-1", sprint_id: "sp-1", template_key: "w3-homepage", week: 3, phase: 1, due_day: 20, focus: "Core Pages", title: "Write the home page",
  description: null, task_type: "page-write", owner: "agent", autopilot_eligible: true, playbook_key: "w3-homepage", status: "in_progress", source: "template",
  parent_optimization_id: null, context: null, issue_id: "iss-1", issue_identifier: "PAR-9", issue_status: "in_progress", assignee_kind: "agent", blocker_reason: null,
  human_ask: null, evidence: null, started_at: null, completed_at: null, completed_by: null, created_at: null, updated_at: null,
};

function host(opts: { sprint?: Row; task?: Row; previewStatus?: string | null; agents?: Array<Record<string, unknown>>; grants?: Array<Record<string, unknown>> } = {}) {
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const created: Array<Record<string, unknown>> = [];
  const comments: Array<{ id: string; body: string }> = [];
  const wakes: string[] = [];
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string) {
        if (/FROM plugin_seo_8099f8879a\.sprints WHERE id/.test(sql)) return [opts.sprint ?? SPRINT];
        if (/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE id/.test(sql)) return [opts.task ?? TASK];
        if (/FROM plugin_seo_8099f8879a\.previews/.test(sql)) return opts.previewStatus ? [{ status: opts.previewStatus }] : [];
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        executes.push({ sql, params });
        return { rowCount: 1 };
      },
    },
    config: { get: vi.fn(async () => ({})) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
    agents: { list: vi.fn(async () => opts.agents ?? [{ id: "dev-1", name: "Developer", status: "idle" }, { id: "sen-1", name: "Senior Developer", status: "idle" }, { id: "seo-1", name: "SEO Specialist", status: "running" }]) },
    authorization: { grants: { list: vi.fn(async () => opts.grants ?? [{ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }]) } },
    issues: {
      get: vi.fn(async (id: string) => (id === "bld-1" ? { id, status: "done", identifier: "PAR-20", originKind: ORIGIN.build, originId: "seo:build:t-1" } : { id, status: "todo", identifier: "PAR-9" })),
      create: vi.fn(async (input: Record<string, unknown>) => { created.push(input); return { id: "bld-1" }; }),
      createComment: vi.fn(async (id: string, body: string) => { comments.push({ id, body }); return { id: "c" }; }),
      requestWakeup: vi.fn(async (id: string) => { wakes.push(id); return { queued: true, runId: null }; }),
      update: vi.fn(),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    state: { get: vi.fn(async () => null), set: vi.fn() },
  } as unknown as PluginContext;
  return { env: createEnv(ctx, { now: () => new Date("2026-09-26T08:00:00Z") }), executes, created, comments, wakes, ctx };
}

const agent: Actor = { kind: "agent", agentId: "seo-1", runId: "run-1", responsibleUserId: null };
const base = { sprintId: "sp-1", taskId: "t-1", summary: "Home page rewrite", changeSet: "H1: old -> new" };

describe("request-build", () => {
  it("finds the Developer and Senior Developer by name, only when they can work", async () => {
    const { env } = host({ agents: [{ id: "d", name: "Developer", status: "paused" }, { id: "s", name: "Senior Developer", status: "idle" }] });
    const found = await findBuilders(env, "co-1");
    expect(found.developer).toBeNull();
    expect(found.senior).toMatchObject({ id: "s", level: "senior" });
  });

  it("on a sign-off site needs an approved preview", async () => {
    await expect(requestBuild(host().env, "co-1", agent, base)).rejects.toThrow(/sign-off first/);
    await expect(requestBuild(host({ previewStatus: "pending" }).env, "co-1", agent, { ...base, previewId: "p1" })).rejects.toThrow(/not approved/);
  });

  it("opens a build issue for the Developer under the task's issue and tells the task", async () => {
    const h = host({ previewStatus: "approved" });
    const out = (await requestBuild(h.env, "co-1", agent, { ...base, previewId: "p1", acceptance: "check-meta passes" })) as { buildIssueId: string; assignedTo: string };
    expect(out).toMatchObject({ buildIssueId: "bld-1", assignedTo: "Developer" });
    expect(h.created[0]).toMatchObject({ originKind: ORIGIN.build, originId: "seo:build:t-1", parentId: "iss-1", assigneeAgentId: "dev-1" });
    expect(String(h.created[0]!.description)).toContain("check-meta passes");
    expect(String(h.created[0]!.description)).toContain("/p/acme/p1");
    expect(h.comments[0]!.id).toBe("iss-1");
    expect(h.executes.some((e) => /UPDATE plugin_seo_8099f8879a\.sprint_tasks SET/.test(e.sql))).toBe(true);
  });

  it("level senior goes to the Senior Developer; a developer without plugin tools cannot take a WordPress build", async () => {
    const h = host({ previewStatus: "approved" });
    await requestBuild(h.env, "co-1", agent, { ...base, previewId: "p1", level: "senior" });
    expect(h.created[0]).toMatchObject({ assigneeAgentId: "sen-1" });
    const none = host({ previewStatus: "approved", grants: [{ permissionKey: "tasks:assign", scope: null }] });
    await expect(requestBuild(none.env, "co-1", agent, { ...base, previewId: "p1" })).rejects.toThrow(/cannot use plugin tools/);
  });

  it("refuses a second build while one is open", async () => {
    const task = { ...TASK, evidence: { builds: [{ issueId: "bld-0", agentId: "dev-1", at: "x" }] } };
    await expect(requestBuild(host({ previewStatus: "approved", task }).env, "co-1", agent, { ...base, previewId: "p1" })).rejects.toThrow(/already open/);
  });

  it("tells the task's issue and wakes the SEO agent once when the build is done", async () => {
    const task = { ...TASK, evidence: { builds: [{ issueId: "bld-1", agentId: "dev-1", at: "x" }] } };
    const h = host({ task });
    expect(await onBuildIssueUpdated(h.env, "co-1", "bld-1")).toBe(true);
    expect(h.comments[0]).toMatchObject({ id: "iss-1" });
    expect(h.comments[0]!.body).toMatch(/PAR-20 is done/);
    expect(h.wakes).toEqual(["iss-1"]);
    expect(await onBuildIssueUpdated(host().env, "co-1", "other")).toBe(false);
  });

  it("writes the brief with the rules and how to report", () => {
    const text = buildBrief({ taskTitle: "T", taskIdentifier: "PAR-9", summary: "S", changeSet: "C", acceptance: null, previewUrl: null, requester: "SEO", site: { url: "https://x.co.za", wordpressSiteId: null, repoUrl: "https://github.com/o/r", defaultBranch: "main", hosting: "vercel", policy: "merge_seo_scope", branch: "seo/t", access: "repo" } });
    expect(text).toMatch(/Do NOT merge/);
    expect(text).toMatch(/set this issue to done/);
  });
});
