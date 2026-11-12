/**
 * 0.48.8 (PAR-10702, plan PAR-10548 T5): a one-task sign-off on the Cockpit waits on the first sign-off delegate only where
 * the page grant gate (`pageApplyRefusal`, the check approve-page-apply runs) would let that delegate approve every page of
 * the task; everything else stays the owner's (no `waitsOn`). The plugin tables are the real ones on an embedded Postgres
 * under the host's SQL rules. Skipped where embedded Postgres is not available.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cockpitSnapshot } from "../src/cockpit.js";
import { NAMESPACE } from "../src/namespace.js";
import { validateParams, validateRuntimeQuery } from "./helpers/sql-guard.js";

vi.mock("@partnersinbiz/pib-plugin-kit", async (orig) => ({ ...(await orig<object>()), reviewerAgentId: vi.fn(async () => null) }));

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
const RHEA = "5c1b1944-5325-455c-b968-ae0971ea934b";
const SOFIA = "75e41a0f-0000-4000-8000-000000000001";
const ISSUE = "1550e000-0000-4000-8000-000000000001";
const PAGE = "https://acme.co.za/crop-production";
const ADDED = "2026-11-10T08:00:00.000Z";

describePg("SEO cockpit: sign-off waitsOn follows the delegate's page grant gate", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: Sql;
  let issues: Map<string, Row>;
  let config: () => Promise<Row>;
  let kind = "review";

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("seo-waits-on-");
    sql = postgres(pg.connectionString, { max: 4, onnotice: () => undefined });
    await sql.unsafe(`CREATE SCHEMA ${S}`);
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) await sql.unsafe(readFileSync(join(MIGRATIONS, f), "utf8"));
  }, 120_000);
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await pg?.cleanup();
  });

  beforeEach(async () => {
    config = async () => ({ signoffDelegateAgentIds: [RHEA] });
    issues = new Map([[ISSUE, { id: ISSUE, status: "todo", assigneeAgentId: SOFIA, parentId: null }]]);
    for (const name of ["needs_you", "page_apply_grants", "previews", "task_chunks", "sprint_tasks", "optimizations", "sprints"]) await sql.unsafe(`DELETE FROM ${S}.${name}`);
    await sql.unsafe(
      `INSERT INTO ${S}.sprints (id, company_id, name, site_url, site_name, start_date, client_signoff, change_policy, site_access, site_id)
       VALUES ('sp-1', 'co-1', 'S', 'https://acme.co.za', 'Acme', '2026-10-01', 'manual', 'pr_only', 'wordpress', 'site-1')`,
    );
    await sql.unsafe(`INSERT INTO ${S}.sprint_tasks (id, company_id, sprint_id, title, issue_id, issue_status, status) VALUES ('t-1', 'co-1', 'sp-1', 'T', $1, 'todo', 'in_progress')`, [ISSUE]);
    await preview("passed");
    await needsYou("review");
  });

  async function preview(review: string) {
    await sql.unsafe(
      `INSERT INTO ${S}.previews (id, company_id, sprint_id, task_id, issue_id, page_url, title, html, review_status, status, created_at, expires_at)
       VALUES ('p-1', 'co-1', 'sp-1', 't-1', $1, $2, 'P', '<html></html>', $3, 'pending', now() - interval '1 hour', now() + interval '1 day')`,
      [ISSUE, PAGE, review],
    );
  }
  async function needsYou(k: string) {
    kind = k;
    const item = { key: `${kind}:t-1`, kind, title: "Sign off the page change", why: "The Reviewer passed it.", steps: [], links: [], after: "", check: { kind: "manual" }, taskIds: ["t-1"], status: "open", addedAt: ADDED };
    await sql.unsafe(`DELETE FROM ${S}.needs_you`);
    await sql.unsafe(`INSERT INTO ${S}.needs_you (id, company_id, sprint_id, week_start, issue_id, items, status) VALUES ('ny-1', 'co-1', 'sp-1', '2026-11-09', 'digest-issue', $1::jsonb, 'open')`, [JSON.stringify([item])]);
  }

  function ctx(): PluginContext {
    const bind = (params: unknown[]) => params.map((x) => (typeof x === "string" && x.startsWith("[") ? JSON.parse(x) : x)) as never;
    return {
      db: {
        namespace: S,
        query: async (text: string, params: unknown[] = []) => {
          validateRuntimeQuery(text, S, ["heartbeat_runs", "issue_comments"]);
          validateParams(text, params);
          return JSON.parse(JSON.stringify(await sql.unsafe(text, bind(params)))) as Row[];
        },
        execute: async () => {
          throw new Error("the snapshot never writes");
        },
      },
      config: { get: vi.fn(() => config()) },
      state: { get: async () => null, set: async () => {} },
      issues: { get: vi.fn(async (id: string) => issues.get(id) ?? null) },
      agents: { get: vi.fn(async (id: string) => ({ id, status: "idle", name: "SEO Specialist" })) },
      companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PIB" })), list: vi.fn(async () => []) },
      events: { emit: vi.fn(async () => undefined), on: vi.fn() },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    } as unknown as PluginContext;
  }
  async function waiting() {
    return (await cockpitSnapshot(ctx(), "co-1")).waiting;
  }
  async function signoff() {
    const item = (await waiting()).find((w) => w.key === `seo:needs-you:sp-1:${kind}:t-1`);
    expect(item, "the sign-off is still on the list").toBeTruthy();
    return item!;
  }
  const owner = async () => expect((await signoff()).waitsOn).toBeUndefined();

  it("1: the gate says yes, so the sign-off waits on the delegate since the item was added (pr too)", async () => {
    expect(await signoff()).toMatchObject({ waitsOn: { kind: "agent", agentId: RHEA }, since: ADDED, issueId: ISSUE });
    await needsYou("pr");
    expect(await signoff()).toMatchObject({ waitsOn: { kind: "agent", agentId: RHEA }, since: ADDED });
  });
  it("2: no delegate, or a failed settings read, stays the owner's", async () => {
    config = async () => ({ signoffDelegateAgentIds: [] });
    await owner();
    config = async () => { throw new Error("config down"); };
    await owner();
  });
  it("3: a sprint not on WordPress stays the owner's", async () => {
    await sql.unsafe(`UPDATE ${S}.sprints SET site_access = 'repo'`);
    await owner();
  });
  it("4: a change policy other than pr_only stays the owner's", async () => {
    await sql.unsafe(`UPDATE ${S}.sprints SET change_policy = 'merge_seo_scope'`);
    await owner();
  });
  it("5: automatic client sign-off stays the owner's", async () => {
    await sql.unsafe(`UPDATE ${S}.sprints SET client_signoff = 'auto'`);
    await owner();
  });
  it("6: the delegate is the task issue's assignee (no self-approval): owner", async () => {
    issues.get(ISSUE)!.assigneeAgentId = RHEA;
    await owner();
  });
  it("7: a task with no issue stays the owner's", async () => {
    await sql.unsafe(`UPDATE ${S}.sprint_tasks SET issue_id = NULL`);
    await owner();
  });
  it("8: a terminal task, or a done task issue, stays the owner's", async () => {
    await sql.unsafe(`UPDATE ${S}.sprint_tasks SET status = 'done'`);
    await owner();
    await sql.unsafe(`UPDATE ${S}.sprint_tasks SET status = 'in_progress'`);
    issues.get(ISSUE)!.status = "done";
    await owner();
  });
  it("9: a task that names no page stays the owner's", async () => {
    await sql.unsafe(`DELETE FROM ${S}.previews`);
    await owner();
  });
  it("10: a page without a passed preview stays the owner's", async () => {
    await sql.unsafe(`UPDATE ${S}.previews SET review_status = 'pending'`);
    await owner();
  });
  it("11: the site's open grant cap reached stays the owner's", async () => {
    for (let i = 0; i < 10; i++) {
      await sql.unsafe(`INSERT INTO ${S}.page_apply_grants (id, company_id, sprint_id, site_id, task_id, page_url, granted_by, apply_until) VALUES ($1, 'co-1', 'sp-1', 'site-1', 't-x', $2, 'p', now() + interval '1 hour')`, [`g${i}`, `https://acme.co.za/g${i}`]);
    }
    await owner();
  });
  it("12: the preview line never carries waitsOn", async () => {
    const line = (await waiting()).find((w) => w.key === "seo:previews:sp-1");
    expect(line).toMatchObject({ kind: "review" });
    expect(line!.waitsOn).toBeUndefined();
  });
});
