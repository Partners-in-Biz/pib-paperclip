import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { assertPreviewLinksChecked, createPreview, previewLink, previewSlug, reviewPreview } from "../src/service/preview.js";
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
  id: "t-1", company_id: "co-1", sprint_id: "sp-1", template_key: "w3-homepage", week: 3, phase: 1, due_day: 20, focus: "Core Pages", title: "Home", description: null,
  task_type: "page-write", owner: "agent", autopilot_eligible: true, playbook_key: "w3-homepage", status: "in_progress", source: "template", parent_optimization_id: null,
  context: null, issue_id: "iss-1", issue_identifier: "PAR-9", issue_status: "in_progress", assignee_kind: "agent", blocker_reason: null, human_ask: null, evidence: null,
  started_at: null, completed_at: null, completed_by: null, created_at: null, updated_at: null,
};
const LIVE = `<html><head><title>Old</title></head><body><h1>Old heading</h1><main><div class="entry-content">${"<p>auction lot listing word </p>".repeat(40)}</div></main></body></html>`;

function host(previewRow?: Row, rounds = 0, evidence: Row | null = null) {
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
        if (/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE id/.test(sql)) return [{ ...TASK, evidence }];
        if (/count\(\*\)/.test(sql)) return [{ n: rounds }];
        if (/needs_you/.test(sql)) return [];
        if (/FROM plugin_seo_8099f8879a\.previews/.test(sql)) return previewRow ? [previewRow] : [];
        return [];
      },
      async execute(sql: string, params: unknown[] = []) { executes.push({ sql, params }); return { rowCount: 1 }; },
    },
    config: { get: vi.fn(async () => ({})) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
    state: { get: vi.fn(async () => null), set: vi.fn() },
    issues: {
      create: vi.fn(async (input: Record<string, unknown>) => { created.push(input); return { id: "rev-1" }; }),
      createComment: vi.fn(async (id: string, body: string) => { comments.push({ id, body }); return { id: "c" }; }),
      requestWakeup: vi.fn(async (id: string) => { wakes.push(id); return { queued: true, runId: null }; }),
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }); return { id, ...patch }; }),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
  const site = vi.fn(async () => ({ status: 200, url: "https://acme.co.za/", redirects: [], headers: {}, text: LIVE, ms: 1 }));
  return { env: createEnv(ctx, { now: () => new Date("2026-10-02T12:00:00Z"), site: site as never }), executes, created, comments, wakes, updates };
}

const seo: Actor = { kind: "agent", agentId: "seo-1", runId: "r", responsibleUserId: null };
const reviewer: Actor = { kind: "agent", agentId: "rev-agent", runId: "r2", responsibleUserId: null };
const base = { sprintId: "sp-1", taskId: "t-1", pageUrl: "/", h1: "New heading" };

describe("create-preview", () => {
  it("refuses a body that would wipe most of the live page", async () => {
    await expect(createPreview(host().env, "co-1", seo, { ...base, bodyHtml: "<p>short intro</p>", bodyMode: "replace" })).rejects.toThrow(/keep only \d+% of the live page/);
  });

  it("adds copy by default, holds the preview and opens a review issue for the owner or Reviewer", async () => {
    const h = host();
    const out = (await createPreview(h.env, "co-1", seo, { ...base, bodyHtml: "<p>new intro words</p>" })) as { reviewStatus: string; stats: { keptPct: number }; reviewIssueId: string; url: string };
    expect(out).toMatchObject({ reviewStatus: "pending", reviewIssueId: "rev-1" });
    expect(out.url).toMatch(/^https:\/\/preview\.partnersinbiz\.online\/p\/acme\/[A-Za-z0-9_-]{20,}$/);
    expect(out.stats.keptPct).toBeGreaterThanOrEqual(95);
    expect(h.created[0]).toMatchObject({ originKind: ORIGIN.previewReview, parentId: "iss-1" });
    expect(String(h.created[0]!.description)).toMatch(/review\?key=/);
    expect(String(h.created[0]!.description)).toMatch(/Text kept from the live page: \d+%/);
    const insert = h.executes.find((e) => /INSERT INTO plugin_seo_8099f8879a\.previews/.test(e.sql))!;
    expect(String(insert.params[7])).toContain("new intro words");
    expect(String(insert.params[7])).toContain("auction lot listing word");
  });
});

describe("preview links", () => {
  it("carry the site name before the token", () => {
    expect(previewSlug("https://www.huntandgun.co.za/")).toBe("huntandgun");
    expect(previewSlug("agriauctionssa.co.za")).toBe("agriauctionssa");
    expect(previewLink("https://huntandgun.co.za", "TOKEN")).toBe("https://preview.partnersinbiz.online/p/huntandgun/TOKEN");
  });
});

describe("review-preview", () => {
  const row = { id: "p1", task_id: "t-1", issue_id: "iss-1", page_url: "https://acme.co.za/", title: "Home", created_by: "seo-1", stats: { rendered: { keptPct: 96 } } };
  const lossy = { ...row, stats: { rendered: { keptPct: 22 } } };
  const unchecked = { ...row, stats: {} };
  const owner = { kind: "user", userId: "user-1" } as unknown as Actor;
  it("cannot be done by the agent that made the preview", async () => {
    await expect(reviewPreview(host(row).env, "co-1", seo, { sprintId: "sp-1", previewId: "p1", verdict: "pass" })).rejects.toThrow(/someone else/);
  });

  it("an agent cannot pass before the rendered check ran or when it shows a lot missing; the owner can", async () => {
    await expect(reviewPreview(host(unchecked).env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "pass" })).rejects.toThrow(/Open the review page first/);
    await expect(reviewPreview(host(lossy).env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "pass" })).rejects.toThrow(/only 22%/);
    expect(await reviewPreview(host(lossy).env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "changes", notes: "Listings missing" })).toMatchObject({ reviewStatus: "changes_needed" });
    expect(await reviewPreview(host(lossy).env, "co-1", owner, { sprintId: "sp-1", previewId: "p1", verdict: "pass" })).toMatchObject({ reviewStatus: "passed" });
  });

  it("pass releases the link and wakes the SEO agent; changes needs notes and holds it", async () => {
    const h = host(row);
    expect(await reviewPreview(h.env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "pass" })).toMatchObject({ reviewStatus: "passed", clientCanOpen: true });
    expect(h.executes.some((e) => /SET review_status/.test(e.sql) && e.params.includes("passed"))).toBe(true);
    expect(h.wakes).toEqual(["iss-1"]);
    await expect(reviewPreview(host(row).env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "changes" })).rejects.toThrow(/notes are required/);
    const h2 = host(row);
    expect(await reviewPreview(h2.env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "changes", notes: "Listings are missing" })).toMatchObject({ reviewStatus: "changes_needed", clientCanOpen: false });
    expect(h2.comments[0]!.body).toMatch(/Listings are missing/);
  });
});

describe("a page that keeps failing", () => {
  const row = { id: "p1", task_id: "t-1", issue_id: "iss-1", page_url: "https://acme.co.za/", title: "Home", created_by: "seo-1", stats: { rendered: { keptPct: 96 } } };
  it("goes to the owner after two rounds once the Senior Developer has had a go, instead of back to the agent", async () => {
    const h = host(row, 2, { builds: [{ issueId: "fix-0", agentId: "sen-1", at: "2026-10-02T10:00:00Z", kind: "preview-fix", level: "senior" }] });
    const out = await reviewPreview(h.env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "changes", notes: "Claims the client's terms contradict" });
    expect(out).toMatchObject({ escalatedToOwner: true });
    expect(h.wakes).toEqual([]);
    expect(h.executes.some((e) => /needs_you/.test(e.sql))).toBe(true);
    expect(h.comments[0]!.body).toMatch(/sent back 2 times/);
  });

  it("the first round still goes back to the agent", async () => {
    const h = host(row, 1);
    const out = await reviewPreview(h.env, "co-1", reviewer, { sprintId: "sp-1", previewId: "p1", verdict: "changes", notes: "Wording" });
    expect(out).not.toHaveProperty("escalatedToOwner");
    expect(h.wakes).toEqual(["iss-1"]);
  });
});

describe("preview links in asks", () => {
  const TOK = "R6cEBXyHMKM9AvnRAcnz9O4G294tisdJ";
  const ask = (tok: string) => ({ humanAsk: `Show the client https://preview.partnersinbiz.online/p/acme/${tok}` });
  const withRow = (status: string | null) => {
    const h = host(status ? ({ id: TOK, review_status: status, page_url: "https://acme.co.za/" } as Row) : undefined);
    return h.env;
  };

  it("refuses links to previews that are not passed, or not ours", async () => {
    await expect(assertPreviewLinksChecked(withRow("pending"), "co-1", ask(TOK))).rejects.toThrow(/has not been checked/);
    await expect(assertPreviewLinksChecked(withRow("changes_needed"), "co-1", ask(TOK))).rejects.toThrow(/changes needed/);
    await expect(assertPreviewLinksChecked(withRow(null), "co-1", ask(TOK))).rejects.toThrow(/not one of this company/);
  });

  it("allows passed previews and text without a preview link", async () => {
    await expect(assertPreviewLinksChecked(withRow("passed"), "co-1", ask(TOK))).resolves.toBeUndefined();
    await expect(assertPreviewLinksChecked(withRow(null), "co-1", { humanAsk: "Nothing to link" })).resolves.toBeUndefined();
  });
});

describe("waiting for the Reviewer", () => {
  it("parks the task when a preview is made", async () => {
    const h = host();
    await createPreview(h.env, "co-1", seo, { ...base, bodyHtml: "<p>new intro words</p>" });
    expect(h.updates).toEqual([{ id: "iss-1", patch: { status: "blocked" } }]);
    expect(h.executes.some((e) => /UPDATE plugin_seo_8099f8879a\.sprint_tasks SET/.test(e.sql) && e.params.includes("reviewer"))).toBe(true);
  });
});
