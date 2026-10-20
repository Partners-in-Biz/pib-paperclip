import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { experimentsMigration } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const FILE = readFileSync(join(import.meta.dirname, "../migrations/015_campaigns.sql"), "utf8");
const GROWTH = ["growth_experiment_items", "growth_experiments", "growth_playbook_changes", "growth_playbook_versions", "growth_programs"];

describe("015_campaigns.sql", () => {
  it("contains the kit v2 helper output for this namespace", () => {
    expect(FILE).toContain(experimentsMigration(NAMESPACE));
  });
});

describe.skipIf(!available)("growth migration (postgres)", () => {
  let h: PgHarness;
  beforeAll(async () => {
    h = await startPg();
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });
  const q = (sql: string, params: unknown[] = []) => h.client.query(sql, params);

  it("applies on a fresh schema: the growth tables exist and scope is unique per company and channel", async () => {
    const rows = (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${NAMESPACE}' AND table_name LIKE 'growth_%' ORDER BY 1`)).rows as Array<{ table_name: string }>;
    expect(rows.map((r) => r.table_name)).toEqual(GROWTH);
    const add = (id: string, scope: string) =>
      q(`INSERT INTO ${NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, scope_key) VALUES ($1, 'c', 'email', 'o', 'm', $2)`, [id, scope]);
    await add("p1", "own");
    await add("p2", "client:company:x");
    await expect(add("p3", "own")).rejects.toThrow(/growth_programs_scope/);
  });

  it("applies over the previous head (001-014) with seeded rows and leaves them alone", async () => {
    await q(`DROP TABLE ${GROWTH.map((t) => `${NAMESPACE}.${t}`).join(", ")}`);
    await q(`INSERT INTO ${NAMESPACE}.campaigns (id, company_id, name, status) VALUES ('cmp1', 'c', 'Spring', 'draft')`);
    await q(FILE);
    const seeded = (await q(`SELECT name, status FROM ${NAMESPACE}.campaigns WHERE id = 'cmp1'`)).rows;
    expect(seeded).toEqual([{ name: "Spring", status: "draft" }]);
    const rows = (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${NAMESPACE}' AND table_name LIKE 'growth_%' ORDER BY 1`)).rows as Array<{ table_name: string }>;
    expect(rows.map((r) => r.table_name)).toEqual(GROWTH);
    await q(`DELETE FROM ${NAMESPACE}.campaigns WHERE id = 'cmp1'`);
  });
});
