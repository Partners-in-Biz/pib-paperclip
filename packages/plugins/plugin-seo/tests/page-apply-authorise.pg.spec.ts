/**
 * 0.43.0 (PAR-9493 T2a, PAR-9528): who may approve applying a task's pages on a pr_only site, which pages, and the Reviewer
 * PASS. The plugin tables are the real ones on an embedded Postgres under the host's SQL rules, plus a minimal
 * public.issue_comments. Skipped where embedded Postgres is not available.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { grantPageApply } from "../src/service/page-apply.js";
import type { Actor, Env } from "../src/service/common.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

let reviewer: string | null = null;
vi.mock("@partnersinbiz/pib-plugin-kit", async (orig) => ({ ...(await orig<object>()), reviewerAgentId: vi.fn(async () => reviewer) }));

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
const REVIEWER = "9e000000-0000-4000-8000-000000000001";
const ISSUE = "1550e000-0000-4000-8000-000000000001";
const CHILD = "1550e000-0000-4000-8000-000000000002";
const OTHER_ISSUE = "1550e000-0000-4000-8000-000000000003";
const C1 = "c0000000-0000-4000-8000-000000000001";
const PAGE = "https://acme.co.za/crop-production";
const person: Actor = { kind: "user", userId: "user-peet" };
const rhea: Actor = { kind: "agent", agentId: RHEA, runId: "r1", responsibleUserId: null };
const base = { sprintId: "sp-1", taskId: "t-1", pageUrls: [PAGE], note: "Standing approval, Reviewer passed." };

describePg("authorisePageApply", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: Sql;
  let issues: Map<string, Row>;
  let config: () => Promise<Row>;

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("seo-grant-auth-");
    sql = postgres(pg.connectionString, { max: 4, onnotice: () => undefined });
    await sql.unsafe(`CREATE SCHEMA ${S}`);
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) await sql.unsafe(readFileSync(join(MIGRATIONS, f), "utf8"));
    // The test database carries the host schema; a bare copy without its foreign keys keeps the rows small.
    await sql.unsafe(`DROP TABLE IF EXISTS public.issue_comments CASCADE`);
    await sql.unsafe(`CREATE TABLE public.issue_comments (id uuid PRIMARY KEY, company_id text NOT NULL, issue_id uuid NOT NULL, author_agent_id uuid, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz)`);
  }, 120_000);
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await pg?.cleanup();
  });

  beforeEach(async () => {
    reviewer = REVIEWER;
    config = async () => ({ signoffDelegateAgentIds: [RHEA] });
    issues = new Map([[ISSUE, { id: ISSUE, status: "todo", assigneeAgentId: SOFIA, parentId: null }], [CHILD, { id: CHILD, status: "todo", parentId: ISSUE }], [OTHER_ISSUE, { id: OTHER_ISSUE, status: "todo", parentId: null }]]);
    for (const name of ["page_apply_grants", "previews", "task_chunks", "sprint_tasks", "optimizations", "sprints"]) await sql.unsafe(`DELETE FROM ${S}.${name}`);
    await sql.unsafe(`DELETE FROM public.issue_comments`);
    await sql.unsafe(
      `INSERT INTO ${S}.sprints (id, company_id, name, site_url, site_name, start_date, client_signoff, change_policy, site_access, site_id)
       VALUES ('sp-1', 'co-1', 'S', 'https://acme.co.za', 'Acme', '2026-10-01', 'manual', 'pr_only', 'wordpress', 'site-1')`,
    );
    await sql.unsafe(`INSERT INTO ${S}.sprint_tasks (id, company_id, sprint_id, title, issue_id, issue_status, status) VALUES ('t-1', 'co-1', 'sp-1', 'T', $1, 'todo', 'in_progress')`, [ISSUE]);
    await preview("p-1", PAGE, "passed");
  });

  async function preview(id: string, page: string, review: string, opts: { status?: string; ago?: string; task?: string } = {}) {
    await sql.unsafe(
      `INSERT INTO ${S}.previews (id, company_id, sprint_id, task_id, issue_id, page_url, title, html, review_status, status, created_at, expires_at)
       VALUES ($1, 'co-1', 'sp-1', $5, $6, $2, 'P', '<html></html>', $3, $4, now() - $7::interval, now() + interval '1 day')`,
      [id, page, review, opts.status ?? "pending", opts.task ?? "t-1", ISSUE, opts.ago ?? "1 hour"],
    );
  }
  async function comment(body: string, opts: { issue?: string; author?: string; ago?: string; deleted?: boolean } = {}) {
    await sql.unsafe(`INSERT INTO public.issue_comments (id, company_id, issue_id, author_agent_id, body, created_at, deleted_at) VALUES ($1, 'co-1', $2, $3, $4, now() - $5::interval, $6)`, [
      C1, opts.issue ?? ISSUE, opts.author ?? REVIEWER, body, opts.ago ?? "1 hour", opts.deleted ? new Date().toISOString() : null,
    ]);
  }

  function env(): Env {
    const bind = (params: unknown[]) => params.map((x) => (typeof x === "string" && x.startsWith("[") ? JSON.parse(x) : x)) as never;
    const ctx = {
      db: {
        namespace: S,
        query: async (text: string, params: unknown[] = []) => {
          validateRuntimeQuery(text, S, ["issue_comments"]);
          validateParams(text, params);
          return JSON.parse(JSON.stringify(await sql.unsafe(text, bind(params)))) as Row[];
        },
        execute: async (text: string, params: unknown[] = []) => {
          validateRuntimeExecute(text, S);
          validateParams(text, params);
          return { rowCount: (await sql.unsafe(text, bind(params))).count };
        },
      },
      config: { get: vi.fn(() => config()) },
      state: { get: async () => null, set: async () => {} },
      issues: { get: vi.fn(async (id: string) => issues.get(id) ?? null) },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    };
    return { ctx, now: () => new Date() } as unknown as Env;
  }
  const grant = (actor: Actor, params: Row = {}) => grantPageApply(env(), "co-1", actor, { ...base, ...params });
  const grants = async () => sql.unsafe(`SELECT page_url, granted_by_agent_id, review_ref, apply_until FROM ${S}.page_apply_grants ORDER BY page_url`);

  describe("decision table", () => {
    it("1: a person is allowed", async () => {
      const g = await grant(person);
      expect(g.input).toMatchObject({ pageUrls: [PAGE], grantedByAgentId: null, reviewRef: "preview:p-1", siteId: "site-1" });
      expect(await grants()).toHaveLength(1);
    });
    it("2: a delegate that is not the assignee is allowed", async () => {
      const g = await grant(rhea);
      expect(g.input).toMatchObject({ grantedByAgentId: RHEA, grantedBy: `agent ${RHEA} (sign-off delegate)` });
    });
    it("3: a delegate that is the assignee is refused (no self-approval)", async () => {
      issues.get(ISSUE)!.assigneeAgentId = RHEA;
      await expect(grant(rhea)).rejects.toThrow(/no self-approval/);
    });
    it("4: a delegate on a task with no issue is refused", async () => {
      await sql.unsafe(`UPDATE ${S}.sprint_tasks SET issue_id = NULL`);
      await expect(grant(rhea)).rejects.toThrow(/task has no issue/);
    });
    it.each([
      ["not in the list", async () => ({ signoffDelegateAgentIds: [SOFIA] })],
      ["the list is empty", async () => ({})],
      ["the config read fails", async () => { throw new Error("down"); }],
    ])("5: an agent is refused when %s, naming the setting", async (_n, cfg) => {
      config = cfg as () => Promise<Row>;
      await expect(grant(rhea)).rejects.toThrow(/signoffDelegateAgentIds.*Needs you/);
      expect(await grants()).toHaveLength(0);
    });
    it("6: the system is refused", async () => {
      await expect(grant({ kind: "system" })).rejects.toThrow(/Only a person or a sign-off delegate/);
    });
  });

  describe("refusals", () => {
    it.each([
      ["non-WordPress", `UPDATE ${S}.sprints SET site_access = 'repo'`, /not linked to a WordPress site/],
      ["no siteId", `UPDATE ${S}.sprints SET site_id = NULL`, /not linked to a WordPress site/],
      ["not pr_only", `UPDATE ${S}.sprints SET change_policy = 'merge_seo_scope'`, /not pr_only/],
      ["clientSignoff auto", `UPDATE ${S}.sprints SET client_signoff = 'auto'`, /create-preview/],
      ["archived sprint", `UPDATE ${S}.sprints SET status = 'archived'`, /archived/],
      ["task terminal", `UPDATE ${S}.sprint_tasks SET status = 'done'`, /task is done/],
    ])("%s", async (_n, change, text) => {
      await sql.unsafe(change);
      await expect(grant(person)).rejects.toThrow(text);
    });
    it("task not on the sprint", async () => {
      await expect(grant(person, { taskId: "t-9" })).rejects.toThrow(/not on this sprint/);
    });
    it.each(["done", "cancelled"])("issue %s (live)", async (status) => {
      issues.get(ISSUE)!.status = status;
      await expect(grant(person)).rejects.toThrow(new RegExp(`issue is ${status}`));
    });
    it.each([["bad URL", "https://acme.co.za/x?y=1", /not a page address/], ["foreign host", "https://evil.example/crop-production", /not on the sprint's site/]])("%s", async (_n, url, text) => {
      await expect(grant(person, { pageUrls: [url] })).rejects.toThrow(text);
    });
    it("accepts www against a bare site host", async () => {
      const g = await grant(person, { pageUrls: ["https://www.acme.co.za/crop-production/"] });
      expect(g.input.pageUrls).toEqual(["https://www.acme.co.za/crop-production"]);
    });
    it("writes one row for www and bare spellings of one page in one call (first spelling wins)", async () => {
      const g = await grant(person, { pageUrls: [PAGE, "https://www.acme.co.za/crop-production"] });
      expect(g.input.pageUrls).toEqual([PAGE]);
      expect(await grants()).toHaveLength(1);
    });
    it("refuses a URL outside the page set, naming the set", async () => {
      await expect(grant(person, { pageUrls: ["https://acme.co.za/other"] })).rejects.toThrow(`not one of the task's pages: ${PAGE}`);
    });
    it("refuses a task with no page", async () => {
      await sql.unsafe(`DELETE FROM ${S}.previews`);
      await expect(grant(person)).rejects.toThrow(/task names no page/);
    });
    it("takes the page set from the optimization, page groups and dropped pages", async () => {
      await sql.unsafe(`INSERT INTO ${S}.optimizations (id, company_id, sprint_id, signal_type, subject, hypothesis, hypothesis_type, proposed_action, detected_on, target_url) VALUES ('o-1', 'co-1', 'sp-1', 's', 's', 'h', 'h', 'a', '2026-10-01', 'https://acme.co.za/opt')`);
      await sql.unsafe(`UPDATE ${S}.sprint_tasks SET parent_optimization_id = 'o-1', evidence = '{"droppedPages":[{"pageUrl":"https://acme.co.za/dropped"}]}'`);
      await sql.unsafe(`INSERT INTO ${S}.task_chunks (id, company_id, sprint_id, task_id, parent_issue_id, seq, total, label, urls) VALUES ('c-1', 'co-1', 'sp-1', 't-1', 'x', 1, 1, 'G', '["https://acme.co.za/chunk/"]')`);
      await comment("Reviewer: PASS");
      const g = await grant(person, { pageUrls: ["https://acme.co.za/opt", "https://acme.co.za/chunk", "https://acme.co.za/dropped"], reviewCommentId: C1 });
      expect(g.input.pageUrls).toHaveLength(3);
    });
    it("refuses more than 10 open grant pages on the site", async () => {
      for (let i = 0; i < 10; i++) {
        await sql.unsafe(`INSERT INTO ${S}.page_apply_grants (id, company_id, sprint_id, site_id, task_id, page_url, granted_by, apply_until) VALUES ($1, 'co-1', 'sp-1', 'site-1', 't-x', $2, 'p', now() + interval '1 hour')`, [`g${i}`, `https://acme.co.za/g${i}`]);
      }
      await expect(grant(person)).rejects.toThrow(/11 pages open.*at most 10/);
    });
  });

  describe("Reviewer PASS", () => {
    it("refuses when the newest preview of the page needs changes", async () => {
      await preview("p-2", PAGE, "changes_needed", { ago: "1 minute" });
      await expect(grant(person)).rejects.toThrow(/No Reviewer PASS for/);
    });
    it.each([
      ["old PASS on bare, newest changes_needed on www", "https://acme.co.za/crop-production", "https://www.acme.co.za/crop-production"],
      ["old PASS on www, newest changes_needed on bare", "https://www.acme.co.za/crop-production", "https://acme.co.za/crop-production"],
    ])("takes the newest preview across two stored spellings: %s", async (_n, passedUrl, failedUrl) => {
      await sql.unsafe(`DELETE FROM ${S}.previews`);
      await preview("p-old", passedUrl, "passed", { ago: "3 days" });
      await preview("p-new", failedUrl, "changes_needed", { ago: "1 minute" });
      await expect(grant(person)).rejects.toThrow(/No Reviewer PASS for/);
      expect(await grants()).toHaveLength(0);
    });
    it("accepts a Reviewer comment with PASS on a child of the task issue", async () => {
      await sql.unsafe(`UPDATE ${S}.previews SET review_status = 'changes_needed'`);
      await comment("Checked the change set. PASS", { issue: CHILD });
      expect((await grant(rhea, { reviewCommentId: C1 })).input.reviewRef).toBe(`comment:${C1}`);
    });
    it.each([
      ["by another agent", { author: SOFIA }, /not written by the company's Reviewer/],
      ["on an unrelated issue", { issue: OTHER_ISSUE }, /not on the task's issue/],
      ["older than 30 days", { ago: "31 days" }, /older than 30 days/],
      ["deleted", { deleted: true }, /not found/],
      ["containing FAIL", { body: "PASS on copy, FAIL on links" }, /not a PASS/],
    ])("refuses a comment %s", async (_n, opts, text) => {
      await sql.unsafe(`DELETE FROM ${S}.previews WHERE id = 'p-1'`);
      await preview("p-3", PAGE, "pending");
      const { body, ...rest } = opts as { body?: string };
      await comment(body ?? "PASS", rest);
      await expect(grant(person, { reviewCommentId: C1 })).rejects.toThrow(text);
    });
    it("refuses with no Reviewer and no passed preview, naming both routes", async () => {
      reviewer = null;
      await sql.unsafe(`UPDATE ${S}.previews SET review_status = 'pending'`);
      await expect(grant(person)).rejects.toThrow(/create-preview.*reviewCommentId.*no Reviewer is set up/);
    });
  });

  it("a repeat call extends apply_until with no second row", async () => {
    await grant(person, { hours: 2 });
    const first = (await grants())[0]!.apply_until as Date;
    await grant(rhea, { hours: 10 });
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect((rows[0]!.apply_until as Date).getTime()).toBeGreaterThan(first.getTime());
    expect(rows[0]!.granted_by_agent_id).toBe(RHEA);
  });
});
