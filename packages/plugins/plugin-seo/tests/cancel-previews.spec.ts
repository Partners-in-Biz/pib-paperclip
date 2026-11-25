/**
 * 0.34.0 (PAR-8972 T1b): the `cancel-previews` tool and its 5-minute follow-up. Real migrations and the real SQL on an embedded
 * Postgres (prefix matching with `_` and `-`, the status guards and the idempotent UPDATE cannot be proven on a fake host); the
 * Paperclip issues API is the recording fake from seo-host. Skipped where embedded Postgres is not available.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { cancelPreviews, handleCancelledPreviews } from "../src/service/cancel.js";
import { dispatch } from "../src/dispatch.js";
import { SEO_TOOL_DECLARATIONS } from "../src/tools.js";
import { SeoError } from "../src/service/common.js";
import { seoHost, type Row } from "./helpers/seo-host.js";

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
const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const S = NAMESPACE;
const HOURS = 3_600_000;
const agent = { kind: "agent", agentId: "agent-1", runId: "run-1" } as never;

describe("cancel-previews registration", () => {
  it("is a Site tool with the documented parameters and a handler", () => {
    const tool = SEO_TOOL_DECLARATIONS.find((x) => x.name === "cancel-previews")!;
    expect(tool.group).toBe("Site");
    expect(tool.parametersSchema.required).toEqual(["sprintId", "previewIds", "reason"]);
    expect(Object.keys(tool.parametersSchema.properties as object)).toEqual(expect.arrayContaining(["allowApproved", "allowLast", "dryRun"]));
  });
});

describePg("cancel-previews", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: any;

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("seo-cancel-previews-");
    sql = postgres(pg.connectionString, { max: 2, onnotice: () => undefined });
    await sql.unsafe(`CREATE SCHEMA ${S}`);
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) await sql.unsafe(readFileSync(join(MIGRATIONS, f), "utf8"));
    await sql.unsafe(`ALTER TABLE ${S}.previews DROP CONSTRAINT previews_sprint_id_fkey`);
    await sql.unsafe(`ALTER TABLE ${S}.sprint_tasks DROP CONSTRAINT IF EXISTS sprint_tasks_sprint_id_fkey`);
  }, 120_000);
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await pg?.cleanup();
  });

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  async function put(id: string, extra: Record<string, unknown> = {}) {
    const row = { company_id: "co-1", sprint_id: "sp-1", task_id: "t-1", page_url: "https://acme.co.za/a/", title: id, html: "<html></html>", review_status: "passed", status: "pending", created_at: ago(3 * HOURS), expires_at: new Date(Date.now() + 24 * HOURS).toISOString(), ...extra };
    const cols = Object.keys(row);
    await sql.unsafe(`INSERT INTO ${S}.previews (id, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")})`, [id, ...Object.values(row)] as never);
  }
  const status = async (id: string) => (await sql.unsafe(`SELECT status, cancelled_prev_status, cancelled_by, cancel_reason, cancelled_at, stats FROM ${S}.previews WHERE id = $1`, [id]))[0];

  /** A host whose database is the real one for every table; the issues API is the recording fake. */
  function host() {
    const h = seoHost({ now: new Date().toISOString() });
    const plain = (rows: unknown) => JSON.parse(JSON.stringify(rows));
    // postgres.js would send a JSON text bound to ::jsonb as a JSON string; the host binds it as the JSON itself.
    const bind = (params: unknown[]) => params.map((x) => (typeof x === "string" && x.startsWith("[") ? JSON.parse(x) : x)) as never;
    h.ctx.db.query = (async (text: string, params: unknown[] = []) => plain(await sql.unsafe(text, bind(params)))) as never;
    h.ctx.db.execute = (async (text: string, params: unknown[] = []) => ({ rowCount: (await sql.unsafe(text, bind(params))).count })) as never;
    return h;
  }

  beforeEach(async () => {
    await sql.unsafe(`DELETE FROM ${S}.previews`);
    await sql.unsafe(`DELETE FROM ${S}.sprint_tasks`);
    await sql.unsafe(`DELETE FROM ${S}.sprints`);
    await sql.unsafe(`INSERT INTO ${S}.sprints (id, company_id, name, site_name, start_date, site_url, status, client_signoff, change_policy, site_access) VALUES ('sp-1', 'co-1', 'S', 'Acme', current_date, 'https://acme.co.za', 'active', 'auto', 'pr_only', 'wordpress')`);
  });

  const run = (h: ReturnType<typeof host>, extra: Row = {}) => cancelPreviews(h.env, "co-1", agent, { sprintId: "sp-1", reason: "duplicate", ...extra });

  // Ids with `_` and `-` in them, and one that is a prefix trap for LIKE (`_` matches any character).
  const A = "Fg5bQ0Hd_C6dUqsKaAbr8lj7VpS-ego84";
  const B = "Fg5bQ0HdXC6dUqsKaAbr8lj7VpS-zzzzzz";
  const C = "Zk9-aaaa_bbbbbbbbbbbbbbbbbbbbbbbb";

  it("dry run is the default and writes nothing", async () => {
    await put(A);
    await put("newer-live-preview-id-0000000001", { created_at: ago(1 * HOURS) });
    const h = host();
    const out = await run(h, { previewIds: [A.slice(0, 8)] });
    expect(out).toMatchObject({ dryRun: true, cancelled: [A], skipped: [], followUp: "review issues closed and tasks re-checked within 5 minutes" });
    expect(out.newestByPage).toEqual([expect.objectContaining({ pageUrl: "https://acme.co.za/a/", id: "newer-live-preview-id-0000000001", status: "pending", reviewStatus: "passed", expired: false, wouldRevive: false })]);
    expect((await status(A)).status).toBe("pending");
    expect((await sql.unsafe(`SELECT 1 FROM ${S}.previews WHERE status = 'cancelled'`)).length).toBe(0);
  });

  it("resolves a prefix with _ and - literally, by the exact start of the id, inside the company and sprint", async () => {
    await put(A);
    await put(B, { page_url: "https://acme.co.za/b/" });
    await put(C, { page_url: "https://acme.co.za/c/" });
    await put("Fg5bQ0Hd_C6dUqsKaAbr8lj7VpS-other", { sprint_id: "sp-2", page_url: "https://acme.co.za/d/" });
    await put("newer-a", { created_at: ago(HOURS) });
    await put("newer-b", { created_at: ago(HOURS), page_url: "https://acme.co.za/b/" });
    await put("newer-c", { created_at: ago(HOURS), page_url: "https://acme.co.za/c/" });
    const out = await run(host(), { previewIds: ["Fg5bQ0Hd_C6d", "Fg5bQ0HdXC6d", "Zk9-aaaa_b", "Fg5bQ0Hd", "Fg5bQ0Hd_C6dUqsKaAbr8lj7VpS-ego84x", "nomatch99"] });
    expect(out.cancelled.sort()).toEqual([A, B, C].sort());
    // "Fg5bQ0Hd" matches A and B (ambiguous); the longer-than-id input and the unknown one match nothing.
    expect(out.skipped).toEqual([{ input: "Fg5bQ0Hd", reason: "ambiguous" }, { input: "Fg5bQ0Hd_C6dUqsKaAbr8lj7VpS-ego84x", reason: "notFound" }, { input: "nomatch99", reason: "notFound" }]);
    // The sp-2 preview with the same prefix was never in reach.
    expect((await status("Fg5bQ0Hd_C6dUqsKaAbr8lj7VpS-other")).status).toBe("pending");
  });

  it("refuses short or too many inputs and an archived sprint, before any query", async () => {
    const h = host();
    await expect(run(h, { previewIds: ["short"] })).rejects.toThrow(SeoError);
    await expect(run(h, { previewIds: [] })).rejects.toThrow(/previewIds is required/);
    await expect(run(h, { previewIds: Array.from({ length: 301 }, (_, i) => `id-${String(i).padStart(8, "0")}`) })).rejects.toThrow(/at most 300/);
    await expect(cancelPreviews(h.env, "co-1", agent, { sprintId: "sp-1", previewIds: [A] })).rejects.toThrow(/reason is required/);
    await expect(run(h, { previewIds: [A], reason: "x".repeat(301) })).rejects.toThrow(/300/);
    await sql.unsafe(`UPDATE ${S}.sprints SET status = 'archived'`);
    await expect(run(h, { previewIds: [A] })).rejects.toThrow(/archived/);
  });

  it("skips: approved unless allowApproved, alreadyCancelled, lastOnPage unless allowLast", async () => {
    await put("approved-0001", { status: "approved", created_at: ago(5 * HOURS) });
    await put("pending-00001", { created_at: ago(4 * HOURS) });
    await put("cancelled-001", { status: "cancelled", cancelled_prev_status: "pending", created_at: ago(2 * HOURS) });
    await put("only-one-0001", { page_url: "https://acme.co.za/solo/" });
    await put("two-a-0000001", { page_url: "https://acme.co.za/two/", created_at: ago(2 * HOURS) });
    await put("two-b-0000001", { page_url: "https://acme.co.za/two/", created_at: ago(HOURS) });
    const ids = ["approved-0001", "pending-00001", "cancelled-001", "only-one-0001", "two-a-0000001", "two-b-0000001"];
    const dry = await run(host(), { previewIds: ids });
    // pending-00001 stays: the approved one remains live on its page, so it is not the last.
    expect(dry.cancelled).toEqual(["pending-00001"]);
    expect(dry.skipped).toEqual(expect.arrayContaining([{ input: "approved-0001", reason: "approved" }, { input: "cancelled-001", reason: "alreadyCancelled" }, { input: "only-one-0001", reason: "lastOnPage" }, { input: "two-a-0000001", reason: "lastOnPage" }, { input: "two-b-0000001", reason: "lastOnPage" }]));
    expect(dry.skipped).toHaveLength(5);
  });

  it("lastOnPage: counted per page, lifted by allowLast", async () => {
    await put("approved-0001", { status: "approved", created_at: ago(5 * HOURS) });
    await put("pending-00001", { created_at: ago(4 * HOURS) });
    // allowApproved cancels both of the page's live previews: that is the last of the page.
    const blocked = await run(host(), { previewIds: ["approved-0001", "pending-00001"], allowApproved: true });
    expect(blocked.cancelled).toEqual([]);
    expect(blocked.skipped.map((x) => x.reason)).toEqual(["lastOnPage", "lastOnPage"]);
    const forced = await run(host(), { previewIds: ["approved-0001", "pending-00001"], allowApproved: true, allowLast: true, dryRun: false });
    expect(forced.cancelled.sort()).toEqual(["approved-0001", "pending-00001"]);
    expect(forced.newestByPage).toEqual([expect.objectContaining({ id: null, wouldRevive: false })]);
    expect((await status("approved-0001")).cancelled_prev_status).toBe("approved");
  });

  it("writes status, previous status, time, actor and reason, reports drafts and revivals, and is idempotent", async () => {
    await put("survivor-0001", { created_at: ago(5 * HOURS), review_status: "changes_needed" });
    await put("dup-draft-0001", { created_at: ago(2 * HOURS), draft_key: "draft-1" });
    await put("dup-plain-0001", { created_at: ago(HOURS) });
    const ids = ["dup-draft-0001", "dup-plain-0001"];
    const out = await run(host(), { previewIds: ids, dryRun: false, reason: "dedupe" });
    expect(out.cancelled.sort()).toEqual(ids);
    expect(out.inDraft).toEqual([{ previewId: "dup-draft-0001", draftKey: "draft-1" }]);
    expect(out.newestByPage).toEqual([expect.objectContaining({ id: "survivor-0001", reviewStatus: "changes_needed", wouldRevive: true })]);
    expect(await status("dup-draft-0001")).toMatchObject({ status: "cancelled", cancelled_prev_status: "pending", cancelled_by: "agent-1", cancel_reason: "dedupe" });
    expect((await status("dup-draft-0001")).cancelled_at).toBeTruthy();
    expect((await status("survivor-0001")).status).toBe("pending");
    const again = await run(host(), { previewIds: ids, dryRun: false });
    expect(again.cancelled).toEqual([]);
    expect(again.skipped).toEqual([{ input: "dup-draft-0001", reason: "alreadyCancelled" }, { input: "dup-plain-0001", reason: "alreadyCancelled" }]);
    expect((await status("dup-draft-0001")).cancel_reason).toBe("dedupe");
  });

  it("a client answer between the resolve and the UPDATE is not overwritten (the status guard decides)", async () => {
    await put("survivor-0001", { created_at: ago(5 * HOURS) });
    await put("racing-00001", { created_at: ago(HOURS) });
    const h = host();
    const query = h.ctx.db.query;
    h.ctx.db.query = (async (text: string, params: unknown[] = []) => {
      const rows = await query(text, params);
      if (/jsonb_array_elements_text\(\$3::jsonb\) AS i\(input\)/.test(text)) await sql.unsafe(`UPDATE ${S}.previews SET status = 'approved' WHERE id = 'racing-00001'`);
      return rows;
    }) as never;
    const out = await run(h, { previewIds: ["racing-00001"], dryRun: false });
    expect(out.cancelled).toEqual([]);
    expect(out.skipped).toEqual([{ input: "racing-00001", reason: "approved" }]);
    expect((await status("racing-00001")).status).toBe("approved");
  });

  it("dispatch runs the tool", async () => {
    await put("survivor-0001", { created_at: ago(5 * HOURS) });
    await put("dispatch-0001", { created_at: ago(HOURS) });
    const out = (await dispatch(host().env, "co-1", agent, "cancel-previews", { sprintId: "sp-1", previewIds: ["dispatch-0001"], reason: "x" })) as { cancelled: string[]; dryRun: boolean };
    expect(out).toMatchObject({ dryRun: true, cancelled: ["dispatch-0001"] });
  });

  describe("the 5-minute follow-up", () => {
    async function seedTask(extra = "") {
      await sql.unsafe(`INSERT INTO ${S}.sprint_tasks (id, company_id, sprint_id, title, task_type, status, issue_id, assignee_kind, blocker_reason) VALUES ('t-1', 'co-1', 'sp-1', 'Write', 'page-write', 'blocked', 'iss-1', 'client', 'Waiting for the client'${extra})`);
    }

    it("closes the open Reviewer issue once, wakes the task parked on the client whose only waiting preview was cancelled, and marks the row", async () => {
      await seedTask();
      await put("old-approved-01", { status: "approved", page_url: "https://acme.co.za/a/", created_at: ago(5 * HOURS), decided_at: ago(4 * HOURS) });
      await put("dup-waiting-01", { page_url: "https://acme.co.za/b/", review_issue_id: "rev-1", review_status: "pending", created_at: ago(2 * HOURS) });
      await put("dup-newer-0001", { page_url: "https://acme.co.za/b/", created_at: ago(HOURS), review_status: "passed" });
      await sql.unsafe(`UPDATE ${S}.previews SET status = 'pending' WHERE id = 'dup-newer-0001'`);
      const h = host();
      // Before the cancel the task waits: a live preview (dup-newer) is still with the client.
      await run(h, { previewIds: ["dup-waiting-01", "dup-newer-0001"], dryRun: false, allowLast: true });
      expect(await handleCancelledPreviews(h.env)).toBe(2);
      expect(h.updates.filter((u) => u.id === "rev-1")).toEqual([{ id: "rev-1", patch: { status: "cancelled" } }]);
      expect(h.comments.filter((c) => c.id === "rev-1").map((c) => c.body)).toEqual(["Preview replaced by a newer version; nothing to review."]);
      expect(h.wakeups).toEqual(["iss-1"]);
      expect(h.comments.find((c) => c.id === "iss-1")!.body).toMatch(/The previews of this task are decided/);
      expect((await sql.unsafe(`SELECT assignee_kind, status FROM ${S}.sprint_tasks WHERE id = 't-1'`))[0]).toEqual({ assignee_kind: "agent", status: "in_progress" });
      expect((await status("dup-waiting-01")).stats.cancelHandled).toBeTruthy();
      // A second run does nothing: no second close, comment or wake.
      expect(await handleCancelledPreviews(h.env)).toBe(0);
      expect(h.updates.filter((u) => u.id === "rev-1")).toHaveLength(1);
      expect(h.wakeups).toEqual(["iss-1"]);
    });

    it("a failed issue update leaves the row unmarked for the next run; at most 25 rows and 10 tasks a run", async () => {
      await seedTask();
      await put("dup-fail-00001", { review_issue_id: "rev-9", review_status: "pending", status: "cancelled", cancelled_prev_status: "pending", cancelled_at: ago(HOURS) });
      const h = host();
      (h.ctx.issues.update as any).mockRejectedValueOnce(new Error("host down"));
      expect(await handleCancelledPreviews(h.env)).toBe(0);
      expect((await status("dup-fail-00001")).stats.cancelHandled).toBeUndefined();
      expect(await handleCancelledPreviews(h.env)).toBe(1);
      expect((await status("dup-fail-00001")).stats.cancelHandled).toBeTruthy();

      for (let i = 0; i < 30; i += 1) await put(`bulk-${String(i).padStart(8, "0")}`, { task_id: `tb-${i % 12}`, status: "cancelled", cancelled_prev_status: "pending", cancelled_at: ago(HOURS), review_status: "passed" });
      expect(await handleCancelledPreviews(h.env)).toBeLessThanOrEqual(25);
      const left = await sql.unsafe(`SELECT count(*)::int AS n FROM ${S}.previews WHERE status = 'cancelled' AND stats->>'cancelHandled' IS NULL`);
      expect(left[0].n).toBeGreaterThan(0);
    });

    it("hands a task back to the agent when every preview of it was cancelled", async () => {
      await seedTask();
      await put("dup-only-00001");
      const h = host();
      await run(h, { previewIds: ["dup-only-00001"], dryRun: false, allowLast: true });
      expect(await handleCancelledPreviews(h.env)).toBe(1);
      expect((await sql.unsafe(`SELECT assignee_kind, status FROM ${S}.sprint_tasks WHERE id = 't-1'`))[0]).toEqual({ assignee_kind: "agent", status: "in_progress" });
      expect(h.comments.filter((c) => c.id === "iss-1").map((c) => c.body)).toEqual(["Every preview of this task was cancelled; make a new one or complete the task."]);
      expect(h.wakeups).toEqual(["iss-1"]);
    });

    it("gives up a permanently failing row after 5 runs so it cannot starve a later one", async () => {
      for (let i = 0; i < 25; i += 1) await put(`stuck-${String(i).padStart(8, "0")}`, { review_issue_id: `rev-${i}`, review_status: "pending", status: "cancelled", cancelled_prev_status: "pending", cancelled_at: ago(2 * HOURS) });
      await put("good-0000000001", { status: "cancelled", cancelled_prev_status: "pending", cancelled_at: ago(HOURS), task_id: null });
      const h = host();
      (h.ctx.issues.update as any).mockRejectedValue(new Error("host down"));
      for (let run = 1; run <= 4; run += 1) {
        expect(await handleCancelledPreviews(h.env)).toBe(0);
        expect((await status("stuck-00000000")).stats.cancelAttempts).toBe(run);
      }
      expect(await handleCancelledPreviews(h.env)).toBe(0);
      const gaveUp = (await status("stuck-00000000")).stats;
      expect(gaveUp.cancelHandled).toBeTruthy();
      expect(gaveUp.cancelHandledError).toMatch(/./);
      expect((await status("good-0000000001")).stats.cancelHandled).toBeUndefined();
      expect(await handleCancelledPreviews(h.env)).toBe(1);
      expect((await status("good-0000000001")).stats.cancelHandled).toBeTruthy();
    });
  });
});
