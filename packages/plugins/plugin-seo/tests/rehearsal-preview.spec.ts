/**
 * 0.52.0 (PAR-13387): previews on a rehearsal sprint. create-preview builds on the canned fixture page for a `.invalid` address
 * (no DNS, no render service, no WordPress call, no review issue), and `set-rehearsal-preview` sets the Reviewer result and the
 * expiry on a rehearsal sprint only. The SQL runs on an embedded Postgres with the real migrations; skipped where it is not available.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, SeoError, type Actor } from "../src/service/common.js";
import { createPreview } from "../src/service/preview.js";
import { isRehearsalUrl, REHEARSAL_PAGE_NOTE, rehearsalPageHtml } from "../src/engine/rehearsal.js";
import { REHEARSAL_ONLY, setRehearsalPreview } from "../src/service/rehearsal-preview.js";
import { dispatch, HANDLERS } from "../src/dispatch.js";
import { SEO_TOOL_DECLARATIONS } from "../src/tools.js";
import { seoHost } from "./helpers/seo-host.js";

type Row = Record<string, unknown>;
const FIXTURE = "https://par-9131-dogfood.canary.invalid";
const seo: Actor = { kind: "agent", agentId: "seo-1", runId: "r", responsibleUserId: null };

describe("the canned fixture page", () => {
  it("is only for .invalid hosts, the same page for the same address, and escapes the path", () => {
    expect(isRehearsalUrl(`${FIXTURE}/services`)).toBe(true);
    expect(isRehearsalUrl("https://acme.co.za/")).toBe(false);
    expect(isRehearsalUrl("https://invalid-things.co.za/")).toBe(false);
    expect(rehearsalPageHtml(`${FIXTURE}/a`)).toBe(rehearsalPageHtml(`${FIXTURE}/a`));
    expect(rehearsalPageHtml(`${FIXTURE}/a`)).not.toBe(rehearsalPageHtml(`${FIXTURE}/b`));
    expect(rehearsalPageHtml(`${FIXTURE}/"><script>x</script>`)).not.toContain("<script>");
  });
});

describe("create-preview on a fixture site", () => {
  const SPRINT: Row = {
    id: "sp-r", company_id: "co-1", name: "Fixture", site_url: FIXTURE, site_name: "PAR-9131 dogfood fixture", client_ref: null, client_name: null,
    status: "active", start_date: "2026-11-01", template_id: "outrank-90", template_version: 2, autopilot_mode: "off", owner_user_id: "user-1",
    project_id: "proj-1", root_issue_id: null, root_issue_identifier: null, agent_id: "agent-1", site_access: "none", site_id: "site-1",
    change_policy: "pr_only", notes: null, paused_reason: null, health: {}, scoreboard: {}, today: {}, current_day: 5, current_week: 1, current_phase: 1,
    last_daily_on: null, last_weekly_on: null, audit_days_done: [], seeded_at: "2026-11-01T00:00:00Z", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
  };

  function host() {
    const executes: Array<{ sql: string; params: unknown[] }> = [];
    const create = vi.fn(async () => ({ id: "never" }));
    const ctx = {
      db: {
        namespace: NAMESPACE,
        async query(sql: string) {
          if (/FROM plugin_seo_8099f8879a\.sprints WHERE id/.test(sql)) return [SPRINT];
          return [];
        },
        async execute(sql: string, params: unknown[] = []) { executes.push({ sql, params }); return { rowCount: 1 }; },
      },
      config: { get: vi.fn(async () => ({})) },
      companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
      state: { get: vi.fn(async () => null), set: vi.fn() },
      issues: { create, createComment: vi.fn(), requestWakeup: vi.fn(), update: vi.fn(), list: vi.fn(async () => []) },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    } as unknown as PluginContext;
    const site = vi.fn(async () => { throw new Error("DNS resolution failed"); });
    const fetch = vi.fn(async () => { throw new Error("no network in a rehearsal"); });
    return { env: createEnv(ctx, { now: () => new Date("2026-11-19T06:00:00Z"), site: site as never, fetch: fetch as never }), executes, create, site, fetch };
  }

  it("builds on the canned page: nothing is fetched, the figure is final, and no review issue is opened", async () => {
    const h = host();
    const out = (await createPreview(h.env, "co-1", seo, { sprintId: "sp-r", pageUrl: "/services", h1: "Rehearsal heading", bodyHtml: "<p>One more fixture paragraph.</p>" })) as Row & { stats: Row & { rendered: { keptPct: number; liveWords: number } }; notes: string[] };
    expect(h.site).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(out).toMatchObject({ pageUrl: `${FIXTURE}/services`, reviewStatus: "pending", reviewIssueId: null, basis: "rendered", reused: false });
    expect(out.stats.rendered.liveWords).toBeGreaterThan(50);
    expect(out.stats.rendered.keptPct).toBeGreaterThanOrEqual(95);
    expect(out.notes[0]).toBe(REHEARSAL_PAGE_NOTE);
    const insert = h.executes.find((e) => /INSERT INTO plugin_seo_8099f8879a\.previews/.test(e.sql))!;
    expect(String(insert.params[7])).toContain("One more fixture paragraph.");
    expect(String(insert.params[7])).toContain("Rehearsal heading");
  });
});

describe("set-rehearsal-preview registration", () => {
  it("is an agent tool with a handler", () => {
    expect(SEO_TOOL_DECLARATIONS.some((t) => t.name === "set-rehearsal-preview")).toBe(true);
    expect(HANDLERS["set-rehearsal-preview"]).toBeTypeOf("function");
  });
});

const requireFromDb = createRequire(new URL("../../../db/package.json", import.meta.url));
type Postgres = (url: string, o?: Record<string, unknown>) => any;
type EmbeddedDbHelper = {
  getEmbeddedPostgresTestSupport(): Promise<{ supported: boolean }>;
  startEmbeddedPostgresTestDatabase(prefix: string): Promise<{ connectionString: string; cleanup(): Promise<void> }>;
};
let postgres: Postgres = (() => { throw new Error("postgres is not installed"); }) as never;
let getEmbeddedPostgresTestSupport: EmbeddedDbHelper["getEmbeddedPostgresTestSupport"] = async () => ({ supported: false });
let startEmbeddedPostgresTestDatabase: EmbeddedDbHelper["startEmbeddedPostgresTestDatabase"] = async () => { throw new Error("embedded postgres is not available"); };
try {
  postgres = requireFromDb("postgres") as Postgres;
  const dbHelperPath = new URL("../../../db/src/test-embedded-postgres.ts", import.meta.url).pathname;
  ({ getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } = (await import(/* @vite-ignore */ dbHelperPath)) as EmbeddedDbHelper);
} catch {
  // keep the skipping stubs
}
const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const S = NAMESPACE;
const HOUR = 3_600_000;

describePg("set-rehearsal-preview (embedded Postgres)", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: any;

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("seo-rehearsal-preview-");
    sql = postgres(pg.connectionString, { max: 2, onnotice: () => undefined });
    await sql.unsafe(`CREATE SCHEMA ${S}`);
    const dir = join(import.meta.dirname, "../migrations");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) await sql.unsafe(readFileSync(join(dir, f), "utf8"));
    await sql.unsafe(`ALTER TABLE ${S}.previews DROP CONSTRAINT previews_sprint_id_fkey`);
  }, 120_000);
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await pg?.cleanup();
  });

  function host() {
    const h = seoHost({ now: new Date().toISOString() });
    const plain = (rows: unknown) => JSON.parse(JSON.stringify(rows));
    h.ctx.db.query = (async (text: string, params: unknown[] = []) => plain(await sql.unsafe(text, params))) as never;
    h.ctx.db.execute = (async (text: string, params: unknown[] = []) => ({ rowCount: (await sql.unsafe(text, params)).count })) as never;
    return h;
  }
  async function put(id: string, sprintId: string, extra: Row = {}) {
    const row = { company_id: "co-1", sprint_id: sprintId, task_id: "t-1", page_url: `${FIXTURE}/a`, title: id, html: "<html></html>", review_status: "pending", status: "pending", expires_at: new Date(Date.now() + 720 * HOUR).toISOString(), created_by: "seo-1", ...extra };
    const cols = Object.keys(row);
    await sql.unsafe(`INSERT INTO ${S}.previews (id, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")})`, [id, ...Object.values(row)] as never);
  }
  const read = async (id: string) => (await sql.unsafe(`SELECT review_status, review_note, reviewed_by, reviewed_at, expires_at, status FROM ${S}.previews WHERE id = $1`, [id]))[0];

  beforeEach(async () => {
    await sql.unsafe(`DELETE FROM ${S}.previews`);
    await sql.unsafe(`DELETE FROM ${S}.sprints`);
    await sql.unsafe(`INSERT INTO ${S}.sprints (id, company_id, name, site_name, start_date, site_url, status, change_policy) VALUES
      ('sp-r', 'co-1', 'Fixture', 'Fixture', current_date, '${FIXTURE}', 'active', 'pr_only'),
      ('sp-real', 'co-1', 'Acme', 'Acme', current_date, 'https://acme.co.za', 'active', 'pr_only')`);
  });

  it("passes the creator's own preview and sets the expiry, on a rehearsal sprint", async () => {
    await put("p-1", "sp-r");
    const out = await setRehearsalPreview(host().env, "co-1", seo, { sprintId: "sp-r", previewId: "p-1", reviewStatus: "passed", expiresInHours: 36 });
    expect(out).toMatchObject({ previewId: "p-1", reviewStatus: "passed", status: "pending" });
    const row = await read("p-1");
    expect(row).toMatchObject({ review_status: "passed", reviewed_by: "seo-1", status: "pending" });
    expect(String(row.review_note)).toMatch(/Rehearsal/);
    const hours = (new Date(row.expires_at).getTime() - Date.now()) / HOUR;
    expect(hours).toBeGreaterThan(35);
    expect(hours).toBeLessThan(37);
  });

  it("expires a preview (negative hours) without touching its review, and resets a review to pending", async () => {
    await put("p-2", "sp-r", { review_status: "passed", reviewed_by: "x", reviewed_at: new Date().toISOString() });
    await setRehearsalPreview(host().env, "co-1", seo, { sprintId: "sp-r", previewId: "p-2", expiresInHours: -2 });
    let row = await read("p-2");
    expect(row).toMatchObject({ review_status: "passed", reviewed_by: "x" });
    expect(new Date(row.expires_at).getTime()).toBeLessThan(Date.now());
    await setRehearsalPreview(host().env, "co-1", seo, { sprintId: "sp-r", previewId: "p-2", reviewStatus: "pending" });
    row = await read("p-2");
    expect(row).toMatchObject({ review_status: "pending", reviewed_by: null, reviewed_at: null, review_note: null });
  });

  it("refuses a real sprint, a decided preview, a missing preview and a call with nothing to set; the row is unchanged", async () => {
    await put("p-real", "sp-real", { page_url: "https://acme.co.za/a" });
    await put("p-done", "sp-r", { status: "approved" });
    const h = host();
    await expect(setRehearsalPreview(h.env, "co-1", seo, { sprintId: "sp-real", previewId: "p-real", reviewStatus: "passed" })).rejects.toThrow(REHEARSAL_ONLY);
    await expect(setRehearsalPreview(h.env, "co-1", seo, { sprintId: "sp-r", previewId: "p-done", reviewStatus: "passed" })).rejects.toThrow(/only a pending preview/);
    await expect(setRehearsalPreview(h.env, "co-1", seo, { sprintId: "sp-r", previewId: "nope", reviewStatus: "passed" })).rejects.toThrow(/No such preview/);
    await expect(setRehearsalPreview(h.env, "co-1", seo, { sprintId: "sp-r", previewId: "p-done" })).rejects.toThrow(SeoError);
    await expect(setRehearsalPreview(h.env, "co-1", seo, { sprintId: "sp-r", previewId: "p-done", expiresInHours: 1000 })).rejects.toThrow(/at most 720/);
    expect((await read("p-real")).review_status).toBe("pending");
    expect((await read("p-done")).review_status).toBe("pending");
  });

  it("is reachable through dispatch", async () => {
    await put("p-3", "sp-r");
    const out = (await dispatch(host().env, "co-1", seo, "set-rehearsal-preview", { sprintId: "sp-r", previewId: "p-3", reviewStatus: "changes_needed" })) as Row;
    expect(out).toMatchObject({ reviewStatus: "changes_needed" });
  });
});
