/**
 * 0.42.0 (PAR-9493 T1, PAR-9527): page apply grants as a second source of the page-scoped apply window. The previews, sprints,
 * sprint_tasks, apply_windows and page_apply_grants tables are the plugin's real ones on an embedded Postgres, under the host's
 * SQL rules. Skipped where embedded Postgres is not available. The last block (preferences) needs no database.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import * as db from "../src/db.js";
import { loadSeoConfig, parseSeoConfig, validateSeoConfig } from "../src/config.js";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import { syncApplyWindows, syncSiteWindow, syncWindowForIssue } from "../src/service/signoff.js";
import plugin from "../src/worker.js";
import type { Env } from "../src/service/common.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

type Row = Record<string, unknown>;
interface Sql {
  unsafe<T = Row>(text: string, params?: unknown[]): Promise<T[] & { count: number }>;
  end(o?: { timeout?: number }): Promise<void>;
}
type Postgres = (url: string, o?: Record<string, unknown>) => Sql;
type EmbeddedDbHelper = {
  getEmbeddedPostgresTestSupport(): Promise<{ supported: boolean }>;
  startEmbeddedPostgresTestDatabase(prefix: string): Promise<{ connectionString: string; cleanup(): Promise<void> }>;
};
const requireFromDb = createRequire(new URL("../../../db/package.json", import.meta.url));
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
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const S = NAMESPACE;
const HOUR = 3_600_000;
const RHEA = "5c1b1944-5325-455c-b968-ae0971ea934b";
const OTHER = "11111111-1111-4111-8111-111111111111";
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

describePg("page apply grants in the apply window", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: Sql;

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("seo-grants-");
    sql = postgres(pg.connectionString, { max: 4, onnotice: () => undefined });
    await sql.unsafe(`CREATE SCHEMA ${S}`);
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) await sql.unsafe(readFileSync(join(MIGRATIONS, f), "utf8"));
  }, 120_000);
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await pg?.cleanup();
  });

  beforeEach(async () => {
    for (const name of ["page_apply_grants", "apply_windows", "previews", "sprint_tasks", "sprints"]) await sql.unsafe(`DELETE FROM ${S}.${name}`);
    await sql.unsafe(
      `INSERT INTO ${S}.sprints (id, company_id, name, site_url, site_name, start_date, client_signoff, change_policy, site_access, site_id)
       VALUES ('sp-1', 'co-1', 'S', 'https://acme.co.za', 'Acme', '2026-10-01', 'manual', 'pr_only', 'wordpress', 'site-1')`,
    );
    await task("t-1", "iss-1");
  });

  async function task(id: string, issueId: string, status = "in_progress", issueStatus = "todo") {
    await sql.unsafe(`INSERT INTO ${S}.sprint_tasks (id, company_id, sprint_id, title, issue_id, issue_status, status) VALUES ($1, 'co-1', 'sp-1', 'T', $2, $3, $4)`, [id, issueId, issueStatus, status]);
  }
  async function preview(id: string, applyUntil: string) {
    await sql.unsafe(
      `INSERT INTO ${S}.previews (id, company_id, sprint_id, task_id, issue_id, page_url, title, html, review_status, status, created_at, expires_at, decided_at, decided_by, decision_source, handed_at, handover_done_at, apply_until)
       VALUES ($1, 'co-1', 'sp-1', 't-1', 'iss-1', $2, 'P', '<html></html>', 'passed', 'approved', now() - interval '3 hours', now() + interval '1 day', now() - interval '1 hour', 'user:u1', 'cockpit', now() - interval '1 hour', now() - interval '1 hour', $3::timestamptz)`,
      [id, `https://acme.co.za/${id}/`, applyUntil],
    );
  }

  /** The host as it behaves: one statement, SELECT only for query, no RETURNING, JSON text bound to ::jsonb, rows back as JSON. */
  function host(config: () => Promise<Record<string, unknown>> = async () => ({ signoffDelegateAgentIds: [RHEA] })) {
    const bind = (params: unknown[]) => params.map((x) => (typeof x === "string" && x.startsWith("[") ? JSON.parse(x) : x)) as never;
    const ctx = {
      db: {
        namespace: S,
        query: async (text: string, params: unknown[] = []) => {
          validateRuntimeQuery(text, S);
          validateParams(text, params);
          return JSON.parse(JSON.stringify(await sql.unsafe(text, bind(params)))) as Row[];
        },
        execute: async (text: string, params: unknown[] = []) => {
          validateRuntimeExecute(text, S);
          validateParams(text, params);
          return { rowCount: (await sql.unsafe(text, bind(params))).count };
        },
      },
      events: { emit: vi.fn(async () => {}) },
      config: { get: vi.fn(config) },
      state: { get: async () => null, set: async () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    };
    const env = { ctx, now: () => new Date() } as unknown as Env;
    const windows = () => ctx.events.emit.mock.calls.filter((c: unknown[]) => c[0] === "site.write-approved").map((c: unknown[]) => c[2] as Row);
    return { env, ctx, windows };
  }
  const grant = (pages: string[], extra: Partial<db.PageGrantInput> = {}) =>
    db.upsertPageGrants(host().env.ctx.db, { companyId: "co-1", sprintId: "sp-1", siteId: "site-1", taskId: "t-1", pageUrls: pages, grantedBy: "Rhea (sign-off delegate)", grantedByAgentId: RHEA, reviewRef: "prev-1", note: null, applyUntil: at(HOUR), ...extra });

  it("AC1: a grant on an open task opens its page; a repeat keeps the later until", async () => {
    const later = at(5 * HOUR);
    await grant(["https://acme.co.za/x"], { applyUntil: later });
    await grant(["https://acme.co.za/x", "https://acme.co.za/y"], { applyUntil: at(2 * HOUR) });
    const h = host();
    const sent = await syncSiteWindow(h.env, "co-1", "site-1", "test");
    expect(sent.pages).toEqual(["https://acme.co.za/x", "https://acme.co.za/y"]);
    expect(sent.until).toBe(later);
    expect(h.windows().at(-1)).toMatchObject({ siteId: "site-1", scope: "pages", pages: sent.pages, until: later });
  });

  it("AC2: a grant and an approved handed preview merge into one sorted set", async () => {
    const previewUntil = at(3 * HOUR);
    await preview("b", previewUntil);
    await grant(["https://acme.co.za/c", "https://acme.co.za/a"]);
    const sent = await syncSiteWindow(host().env, "co-1", "site-1", "test");
    expect(sent.pages).toEqual(["https://acme.co.za/a", "https://acme.co.za/b", "https://acme.co.za/c"]);
    expect(sent.until).toBe(previewUntil);
  });

  it.each([
    ["task done", `UPDATE ${S}.sprint_tasks SET status = 'done'`],
    ["task skipped", `UPDATE ${S}.sprint_tasks SET status = 'skipped'`],
    ["task na", `UPDATE ${S}.sprint_tasks SET status = 'na'`],
    ["issue done", `UPDATE ${S}.sprint_tasks SET issue_status = 'done'`],
    ["issue cancelled", `UPDATE ${S}.sprint_tasks SET issue_status = 'cancelled'`],
  ])("AC3: %s drops the grant and the next sync sends the close with a higher seq", async (_name, close) => {
    await grant(["https://acme.co.za/x"]);
    const h = host();
    const open = await syncSiteWindow(h.env, "co-1", "site-1", "test");
    expect(open.pages).toEqual(["https://acme.co.za/x"]);
    await sql.unsafe(close);
    const closed = await syncSiteWindow(h.env, "co-1", "site-1", "test");
    expect(closed).toMatchObject({ pages: [], until: null });
    expect(BigInt(closed.seq)).toBeGreaterThan(BigInt(open.seq));
  });

  it("AC4: an expired or a revoked grant is dropped; revoke counts only open grants", async () => {
    await grant(["https://acme.co.za/old"], { applyUntil: at(-60_000) });
    await grant(["https://acme.co.za/x", "https://acme.co.za/y"]);
    expect(await db.revokePageGrants(host().env.ctx.db, "co-1", "t-1", ["https://acme.co.za/x"], "user:u1")).toBe(1);
    expect((await syncSiteWindow(host().env, "co-1", "site-1", "test")).pages).toEqual(["https://acme.co.za/y"]);
    expect(await db.revokePageGrants(host().env.ctx.db, "co-1", "t-1", null, "user:u1")).toBe(1);
    expect(await db.revokePageGrants(host().env.ctx.db, "co-1", "t-1", null, "user:u1")).toBe(0);
    expect((await syncSiteWindow(host().env, "co-1", "site-1", "test")).pages).toEqual([]);
    // A revoked page may be granted again (the unique index covers open rows only).
    await grant(["https://acme.co.za/x"]);
    expect((await syncSiteWindow(host().env, "co-1", "site-1", "test")).pages).toEqual(["https://acme.co.za/x"]);
  });

  it("AC5: an agent grant counts only while the agent is a delegate (a failed config read counts none); a person grant stays", async () => {
    await grant(["https://acme.co.za/agent"]);
    await grant(["https://acme.co.za/person"], { grantedBy: "user:u1", grantedByAgentId: null });
    expect((await syncSiteWindow(host().env, "co-1", "site-1", "t")).pages).toEqual(["https://acme.co.za/agent", "https://acme.co.za/person"]);
    expect((await syncSiteWindow(host(async () => ({ signoffDelegateAgentIds: [OTHER] })).env, "co-1", "site-1", "t")).pages).toEqual(["https://acme.co.za/person"]);
    expect((await syncSiteWindow(host(async () => ({})).env, "co-1", "site-1", "t")).pages).toEqual(["https://acme.co.za/person"]);
    const failing = host(async () => { throw new Error("config down"); });
    expect((await syncSiteWindow(failing.env, "co-1", "site-1", "t")).pages).toEqual(["https://acme.co.za/person"]);
  });

  it("AC6: the 5-minute job picks a grant-only site with no apply_windows row, and a site with a grant revoked under an hour ago", async () => {
    await grant(["https://acme.co.za/x"]);
    const h = host();
    expect(await syncApplyWindows(h.env)).toBe(1);
    expect(h.windows().at(-1)).toMatchObject({ siteId: "site-1", pages: ["https://acme.co.za/x"], by: "seo:window-job" });
    // Revoked, and the apply_windows record lost: the revoke alone still selects the site, which gets its close.
    await db.revokePageGrants(h.env.ctx.db, "co-1", "t-1", null, "user:u1");
    await sql.unsafe(`DELETE FROM ${S}.apply_windows`);
    expect(await syncApplyWindows(h.env)).toBe(1);
    expect(h.windows().at(-1)).toMatchObject({ siteId: "site-1", pages: [], until: null });
    // Revoked over an hour ago, nothing else: left alone.
    await sql.unsafe(`UPDATE ${S}.page_apply_grants SET revoked_at = now() - interval '2 hours'`);
    await sql.unsafe(`DELETE FROM ${S}.apply_windows`);
    expect(await syncApplyWindows(h.env)).toBe(0);
  });

  it("AC7: an open apply_windows row with no preview and no grant sends empty pages (the revert path)", async () => {
    await sql.unsafe(`INSERT INTO ${S}.apply_windows (company_id, site_id, is_open, until, seq) VALUES ('co-1', 'site-1', true, now() + interval '1 hour', 1)`);
    const h = host();
    expect(await syncApplyWindows(h.env)).toBe(1);
    expect(h.windows().at(-1)).toMatchObject({ siteId: "site-1", scope: "pages", pages: [], until: null });
    expect((await sql.unsafe<{ is_open: boolean }>(`SELECT is_open FROM ${S}.apply_windows`))[0]!.is_open).toBe(false);
  });

  it("AC8: issue.updated on a grant task issue re-sends its site; another issue sends nothing", async () => {
    await task("t-2", "iss-2");
    await grant(["https://acme.co.za/two"], { taskId: "t-2" });
    const h = host();
    await sql.unsafe(`UPDATE ${S}.sprint_tasks SET issue_status = 'done' WHERE id = 't-2'`);
    expect(await syncWindowForIssue(h.env, "co-1", "iss-2")).toBe(1);
    expect(h.windows().at(-1)).toMatchObject({ siteId: "site-1", pages: [] });
    expect(await syncWindowForIssue(h.env, "co-1", "iss-other")).toBe(0);
  });

  it("claimGrantNotice claims each apply_until once", async () => {
    const pages = ["https://acme.co.za/x"];
    await grant(pages);
    const d = host().env.ctx.db;
    expect(await db.claimGrantNotice(d, "co-1", "t-1", pages)).toBe(1);
    expect(await db.claimGrantNotice(d, "co-1", "t-1", pages)).toBe(0);
    await grant(pages, { applyUntil: at(-HOUR) }); // an earlier until does not shorten it
    expect(await db.claimGrantNotice(d, "co-1", "t-1", pages)).toBe(0);
    await grant(pages, { applyUntil: at(4 * HOUR) });
    expect(await db.claimGrantNotice(d, "co-1", "t-1", pages)).toBe(1);
  });
});

describe("signoffDelegateAgentIds is a host setting, never a preference (AC10)", () => {
  const CO = "co-1";
  it("a preference save refuses it, and the loaded config keeps the host-form list", async () => {
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", signoffDelegateAgentIds: [RHEA] } });
    harness.seed({
      companies: [{ id: CO, name: "Acme Co", issuePrefix: "ACM" } as never],
      accessMembers: [{ id: `${CO}:u-owner`, companyId: CO, principalType: "user", principalId: "u-owner", status: "active", membershipRole: "owner", grants: [] } as never],
    });
    await plugin.definition.setup(harness.ctx);
    const saved = await harness.performAction<{ ok: boolean; error?: string }>("seo.preferences-save", { patch: { signoffDelegateAgentIds: [OTHER] } }, { companyId: CO, actor: { type: "user", userId: "u-owner" } as never });
    expect(saved.ok).toBe(false);
    expect(saved.error).toMatch(/Unknown preference/);
    expect((await loadSeoConfig(harness.ctx, CO)).config.signoffDelegateAgentIds).toEqual([RHEA]);
  });

  it("parses uuids only and defaults to empty; validation names bad entries", () => {
    expect(parseSeoConfig({}).signoffDelegateAgentIds).toEqual([]);
    expect(parseSeoConfig({ signoffDelegateAgentIds: [RHEA.toUpperCase(), RHEA, "rhea", 7] }).signoffDelegateAgentIds).toEqual([RHEA]);
    expect(validateSeoConfig({ publicBaseUrl: "https://x.example", signoffDelegateAgentIds: ["rhea"] }).errors).toContain("Sign-off delegate agents must be a list of agent ids (uuids)");
    expect(validateSeoConfig({ publicBaseUrl: "https://x.example", signoffDelegateAgentIds: [RHEA] }).ok).toBe(true);
  });
});
