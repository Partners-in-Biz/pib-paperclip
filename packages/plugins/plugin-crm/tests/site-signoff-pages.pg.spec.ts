/** Migration 020 and the page-scoped grant on a real Postgres (PAR-9131 Q13/Q14): seq-guarded replace, close, undo, legacy. */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../src/namespace.js";
import { onApprovalEvent, onSignoffEvent, signoffBlock } from "../src/site-signoff.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const CO = "co-1";
const SITE = { id: "s1", url: "https://example.com" };
const ABOUT = "https://example.com/about";
const CONTACT = "https://example.com/contact";
const available = await embeddedAvailable();
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

describe.skipIf(!available)("migration 020 on an existing database", () => {
  it("adds the page grant columns to rows that exist, and twice is harmless", async () => {
    const old = await startPg({ upTo: 19 });
    try {
      await old.client.query(`INSERT INTO ${NAMESPACE}.site_signoff (site_id, company_id, required) VALUES ('s1', '${CO}', true)`);
      const sql = readFileSync(new URL("../migrations/020_crm.sql", import.meta.url), "utf8");
      await old.client.query(sql);
      await old.client.query(sql);
      expect((await old.client.query(`SELECT pages, pages_until, pages_seq, pages_by, pages_opened_at FROM ${NAMESPACE}.site_signoff`)).rows).toEqual([
        { pages: null, pages_until: null, pages_seq: "0", pages_by: null, pages_opened_at: null },
      ]);
    } finally {
      await old.stop();
    }
  }, 120_000);
});

describe.skipIf(!available)("page-scoped grant", () => {
  let pg: PgHarness;
  let ctx: PluginContext;
  beforeAll(async () => {
    pg = await startPg();
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });
  beforeEach(async () => {
    await pg.reset();
    ctx = pg.ctx;
    await onSignoffEvent(ctx, { companyId: CO, payload: { siteId: SITE.id, required: true } });
  });

  const pages = (list: string[], seq: number, until = inHours(48)) =>
    onApprovalEvent(ctx, { companyId: CO, payload: { siteId: SITE.id, scope: "pages", pages: list, until, seq, by: "user-1" } });
  const block = (endpoint: string, params: Record<string, unknown>) => signoffBlock(ctx, SITE, endpoint, params);
  const row = async () => ((await pg.client.query(`SELECT * FROM ${NAMESPACE}.site_signoff WHERE site_id = 's1'`)).rows as Array<Record<string, unknown>>)[0]!;

  it("opens only the approved pages and stores them normalised", async () => {
    await pages(["HTTPS://Example.com/about/", "https://example.com/?p=3", 7 as unknown as string], 100);
    expect((await row()).pages).toEqual([ABOUT]);
    expect((await row()).pages_by).toBe("user-1");
    expect((await row()).pages_opened_at).not.toBeNull();
    for (const endpoint of ["posts/update", "posts/img-alt", "seo/set", "schema/set"]) expect(await block(endpoint, { url: "/about" })).toBeNull();
    expect(await block("seo/set", { url: CONTACT })).toMatch(/not one of the approved pages/);
    expect(await block("seo/set", { url: "/about", postId: 3 })).toMatch(/leave out postId/);
    expect(await block("posts/create", { title: "x" })).toMatch(/not one of the page changes/);
    expect(await block("redirects/set", { from: "/about", to: "/x" })).toMatch(/not one of the page changes/);
  });

  it("ignores an older or equal seq", async () => {
    await pages([ABOUT], 200);
    await pages([CONTACT], 150);
    await pages([CONTACT], 200);
    expect((await row()).pages).toEqual([ABOUT]);
    expect(Number((await row()).pages_seq)).toBe(200);
    expect(await block("seo/set", { url: CONTACT })).toMatch(/not one of the approved pages/);
  });

  it("a replace with fewer pages drops the page, pages: [] and a past until close the grant", async () => {
    await pages([ABOUT, CONTACT], 1);
    const opened = (await row()).pages_opened_at;
    await pages([CONTACT], 2);
    expect(await block("seo/set", { url: ABOUT })).toMatch(/not one of the approved pages/);
    expect(await block("seo/set", { url: CONTACT })).toBeNull();
    expect((await row()).pages_opened_at).toEqual(opened);
    await pages([], 3);
    expect(await block("seo/set", { url: CONTACT })).toMatch(/no approval to apply is running/);
    await pages([CONTACT], 4);
    expect(await block("seo/set", { url: CONTACT })).toBeNull();
    await pages([CONTACT], 5, new Date(Date.now() - 1000).toISOString());
    expect(await block("seo/set", { url: CONTACT })).toMatch(/no approval to apply is running/);
  });

  it("closes on the exact close event the sender emits for an empty set: until null or left out", async () => {
    const send = (payload: Record<string, unknown>) => onApprovalEvent(ctx, { companyId: CO, payload: { siteId: SITE.id, scope: "pages", by: "user-1", ...payload } });
    await send({ pages: [ABOUT], until: inHours(48), seq: 1 });
    expect(await block("seo/set", { url: ABOUT })).toBeNull();
    await send({ pages: [], until: null, seq: 2 });
    expect(await block("seo/set", { url: ABOUT })).toMatch(/no approval to apply is running/);
    expect([(await row()).pages, (await row()).pages_until, Number((await row()).pages_seq)]).toEqual([[], null, 2]);
    await send({ pages: [ABOUT], until: inHours(48), seq: 3 });
    expect(await block("seo/set", { url: ABOUT })).toBeNull();
    await send({ pages: [], seq: 4 });
    expect(await block("seo/set", { url: ABOUT })).toMatch(/no approval to apply is running/);
    expect([(await row()).pages_until, Number((await row()).pages_seq)]).toEqual([null, 4]);
    // A non-empty set still needs a valid until: these change nothing.
    for (const [until, seq] of [[null, 5], [undefined, 6], ["not a date", 7]] as const) await send({ pages: [ABOUT], until, seq });
    expect(Number((await row()).pages_seq)).toBe(4);
    expect(await block("seo/set", { url: ABOUT })).toMatch(/no approval to apply is running/);
  });

  it("undo passes for a change on an approved page and is refused for another page", async () => {
    await pages([ABOUT], 1);
    await pg.client.query(
      `INSERT INTO ${NAMESPACE}.site_changes (id, company_id, site_id, endpoint, target, change_ref, ok) VALUES
        ('r1', '${CO}', 's1', 'seo/set', '/about/', 'chg-about', true),
        ('r2', '${CO}', 's1', 'seo/set', '${CONTACT}', 'chg-contact', true),
        ('r3', '${CO}', 's1', 'redirects/set', '${ABOUT}', 'chg-redirect', true),
        ('r4', '${CO}', 's1', 'seo/set', '${ABOUT}', 'chg-failed', false),
        ('r5', '${CO}', 's2', 'seo/set', '${ABOUT}', 'chg-other-site', true)`,
    );
    expect(await block("undo", { changeId: "chg-about" })).toBeNull();
    expect(await block("undo", { changeId: "chg-contact" })).toMatch(/not on an approved page/);
    expect(await block("undo", { changeId: "chg-redirect" })).toMatch(/redirects\/set change/);
    expect(await block("undo", { changeId: "chg-failed" })).toMatch(/not an applied change/);
    expect(await block("undo", { changeId: "chg-other-site" })).toMatch(/not an applied change/);
    expect(await block("undo", {})).toMatch(/not an applied change/);
  });

  it("a legacy event and the whole-site grant behave as before, and a page event never touches them", async () => {
    await onApprovalEvent(ctx, { companyId: CO, payload: { siteId: SITE.id, until: inHours(1), by: "user-2" } });
    expect(await block("redirects/set", { from: "/a", to: "/b" })).toBeNull();
    expect(await block("posts/create", { title: "x" })).toBeNull();
    await pages([], 9);
    const r = await row();
    expect(r.approved_by).toBe("user-2");
    expect(r.approved_until).not.toBeNull();
    expect(await block("redirects/set", { from: "/a", to: "/b" })).toBeNull();
    // A legacy close ends the whole-site grant, and the page grant alone applies again.
    await onApprovalEvent(ctx, { companyId: CO, payload: { siteId: SITE.id, until: new Date(Date.now() - 1000).toISOString() } });
    await pages([ABOUT], 10);
    expect(await block("redirects/set", { from: "/a", to: "/b" })).toMatch(/not one of the page changes/);
    expect(await block("seo/set", { url: ABOUT })).toBeNull();
  });

  it("ignores an unknown scope, a bad seq and a missing page list instead of reading them as whole-site", async () => {
    for (const payload of [
      { siteId: SITE.id, scope: "site", until: inHours(1), seq: 1 },
      { siteId: SITE.id, scope: "pages", pages: [ABOUT], until: inHours(1), seq: "abc" },
      { siteId: SITE.id, scope: "pages", pages: [ABOUT], until: inHours(1) },
      { siteId: SITE.id, scope: "pages", until: inHours(1), seq: 3 },
    ]) await onApprovalEvent(ctx, { companyId: CO, payload });
    const r = await row();
    expect([r.approved_until, r.pages]).toEqual([null, null]);
    expect(await block("seo/set", { url: ABOUT })).toMatch(/no approval to apply is running/);
  });

  it("a site nobody marked is never blocked, and a site off pr_only is not either", async () => {
    expect(await signoffBlock(ctx, { id: "s9", url: "https://other.test" }, "redirects/set", {})).toBeNull();
    await onSignoffEvent(ctx, { companyId: CO, payload: { siteId: SITE.id, required: false } });
    expect(await block("redirects/set", {})).toBeNull();
  });
});
