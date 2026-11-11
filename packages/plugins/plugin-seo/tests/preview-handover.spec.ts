/**
 * 0.38.0 (PAR-9131 T1b, PAR-9141): the hand-over of decided previews to the SEO agent. One statement claims the task's decided rows
 * (FOR UPDATE, in id order), the effects run after it from stored values, and `retryHandovers` finishes what a crash left, bounded.
 * The previews table is the plugin's real one on an embedded Postgres; every other table answers from routes. Skipped where
 * embedded Postgres is not available.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { HANDOVER_MAX_ATTEMPTS, PERSON_APPLY_HOURS, recheckTaskAnswers, retryHandovers } from "../src/service/client-signoff.js";
import { deliverPreviewAnswers } from "../src/service/preview.js";
import { needsYouRoutes, seoHost, SPRINT, taskRow, type Row, type Route } from "./helpers/seo-host.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

const requireFromDb = createRequire(new URL("../../../db/package.json", import.meta.url));
const postgres = requireFromDb("postgres") as (url: string, o?: Record<string, unknown>) => any;
const dbHelperPath = new URL("../../../db/src/test-embedded-postgres.ts", import.meta.url).pathname;
const { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } = (await import(/* @vite-ignore */ dbHelperPath)) as {
  getEmbeddedPostgresTestSupport(): Promise<{ supported: boolean }>;
  startEmbeddedPostgresTestDatabase(prefix: string): Promise<{ connectionString: string; cleanup(): Promise<void> }>;
};
const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const SCHEMA = NAMESPACE;
const HOURS = 3_600_000;

const AUTO: Row = { ...SPRINT, client_signoff: "auto", change_policy: "pr_only", site_access: "wordpress", site_id: "site-1" };
const MANUAL: Row = { ...AUTO, client_signoff: "manual" };

describePg("the hand-over of decided previews", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: any;

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("seo-handover-");
    sql = postgres(pg.connectionString, { max: 4, onnotice: () => undefined });
    await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) await sql.unsafe(readFileSync(join(MIGRATIONS, f), "utf8"));
    await sql.unsafe(`ALTER TABLE ${SCHEMA}.previews DROP CONSTRAINT previews_sprint_id_fkey`);
  }, 120_000);
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
    await pg?.cleanup();
  });

  const reset = () => sql.unsafe(`DELETE FROM ${SCHEMA}.previews`);
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  async function put(id: string, extra: Record<string, unknown> = {}) {
    const row = { company_id: "co-1", sprint_id: "sp-1", task_id: "t-1", issue_id: "iss-1", page_url: `https://acme.co.za/${id}/`, title: `Page ${id}`, html: "<html></html>", review_status: "passed", status: "pending", created_at: ago(3 * HOURS), expires_at: new Date(Date.now() + 24 * HOURS).toISOString(), ...extra };
    const cols = Object.keys(row);
    await sql.unsafe(`INSERT INTO ${SCHEMA}.previews (id, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")})`, [id, ...Object.values(row)] as never);
  }
  const decided = (status: string, source: string, extra: Record<string, unknown> = {}) => ({ status, decision_source: source, decided_by: source === "email" ? "client:email-link" : "user:u1", decided_at: ago(HOURS), ...extra });
  const one = async (id: string) => (await sql.unsafe(`SELECT * FROM ${SCHEMA}.previews WHERE id = $1`, [id]))[0];

  /** The previews table is real; tasks answer from `tasks` (id -> row, missing: no task); sprints from `sprint`; other executes are recorded only. */
  function host(sprint: Row, opts: { tasks?: Record<string, Row>; routes?: Route[] } = {}) {
    const tasks = opts.tasks ?? { "t-1": taskRow({ id: "t-1", issue_id: "iss-1", status: "blocked", assignee_kind: "client", task_type: "page-write" }) };
    const h = seoHost({
      now: new Date().toISOString(),
      routes: [
        [/FROM plugin_seo_8099f8879a\.sprints WHERE/, () => [sprint]],
        [/FROM plugin_seo_8099f8879a\.sprint_tasks WHERE id = \$1/, (p) => (tasks[String(p[0])] ? [tasks[String(p[0])]!] : [])],
        ...(opts.routes ?? []),
      ],
    });
    const fakeQuery = h.ctx.db.query.bind(h.ctx.db);
    const fakeExecute = h.ctx.db.execute.bind(h.ctx.db);
    const real = (text: string) => new RegExp(`(FROM|UPDATE) ${SCHEMA}\\.previews`).test(text);
    // As the host does: a JSON text bound to ::jsonb is the JSON itself, and rows come back as JSON (dates as ISO strings).
    const bind = (params: unknown[]) => params.map((x) => (typeof x === "string" && x.startsWith("[") ? JSON.parse(x) : x)) as never;
    const plain = (rows: unknown) => JSON.parse(JSON.stringify(rows)) as Row[];
    // The host's SQL rules hold for the real statements too (one statement, FOR UPDATE inside the claim, no RETURNING needed).
    h.ctx.db.query = (async (text: string, params: unknown[] = []) => {
      if (!real(text)) return fakeQuery(text, params);
      validateRuntimeQuery(text, NAMESPACE, ["heartbeat_runs", "issue_comments"]);
      validateParams(text, params);
      return plain(await sql.unsafe(text, bind(params)));
    }) as never;
    h.ctx.db.execute = (async (text: string, params: unknown[] = []) => {
      if (!real(text)) return fakeExecute(text, params);
      validateRuntimeExecute(text, NAMESPACE);
      validateParams(text, params);
      h.executes.push({ sql: text, params });
      return { rowCount: (await sql.unsafe(text, bind(params))).count };
    }) as never;
    const locks = () => (h.ctx.events.emit as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => c[0] === "site.write-approved").map((c) => c[2] as Record<string, unknown>);
    return { ...h, locks };
  }
  const sprintOf = async (h: ReturnType<typeof host>) => (await db.getSprint(h.env.ctx.db, "co-1", "sp-1"))!;

  it("two rechecks of one task, at the same time, produce one comment, one wake and one lock", async () => {
    await reset();
    await put("a", decided("approved", "cockpit"));
    await put("b", decided("changes_requested", "cockpit", { decision_note: "Shorter intro" }));
    const h = host(AUTO);
    const sprint = await sprintOf(h);
    await Promise.all([recheckTaskAnswers(h.env, sprint, "t-1"), recheckTaskAnswers(h.env, sprint, "t-1")]);
    await recheckTaskAnswers(h.env, sprint, "t-1");
    expect(h.comments).toHaveLength(1);
    expect(h.wakeups).toEqual(["iss-1"]);
    expect(h.locks()).toHaveLength(1);
    expect(h.locks()[0]).toMatchObject({ siteId: "site-1", by: "client-approval:t-1" });
    const body = h.comments[0]!.body;
    expect(body).toContain("The lock is open for the whole site until");
    expect(body).toContain("change only these pages:\n- https://acme.co.za/a/ (preview a, \"Page a\")");
    expect(body).toContain("- https://acme.co.za/b/: Shorter intro");
    const [a, b] = [await one("a"), await one("b")];
    expect(a.handover_done_at).not.toBeNull();
    expect(b.handover_done_at).not.toBeNull();
    expect(a.handed_at.getTime()).toBe(b.handed_at.getTime());
    expect(a.apply_until.getTime() - a.handed_at.getTime()).toBe(PERSON_APPLY_HOURS * HOURS);
    expect(b.apply_until).toBeNull();
    expect(h.updates).toContainEqual({ id: "iss-1", patch: { status: "todo" } });
  });

  it("a crash after the claim is finished by the sweep with the same comment text and one wake", async () => {
    await reset();
    await put("a", decided("approved", "cockpit"));
    const h = host(AUTO);
    const sprint = await sprintOf(h);
    let fail = true;
    const wake = h.ctx.issues.requestWakeup;
    h.ctx.issues.requestWakeup = (async (...args: Parameters<typeof wake>) => {
      if (fail) throw new Error("host down");
      return wake(...args);
    }) as typeof wake;
    await recheckTaskAnswers(h.env, sprint, "t-1");
    expect(h.wakeups).toEqual([]);
    const claimed = await one("a");
    expect(claimed.handed_at).not.toBeNull();
    expect(claimed.handover_done_at).toBeNull();
    // Too fresh for the sweep: the claiming run may still be at work.
    expect(await retryHandovers(h.env)).toBe(0);
    await sql.unsafe(`UPDATE ${SCHEMA}.previews SET handed_at = handed_at - interval '10 minutes' WHERE id = 'a'`);
    fail = false;
    // Forget the posted comment, so the retry posts again and the two texts can be compared.
    h.state.delete("iss-1");
    expect(await retryHandovers(h.env)).toBe(1);
    expect(h.comments).toHaveLength(2);
    expect(h.comments[1]!.body).toBe(h.comments[0]!.body);
    expect(h.wakeups).toEqual(["iss-1"]);
    expect(await one("a")).toMatchObject({ handover_attempts: 1 });
    expect((await one("a")).handover_done_at).not.toBeNull();
    expect(await retryHandovers(h.env)).toBe(0);
    expect(h.wakeups).toEqual(["iss-1"]);
  });

  it("25 rows that fail permanently do not block row 26, and each gets one Needs you line after 5 tries", async () => {
    await reset();
    for (let i = 1; i <= 25; i += 1) {
      await put(`bad-${i}`, decided("approved", "cockpit", { task_id: `gone-${i}`, handed_at: ago(2 * HOURS - i * 1000), apply_until: ago(-HOURS) }));
    }
    await put("good", decided("approved", "cockpit", { handed_at: ago(HOURS), apply_until: new Date(Date.now() + HOURS).toISOString() }));
    const h = host(AUTO, { routes: needsYouRoutes([]) });
    expect(await retryHandovers(h.env)).toBe(0);
    expect((await one("good")).handover_done_at).toBeNull();
    expect(await retryHandovers(h.env)).toBe(1);
    expect((await one("good")).handover_done_at).not.toBeNull();
    for (let run = 0; run < HANDOVER_MAX_ATTEMPTS; run += 1) await retryHandovers(h.env);
    const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${SCHEMA}.previews WHERE id LIKE 'bad-%' AND handover_attempts = $1`, [HANDOVER_MAX_ATTEMPTS]);
    expect(n).toBe(25);
    const titles = new Set(h.executes.filter((e) => /INSERT INTO plugin_seo_8099f8879a\.needs_you /.test(e.sql)).flatMap((e) => (JSON.parse(String(e.params[4])) as Array<{ title: string }>).map((i) => i.title)));
    expect(titles.size).toBe(25);
    expect(titles.has("Hand-over of preview bad-1 failed 5 times")).toBe(true);
    // Stopped: a further run takes none of them.
    await retryHandovers(h.env);
    const [{ m }] = await sql.unsafe(`SELECT max(handover_attempts)::int AS m FROM ${SCHEMA}.previews`);
    expect(m).toBe(HANDOVER_MAX_ATTEMPTS);
  });

  it("a decline-only task gets no window event, and the agent is told not to apply, with the reason", async () => {
    await reset();
    await put("d", decided("declined", "cockpit", { decision_note: "We no longer offer this service" }));
    const h = host(AUTO);
    await recheckTaskAnswers(h.env, await sprintOf(h), "t-1");
    expect(h.locks()).toEqual([]);
    expect(h.wakeups).toEqual(["iss-1"]);
    const body = h.comments[0]!.body;
    expect(body).toContain("**Declined: do not apply; revise or close**");
    expect(body).toContain("- https://acme.co.za/d/ (preview d, \"Page d\"): We no longer offer this service");
    expect(body).not.toContain("lock is open");
    expect((await one("d")).apply_until).toBeNull();
  });

  it("a manual-sprint email approval waits, and its confirmation hands over", async () => {
    await reset();
    await put("m", decided("approved", "email", { notified_at: ago(HOURS) }));
    await put("c", decided("approved", "cockpit"));
    const h = host(MANUAL);
    const sprint = await sprintOf(h);
    await recheckTaskAnswers(h.env, sprint, "t-1");
    expect(h.comments).toEqual([]);
    expect((await one("c")).handed_at).toBeNull();
    // The sweep does not count waiting as a failed try.
    await sql.unsafe(`UPDATE ${SCHEMA}.previews SET decided_at = now() - interval '1 hour'`);
    await retryHandovers(h.env);
    expect((await one("c")).handover_attempts).toBe(0);
    await sql.unsafe(`UPDATE ${SCHEMA}.previews SET confirmed_by = 'user:u1', confirmed_at = now() WHERE id = 'm'`);
    await recheckTaskAnswers(h.env, sprint, "t-1");
    expect(h.wakeups).toEqual(["iss-1"]);
    const m = await one("m");
    expect(m.apply_until.getTime() - m.handed_at.getTime()).toBe(PERSON_APPLY_HOURS * HOURS);
    expect(h.locks()).toHaveLength(1);
    expect(new Date(String(h.locks()[0]!.until)).getTime() - Date.now()).toBeGreaterThan((PERSON_APPLY_HOURS - 1) * HOURS);
    expect(h.comments[0]!.body).toContain("preview m,");
    expect(h.comments[0]!.body).toContain("preview c,");
  });

  it("an email approval on an auto sprint is handed over with the 6-hour window", async () => {
    await reset();
    await put("e", decided("approved", "email"));
    const h = host(AUTO);
    await recheckTaskAnswers(h.env, await sprintOf(h), "t-1");
    const e = await one("e");
    expect(e.apply_until.getTime() - e.handed_at.getTime()).toBe(6 * HOURS);
    expect(h.wakeups).toEqual(["iss-1"]);
  });

  it("the sweep hands over a person's decision that nobody claimed, and leaves a superseded one alone", async () => {
    await reset();
    await put("p", decided("approved", "cockpit", { decided_at: ago(HOURS), created_at: ago(5 * HOURS) }));
    await put("old", decided("approved", "cockpit", { page_url: "https://acme.co.za/x/", created_at: ago(6 * HOURS) }));
    await put("new", { page_url: "https://acme.co.za/x/", created_at: ago(4 * HOURS), status: "changes_requested", decision_source: "email", decided_at: ago(HOURS), handed_at: ago(HOURS), handover_done_at: ago(HOURS) });
    const h = host(AUTO);
    expect(await retryHandovers(h.env)).toBe(1);
    expect((await one("p")).handover_done_at).not.toBeNull();
    expect((await one("old")).handed_at).toBeNull();
    expect((await one("old")).handover_attempts).toBe(0);
  });

  it("a cockpit decision is never picked up by deliverPreviewAnswers", async () => {
    await reset();
    await put("ck", decided("approved", "cockpit"));
    await put("ck2", decided("changes_requested", "cockpit", { notified_at: ago(HOURS) }));
    const h = host(AUTO);
    expect(await deliverPreviewAnswers(h.env)).toBe(0);
    expect(h.comments).toEqual([]);
    expect((await one("ck")).notified_at).toBeNull();
  });
});
