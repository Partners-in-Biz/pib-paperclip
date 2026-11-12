/**
 * PAR-10301: the stored lookup create-preview runs before building, on the real previews table (all migrations, 029 adds
 * request_key) in an embedded Postgres. Skipped where embedded Postgres is not available.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv, type Env } from "../src/service/common.js";
import { findReusablePreview } from "../src/service/preview.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const P = `${NAMESPACE}.previews`;

describe.skipIf(!available)("findReusablePreview on Postgres", () => {
  let pg: PgHarness;
  let env: Env;

  beforeAll(async () => {
    pg = await startPg();
    env = createEnv(pg.ctx);
    await pg.client.query(`INSERT INTO ${NAMESPACE}.sprints (id, company_id, name, site_url, site_name, start_date) VALUES ('sp-1', 'co-1', 'Acme', 'https://acme.co.za', 'Acme', '2026-11-01')`);
  }, 60_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => { await pg.client.query(`DELETE FROM ${P}`); });

  /** One preview row for request key k1, made `ageMin` minutes ago; `extra` overrides columns. */
  async function row(id: string, extra: Record<string, string> = {}, ageMin = 1) {
    const cols: Record<string, string> = { request_key: "'k1'", status: "'pending'", review_status: "'pending'", expires_at: "now() + interval '30 days'", created_at: `now() - interval '${ageMin} minutes'`, ...extra };
    await pg.client.query(
      `INSERT INTO ${P} (id, company_id, sprint_id, page_url, title, html, ${Object.keys(cols).join(", ")}) VALUES ($1, 'co-1', 'sp-1', 'https://acme.co.za/', 'Home', '<html></html>', ${Object.values(cols).join(", ")})`,
      [id],
    );
  }
  const found = async (key = "k1", company = "co-1") => (await findReusablePreview(env, company, key))?.id ?? null;

  it("finds the newest pending row of the same key and company", async () => {
    await row("old", {}, 10);
    await row("new", {}, 2);
    await row("passed", { review_status: "'passed'" }, 20);
    expect(await found()).toBe("new");
    expect(await found("k2")).toBeNull();
    expect(await found("k1", "co-2")).toBeNull();
  });

  it("returns the columns the reuse path reads", async () => {
    await row("p1", { stats: `'{"basis":"source"}'::jsonb`, review_key: "'rk'", task_id: "'t-1'" });
    expect(await findReusablePreview(env, "co-1", "k1")).toMatchObject({ id: "p1", review_status: "pending", review_issue_id: null, review_key: "rk", title: "Home", task_id: "t-1", stats: { basis: "source" } });
  });

  it("reuses a passed row", async () => {
    await row("p1", { review_status: "'passed'" });
    expect(await found()).toBe("p1");
  });

  it.each([
    ["cancelled", { status: "'cancelled'" }, 1],
    ["changes_needed", { review_status: "'changes_needed'" }, 1],
    ["expired", { expires_at: "now() - interval '1 minute'" }, 1],
    ["older than 30 minutes", {}, 31],
    ["without a request_key", { request_key: "NULL" }, 1],
  ] as const)("skips a %s row", async (_name, extra, ageMin) => {
    await row("p1", extra, ageMin);
    expect(await found()).toBeNull();
  });

  it("migration 029 adds the partial index", async () => {
    const { rows } = await pg.client.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'previews_request_key'`, [NAMESPACE]);
    expect(String((rows[0] as { indexdef: string }).indexdef)).toMatch(/\(company_id, request_key\) WHERE \(request_key IS NOT NULL\)/);
  });
});
