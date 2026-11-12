/** Migration 021 and the site.changed replay on a real Postgres (PAR-9131 Q16, T2b). */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { onApprovalEvent, onSignoffEvent, REPLAY_CAP, replaySiteChanges } from "../src/site-signoff.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const CO = "co-1";
const ABOUT = "https://example.com/about";
const available = await embeddedAvailable();
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

describe.skipIf(!available)("migration 021 on an existing database", () => {
  it("adds page_url and pages_closed_at to rows that exist, and twice is harmless", async () => {
    const old = await startPg({ upTo: 20 });
    try {
      await old.client.query(`INSERT INTO ${NAMESPACE}.site_signoff (site_id, company_id, required) VALUES ('s1', '${CO}', true)`);
      await old.client.query(`INSERT INTO ${NAMESPACE}.site_changes (id, company_id, site_id, endpoint, ok) VALUES ('c1', '${CO}', 's1', 'seo/set', true)`);
      const sql = readFileSync(new URL("../migrations/021_crm.sql", import.meta.url), "utf8");
      await old.client.query(sql);
      await old.client.query(sql);
      expect((await old.client.query(`SELECT pages_closed_at FROM ${NAMESPACE}.site_signoff`)).rows).toEqual([{ pages_closed_at: null }]);
      expect((await old.client.query(`SELECT page_url FROM ${NAMESPACE}.site_changes`)).rows).toEqual([{ page_url: null }]);
    } finally {
      await old.stop();
    }
  }, 120_000);
});

describe.skipIf(!available)("site.changed replay", () => {
  let pg: PgHarness;
  let ctx: PluginContext;
  let emit: ReturnType<typeof vi.fn>;
  let n = 0;
  beforeAll(async () => {
    pg = await startPg();
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });
  beforeEach(async () => {
    await pg.reset();
    emit = vi.fn(async () => undefined);
    ctx = { ...pg.ctx, events: { emit } } as unknown as PluginContext;
    for (const site of ["s1", "s2"]) await onSignoffEvent(ctx, { companyId: CO, payload: { siteId: site, required: true } });
  });

  const open = (site: string, seq: number, pages = [ABOUT], until = inHours(48)) =>
    onApprovalEvent(ctx, { companyId: CO, payload: { siteId: site, scope: "pages", pages, until, seq, by: "user-1" } });
  /** A site_changes row `minutes` from now (negative is the past). */
  const change = async (site: string, opts: { minutes?: number; actor?: string; page?: string | null; ok?: boolean } = {}) => {
    n += 1;
    await pg.client.query(
      `INSERT INTO ${NAMESPACE}.site_changes (id, company_id, site_id, endpoint, target, change_ref, ok, actor, page_url, created_at)
       VALUES ($1, $2, $3, 'seo/set', '/about', $4, $5, $6, $7, now() + make_interval(mins => $8))`,
      [`row-${n}`, CO, site, `chg-${n}`, opts.ok ?? true, opts.actor ?? "agent:a1", opts.page === undefined ? ABOUT : opts.page, opts.minutes ?? 0],
    );
    return `chg-${n}`;
  };
  const sent = () => emit.mock.calls.map((call) => (call as unknown[])[2] as Record<string, unknown>);
  const signoff = (site: string, set: string) => pg.client.query(`UPDATE ${NAMESPACE}.site_signoff SET ${set} WHERE site_id = $1`, [site]);

  it("re-emits each ok agent page-grant write since the grant opened, once per row per run", async () => {
    await open("s1", 1);
    await signoff("s1", "pages_opened_at = now() - interval '10 minutes'");
    await change("s1", { minutes: -20 }); // before the grant opened
    const first = await change("s1", { minutes: -5 });
    const second = await change("s1", { minutes: -1 });
    await change("s1", { actor: "user:u1" }); // a person's write
    await change("s1", { page: null }); // whole-site grant only
    await change("s1", { ok: false });
    expect(await replaySiteChanges(ctx, CO)).toBe(2);
    expect(sent().map((p) => p.changeId)).toEqual([first, second]);
    expect(sent()[0]).toEqual({ siteId: "s1", url: ABOUT, endpoint: "seo/set", changeId: first, at: expect.any(String) });
    expect(emit.mock.calls.every((call) => (call as unknown[])[0] === "site.changed" && (call as unknown[])[1] === CO)).toBe(true);
    // The next run sends the same rows again, once each: the consumer is idempotent.
    expect(await replaySiteChanges(ctx, CO)).toBe(2);
    expect(sent().map((p) => p.changeId)).toEqual([first, second, first, second]);
    // Another company's replay sends nothing.
    expect(await replaySiteChanges(ctx, "co-2")).toBe(0);
  });

  it("sends at most 50 per site, oldest first, and caps each site on its own", async () => {
    await open("s1", 1);
    await open("s2", 1);
    await signoff("s1", "pages_opened_at = now() - interval '2 hours'");
    for (let i = 0; i < REPLAY_CAP + 5; i += 1) await change("s1", { minutes: -100 + i });
    const other = await change("s2");
    expect(await replaySiteChanges(ctx, CO)).toBe(REPLAY_CAP + 1);
    const bySite = sent().filter((p) => p.siteId === "s1");
    expect(bySite).toHaveLength(REPLAY_CAP);
    expect(bySite[0]!.changeId).toBe("chg-" + String(n - REPLAY_CAP - 5));
    expect(sent().filter((p) => p.siteId === "s2").map((p) => p.changeId)).toEqual([other]);
  });

  it("keeps replaying for an hour after the grant closes, then stops; an expired grant counts from its until", async () => {
    await open("s1", 1);
    const id = await change("s1");
    await open("s1", 2, []);
    expect(((await pg.client.query(`SELECT pages_closed_at FROM ${NAMESPACE}.site_signoff WHERE site_id = 's1'`)).rows[0] as { pages_closed_at: unknown }).pages_closed_at).not.toBeNull();
    expect(await replaySiteChanges(ctx, CO)).toBe(1);
    expect(sent()[0]!.changeId).toBe(id);
    // A later close keeps the first close time.
    await signoff("s1", "pages_closed_at = now() - interval '61 minutes'");
    await open("s1", 3, []);
    expect(await replaySiteChanges(ctx, CO)).toBe(0);
    // Reopening clears it; an expired grant (no close event) is closed at its pages_until.
    await open("s1", 4);
    expect(((await pg.client.query(`SELECT pages_closed_at FROM ${NAMESPACE}.site_signoff WHERE site_id = 's1'`)).rows[0] as { pages_closed_at: unknown }).pages_closed_at).toBeNull();
    await change("s1");
    await signoff("s1", "pages_until = now() - interval '30 minutes'");
    expect(await replaySiteChanges(ctx, CO)).toBe(1);
    await signoff("s1", "pages_until = now() - interval '2 hours'");
    expect(await replaySiteChanges(ctx, CO)).toBe(0);
  });
});
