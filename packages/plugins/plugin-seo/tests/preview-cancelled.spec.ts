/**
 * 0.33.0 (PAR-8972 T1a): the `cancelled` preview status. Runs the plugin's real migrations and the real reader SQL on an embedded
 * Postgres, because the fake hosts cannot tell whether "an older live preview wins over a newer cancelled one" is true.
 * Skipped where embedded Postgres is not available.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { deliverPreviewAnswers, handStuckPreviewsToSenior, listPreviews, nudgeStalledReviews, previewRows, refreshStalePreviews, reviewPreview, reviveOrphanedChanges } from "../src/service/preview.js";
import { latestTaskPreviews, previewsToDraft } from "../src/service/client-signoff.js";
import { reclaimPersonHandOffs, taskHasPreview } from "../src/service/tasks.js";
import { needsYouAddTool } from "../src/service/needs-you.js";
import { siteProgress } from "../src/service/report.js";
import { onBuildIssueUpdated } from "../src/service/build.js";
import { SeoError } from "../src/service/common.js";
import { seoHost, SPRINT, taskRow, type Row, type Route } from "./helpers/seo-host.js";

const requireFromDb = createRequire(new URL("../../../db/package.json", import.meta.url));
const postgres = requireFromDb("postgres") as (url: string, o?: Record<string, unknown>) => any;
// Loaded by path at run time: the db package is outside this plugin's tsconfig rootDir.
const dbHelperPath = new URL("../../../db/src/test-embedded-postgres.ts", import.meta.url).pathname;
const { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } = (await import(/* @vite-ignore */ dbHelperPath)) as {
  getEmbeddedPostgresTestSupport(): Promise<{ supported: boolean }>;
  startEmbeddedPostgresTestDatabase(prefix: string): Promise<{ connectionString: string; cleanup(): Promise<void> }>;
};
type EmbeddedPostgresTestDatabase = Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const SCHEMA = NAMESPACE;
const migration = (n: string) => readFileSync(join(MIGRATIONS, n), "utf8");
const HOURS = 3_600_000;

describePg("cancelled previews", () => {
  let pg: EmbeddedPostgresTestDatabase;
  let sql: any;

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("seo-cancelled-");
    sql = postgres(pg.connectionString, { max: 2, onnotice: () => undefined });
    await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    const files = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort();
    for (const f of files.filter((n) => n < "025_")) await sql.unsafe(migration(f));
    await sql.unsafe(`ALTER TABLE ${SCHEMA}.previews DROP CONSTRAINT previews_sprint_id_fkey`); // sprint rows are not what is under test
    // A row made by the old code, before the migration: it must come through untouched.
    await sql.unsafe(`INSERT INTO ${SCHEMA}.previews (id, company_id, sprint_id, page_url, title, html, expires_at, status) VALUES ('pre-025', 'co-1', 'sp-0', 'https://acme.co.za/', 'T', '<html/>', now() + interval '1 day', 'changes_requested')`);
    for (const f of files.filter((n) => n >= "025_")) await sql.unsafe(migration(f));
  }, 120_000);
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await pg?.cleanup();
  });

  const reset = () => sql.unsafe(`DELETE FROM ${SCHEMA}.previews`);
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  async function put(id: string, extra: Record<string, unknown> = {}) {
    const row = { company_id: "co-1", sprint_id: "sp-1", task_id: "t-1", page_url: "https://acme.co.za/a/", title: id, html: "<html></html>", review_status: "passed", status: "pending", created_at: ago(3 * HOURS), expires_at: new Date(Date.now() + 24 * HOURS).toISOString(), ...extra };
    const cols = Object.keys(row);
    await sql.unsafe(`INSERT INTO ${SCHEMA}.previews (id, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")})`, [id, ...Object.values(row)] as never);
  }
  /** A host whose previews table is the real one; every other table answers from `routes`. */
  function host(routes: Route[] = []) {
    const h = seoHost({ routes, now: new Date().toISOString() });
    const fakeQuery = h.ctx.db.query.bind(h.ctx.db);
    const results: Row[][] = [];
    h.ctx.db.query = (async (text: string, params: unknown[] = []) => {
      if (!new RegExp(`FROM ${SCHEMA}\\.previews`).test(text)) return fakeQuery(text, params);
      const out = (await sql.unsafe(text, params as never)) as unknown as Row[];
      results.push(out);
      return out;
    }) as never;
    h.ctx.db.execute = (async (text: string, params: unknown[] = []) => {
      h.executes.push({ sql: text, params });
      const r = await sql.unsafe(text, params as never);
      return { rowCount: r.count };
    }) as never;
    return { ...h, results, last: () => results.at(-1)!.map((r) => String(r.id)) };
  }
  const sprint = { ...SPRINT, id: "sp-1", company_id: "co-1" };
  const sprintObj = { id: "sp-1", companyId: "co-1", clientSignoff: "auto" } as never;

  describe("migration 025", () => {
    it("keeps the INSERT of create-preview working, accepts cancelled and refuses other statuses", async () => {
      expect(await sql.unsafe(`SELECT status, cancelled_at, cancelled_by, cancel_reason, cancelled_prev_status FROM ${SCHEMA}.previews WHERE id = 'pre-025'`)).toEqual([{ status: "changes_requested", cancelled_at: null, cancelled_by: null, cancel_reason: null, cancelled_prev_status: null }]);
      await reset();
      await sql.unsafe(
        `INSERT INTO ${SCHEMA}.previews (id, company_id, sprint_id, task_id, issue_id, page_url, title, html, changes, expires_at, created_by, review_key, stats)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz, $11, $12, $13::jsonb)`,
        ["ins-1", "co-1", "sp-1", "t-1", "iss-1", "https://acme.co.za/a/", "T", "<html/>", "{}", new Date(Date.now() + HOURS).toISOString(), "agent-1", "key", "{}"],
      );
      await sql.unsafe(`UPDATE ${SCHEMA}.previews SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'u', cancel_reason = 'dup', cancelled_prev_status = 'pending' WHERE id = 'ins-1'`);
      await expect(sql.unsafe(`UPDATE ${SCHEMA}.previews SET status = 'bogus' WHERE id = 'ins-1'`)).rejects.toThrow(/previews_status_check/);
      const [c] = await sql.unsafe(`SELECT convalidated FROM pg_constraint WHERE conname = 'previews_status_check'`);
      expect(c.convalidated).toBe(true);
    });

    it("dry-runs both rollback statements (old CHECK comes back, rows get their exact prior status), then rolls back", async () => {
      await reset();
      await put("rb-pending", { status: "cancelled", cancelled_prev_status: "pending" });
      await put("rb-approved", { status: "cancelled", cancelled_prev_status: "approved", page_url: "https://acme.co.za/b/" });
      await put("rb-live", { page_url: "https://acme.co.za/c/" });
      const before = await sql.unsafe(`SELECT id, status FROM ${SCHEMA}.previews ORDER BY id`);
      const out: string[] = [`before: ${JSON.stringify(before)}`];
      await sql.begin(async (tx: any) => {
        await tx.unsafe(`UPDATE ${SCHEMA}.previews SET status = cancelled_prev_status WHERE status = 'cancelled'`);
        await tx.unsafe(`ALTER TABLE ${SCHEMA}.previews DROP CONSTRAINT previews_status_check`);
        await tx.unsafe(`ALTER TABLE ${SCHEMA}.previews ADD CONSTRAINT previews_status_check CHECK (status IN ('pending', 'approved', 'changes_requested'))`);
        const after = await tx.unsafe(`SELECT id, status FROM ${SCHEMA}.previews ORDER BY id`);
        out.push(`after rollback statements: ${JSON.stringify(after)}`);
        expect(after).toEqual([{ id: "rb-approved", status: "approved" }, { id: "rb-live", status: "pending" }, { id: "rb-pending", status: "pending" }]);
        await expect(tx.unsafe(`SAVEPOINT s`).then(() => tx.unsafe(`UPDATE ${SCHEMA}.previews SET status = 'cancelled' WHERE id = 'rb-live'`))).rejects.toThrow(/previews_status_check/);
        out.push("old CHECK rejects 'cancelled' again: ok");
        throw new Error("DRY_RUN_ROLLBACK");
      }).catch((e: Error) => { if (e.message !== "DRY_RUN_ROLLBACK") throw e; });
      expect(await sql.unsafe(`SELECT id, status FROM ${SCHEMA}.previews ORDER BY id`)).toEqual(before);
      out.push("rolled back: table unchanged");
      // Option B: the pending duplicates stay hidden under the old code (expired), the approved one comes back as approved.
      await sql.begin(async (tx: any) => {
        await tx.unsafe(`UPDATE ${SCHEMA}.previews SET status = 'pending', expires_at = LEAST(expires_at, now()) WHERE status = 'cancelled' AND cancelled_prev_status = 'pending'`);
        await tx.unsafe(`UPDATE ${SCHEMA}.previews SET status = cancelled_prev_status WHERE status = 'cancelled'`);
        const after = await tx.unsafe(`SELECT id, status, expires_at <= now() AS expired FROM ${SCHEMA}.previews ORDER BY id`);
        out.push(`option B: ${JSON.stringify(after)}`);
        expect(after).toEqual([{ id: "rb-approved", status: "approved", expired: false }, { id: "rb-live", status: "pending", expired: false }, { id: "rb-pending", status: "pending", expired: true }]);
        throw new Error("DRY_RUN_ROLLBACK");
      }).catch((e: Error) => { if (e.message !== "DRY_RUN_ROLLBACK") throw e; });
      if (process.env.SHOW_DRY_RUN) process.stderr.write(`ROLLBACK-DRY-RUN\n${out.join("\n")}\n`);
    });
  });

  // One page: an older live preview and a newer cancelled one. The older one must win everywhere.
  const pair = async (older: Record<string, unknown> = {}) => {
    await reset();
    await put("old-live", { created_at: ago(4 * HOURS), ...older });
    await put("new-cancelled", { created_at: ago(1 * HOURS), status: "cancelled", cancelled_prev_status: "pending", cancelled_at: ago(0.5 * HOURS), review_status: "pending" });
  };

  it("task gate (latestTaskPreviews) picks the older live preview", async () => {
    await pair();
    expect((await latestTaskPreviews(host().env, "co-1", "t-1")).map((p) => p.id)).toEqual(["old-live"]);
  });

  it("draft (previewsToDraft) picks the older live preview", async () => {
    await pair({ reviewed_at: ago(2 * HOURS), task_id: null }); // task_id null: not tied to a client-assigned task
    expect((await previewsToDraft(host().env, sprintObj)).map((p) => p.id)).toEqual(["old-live"]);
  });

  it("report (siteProgress) counts the older live preview, not the cancelled one", async () => {
    await pair();
    const h = host([[/FROM plugin_seo_8099f8879a\.sprint_tasks/, () => []]]);
    await siteProgress(h.env, sprintObj, "2026-11-10").catch(() => undefined);
    expect(h.results.at(-1)).toMatchObject([{ status: "pending", review_status: "passed" }]); // one row: the older, passed one (the cancelled one is pending review)
  });

  it("nudge: the older pending review is still nudged, the cancelled newer row does not supersede it", async () => {
    await pair({ review_status: "pending", review_issue_id: "rev-1", created_at: ago(5 * HOURS) });
    const h = host();
    await nudgeStalledReviews(h.env).catch(() => undefined);
    expect(h.last()).toEqual(["old-live"]);
  });

  it("nudge: a cancelled row is never nudged itself", async () => {
    await reset();
    await put("only-cancelled", { status: "cancelled", review_status: "pending", review_issue_id: "rev-1", created_at: ago(5 * HOURS) });
    const h = host();
    await nudgeStalledReviews(h.env).catch(() => undefined);
    expect(h.last()).toEqual([]);
  });

  it("orphan sweep picks the older changes_needed preview", async () => {
    await pair({ review_status: "changes_needed", reviewed_at: ago(3 * HOURS), created_at: ago(5 * HOURS) });
    const h = host();
    await reviveOrphanedChanges(h.env).catch(() => undefined);
    expect(h.last()).toEqual(["old-live"]);
  });

  it("stale sweep picks the older passed preview", async () => {
    await pair({ created_at: ago(60 * HOURS) });
    const h = host();
    await refreshStalePreviews(h.env).catch(() => undefined);
    expect(h.last()).toEqual(["old-live"]);
  });

  it("previewRows lists the older preview and does not mark it superseded; the cancelled row is not listed", async () => {
    await pair();
    const rows = await previewRows(host().env, "co-1", "sp-1");
    expect(rows.map((r) => r.id)).toEqual(["old-live"]);
    expect(rows[0]).toMatchObject({ superseded: false });
  });

  it("preview-stuck picker hands the older preview to the Senior Developer, not the cancelled one", async () => {
    await pair({ review_status: "changes_needed" });
    const item = { key: "preview-stuck:t-1:https://acme.co.za/a/", status: "open", taskIds: ["t-1"], title: "A", why: "keeps failing" };
    const h = host([
      [/SELECT DISTINCT company_id FROM plugin_seo_8099f8879a\.sprints/, () => [{ company_id: "co-1" }]],
      [/FROM plugin_seo_8099f8879a\.needs_you n JOIN/, () => [{ sprint_id: "sp-1", items: [item] }]],
      [/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE id/, () => [taskRow({ id: "t-1", issue_id: "iss-1" })]],
    ]);
    await handStuckPreviewsToSenior(h.env).catch(() => undefined);
    expect(h.last()).toEqual(["old-live"]);
    void sprint;
  });

  it("round counts ignore cancelled rows (review-preview changes verdict)", async () => {
    await reset();
    await put("r1", { review_status: "changes_needed", created_at: ago(9 * HOURS) });
    await put("r2", { review_status: "changes_needed", status: "cancelled", cancelled_prev_status: "pending", created_at: ago(8 * HOURS) });
    await put("r3", { review_status: "pending", created_at: ago(7 * HOURS) });
    const h = host([[/FROM plugin_seo_8099f8879a\.sprints WHERE id/, () => [sprint]]]);
    await reviewPreview(h.env, "co-1", { kind: "user", userId: "user-1" }, { sprintId: "sp-1", previewId: "r3", verdict: "changes", notes: "No." }).catch(() => undefined);
    const counts = h.results.filter((r) => r.length === 1 && "n" in r[0]!).map((r) => Number(r[0]!.n));
    expect(counts.length).toBeGreaterThan(0);
    expect(new Set(counts)).toEqual(new Set([2])); // r1 and r3 (just marked changes_needed); r2 is cancelled and not counted
  });

  it("build.ts:214 'a corrected preview was made' ignores a cancelled newer row", async () => {
    await reset();
    await put("cancelled-newer", { status: "cancelled", cancelled_prev_status: "pending", created_at: ago(1 * HOURS) });
    const sqlText = readFileSync(join(import.meta.dirname, "../src/service/build.ts"), "utf8");
    expect(sqlText).toMatch(/task_id = \$2 AND status <> 'cancelled' AND created_at > \$3::timestamptz LIMIT 1/);
    const rows = await sql.unsafe(`SELECT id FROM ${SCHEMA}.previews WHERE company_id = $1 AND task_id = $2 AND status <> 'cancelled' AND created_at > $3::timestamptz LIMIT 1`, ["co-1", "t-1", ago(2 * HOURS)]);
    expect(rows).toHaveLength(0);
    void onBuildIssueUpdated;
  });

  it("deliverPreviewAnswers skips a cancelled row that was answered but not yet delivered", async () => {
    await reset();
    await put("answered-then-cancelled", { status: "cancelled", cancelled_prev_status: "approved", decided_at: ago(HOURS), notified_at: null });
    const h = host();
    expect(await deliverPreviewAnswers(h.env)).toBe(0);
    expect(h.last()).toEqual([]);
    expect(h.executes.filter((e) => /SET notified_at/.test(e.sql))).toHaveLength(0);
  });

  it("review-preview on a cancelled preview throws a SeoError before any write", async () => {
    await reset();
    await put("dead", { status: "cancelled", cancelled_prev_status: "pending", review_status: "pending", created_by: "agent-9" });
    const h = host([[/FROM plugin_seo_8099f8879a\.sprints WHERE id/, () => [sprint]]]);
    const err = await reviewPreview(h.env, "co-1", { kind: "user", userId: "user-1" }, { sprintId: "sp-1", previewId: "dead", verdict: "pass" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeoError);
    expect((err as Error).message).toMatch(/was cancelled/);
    expect(h.executes).toHaveLength(0);
  });

  it("list-previews accepts status cancelled and the full row adds cancelReason and cancelledAt", async () => {
    await reset();
    await put("dead", { status: "cancelled", cancelled_prev_status: "pending", cancel_reason: "duplicate of x", cancelled_at: ago(HOURS) });
    await put("live", { page_url: "https://acme.co.za/b/" });
    const h = host([[/FROM plugin_seo_8099f8879a\.sprints WHERE id/, () => [sprint]]]);
    const out = (await listPreviews(h.env, "co-1", { sprintId: "sp-1", status: "cancelled", compact: false })) as { previews: Array<Record<string, unknown>> };
    expect(out.previews).toHaveLength(1);
    expect(out.previews[0]).toMatchObject({ previewId: "dead", status: "cancelled", cancelReason: "duplicate of x" });
    expect(out.previews[0]!.cancelledAt).toBeTruthy();
    const live = (await listPreviews(h.env, "co-1", { sprintId: "sp-1", compact: false })) as { previews: Array<Record<string, unknown>> };
    expect(live.previews.find((p) => p.previewId === "live")).not.toHaveProperty("cancelReason");
  });

  it("the preview server SQL: GET answers 410 for a cancelled preview before expiry, POST /decision does not change it", async () => {
    await reset();
    await put("srv", { status: "cancelled", cancelled_prev_status: "pending", expires_at: ago(-HOURS) });
    const server = readFileSync(join(import.meta.dirname, "../ops/preview-server/server.mjs"), "utf8");
    const cancelledAt = server.indexOf('rows[0].status === "cancelled"');
    expect(cancelledAt).toBeGreaterThan(0);
    expect(cancelledAt).toBeLessThan(server.indexOf("rows[0].expired) return send(res, 410"));
    expect(server).toContain("This preview was replaced by a newer version. We will send you the current link.");
    const post = server.match(/UPDATE \$\{SCHEMA\}\.previews SET status = \$2[^`]*/)![0].replaceAll("${SCHEMA}", SCHEMA);
    const r = await sql.unsafe(post, ["srv", "approved", null]);
    expect(r.count).toBe(0);
    const get = server.match(/SELECT html, status, review_status[^`]*/)![0].replaceAll("${SCHEMA}", SCHEMA).replace("$1", "'srv'");
    const [row] = await sql.unsafe(get);
    expect(row.status).toBe("cancelled");
  });
  describe("task-level readers: a cancelled preview is not a preview the client can answer", () => {
    const actor = { type: "agent", id: "agent-1" } as never;
    async function seedTask(id: string) {
      await sql.unsafe(`ALTER TABLE ${SCHEMA}.sprint_tasks DROP CONSTRAINT IF EXISTS sprint_tasks_sprint_id_fkey`);
      await sql.unsafe(`DELETE FROM ${SCHEMA}.sprint_tasks`);
      await sql.unsafe(`DELETE FROM ${SCHEMA}.sprints`);
      await sql.unsafe(`INSERT INTO ${SCHEMA}.sprints (id, company_id, name, site_name, start_date, site_url, status, client_signoff) VALUES ('sp-1', 'co-1', 'S', 'Acme', current_date, 'https://acme.co.za', 'active', 'auto')`);
      await sql.unsafe(`INSERT INTO ${SCHEMA}.sprint_tasks (id, company_id, sprint_id, title, task_type, status, issue_id) VALUES ($1, 'co-1', 'sp-1', 'Write', 'page-write', 'blocked', 'iss-1')`, [id]);
    }
    const onlyCancelled = async () => { await reset(); await put("c-only", { status: "cancelled", cancelled_prev_status: "pending" }); };
    const olderLive = async () => { await onlyCancelled(); await put("live", { created_at: ago(5 * HOURS) }); };

    it("taskHasPreview: only a cancelled preview counts as none, an older live one counts", async () => {
      await onlyCancelled();
      expect(await taskHasPreview(host().env, "co-1", "t-1")).toBe(false);
      await olderLive();
      expect(await taskHasPreview(host().env, "co-1", "t-1")).toBe(true);
    });

    // These two queries join sprint_tasks, so they are sent to the real database whole.
    const realHost = () => {
      const h = host([[/FROM plugin_seo_8099f8879a\.sprints WHERE id = \$1/, () => [{ ...SPRINT, client_signoff: "auto" }]]]);
      const before = h.ctx.db.query.bind(h.ctx.db);
      h.ctx.db.query = (async (text: string, params: unknown[] = []) => (/NOT EXISTS \(SELECT 1 FROM plugin_seo_8099f8879a\.previews/.test(text) ? ((await sql.unsafe(text, params.map((x) => (typeof x === "string" && x.startsWith("[") ? JSON.parse(x) : x)) as never)) as unknown as Row[]) : before(text, params))) as never;
      return h;
    };

    it("reclaimPersonHandOffs: a blocked page task with only a cancelled preview is a candidate; with an older live one it is not", async () => {
      await seedTask("t-1");
      await onlyCancelled();
      const h = realHost();
      const seen: string[][] = [];
      const orig = h.ctx.db.query;
      h.ctx.db.query = (async (text: string, params: unknown[] = []) => { const r = await orig(text, params); if (/AS t JOIN|t JOIN/.test(text) && /reclaim|NOT EXISTS/.test(text)) seen.push((r as Row[]).map((x) => String(x.id))); return r; }) as never;
      await reclaimPersonHandOffs(h.env).catch(() => undefined);
      expect(seen.at(-1)).toEqual(["t-1"]);
      await olderLive();
      seen.length = 0;
      await reclaimPersonHandOffs(h.env).catch(() => undefined);
      expect(seen.at(-1)).toEqual([]);
    });

    it("needs-you-add on an auto sign-off sprint: only a cancelled preview does not satisfy the page; an older live one does", async () => {
      await seedTask("t-1");
      const params = { sprintId: "sp-1", kind: "task", title: "Apply it", why: "x", after: "y", taskIds: ["t-1"] };
      await onlyCancelled();
      await expect(needsYouAddTool(realHost().env, "co-1", actor, params)).rejects.toThrow(/client sign-off is automatic/);
      await olderLive();
      await expect(needsYouAddTool(realHost().env, "co-1", actor, params)).resolves.toMatchObject({ key: "task:apply-it" });
    });
  });
});
