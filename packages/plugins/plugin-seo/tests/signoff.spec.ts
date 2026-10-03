import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createEnv, type Actor } from "../src/service/common.js";
import { approveSiteWrites, syncSignoff } from "../src/service/signoff.js";
import { UI_ONLY_HANDLERS, HANDLERS } from "../src/dispatch.js";

const emitted: Array<{ name: string; companyId: string; payload: Record<string, unknown> }> = [];
function host(rows: Record<string, unknown>[]) {
  emitted.length = 0;
  const ctx = {
    db: { namespace: "plugin_seo_8099f8879a", query: vi.fn(async () => rows), execute: vi.fn() },
    events: { emit: vi.fn(async (name: string, companyId: string, payload: Record<string, unknown>) => void emitted.push({ name, companyId, payload })) },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
  return createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") });
}

describe("sign-off sync", () => {
  it("tells the CRM which WordPress sites need the client's sign-off", async () => {
    const env = host([
      { company_id: "co-1", site_id: "site-a", required: true },
      { company_id: "co-1", site_id: "site-b", required: false },
    ]);
    expect(await syncSignoff(env)).toBe(2);
    expect(emitted.map((e) => [e.name, e.payload])).toEqual([
      ["site.signoff", { siteId: "site-a", required: true }],
      ["site.signoff", { siteId: "site-b", required: false }],
    ]);
  });
});

describe("approve-site-writes", () => {
  it("is a page-only action and refuses agents and system callers", async () => {
    expect(HANDLERS["approve-site-writes"]).toBeUndefined();
    expect(UI_ONLY_HANDLERS["approve-site-writes"]).toBeDefined();
    const env = host([]);
    for (const actor of [{ kind: "agent", agentId: "a", runId: "r", responsibleUserId: null }, { kind: "system" }] as Actor[]) {
      await expect(approveSiteWrites(env, "co-1", actor, { sprintId: "sp-1" })).rejects.toThrow(/Only a person/);
    }
    expect(emitted).toHaveLength(0);
  });
});

describe("approve-site-writes comment", () => {
  const SPRINT = {
    id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_ref: null, client_name: "Acme Ltd",
    status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 4, autopilot_mode: "safe", owner_user_id: "user-1",
    project_id: "proj-1", root_issue_id: "root-1", site_access: "wordpress", site_id: "site-1", change_policy: "pr_only", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
  };
  const owner = { kind: "user", userId: "user-1" } as unknown as Actor;

  function approvedHost(count: number) {
    const comments: string[] = [];
    const previews = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, task_id: "t-1", issue_id: "iss-1", page_url: `https://acme.co.za/category/page-${i}/`, title: `Page ${i}: ${"long title ".repeat(20)}` }));
    const ctx = {
      db: {
        namespace: "plugin_seo_8099f8879a",
        query: vi.fn(async (sql: string) => (/FROM plugin_seo_\w+\.sprints WHERE id/.test(sql) ? [SPRINT] : /FROM plugin_seo_\w+\.previews/.test(sql) ? previews : [])),
        execute: vi.fn(),
      },
      config: { get: vi.fn(async () => ({})) },
      companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
      state: { get: vi.fn(async () => null), set: vi.fn() },
      events: { emit: vi.fn() },
      issues: { createComment: vi.fn(async (_id: string, body: string) => void comments.push(body)), requestWakeup: vi.fn(async () => ({ queued: true, runId: null })) },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    } as unknown as PluginContext;
    return { env: createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z") }), comments };
  }

  it("lists at most 15 page addresses and points at list-previews for the rest, so one approval cannot bloat a thread", async () => {
    const h = approvedHost(40);
    expect(await approveSiteWrites(h.env, "co-1", owner, { sprintId: "sp-1" })).toMatchObject({ approvedPreviews: 40, issuesNotified: 1 });
    expect(h.comments).toHaveLength(1);
    const body = h.comments[0]!;
    expect(body.length).toBeLessThan(1_500);
    expect((body.match(/^- https:\/\/acme\.co\.za\/category\/page-\d+\/$/gm) ?? []).length).toBe(15);
    expect(body).toContain("…and 25 more: partnersinbiz.seo:list-previews with status approved");
    expect(body).not.toContain("long title");
  });

  it("lists a short approval in full", async () => {
    const h = approvedHost(3);
    await approveSiteWrites(h.env, "co-1", owner, { sprintId: "sp-1" });
    expect((h.comments[0]!.match(/^- https:/gm) ?? []).length).toBe(3);
    expect(h.comments[0]).not.toContain("…and");
  });
});
