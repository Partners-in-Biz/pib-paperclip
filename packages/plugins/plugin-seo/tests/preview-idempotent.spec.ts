/**
 * PAR-10301: create-preview is idempotent. The same request made again (an agent retrying after a gateway timeout) gets the
 * preview the first call made (`reused: true`) instead of a second row, review issue, Drive copy and task park. The previews
 * table here is in memory and answers the stored lookup the way its WHERE clause reads; tests/preview-idempotent.pg.spec.ts
 * runs that clause on a real Postgres.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { createPreview, inFlightPreviewCount, type CreatePreviewResult } from "../src/service/preview.js";
import { CREATE_PREVIEW_TOOL_TIMEOUT_MS, stableStringify } from "../src/engine/request-key.js";
import { SEO_TOOLS } from "../src/tools.js";
import { ORIGIN } from "../src/constants.js";

const { fakeDriveSave } = vi.hoisted(() => ({ fakeDriveSave: vi.fn(async (_ctx: unknown, _opts: Record<string, unknown>) => ({ status: "saved", requestId: "rq", driveFileId: "f1", url: "https://drive.example/f1" })) }));
vi.mock("@partnersinbiz/pib-plugin-kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@partnersinbiz/pib-plugin-kit")>();
  return { ...actual, driveSave: fakeDriveSave };
});

type Row = Record<string, unknown>;
const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_ref: null, client_name: "Acme Ltd",
  status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "proj-1", root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: "agent-1", site_access: "wordpress", site_id: "site-1",
  change_policy: "pr_only", notes: null, paused_reason: null, health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1,
  last_daily_on: null, last_weekly_on: null, audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};
const taskRow = (id: string, issueId: string): Row => ({
  id, company_id: "co-1", sprint_id: "sp-1", template_key: `k-${id}`, week: 3, phase: 1, due_day: 20, focus: "Core Pages", title: "Home", description: null,
  task_type: "page-write", owner: "agent", autopilot_eligible: true, playbook_key: null, status: "in_progress", source: "template", parent_optimization_id: null,
  context: null, issue_id: issueId, issue_identifier: "PAR-9", issue_status: "in_progress", assignee_kind: "agent", blocker_reason: null, human_ask: null, evidence: null,
  started_at: null, completed_at: null, completed_by: null, created_at: null, updated_at: null,
});
const page = (title: string) => `<html><head><title>${title}</title></head><body><h1>Old heading</h1><main><div class="entry-content">${"<p>auction lot listing word </p>".repeat(40)}</div></main></body></html>`;

/** In-memory previews, tasks and issues; `site` is the live page fetcher the test controls. */
function world(opts: { siteUrl?: string } = {}) {
  const sprint = { ...SPRINT, site_url: opts.siteUrl ?? SPRINT.site_url };
  const tasks: Record<string, Row> = { "t-1": taskRow("t-1", "iss-1"), "t-2": taskRow("t-2", "iss-2") };
  const previews: Row[] = [];
  const issues: Array<{ id: string; originKind: string; originId: string; status: string }> = [];
  const fails = { create: false, park: false };
  const parks: string[] = [];
  let live = page("Old");
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string, p: unknown[] = []) {
        if (/FROM plugin_seo_8099f8879a\.sprints WHERE id/.test(sql)) return [sprint];
        if (/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE id/.test(sql)) return tasks[String(p[0])] ? [tasks[String(p[0])]] : [];
        if (/FROM plugin_seo_8099f8879a\.previews\s+WHERE company_id = \$1 AND request_key = \$2/.test(sql)) {
          const now = Date.now();
          return previews
            .filter((r) => r.company_id === p[0] && r.request_key === p[1] && r.status === "pending" && r.review_status !== "changes_needed" && Date.parse(String(r.expires_at)) > now && Date.parse(String(r.created_at)) > now - 30 * 60_000)
            .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)))
            .slice(0, 1);
        }
        return [];
      },
      async execute(sql: string, p: unknown[] = []) {
        if (/^INSERT INTO plugin_seo_8099f8879a\.previews/.test(sql)) {
          previews.push({ id: p[0], company_id: p[1], sprint_id: p[2], task_id: p[3], page_url: p[5], title: p[6], expires_at: p[9], review_key: p[11], stats: JSON.parse(String(p[12])), request_key: p[13], status: "pending", review_status: "pending", review_issue_id: null, created_at: new Date().toISOString() });
        }
        const review = /^UPDATE plugin_seo_8099f8879a\.previews SET review_issue_id = \$2 WHERE id = \$1/.exec(sql);
        if (review) for (const r of previews) if (r.id === p[0]) r.review_issue_id = p[1];
        return { rowCount: 1 };
      },
    },
    config: { get: vi.fn(async () => ({})) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
    state: { get: vi.fn(async () => null), set: vi.fn() },
    issues: {
      create: vi.fn(async (input: Record<string, unknown>) => {
        if (fails.create) throw new Error("issues API down");
        const id = `rev-${issues.length + 1}`;
        issues.push({ id, originKind: String(input.originKind), originId: String(input.originId), status: "todo" });
        return { id };
      }),
      list: vi.fn(async (q: { originKind?: string; originId?: string }) => issues.filter((i) => i.originKind === q.originKind && i.originId === q.originId)),
      createComment: vi.fn(async () => ({ id: "c" })),
      requestWakeup: vi.fn(async () => ({ queued: true, runId: null })),
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        if (patch.status === "blocked") {
          if (fails.park) throw new Error("cut off");
          parks.push(id);
          for (const t of Object.values(tasks)) if (t.issue_id === id) t.status = "blocked";
        }
        return { id, ...patch };
      }),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
  const site = vi.fn(async (_url: string) => ({ status: 200, url: "https://acme.co.za/", redirects: [], headers: {}, text: live, ms: 1 }));
  const fetch = vi.fn(async () => { throw new TypeError("fetch failed"); }); // no render service: built from the source
  const env = createEnv(ctx, { now: () => new Date(), site: site as never, fetch });
  return { env, ctx, tasks, previews, issues, parks, fails, site, setLive: (title: string) => { live = page(title); } };
}

const seo: Actor = { kind: "agent", agentId: "seo-1", runId: "r", responsibleUserId: null };
const base = { sprintId: "sp-1", taskId: "t-1", pageUrl: "/", h1: "New heading", bodyHtml: "<p>new intro words</p>", client: { kind: "company", ref: "crm-1" } };
const make = (w: ReturnType<typeof world>, extra: Row = {}) => createPreview(w.env, "co-1", seo, { ...base, ...extra }) as Promise<CreatePreviewResult>;
const flush = () => new Promise((done) => setTimeout(done, 0));

afterEach(() => {
  vi.useRealTimers();
  fakeDriveSave.mockClear();
});

describe("create-preview tool budget", () => {
  it("declares 45 s and explains reused: true", () => {
    const tool = SEO_TOOLS.find((t) => t.name === "create-preview")!;
    expect(tool.timeoutMs).toBe(45_000);
    expect(CREATE_PREVIEW_TOOL_TIMEOUT_MS).toBe(45_000);
    expect(tool.description).toContain("`reused: true` means this exact preview already existed (for example after a gateway timeout): use that previewId and do not call again.");
  });
});

describe("create-preview called twice with the same request", () => {
  it("in sequence: the second call returns the first preview and does no follow-up work again", async () => {
    const w = world();
    const first = await make(w);
    await flush();
    const second = await make(w);
    await flush();
    expect(first.reused).toBe(false);
    expect(second).toMatchObject({ previewId: first.previewId, url: first.url, reused: true, reviewStatus: "pending", reviewIssueId: "rev-1" });
    expect(second.notes?.[0]).toMatch(/^This exact preview was already made at .+ No new preview was made\.$/);
    expect(w.previews).toHaveLength(1);
    expect(fakeDriveSave).toHaveBeenCalledTimes(1);
    expect(w.ctx.issues.create).toHaveBeenCalledTimes(1);
    expect(w.parks).toEqual(["iss-1"]);
  });

  it("at once: one build, one row, one page fetch", async () => {
    const w = world();
    w.site.mockImplementation(async () => { await new Promise((done) => setTimeout(done, 20)); return { status: 200, url: "https://acme.co.za/", redirects: [], headers: {}, text: page("Old"), ms: 1 }; });
    const [a, b] = await Promise.all([make(w), make(w)]);
    expect(b.previewId).toBe(a.previewId);
    expect([a.reused, b.reused].sort()).toEqual([false, true]);
    expect(w.previews).toHaveLength(1);
    expect(w.site).toHaveBeenCalledTimes(1);
    expect(inFlightPreviewCount()).toBe(0);
  });

  it.each([
    ["changes (one character)", { h1: "New headinG" }],
    ["pageUrl", { pageUrl: "/about" }],
    ["taskId", { taskId: "t-2" }],
    ["allowReplace", { allowReplace: true }],
    ["label", { label: "Home intro" }],
    ["client", { client: { kind: "contact", ref: "crm-1" } }],
  ])("a call that differs only in %s makes a new preview", async (_name, extra) => {
    const w = world();
    const first = await make(w);
    const second = await make(w, extra);
    expect(second.reused).toBe(false);
    expect(second.previewId).not.toBe(first.previewId);
    expect(w.previews).toHaveLength(2);
  });

  it.each([
    ["cancelled", (r: Row) => { r.status = "cancelled"; }],
    ["sent back by the Reviewer", (r: Row) => { r.review_status = "changes_needed"; }],
    ["expired", (r: Row) => { r.expires_at = new Date(Date.now() - 1000).toISOString(); }],
    ["older than 30 minutes", (r: Row) => { r.created_at = new Date(Date.now() - 31 * 60_000).toISOString(); }],
    ["made before request keys", (r: Row) => { r.request_key = null; }],
  ])("is not reused when the stored row is %s", async (_name, edit) => {
    const w = world();
    const first = await make(w);
    edit(w.previews[0]!);
    const second = await make(w);
    expect(second.reused).toBe(false);
    expect(second.previewId).not.toBe(first.previewId);
    expect(w.previews).toHaveLength(2);
  });

  it("a row the Reviewer passed is reused, and the task is not parked again", async () => {
    const w = world();
    const first = await make(w);
    // The Reviewer passed it and the task went back to the agent.
    w.previews[0]!.review_status = "passed";
    w.tasks["t-1"]!.status = "in_progress";
    const second = await make(w);
    expect(second).toMatchObject({ previewId: first.previewId, reused: true, reviewStatus: "passed" });
    expect(w.parks).toEqual(["iss-1"]);
    expect(w.tasks["t-1"]!.status).toBe("in_progress");
  });
});

describe("in-flight dedupe", () => {
  it("the first call throws: the waiting call gets the same error, a third call runs fresh", async () => {
    const w = world();
    const boom = new Error("site down");
    w.site.mockImplementationOnce(async () => { await new Promise((done) => setTimeout(done, 20)); throw boom; });
    const [a, b] = await Promise.allSettled([make(w), make(w)]);
    expect(a).toEqual({ status: "rejected", reason: boom });
    expect(b).toEqual({ status: "rejected", reason: boom });
    const third = await make(w);
    expect(third.reused).toBe(false);
    expect(w.previews).toHaveLength(1);
    expect(w.site).toHaveBeenCalledTimes(2);
  });

  it("a hung first call holds retries for at most 50 s", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-12T10:00:00Z"), toFake: ["Date"] });
    const w = world();
    w.site.mockImplementationOnce(() => new Promise(() => {})); // never settles
    void make(w);
    await vi.waitFor(() => expect(w.site).toHaveBeenCalledTimes(1));
    expect(inFlightPreviewCount()).toBe(1);
    vi.setSystemTime(Date.parse("2026-11-12T10:00:51Z"));
    let duringSecond = -1;
    w.site.mockImplementationOnce(async () => { duringSecond = inFlightPreviewCount(); return { status: 200, url: "https://acme.co.za/", redirects: [], headers: {}, text: page("Old"), ms: 1 }; });
    const second = await make(w);
    expect(second.reused).toBe(false);
    expect(duringSecond).toBe(1);
    expect(w.previews).toHaveLength(1);
    expect(inFlightPreviewCount()).toBe(0);
  });
});

describe("a retry finishes the first call's follow-up work", () => {
  it("opens the review issue the first call could not, records it and parks the task", async () => {
    const w = world();
    w.fails.create = true;
    w.fails.park = true; // the first call stops right after the INSERT
    const first = await make(w);
    expect(first.reviewIssueId).toBeNull();
    expect(w.parks).toEqual([]);
    w.fails.create = false;
    w.fails.park = false;
    const second = await make(w);
    expect(second).toMatchObject({ previewId: first.previewId, reused: true, reviewIssueId: "rev-1" });
    expect(w.issues).toEqual([{ id: "rev-1", originKind: ORIGIN.previewReview, originId: `preview-review:${first.previewId}`, status: "todo" }]);
    expect(w.previews[0]!.review_issue_id).toBe("rev-1");
    expect(w.parks).toEqual(["iss-1"]);
    const third = await make(w);
    expect(third.reviewIssueId).toBe("rev-1");
    expect(w.issues).toHaveLength(1);
  });

  it("records a review issue that already exists instead of opening another", async () => {
    const w = world();
    w.fails.create = true;
    const first = await make(w);
    w.fails.create = false;
    w.issues.push({ id: "rev-existing", originKind: ORIGIN.previewReview, originId: `preview-review:${first.previewId}`, status: "todo" });
    const createsBefore = vi.mocked(w.ctx.issues.create).mock.calls.length;
    const second = await make(w);
    expect(second.reviewIssueId).toBe("rev-existing");
    expect(w.previews[0]!.review_issue_id).toBe("rev-existing");
    expect(vi.mocked(w.ctx.issues.create).mock.calls.length).toBe(createsBefore);
  });

  it("a rehearsal sprint opens none", async () => {
    const w = world({ siteUrl: "https://acme.invalid" });
    const first = await make(w);
    const second = await make(w);
    expect(second).toMatchObject({ previewId: first.previewId, reused: true, reviewIssueId: null });
    expect(w.ctx.issues.create).not.toHaveBeenCalled();
    expect(w.ctx.issues.list).not.toHaveBeenCalled();
  });
});

describe("the live page since the stored preview", () => {
  it("changed: a new preview is built", async () => {
    const w = world();
    const first = await make(w);
    w.setLive("New title on the live page");
    const second = await make(w);
    expect(second.reused).toBe(false);
    expect(second.previewId).not.toBe(first.previewId);
    expect(w.previews).toHaveLength(2);
  });

  it("could not be read: the stored preview is reused with a note", async () => {
    const w = world();
    const first = await make(w);
    w.site.mockRejectedValueOnce(new Error("timeout"));
    const second = await make(w);
    expect(second).toMatchObject({ previewId: first.previewId, reused: true });
    expect(second.notes?.[1]).toMatch(/^Could not re-check the live page; reused the preview made at \d{4}-\d{2}-\d{2}T/);
    expect(w.previews).toHaveLength(1);
  });
});

describe("stableStringify", () => {
  it("ignores key order and undefined values", () => {
    expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(stableStringify({ a: { d: [1, { x: 1, y: 2 }] }, b: 1, e: undefined }));
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: "1" }));
  });
});
