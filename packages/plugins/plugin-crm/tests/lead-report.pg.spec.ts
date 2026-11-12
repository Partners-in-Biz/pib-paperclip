/** Migration 022 (report intake) on a real Postgres: existing sources become intake lead, and only lead or issue is allowed. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg } from "./helpers/pg.js";

const available = await embeddedAvailable();

describe.skipIf(!available)("migration 022 on an existing database", () => {
  it("keeps every existing source as a lead source and refuses an unknown intake", async () => {
    const old = await startPg({ upTo: 21 });
    try {
      await old.client.query(`INSERT INTO ${NAMESPACE}.lead_sources (id, company_id, label, public_key) VALUES ('s1', 'co-1', 'Contact', 'pibl_aaaaaaaaaaaaaaaaaaaaaaaa')`);
      await old.client.query(readFileSync(new URL("../migrations/022_crm.sql", import.meta.url), "utf8"));
      expect((await old.client.query(`SELECT intake, target_project_id, target_agent_id FROM ${NAMESPACE}.lead_sources`)).rows).toEqual([{ intake: "lead", target_project_id: null, target_agent_id: null }]);
      await old.client.query(`UPDATE ${NAMESPACE}.lead_sources SET intake = 'issue', target_project_id = 'p1' WHERE id = 's1'`);
      await expect(old.client.query(`UPDATE ${NAMESPACE}.lead_sources SET intake = 'newsletter' WHERE id = 's1'`)).rejects.toThrow(/lead_sources_intake/);
    } finally {
      await old.stop();
    }
  }, 120_000);
});
