/**
 * 0.37.0 (PAR-9131 T1a, PAR-9139): migration 026 (the `declined` status and the decision columns), the email link that takes one
 * answer, and every reader of `previews` the readers table marks with an action. Runs the plugin's real migrations and reader SQL on
 * an embedded Postgres. Skipped where embedded Postgres is not available.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { deliverPreviewAnswers, listPreviews, refreshStalePreviews, reviveOrphanedChanges } from "../src/service/preview.js";
import { latestTaskPreviews } from "../src/service/client-signoff.js";
import { taskHasPreview } from "../src/service/tasks.js";
import { siteProgress } from "../src/service/report.js";
import { progressEmail } from "../src/engine/progress-email.js";
import { continuationSummary } from "../src/engine/thread.js";
import { previewsForTask } from "../src/db.js";
import { ALREADY_ANSWERED, DECISION_SQL, DECISION_STATE_SQL, DECLINED_PAGE, NOT_READY, refusedAnswer, SCHEMA as SERVER_SCHEMA } from "../ops/preview-server/decision.mjs";
import { seoHost, SPRINT, type Row, type Route } from "./helpers/seo-host.js";

const requireFromDb = createRequire(new URL("../../../db/package.json", import.meta.url));
type Postgres = (url: string, o?: Record<string, unknown>) => any;
type EmbeddedDbHelper = {
  getEmbeddedPostgresTestSupport(): Promise<{ supported: boolean }>;
  startEmbeddedPostgresTestDatabase(prefix: string): Promise<{ connectionString: string; cleanup(): Promise<void> }>;
};
// The deploy host installs only this plugin's dependencies: when the db package or `postgres` is missing, these specs skip.
let postgres: Postgres = (() => { throw new Error("postgres is not installed"); }) as never;
let getEmbeddedPostgresTestSupport: EmbeddedDbHelper["getEmbeddedPostgresTestSupport"] = async () => ({ supported: false });
let startEmbeddedPostgresTestDatabase: EmbeddedDbHelper["startEmbeddedPostgresTestDatabase"] = async () => { throw new Error("embedded postgres is not available"); };
try {
  postgres = requireFromDb("postgres") as Postgres;
  // Loaded by path at run time: the db package is outside this plugin's tsconfig rootDir.
  const dbHelperPath = new URL("../../../db/src/test-embedded-postgres.ts", import.meta.url).pathname;
  ({ getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } = (await import(/* @vite-ignore */ dbHelperPath)) as EmbeddedDbHelper);
} catch {
  // keep the skipping stubs
}
type EmbeddedPostgresTestDatabase = Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const SCHEMA = NAMESPACE;
const migration = (n: string) => readFileSync(join(MIGRATIONS, n), "utf8");
const HOURS = 3_600_000;
const DAYS = 24 * HOURS;
const server = readFileSync(join(import.meta.dirname, "../ops/preview-server/server.mjs"), "utf8");

describe("decision.mjs (no database)", () => {
  it("targets the plugin schema and guards on pending", () => {
    expect(SERVER_SCHEMA).toBe(SCHEMA);
    expect(DECISION_SQL).toMatch(/WHERE id = \$1 AND status = 'pending' AND expires_at > now\(\) AND review_status = 'passed'/);
    expect(DECISION_SQL).toContain("decision_source = 'email', decided_by = 'client:email-link'");
  });

  it("says 'already answered' for a decided row and 'not ready' otherwise", () => {
    expect(ALREADY_ANSWERED).toBe("This preview has already been answered. To change it, reply to the email.");
    for (const s of ["approved", "changes_requested", "declined"]) expect(refusedAnswer(s)).toBe(ALREADY_ANSWERED);
    for (const s of ["pending", "cancelled", undefined]) expect(refusedAnswer(s)).toBe(NOT_READY);
  });

  it("server.mjs uses the exported SQL, answers 409 from refusedAnswer, and shows a declined page before the expiry check", () => {
    expect(server).toContain("pool.query(DECISION_SQL, [token, decision, note])");
    expect(server).toContain("send(res, 409, page(refusedAnswer(rows[0]?.status)))");
    expect(server).not.toMatch(/UPDATE \$\{SCHEMA\}\.previews SET status = \$2/);
    expect(server).toContain('state === "declined") return send(res, 410, page(DECLINED_PAGE))');
    expect(DECLINED_PAGE).toBe("This proposal is not going ahead.");
  });

  it("the thread line names where the decision came from", () => {
    const out = continuationSummary({
      oldIdentifier: "PAR-1", bytes: 50_000, comments: 80, reason: "long", sprintId: "sp-1", lastComments: [],
      task: { title: "Write", status: "blocked", blockerReason: null, humanAsk: null, startedAt: null, evidenceSummary: null },
      previews: [
        { pageUrl: "https://acme.co.za/a/", title: "A", status: "declined", reviewStatus: "passed", reviewNote: null, previewId: "p1", decisionSource: "cockpit" },
        { pageUrl: "https://acme.co.za/b/", title: "B", status: "approved", reviewStatus: "passed", reviewNote: null, previewId: "p2", decisionSource: "email" },
        { pageUrl: "https://acme.co.za/c/", title: "C", status: "pending", reviewStatus: "passed", reviewNote: null, previewId: "p3", decisionSource: null },
      ],
    });
    expect(out).toContain("- https://acme.co.za/a/ · declined (in the cockpit), review passed");
    expect(out).toContain("- https://acme.co.za/b/ · approved (by email), review passed");
    expect(out).toContain("- https://acme.co.za/c/ · pending, review passed");
  });

  it("the progress email says how many pages are not going ahead", () => {
    const site = { siteName: "Acme", siteUrl: "acme.co.za", day: 20, done: [], open: [], next: [], pages: { prepared: 3, asked: 1, approved: 1, declined: 1, held: 0 } };
    expect(progressEmail({ greetingName: null, sites: [site], signature: "x" }).text).toContain("1 approved by you; 1 not going ahead");
    expect(progressEmail({ greetingName: null, sites: [{ ...site, pages: { ...site.pages, declined: 0 } }], signature: "x" }).text).not.toContain("not going ahead");
  });
});

describePg("declined previews and recorded decisions (migration 026)", () => {
  let pg: EmbeddedPostgresTestDatabase;
  let sql: any;

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("seo-declined-");
    sql = postgres(pg.connectionString, { max: 2, onnotice: () => undefined });
    await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    const files = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort();
    for (const f of files.filter((n) => n < "026_")) await sql.unsafe(migration(f));
    await sql.unsafe(`ALTER TABLE ${SCHEMA}.previews DROP CONSTRAINT previews_sprint_id_fkey`);
    // Rows made by the old code, before the migration.
    const ins = (id: string, extra: string) =>
      sql.unsafe(`INSERT INTO ${SCHEMA}.previews (id, company_id, sprint_id, page_url, title, html, expires_at, status, decided_at, handed_at) VALUES ('${id}', 'co-1', 'sp-0', 'https://acme.co.za/', 'T', '<html/>', now() + interval '1 day', ${extra})`);
    await ins("old-approved", "'approved', now() - interval '2 days', now() - interval '1 day'");
    await ins("old-changes", "'changes_requested', now() - interval '3 days', NULL");
    await ins("old-pending", "'pending', NULL, NULL");
    await ins("old-cancelled", "'cancelled', now() - interval '3 days', NULL");
    for (const f of files.filter((n) => n >= "026_")) await sql.unsafe(migration(f));
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
  const one = async (id: string) => (await sql.unsafe(`SELECT * FROM ${SCHEMA}.previews WHERE id = $1`, [id]))[0];
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

  describe("migration 026", () => {
    it("backfills old answers as email answers and old hand-overs as done; pending and cancelled rows get no source", async () => {
      const rows = await sql.unsafe(`SELECT id, status, decision_source, decided_by, handover_done_at IS NOT NULL AND handover_done_at = handed_at AS done, handover_attempts FROM ${SCHEMA}.previews ORDER BY id`);
      expect(rows).toEqual([
        { id: "old-approved", status: "approved", decision_source: "email", decided_by: "client:email-link", done: true, handover_attempts: 0 },
        { id: "old-cancelled", status: "cancelled", decision_source: null, decided_by: null, done: false, handover_attempts: 0 },
        { id: "old-changes", status: "changes_requested", decision_source: "email", decided_by: "client:email-link", done: false, handover_attempts: 0 },
        { id: "old-pending", status: "pending", decision_source: null, decided_by: null, done: false, handover_attempts: 0 },
      ]);
    });

    it("keeps create-preview's INSERT working, accepts declined, refuses other statuses and sources; the CHECK is validated", async () => {
      await reset();
      await sql.unsafe(
        `INSERT INTO ${SCHEMA}.previews (id, company_id, sprint_id, task_id, issue_id, page_url, title, html, changes, expires_at, created_by, review_key, stats)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz, $11, $12, $13::jsonb)`,
        ["ins-1", "co-1", "sp-1", "t-1", "iss-1", "https://acme.co.za/a/", "T", "<html/>", "{}", new Date(Date.now() + HOURS).toISOString(), "agent-1", "key", "{}"],
      );
      await sql.unsafe(`UPDATE ${SCHEMA}.previews SET status = 'declined', decision_source = 'cockpit', decided_by = 'user:u1', decided_at = now() WHERE id = 'ins-1'`);
      await expect(sql.unsafe(`UPDATE ${SCHEMA}.previews SET status = 'bogus' WHERE id = 'ins-1'`)).rejects.toThrow(/previews_status_check/);
      await expect(sql.unsafe(`UPDATE ${SCHEMA}.previews SET decision_source = 'phone' WHERE id = 'ins-1'`)).rejects.toThrow(/previews_decision_source_check/);
      const [c] = await sql.unsafe(`SELECT convalidated FROM pg_constraint WHERE conname = 'previews_status_check'`);
      expect(c.convalidated).toBe(true);
    });

    it("dry-runs the rollback in the header: declined becomes changes_requested and the old CHECK comes back", async () => {
      await reset();
      await put("rb-declined", { status: "declined", decided_at: ago(HOURS), decision_source: "cockpit" });
      await put("rb-approved", { status: "approved", page_url: "https://acme.co.za/b/" });
      const header = migration("026_seo.sql").split("\n").filter((l) => /^--\s{3}(UPDATE|ALTER)/.test(l)).map((l) => l.replace(/^--\s+/, ""));
      expect(header).toHaveLength(3);
      const before = await sql.unsafe(`SELECT id, status FROM ${SCHEMA}.previews ORDER BY id`);
      await sql.begin(async (tx: any) => {
        for (const stmt of header) await tx.unsafe(stmt);
        expect(await tx.unsafe(`SELECT id, status FROM ${SCHEMA}.previews ORDER BY id`)).toEqual([{ id: "rb-approved", status: "approved" }, { id: "rb-declined", status: "changes_requested" }]);
        await expect(tx.unsafe(`UPDATE ${SCHEMA}.previews SET status = 'declined' WHERE id = 'rb-approved'`)).rejects.toThrow(/previews_status_check/);
        throw new Error("DRY_RUN_ROLLBACK");
      }).catch((e: Error) => { if (e.message !== "DRY_RUN_ROLLBACK") throw e; });
      expect(await sql.unsafe(`SELECT id, status FROM ${SCHEMA}.previews ORDER BY id`)).toEqual(before);
    });
  });

  describe("the email link (DECISION_SQL)", () => {
    it("the first answer writes decision_source email; a second answer changes no row", async () => {
      await reset();
      await put("e1");
      expect((await sql.unsafe(DECISION_SQL, ["e1", "approved", "Looks good"])).count).toBe(1);
      const first = await one("e1");
      expect(first).toMatchObject({ status: "approved", decision_source: "email", decided_by: "client:email-link", decision_note: "Looks good", notified_at: null });
      expect((await sql.unsafe(DECISION_SQL, ["e1", "changes_requested", "No, wait"])).count).toBe(0);
      expect(await one("e1")).toEqual(first);
      const [state] = await sql.unsafe(DECISION_STATE_SQL, ["e1"]);
      expect(refusedAnswer(state.status)).toBe(ALREADY_ANSWERED);
    });

    it("takes no answer on a declined, cancelled, expired or unreviewed preview", async () => {
      await reset();
      await put("d", { status: "declined", decision_source: "cockpit", decided_at: ago(HOURS) });
      await put("c", { status: "cancelled", cancelled_prev_status: "pending" });
      await put("x", { expires_at: ago(HOURS) });
      await put("r", { review_status: "pending" });
      for (const id of ["d", "c", "x", "r"]) expect((await sql.unsafe(DECISION_SQL, [id, "approved", null])).count).toBe(0);
      expect((await one("d")).status).toBe("declined");
    });

    it("takes an answer again after staff Undo puts the row back to pending", async () => {
      await reset();
      await put("u", { status: "approved", decision_source: "email", decided_by: "client:email-link", decided_at: ago(HOURS) });
      await sql.unsafe(`UPDATE ${SCHEMA}.previews SET status = 'pending', decided_at = NULL, decided_by = NULL, decision_source = NULL WHERE id = 'u'`);
      expect((await sql.unsafe(DECISION_SQL, ["u", "changes_requested", "Shorter"])).count).toBe(1);
    });

    it("the preview page reads a declined row as declined (shown before the expiry check)", async () => {
      await reset();
      await put("pg-d", { status: "declined", decided_at: ago(2 * DAYS), expires_at: ago(DAYS) });
      const get = server.match(/SELECT html, status, review_status[^`]*/)![0].replaceAll("${SCHEMA}", SCHEMA);
      expect((await sql.unsafe(get, ["pg-d"]))[0]).toMatchObject({ status: "declined", expired: true, approved_live: false });
    });
  });

  describe("readers", () => {
    it("latestTaskPreviews keeps a declined row whose link expired for 30 days after the decision", async () => {
      await reset();
      await put("d10", { status: "declined", decided_at: ago(10 * DAYS), expires_at: ago(5 * DAYS), created_at: ago(40 * DAYS) });
      await put("d31", { status: "declined", decided_at: ago(31 * DAYS), expires_at: ago(5 * DAYS), created_at: ago(40 * DAYS), page_url: "https://acme.co.za/b/" });
      expect((await latestTaskPreviews(host().env, "co-1", "t-1")).map((p) => p.id)).toEqual(["d10"]);
    });

    it("deliverPreviewAnswers picks email answers (and answers with no source), never declined or cockpit rows", async () => {
      await reset();
      await put("mail", { status: "approved", decision_source: "email", decided_at: ago(4 * HOURS), page_url: "https://acme.co.za/1/" });
      await put("legacy", { status: "changes_requested", decided_at: ago(3 * HOURS), page_url: "https://acme.co.za/2/" });
      await put("cockpit", { status: "approved", decision_source: "cockpit", decided_at: ago(2 * HOURS), page_url: "https://acme.co.za/3/" });
      await put("declined", { status: "declined", decision_source: "email", decided_at: ago(HOURS), page_url: "https://acme.co.za/4/" });
      const h = host();
      await deliverPreviewAnswers(h.env).catch(() => undefined);
      expect(h.results[0]!.map((r) => String(r.id))).toEqual(["mail", "legacy"]);
    });

    it("a changes_requested answer delivered on a manual sprint marks the hand-over done; an approval does not", async () => {
      await reset();
      await put("ask", { status: "changes_requested", decision_source: "email", decided_at: ago(2 * HOURS), issue_id: null, page_url: "https://acme.co.za/1/" });
      await put("yes", { status: "approved", decision_source: "email", decided_at: ago(HOURS), issue_id: null, page_url: "https://acme.co.za/2/" });
      const h = host([[/FROM plugin_seo_8099f8879a\.sprints WHERE/, () => [sprint]]]);
      expect(await deliverPreviewAnswers(h.env)).toBe(2);
      const ask = await one("ask");
      expect(ask.notified_at).not.toBeNull();
      expect(ask.handed_at).not.toBeNull();
      expect(ask.handover_done_at).not.toBeNull();
      expect(await one("yes")).toMatchObject({ handed_at: null, handover_done_at: null });
      expect((await one("yes")).notified_at).not.toBeNull();
    });

    it("the revive sweep does not revive a page whose newest preview was declined", async () => {
      await reset();
      await put("older", { review_status: "changes_needed", reviewed_at: ago(3 * HOURS), created_at: ago(5 * HOURS) });
      await put("newer", { status: "declined", decided_at: ago(HOURS), review_status: "changes_needed", reviewed_at: ago(3 * HOURS), created_at: ago(4 * HOURS) });
      const h = host();
      await reviveOrphanedChanges(h.env).catch(() => undefined);
      expect(h.last()).toEqual([]);
    });

    it("the stale sweep does not refresh a page whose newest preview was declined", async () => {
      await reset();
      await put("older", { created_at: ago(70 * HOURS) });
      await put("newer", { status: "declined", decided_at: ago(HOURS), created_at: ago(60 * HOURS) });
      const h = host();
      await refreshStalePreviews(h.env).catch(() => undefined);
      expect(h.last()).toEqual([]);
    });

    it("taskHasPreview counts a declined preview (the agent was answered)", async () => {
      await reset();
      await put("only-declined", { status: "declined", decided_at: ago(HOURS) });
      expect(await taskHasPreview(host().env, "co-1", "t-1")).toBe(true);
    });

    it("the client report counts a declined page as not going ahead, not as waiting", async () => {
      await reset();
      await put("w", { status: "pending", draft_key: "k1", page_url: "https://acme.co.za/w/" });
      await put("d", { status: "declined", decided_at: ago(HOURS), draft_key: "k1", page_url: "https://acme.co.za/d/" });
      const h = host([[/FROM plugin_seo_8099f8879a\.sprint_tasks/, () => []]]);
      const out = await siteProgress(h.env, { id: "sp-1", companyId: "co-1", siteName: "Acme", siteUrl: "https://acme.co.za", startDate: "2026-10-01" } as never, "2026-11-10");
      expect(out.pages).toMatchObject({ prepared: 2, asked: 1, approved: 0, declined: 1 });
    });

    it("list-previews filters on declined", async () => {
      await reset();
      await put("d", { status: "declined", decided_at: ago(HOURS) });
      await put("p", { page_url: "https://acme.co.za/b/" });
      const h = host([[/FROM plugin_seo_8099f8879a\.sprints WHERE id/, () => [sprint]]]);
      const out = (await listPreviews(h.env, "co-1", { sprintId: "sp-1", status: "declined" })) as { previews: Array<Record<string, unknown>> };
      expect(out.previews.map((p) => [p.previewId, p.status])).toEqual([["d", "declined"]]);
    });

    it("previewsForTask returns the decision source for the thread line", async () => {
      await reset();
      await put("s", { status: "declined", decided_at: ago(HOURS), decision_source: "cockpit" });
      const h = host();
      expect((await previewsForTask(h.ctx.db as never, "co-1", "t-1")).map((p) => [p.id, p.decisionSource])).toEqual([["s", "cockpit"]]);
    });
  });
});
