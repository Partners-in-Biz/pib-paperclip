import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { reviewPreview } from "../src/service/preview.js";
import { onBuildIssueUpdated } from "../src/service/build.js";
import { ORIGIN } from "../src/constants.js";

type Row = Record<string, unknown>;
const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_ref: null, client_name: "Acme Ltd",
  status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "proj-1", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", site_access: "wordpress", site_id: "site-1",
  change_policy: "pr_only", notes: null, paused_reason: null, health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1,
  last_daily_on: null, last_weekly_on: null, audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};
const task = (extra: Row = {}): Row => ({
  id: "t-1", company_id: "co-1", sprint_id: "sp-1", template_key: "w3-homepage", week: 3, phase: 1, due_day: 20, focus: "Core Pages", title: "Home", description: null,
  task_type: "page-write", owner: "agent", autopilot_eligible: true, playbook_key: "w3-homepage", status: "blocked", source: "template", parent_optimization_id: null,
  context: null, issue_id: "iss-1", issue_identifier: "PAR-9", issue_status: "blocked", assignee_kind: "reviewer", blocker_reason: "Waiting for the Reviewer", human_ask: null,
  evidence: null, started_at: null, completed_at: null, completed_by: null, created_at: null, updated_at: null, ...extra,
});
const PREVIEW: Row = { id: "p1", task_id: "t-1", issue_id: "iss-1", page_url: "https://acme.co.za/", title: "Home", created_by: "seo-1", review_key: "rk", changes: { title: "T", bodyHtml: "<p>x</p>" }, stats: { rendered: { keptPct: 96 } } };

function host(opts: { task?: Row; agents?: Array<Record<string, unknown>>; newerPreview?: boolean } = {}) {
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const created: Array<Record<string, unknown>> = [];
  const comments: Array<{ id: string; body: string }> = [];
  const wakes: string[] = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string) {
        if (/FROM plugin_seo_8099f8879a\.sprints WHERE id/.test(sql)) return [SPRINT];
        if (/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE id/.test(sql)) return [opts.task ?? task()];
        if (/SELECT id FROM plugin_seo_8099f8879a\.previews/.test(sql)) return opts.newerPreview ? [{ id: "p2" }] : [];
        if (/FROM plugin_seo_8099f8879a\.previews/.test(sql)) return [PREVIEW];
        return [];
      },
      async execute(sql: string, params: unknown[] = []) { executes.push({ sql, params }); return { rowCount: 1 }; },
    },
    config: { get: vi.fn(async () => ({})) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
    state: { get: vi.fn(async () => null), set: vi.fn() },
    agents: { list: vi.fn(async () => opts.agents ?? [{ id: "dev-1", name: "Developer", status: "idle" }, { id: "sen-1", name: "Senior Developer", status: "idle" }]) },
    authorization: { grants: { list: vi.fn(async () => [{ permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } }]) } },
    issues: {
      get: vi.fn(async (id: string) => ({ id, status: "done", identifier: "PAR-30", originKind: ORIGIN.build, originId: "seo:build:t-1" })),
      create: vi.fn(async (input: Record<string, unknown>) => { created.push(input); return { id: "fix-1" }; }),
      createComment: vi.fn(async (id: string, body: string) => { comments.push({ id, body }); return { id: "c" }; }),
      requestWakeup: vi.fn(async (id: string) => { wakes.push(id); return { queued: true, runId: null }; }),
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); return { id, ...patch }; }),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
  return { env: createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") }), executes, created, comments, wakes, updates };
}

const reviewer: Actor = { kind: "agent", agentId: "rev-agent", runId: "r2", responsibleUserId: null };
const base = { sprintId: "sp-1", previewId: "p1", verdict: "changes", notes: "Copy is unreadable on the dark hero." };

describe("Reviewer sends a build problem to a developer", () => {
  it("opens a fix for the Developer, keeps the task parked and does not wake the SEO agent", async () => {
    const h = host();
    const out = (await reviewPreview(h.env, "co-1", reviewer, { ...base, fixBy: "developer" })) as { fixIssueId: string; fixedBy: string };
    expect(out).toMatchObject({ fixIssueId: "fix-1", fixedBy: "Developer" });
    expect(h.created[0]).toMatchObject({ originKind: ORIGIN.build, originId: "seo:build:t-1", parentId: "iss-1", assigneeAgentId: "dev-1" });
    const brief = String(h.created[0]!.description);
    expect(brief).toContain("unreadable on the dark hero");
    expect(brief).toContain("create-preview");
    expect(brief).toContain("review?key=rk");
    expect(h.wakes).not.toContain("iss-1"); // the developer is woken, the SEO agent is not
    expect(h.comments[0]!.body).toMatch(/BUILD problem/);
    expect(h.executes.some((e) => /UPDATE plugin_seo_8099f8879a\.sprint_tasks SET/.test(e.sql) && JSON.stringify(e.params).includes("preview-fix"))).toBe(true);
    expect(h.updates.some((u) => u.patch.status === "todo")).toBe(false);
  });

  it("senior goes to the Senior Developer", async () => {
    const h = host();
    await reviewPreview(h.env, "co-1", reviewer, { ...base, fixBy: "senior" });
    expect(h.created[0]).toMatchObject({ assigneeAgentId: "sen-1" });
  });

  it("wording problems and the default still go back to the SEO Specialist", async () => {
    const h = host();
    expect(await reviewPreview(h.env, "co-1", reviewer, base)).toMatchObject({ reviewStatus: "changes_needed" });
    expect(h.created).toHaveLength(0);
    expect(h.wakes).toEqual(["iss-1"]);
  });

  it("falls back to the SEO Specialist when no developer can take it or the fixes keep failing", async () => {
    const none = host({ agents: [] });
    await reviewPreview(none.env, "co-1", reviewer, { ...base, fixBy: "developer" });
    expect(none.created).toHaveLength(0);
    expect(none.wakes).toEqual(["iss-1"]);
    expect(none.comments[0]!.body).toMatch(/meant for a developer but no Developer/);
    const builds = [1, 2, 3].map((n) => ({ issueId: `f${n}`, agentId: "dev-1", at: "x", kind: "preview-fix", reported: "done" }));
    const tired = host({ task: task({ evidence: { builds } }) });
    await reviewPreview(tired.env, "co-1", reviewer, { ...base, fixBy: "developer" });
    expect(tired.created).toHaveLength(0);
    expect(tired.comments[0]!.body).toMatch(/3 developer fixes/);
  });
});

describe("developer finishes a preview fix", () => {
  const withFix = (extra: Row = {}) => task({ evidence: { builds: [{ issueId: "fix-1", agentId: "dev-1", at: "2026-10-02T11:00:00Z", kind: "preview-fix" }] }, ...extra });

  it("reopens the fix when no corrected preview was made", async () => {
    const h = host({ task: withFix(), newerPreview: false });
    expect(await onBuildIssueUpdated(h.env, "co-1", "fix-1")).toBe(true);
    expect(h.updates).toEqual([{ id: "fix-1", patch: { status: "todo" } }]);
    expect(h.wakes).toEqual(["fix-1"]);
  });

  it("leaves it to the Reviewer when a corrected preview exists (the SEO agent is not woken)", async () => {
    const h = host({ task: withFix(), newerPreview: true });
    await onBuildIssueUpdated(h.env, "co-1", "fix-1");
    expect(h.wakes).toEqual([]);
    expect(h.updates).toEqual([]);
  });
});
