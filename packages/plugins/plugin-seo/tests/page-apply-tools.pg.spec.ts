/**
 * 0.44.0 (PAR-9493 T2b, PAR-9529): approve-page-apply and revoke-page-apply effects. The plugin tables are the real ones on an
 * embedded Postgres under the host's SQL rules; the host (events, comments, wakeups, state) is faked. resolveNeedsYou is mocked
 * (its own specs cover it). Skipped where embedded Postgres is not available.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { dispatch } from "../src/dispatch.js";
import type { Actor, Env } from "../src/service/common.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

vi.mock("@partnersinbiz/pib-plugin-kit", async (orig) => ({ ...(await orig<object>()), reviewerAgentId: vi.fn(async () => null) }));
const resolveNeedsYou = vi.fn();
vi.mock("../src/service/needs-you.js", async (orig) => ({ ...(await orig<object>()), resolveNeedsYou: (...a: unknown[]) => resolveNeedsYou(...a) }));

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
const person: Actor = { kind: "user", userId: "user-peet" };
const rhea: Actor = { kind: "agent", agentId: RHEA, runId: "r1", responsibleUserId: null };
const sofia: Actor = { kind: "agent", agentId: SOFIA, runId: "r2", responsibleUserId: null };
const base = { sprintId: "sp-1", taskId: "t-1", pageUrls: [PAGE], note: "Standing approval, Reviewer passed." };

describePg("approve-page-apply and revoke-page-apply", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: Sql;
  let emit: ReturnType<typeof vi.fn>;
  let createComment: ReturnType<typeof vi.fn>;
  let requestWakeup: ReturnType<typeof vi.fn>;
  let state: Map<string, unknown>;

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("seo-grant-tools-");
    sql = postgres(pg.connectionString, { max: 4, onnotice: () => undefined });
    await sql.unsafe(`CREATE SCHEMA ${S}`);
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) await sql.unsafe(readFileSync(join(MIGRATIONS, f), "utf8"));
  }, 120_000);
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await pg?.cleanup();
  });

  beforeEach(async () => {
    emit = vi.fn(async () => undefined);
    createComment = vi.fn(async () => ({ id: "c" }));
    requestWakeup = vi.fn(async () => undefined);
    state = new Map();
    resolveNeedsYou.mockReset();
    for (const name of ["page_apply_grants", "apply_windows", "needs_you", "previews", "sprint_tasks", "sprints"]) await sql.unsafe(`DELETE FROM ${S}.${name}`);
    await sql.unsafe(
      `INSERT INTO ${S}.sprints (id, company_id, name, site_url, site_name, start_date, client_signoff, change_policy, site_access, site_id)
       VALUES ('sp-1', 'co-1', 'S', 'https://acme.co.za', 'Acme', '2026-10-01', 'manual', 'pr_only', 'wordpress', 'site-1')`,
    );
    await sql.unsafe(`INSERT INTO ${S}.sprint_tasks (id, company_id, sprint_id, title, issue_id, issue_status, status) VALUES ('t-1', 'co-1', 'sp-1', 'T', $1, 'todo', 'in_progress')`, [ISSUE]);
    await sql.unsafe(
      `INSERT INTO ${S}.previews (id, company_id, sprint_id, task_id, issue_id, page_url, title, html, review_status, status, created_at, expires_at)
       VALUES ('p-1', 'co-1', 'sp-1', 't-1', $1, $2, 'P', '<html></html>', 'passed', 'pending', now() - interval '1 hour', now() + interval '1 day')`,
      [ISSUE, PAGE],
    );
  });

  function env(): Env {
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
      config: { get: vi.fn(async () => ({ signoffDelegateAgentIds: [RHEA] })) },
      companies: { get: async () => ({ issuePrefix: "ACM" }) },
      events: { emit },
      state: { get: async (k: Row) => state.get(JSON.stringify(k)) ?? null, set: async (k: Row, v: unknown) => void state.set(JSON.stringify(k), v) },
      issues: { get: vi.fn(async (id: string) => (id === ISSUE ? { id, status: "todo", assigneeAgentId: SOFIA, parentId: null } : null)), createComment, requestWakeup },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    };
    return { ctx, now: () => new Date() } as unknown as Env;
  }
  const approve = (actor: Actor, params: Row = {}) => dispatch(env(), "co-1", actor, "approve-page-apply", { ...base, ...params }) as Promise<Row>;
  const revoke = (actor: Actor, params: Row = {}) => dispatch(env(), "co-1", actor, "revoke-page-apply", { sprintId: "sp-1", taskId: "t-1", ...params }) as Promise<Row>;
  const openRows = async () => sql.unsafe(`SELECT page_url, revoked_by FROM ${S}.page_apply_grants WHERE revoked_at IS NULL`);
  const lastEmit = () => emit.mock.calls.at(-1)?.[2] as Row;

  it("writes the grant, sends the window, comments and wakes the task issue once", async () => {
    const r = await approve(rhea);
    expect(r).toMatchObject({ sprintId: "sp-1", siteId: "site-1", taskId: "t-1", pages: [PAGE], windowSent: true, needsYouResolved: false, issueNotified: true });
    expect(r.retry).toBeUndefined();
    expect(lastEmit()).toMatchObject({ siteId: "site-1", scope: "pages", pages: [PAGE] });
    expect(createComment).toHaveBeenCalledTimes(1);
    const body = String(createComment.mock.calls[0]![1]);
    for (const part of [PAGE, String(r.applyUntil), base.note, "preview:p-1", "by url alone", "check-meta", "complete-task", "(sign-off delegate)"]) expect(body).toContain(part);
    expect(requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("an emit failure returns windowSent false with retry and leaves the row", async () => {
    emit.mockRejectedValueOnce(new Error("bus down"));
    const r = await approve(person);
    expect(r).toMatchObject({ windowSent: false, issueNotified: true, retry: expect.stringContaining("approve-page-apply again") });
    expect(await openRows()).toHaveLength(1);
  });

  it("resolves an open needsYouKey as the delegate", async () => {
    resolveNeedsYou.mockResolvedValue({ resolved: true, stillOpen: null, tasksContinued: 1 });
    const r = await approve(rhea, { needsYouKey: "task:t-1" });
    expect(r).toMatchObject({ needsYouResolved: true });
    expect(resolveNeedsYou.mock.calls[0]![3]).toBe("task:t-1");
    expect(resolveNeedsYou.mock.calls[0]![4]).toBe(`agent ${RHEA} (sign-off delegate)`);
  });

  it("a needsYouKey already done counts as resolved, without error", async () => {
    resolveNeedsYou.mockResolvedValue({ resolved: false, stillOpen: null, tasksContinued: 0 });
    const items = [{ key: "task:t-1", kind: "task", title: "Apply", steps: [], after: "", status: "done", addedAt: "2026-11-01T00:00:00.000Z" }];
    await sql.unsafe(`INSERT INTO ${S}.needs_you (id, company_id, sprint_id, week_start, items, status) VALUES ('ny-1', 'co-1', 'sp-1', '2026-11-09', $1::jsonb, 'open')`, [JSON.stringify(items)]);
    const r = await approve(rhea, { needsYouKey: "task:t-1" });
    expect(r).toMatchObject({ needsYouResolved: true });
    expect(r.retry).toBeUndefined();
  });

  it("the same input again posts no second comment; a call that extends apply_until posts one", async () => {
    await approve(rhea);
    const again = await approve(rhea);
    expect(again).toMatchObject({ issueNotified: true });
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(requestWakeup).toHaveBeenCalledTimes(1);
    await approve(rhea, { hours: 48 });
    expect(createComment).toHaveBeenCalledTimes(2);
    expect(requestWakeup).toHaveBeenCalledTimes(2);
  });

  it("a failed comment returns retry and a repeat posts it", async () => {
    createComment.mockRejectedValueOnce(new Error("host down"));
    const first = await approve(rhea);
    expect(first).toMatchObject({ issueNotified: false, retry: expect.any(String) });
    expect(requestWakeup).not.toHaveBeenCalled();
    const second = await approve(rhea);
    expect(second).toMatchObject({ issueNotified: true });
    expect(second.retry).toBeUndefined();
    expect(createComment).toHaveBeenCalledTimes(2);
    expect(requestWakeup).toHaveBeenCalledTimes(1);
  });

  it.each([["a delegate", rhea], ["a person", person]])("revoke by %s closes the window and tells the issue once", async (_n, actor) => {
    await approve(person);
    createComment.mockClear();
    const r = await revoke(actor);
    expect(r).toMatchObject({ revoked: 1, pages: [PAGE], windowSent: true, issueNotified: true });
    expect(await openRows()).toHaveLength(0);
    expect(lastEmit()).toMatchObject({ siteId: "site-1", pages: [] });
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(String(createComment.mock.calls[0]![1])).toContain("do not write");
  });

  it("revoke only the named pages (www spelling matches)", async () => {
    await approve(person);
    expect(await revoke(rhea, { pageUrls: ["https://www.acme.co.za/other"] })).toMatchObject({ revoked: 0 });
    expect(await revoke(rhea, { pageUrls: ["https://www.acme.co.za/crop-production"] })).toMatchObject({ revoked: 1 });
  });

  it("revoke by an agent that is not a delegate is refused", async () => {
    await approve(person);
    await expect(revoke(sofia)).rejects.toThrow(/not a sign-off delegate/);
    expect(await openRows()).toHaveLength(1);
  });

  it("revoke of nothing open returns 0 and posts nothing", async () => {
    const r = await revoke(person);
    expect(r).toMatchObject({ revoked: 0, pages: [] });
    expect(createComment).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
  // 0.45.0 (PAR-9493 T3, PAR-9530): needs-you-resolve with pageUrls opens the window through approve-page-apply first.
  describe("needs-you-resolve with pageUrls", () => {
    const seedItem = async (taskIds: string[], key = "change-set-1") => {
      const items = [{ key, kind: "task", title: "Approve page refresh: crop production", why: "w", steps: [], links: [], after: "a", check: "manual", taskIds, status: "open", addedAt: "2026-11-01T00:00:00.000Z" }];
      await sql.unsafe(`INSERT INTO ${S}.needs_you (id, company_id, sprint_id, week_start, items, status) VALUES ('ny-r', 'co-1', 'sp-1', date_trunc('week', now())::date, $1::jsonb, 'open')`, [JSON.stringify(items)]);
    };
    const resolve = (actor: Actor, params: Row) => dispatch(env(), "co-1", actor, "needs-you-resolve", { sprintId: "sp-1", key: "change-set-1", pageUrls: [PAGE], ...params }) as Promise<Row>;
    beforeEach(() => resolveNeedsYou.mockResolvedValue({ resolved: true, stillOpen: null, tasksContinued: 1 }));

    it("the item's single task: opens the window and resolves the item with needsYouKey", async () => {
      await seedItem(["t-1"]);
      const r = await resolve(rhea, {});
      expect(r).toMatchObject({ sprintId: "sp-1", key: "change-set-1", taskId: "t-1", pages: [PAGE], applyWindow: "opened", resolved: true, needsYouResolved: true, windowSent: true });
      expect(await openRows()).toHaveLength(1);
      expect(resolveNeedsYou.mock.calls[0]![3]).toBe("change-set-1");
      // 24 h default
      const hours = (Date.parse(String(r.applyUntil)) - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(23.9);
      expect(hours).toBeLessThanOrEqual(24);
    });

    it("an item with no taskIds opens with taskId (the Agri Studies shape)", async () => {
      await seedItem([]);
      expect(await resolve(person, { taskId: "t-1" })).toMatchObject({ taskId: "t-1", applyWindow: "opened", resolved: true });
      expect(await openRows()).toHaveLength(1);
    });

    it("refuses a taskId outside the item's tasks, and 0 or several tasks without taskId", async () => {
      await seedItem(["t-1"]);
      await expect(resolve(rhea, { taskId: "t-2" })).rejects.toThrow(/not one of this item's tasks/);
      await sql.unsafe(`DELETE FROM ${S}.needs_you`);
      await seedItem([]);
      await expect(resolve(rhea, {})).rejects.toThrow(/names no task.*pass taskId/);
      await sql.unsafe(`DELETE FROM ${S}.needs_you`);
      await seedItem(["t-1", "t-2"]);
      await expect(resolve(rhea, {})).rejects.toThrow(/names 2 tasks.*pass taskId/);
      expect(await openRows()).toHaveLength(0);
      expect(resolveNeedsYou).not.toHaveBeenCalled();
    });

    it("a refused grant (no Reviewer PASS) leaves the item open", async () => {
      await seedItem(["t-1"]);
      await sql.unsafe(`UPDATE ${S}.previews SET review_status = 'pending'`);
      await expect(resolve(rhea, {})).rejects.toThrow(/No Reviewer PASS/);
      expect(resolveNeedsYou).not.toHaveBeenCalled();
      expect(await openRows()).toHaveLength(0);
      const [row] = await sql.unsafe<{ items: unknown }>(`SELECT items FROM ${S}.needs_you WHERE id = 'ny-r'`);
      const items = (typeof row!.items === "string" ? JSON.parse(row!.items) : row!.items) as Array<{ status: string }>;
      expect(items[0]!.status).toBe("open");
    });

    it("the task issue's assignee cannot open it through needs-you-resolve either", async () => {
      await seedItem(["t-1"]);
      await expect(resolve(sofia, {})).rejects.toThrow(/not a sign-off delegate|no self-approval/);
      expect(resolveNeedsYou).not.toHaveBeenCalled();
    });
  });
});
