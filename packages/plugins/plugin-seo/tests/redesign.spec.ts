import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { buildPreviewHtml, sanitizeCss } from "../src/engine/preview.js";
import { createPreview, deliverPreviewAnswers } from "../src/service/preview.js";
import { addRedesign, redesignBrief } from "../src/service/redesign.js";
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
  id: "t-1", company_id: "co-1", sprint_id: "sp-1", template_key: null, week: 3, phase: 1, due_day: 20, focus: "Redesign", title: "Redesign: home page", description: null,
  task_type: "redesign", owner: "agent", autopilot_eligible: false, playbook_key: "custom", status: "blocked", source: "manual", parent_optimization_id: null,
  context: null, issue_id: "iss-1", issue_identifier: "PAR-9", issue_status: "blocked", assignee_kind: "agent", blocker_reason: "Waiting on you", human_ask: null,
  evidence: null, started_at: null, completed_at: null, completed_by: null, created_at: null, updated_at: null, ...extra,
});
const LIVE = `<html><head><title>Old</title></head><body><h1>Old</h1><main><div class="entry-content">${"<p>auction lot listing word </p>".repeat(40)}</div></main></body></html>`;

function host(opts: { task?: Row; pending?: Row[] } = {}) {
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
        if (/decided_at IS NOT NULL AND notified_at IS NULL/.test(sql)) return opts.pending ?? [];
        if (/needs_you/.test(sql)) return [];
        return [];
      },
      async execute(sql: string, params: unknown[] = []) { executes.push({ sql, params }); return { rowCount: 1 }; },
    },
    config: { get: vi.fn(async () => ({})) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
    state: { get: vi.fn(async () => null), set: vi.fn() },
    agents: { list: vi.fn(async () => [{ id: "dev-1", name: "Developer", status: "idle" }, { id: "sen-1", name: "Senior Developer", status: "idle" }]) },
    issues: {
      create: vi.fn(async (input: Record<string, unknown>) => { created.push(input); return { id: "red-1" }; }),
      createComment: vi.fn(async (id: string, body: string) => { comments.push({ id, body }); return { id: "c" }; }),
      requestWakeup: vi.fn(async (id: string) => { wakes.push(id); return { queued: true, runId: null }; }),
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); return { id, ...patch }; }),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
  const site = vi.fn(async () => ({ status: 200, url: "https://acme.co.za/", redirects: [], headers: {}, text: LIVE, ms: 1 }));
  return { env: createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z"), site: site as never }), executes, created, comments, wakes, updates };
}

const user = { kind: "user", userId: "user-1" } as unknown as Actor;
const agent: Actor = { kind: "agent", agentId: "seo-1", runId: "r", responsibleUserId: null };

describe("redesign preview styles", () => {
  it("strips imports, scripts, expressions and escapes from styles", () => {
    const css = sanitizeCss('@import url(x.css); body{background:url(javascript:evil())} h1{width:expression(alert(1))} </style><script>x</script> p{color:#222}');
    expect(css).not.toMatch(/@import|javascript|expression|<\/?style|<script/i);
    expect(css).toContain("p{color:#222}");
  });

  it("puts the styles at the end of the head and lists css as applied", () => {
    const out = buildPreviewHtml(LIVE, "https://acme.co.za/", { css: "h1{color:red}" }, { token: "t" });
    expect(out.applied).toContain("css");
    expect(out.html).toMatch(/<style id="pib-redesign-css">h1\{color:red\}<\/style><\/head>/);
  });
});

describe("create-preview css", () => {
  const base = { sprintId: "sp-1", taskId: "t-1", pageUrl: "/", h1: "New", css: "h1{color:red}" };
  it("is only for redesign tasks", async () => {
    await expect(createPreview(host({ task: task({ task_type: "page-write" }) }).env, "co-1", agent, base)).rejects.toThrow(/only for redesign tasks/);
    const ok = (await createPreview(host().env, "co-1", agent, base)) as { applied: string[] };
    expect(ok.applied).toContain("css");
  });
});

describe("ask for a redesign", () => {
  const params = { sprintId: "sp-1", pageUrl: "/", goal: "Dated. Keep the dark theme." };
  it("is a person's request and stays on the client's site", async () => {
    await expect(addRedesign(host().env, "co-1", agent, params)).rejects.toThrow(/asked for by a person/);
    await expect(addRedesign(host().env, "co-1", user, { ...params, pageUrl: "https://other.com/x" })).rejects.toThrow(/page on https:\/\/acme.co.za/);
  });

  it("opens a task and an issue for the Senior Developer with the design brief", async () => {
    const h = host();
    const out = (await addRedesign(h.env, "co-1", user, params)) as { assignedTo: string; issueId: string };
    expect(out).toMatchObject({ assignedTo: "Senior Developer", issueId: "red-1" });
    expect(h.executes.some((e) => /INSERT INTO plugin_seo_8099f8879a\.sprint_tasks/.test(e.sql) && e.params.includes("redesign"))).toBe(true);
    expect(h.created[0]).toMatchObject({ originKind: ORIGIN.task, assigneeAgentId: "sen-1", parentId: "root-1" });
    const brief = String(h.created[0]!.description);
    expect(brief).toContain("Keep the dark theme");
    expect(brief).toContain("create-preview");
    expect(brief).toContain("phone");
    expect(brief).toMatch(/theme changes/);
  });

  it("the brief for a repo site does not mention the Connector", () => {
    expect(redesignBrief({ siteUrl: "https://x.co.za", pageUrl: "https://x.co.za/", goal: "g", sprintId: "s", taskId: "t", requester: "Peet", wordpress: false })).not.toMatch(/Connector/);
  });
});

describe("the client's answer reaches the agent", () => {
  const row = (status: string) => ({ id: "p1", company_id: "co-1", task_id: "t-1", issue_id: "iss-1", page_url: "https://acme.co.za/", title: "Home", status, decision_note: "Make the header bigger" });

  it("changes requested: the parked task goes back to its agent and the agent is woken", async () => {
    const h = host({ pending: [row("changes_requested")] });
    expect(await deliverPreviewAnswers(h.env)).toBe(1);
    expect(h.updates).toEqual([{ id: "iss-1", patch: { status: "todo" } }]);
    expect(h.wakes).toEqual(["iss-1"]);
    expect(h.comments[0]!.body).toMatch(/asked for changes[\s\S]*Make the header bigger/);
    expect(h.executes.some((e) => /UPDATE plugin_seo_8099f8879a\.sprint_tasks SET/.test(e.sql) && e.params.includes("agent"))).toBe(true);
  });

  it("approved: the owner is told, nothing is woken or applied", async () => {
    const h = host({ pending: [row("approved")] });
    await deliverPreviewAnswers(h.env);
    expect(h.wakes).toEqual([]);
    expect(h.comments[0]!.body).toMatch(/Nothing is applied yet/);
  });
});
