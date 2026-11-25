/** site.changed after an agent write a page grant allows (PAR-9131 T2b), through the real wp-* tool path. */
import { describe, expect, it, vi } from "vitest";
import { BOARD, boot, CO, tool, type Harness } from "./helpers/crm.js";

const ABOUT = "https://www.acme.co.za/about";

/** Every Connector call answers ok with the next change id. */
function fakeSite(harness: Harness) {
  let n = 0;
  vi.spyOn(harness.ctx.http, "fetch").mockImplementation(async () => {
    n += 1;
    return new Response(JSON.stringify({ ok: true, data: { changeId: `chg-${n}` } }), { status: 200, headers: { "content-type": "application/json" } });
  });
}

/**
 * The in-memory database cannot evaluate `pages_until > now()`, so the one sign-off read answers from `grant` instead
 * (the SQL itself runs on Postgres in site-signoff-pages.pg.spec.ts).
 */
function grantIs(harness: Harness, grant: { approved: boolean; pages: string[] }) {
  const db = harness.ctx.db;
  const real = db.query.bind(db);
  vi.spyOn(db, "query").mockImplementation((async (sql: string, params?: unknown[]) => {
    if (sql.includes("site_signoff") && sql.includes("pages_open")) return [{ required: true, approved: grant.approved, pages_open: grant.pages.length > 0, pages: grant.pages }];
    return real(sql, params);
  }) as typeof db.query);
}

async function setup(grant: { approved: boolean; pages: string[] }) {
  const booted = await boot();
  const { harness } = booted;
  const saved = await tool(harness, "save-client-site", { client: "company:acme", url: "https://www.acme.co.za", platform: "wordpress" });
  const site = saved.site as Record<string, any>;
  await harness.performAction("crm.connect-client-site", { siteId: site.id }, { companyId: CO, actor: BOARD });
  fakeSite(harness);
  grantIs(harness, grant);
  const changed = () => (booted.emit.mock.calls as unknown[][]).filter((call) => call[0] === "site.changed").map((call) => call[2] as Record<string, unknown>);
  return { ...booted, site, changed };
}

describe("site.changed", () => {
  it("is emitted with the changeId and the normalised page after an agent write a page grant allows, and after its undo", async () => {
    const { harness, site, store, changed } = await setup({ approved: false, pages: [ABOUT] });
    const out = await tool(harness, "wp-seo", { siteId: site.id, op: "set", url: "/about/", title: "New", reason: "approved preview" });
    expect(out.changeId).toBe("chg-1");
    expect(changed()).toEqual([{ siteId: site.id, url: ABOUT, endpoint: "seo/set", changeId: "chg-1", at: expect.any(String) }]);
    expect(store.site_changes).toEqual([expect.objectContaining({ endpoint: "seo/set", page_url: ABOUT, change_ref: "chg-1", ok: true })]);
    expect(changed()[0]!.at).toBe(new Date(String(store.site_changes![0]!.created_at)).toISOString());

    await tool(harness, "wp-undo", { siteId: site.id, changeId: "chg-1", reason: "revert" });
    expect(changed().at(-1)).toEqual({ siteId: site.id, url: ABOUT, endpoint: "undo", changeId: "chg-2", at: expect.any(String) });
  });

  it("is not emitted for a person's write, under the whole-site grant only, or for a write the page grant does not cover", async () => {
    const person = await setup({ approved: false, pages: [ABOUT] });
    await person.harness.performAction("crm.wp-seo", { siteId: person.site.id, op: "set", url: "/about", title: "New", reason: "by hand" }, { companyId: CO, actor: BOARD });
    expect(person.changed()).toEqual([]);
    expect(person.store.site_changes).toEqual([expect.objectContaining({ page_url: null, ok: true })]);

    const wholeSite = await setup({ approved: true, pages: [] });
    await tool(wholeSite.harness, "wp-seo", { siteId: wholeSite.site.id, op: "set", url: "/about", title: "New", reason: "whole site" });
    expect(wholeSite.changed()).toEqual([]);

    // Both grants open: the whole-site one lets a write on another page through, but the page grant does not apply to it.
    const both = await setup({ approved: true, pages: [ABOUT] });
    await tool(both.harness, "wp-seo", { siteId: both.site.id, op: "set", url: "/contact", title: "New", reason: "other page" });
    await tool(both.harness, "wp-redirects", { siteId: both.site.id, op: "set", from: "/about", to: "/x", reason: "redirect" });
    expect(both.changed()).toEqual([]);
    await tool(both.harness, "wp-seo", { siteId: both.site.id, op: "set", url: "/about", title: "New", reason: "approved page" });
    expect(both.changed()).toEqual([expect.objectContaining({ url: ABOUT, endpoint: "seo/set" })]);
  });
});
