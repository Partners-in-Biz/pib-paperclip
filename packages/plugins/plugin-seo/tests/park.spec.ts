import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv } from "../src/service/common.js";
import { parkTasksWaitingOnYou } from "../src/service/needs-you.js";

type Row = Record<string, unknown>;
const TASK: Row = {
  id: "t-1", company_id: "co-1", sprint_id: "sp-1", template_key: "w3-homepage", week: 3, phase: 1, due_day: 20, focus: "Core Pages", title: "Write the home page",
  description: null, task_type: "page-write", owner: "agent", autopilot_eligible: true, playbook_key: "w3-homepage", status: "in_progress", source: "template",
  parent_optimization_id: null, context: null, issue_id: "iss-1", issue_identifier: "PAR-9", issue_status: "in_progress", assignee_kind: "agent", blocker_reason: null,
  human_ask: null, evidence: null, started_at: null, completed_at: null, completed_by: null, created_at: null, updated_at: null,
};
const item = (extra: Row = {}) => ({ key: "pr:413", kind: "pr", title: "Merge PR 413", why: "w", steps: [], links: [], after: "a", check: "task_done", taskIds: ["t-1"], status: "open", addedAt: "x", ...extra });

function host(items: Row[], task: Row = TASK) {
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const comments: string[] = [];
  const patches: Row[] = [];
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string) {
        if (/SELECT DISTINCT company_id/.test(sql)) return [{ company_id: "co-1" }];
        if (/needs_you/.test(sql)) return [{ sprint_id: "sp-1", items }];
        if (/sprint_tasks WHERE id/.test(sql)) return [task];
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        executes.push({ sql, params });
        return { rowCount: 1 };
      },
    },
    issues: {
      update: vi.fn(async (id: string, patch: Row) => { patches.push(patch); return { id, ...patch }; }),
      createComment: vi.fn(async (_id: string, body: string) => { comments.push(body); return { id: "c" }; }),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
  return { env: createEnv(ctx), executes, comments, patches };
}

describe("parkTasksWaitingOnYou", () => {
  it("blocks an agent task whose Needs you item is open, once, with a comment", async () => {
    const h = host([item()]);
    expect(await parkTasksWaitingOnYou(h.env)).toBe(1);
    expect(h.patches).toEqual([{ status: "blocked" }]);
    expect(h.executes.some((e) => /UPDATE plugin_seo_8099f8879a\.sprint_tasks SET/.test(e.sql) && e.params.includes("blocked"))).toBe(true);
    expect(h.comments[0]).toMatch(/Waiting on a person: \*\*Merge PR 413\*\*/);
  });

  it("leaves tasks alone when the item is done, optional, a human task, or the task is already waiting", async () => {
    for (const items of [[item({ status: "done" })], [item({ optional: true })], [item({ key: "task:t-1" })]]) {
      expect(await parkTasksWaitingOnYou(host(items).env)).toBe(0);
    }
    expect(await parkTasksWaitingOnYou(host([item()], { ...TASK, status: "blocked" }).env)).toBe(0);
    expect(await parkTasksWaitingOnYou(host([item()], { ...TASK, assignee_kind: "needs_you" }).env)).toBe(0);
  });
});
