import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AUTOPILOT, experimentsMigration, experimentsMigrationV1 } from "../src/experiments.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const TEST_NAMESPACE = "test_experiments";
const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

describe.skipIf(!available)("Growth Lab migrations", () => {
  beforeEach(async () => {
    await pg.client.query(`DROP SCHEMA IF EXISTS ${TEST_NAMESPACE} CASCADE`);
    await pg.client.query(`CREATE SCHEMA ${TEST_NAMESPACE}`);
  });

  describe("experimentsMigrationV1", () => {
    it("matches the text inside plugin-social 012 for CREATE TABLE blocks", () => {
      // Read the social migration file using a path relative to this file
      const socialMigrationPath = new URL("../../plugin-social/migrations/012_social.sql", import.meta.url).pathname;
      const socialMigration = readFileSync(socialMigrationPath, "utf8");
      const v1Output = experimentsMigrationV1(TEST_NAMESPACE);

      // Check each CREATE TABLE block from V1 is contained in the social migration
      for (const block of v1Output.trim().split("\n\n")) {
        const blockContent = block.trim();
        // Replace namespace for matching
        const socialNamespace = "plugin_social_e70c4e79f2";
        const blockWithSocialNs = blockContent.replace(new RegExp(TEST_NAMESPACE, "g"), socialNamespace);
        expect(socialMigration).toContain(blockWithSocialNs);
      }
    });

    it("creates the V1 schema (without scope_key or project_id)", async () => {
      const sql = experimentsMigrationV1(TEST_NAMESPACE);
      await pg.client.query(sql);

      const columns = (await pg.client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'growth_programs' ORDER BY ordinal_position`,
        [TEST_NAMESPACE],
      )).rows as Array<{ column_name: string }>;

      const columnNames = columns.map((c) => c.column_name);
      expect(columnNames).not.toContain("scope_key");
      expect(columnNames).not.toContain("project_id");
      expect(columnNames).toContain("client_kind");
      expect(columnNames).toContain("client_ref");
      expect(columnNames).not.toContain("owner_user_id"); // V1 doesn't have this; Social's ALTERs add it
    });

    it("V1 autopilot CHECK only accepts off, safe, full", async () => {
      const sql = experimentsMigrationV1(TEST_NAMESPACE);
      await pg.client.query(sql);

      // Insert should work with 'safe'
      await pg.client.query(
        `INSERT INTO ${TEST_NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, autopilot) VALUES ($1, $2, $3, $4, $5, $6)`,
        ["p1", "c1", "ch1", "o1", "m1", "safe"],
      );

      // Insert should fail with 'reviewed' (not in V1 CHECK)
      await expect(
        pg.client.query(
          `INSERT INTO ${TEST_NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, autopilot) VALUES ($1, $2, $3, $4, $5, $6)`,
          ["p2", "c1", "ch1", "o1", "m1", "reviewed"],
        ),
      ).rejects.toThrow(/CHECK/i);
    });
  });

  describe("experimentsMigration (V2)", () => {
    it("creates the V2 schema with scope_key NOT NULL and project_id nullable", async () => {
      const sql = experimentsMigration(TEST_NAMESPACE);
      await pg.client.query(sql);

      const columns = (await pg.client.query(
        `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'growth_programs' ORDER BY ordinal_position`,
        [TEST_NAMESPACE],
      )).rows as Array<{ column_name: string; is_nullable: string }>;

      const scopeKeyCol = columns.find((c) => c.column_name === "scope_key");
      const projectIdCol = columns.find((c) => c.column_name === "project_id");
      expect(scopeKeyCol).toBeDefined();
      expect(scopeKeyCol!.is_nullable).toBe("NO"); // NOT NULL
      expect(projectIdCol).toBeDefined();
      expect(projectIdCol!.is_nullable).toBe("YES");
    });

    it("V2 autopilot CHECK accepts off, safe, reviewed, full", async () => {
      const sql = experimentsMigration(TEST_NAMESPACE);
      await pg.client.query(sql);

      for (const ap of ["off", "safe", "reviewed", "full"]) {
        await pg.client.query(
          `INSERT INTO ${TEST_NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, scope_key, autopilot) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [`p_${ap}`, "c1", "ch1", "o1", "m1", `scope_${ap}`, ap],
        );
      }

      // Verify they were all inserted
      const rows = (await pg.client.query(`SELECT autopilot FROM ${TEST_NAMESPACE}.growth_programs ORDER BY id`)).rows as Array<{ autopilot: string }>;
      expect(rows).toHaveLength(4);
    });

    it("V2 has client_kind CHECK for company/contact/null", async () => {
      const sql = experimentsMigration(TEST_NAMESPACE);
      await pg.client.query(sql);

      // Valid: NULL
      await pg.client.query(
        `INSERT INTO ${TEST_NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, scope_key, client_kind) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ["p1", "c1", "ch1", "o1", "m1", "own", null],
      );

      // Valid: 'company'
      await pg.client.query(
        `INSERT INTO ${TEST_NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, scope_key, client_kind) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ["p2", "c1", "ch1", "o1", "m1", "client:company:c2", "company"],
      );

      // Valid: 'contact'
      await pg.client.query(
        `INSERT INTO ${TEST_NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, scope_key, client_kind) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ["p3", "c1", "ch1", "o1", "m1", "client:contact:ct1", "contact"],
      );

      // Invalid: 'bogus'
      await expect(
        pg.client.query(
          `INSERT INTO ${TEST_NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, scope_key, client_kind) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          ["p4", "c1", "ch1", "o1", "m1", "scope_key", "bogus"],
        ),
      ).rejects.toThrow(/CHECK/i);
    });

    it("creates growth_playbook_changes with approval columns", async () => {
      const sql = experimentsMigration(TEST_NAMESPACE);
      await pg.client.query(sql);

      const columns = (await pg.client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'growth_playbook_changes' ORDER BY column_name`,
        [TEST_NAMESPACE],
      )).rows as Array<{ column_name: string }>;

      const columnNames = columns.map((c) => c.column_name);
      expect(columnNames).toContain("owner_user_id");
      expect(columnNames).toContain("approval_issue_id");
      expect(columnNames).toContain("approval_week");
      expect(columnNames).toContain("decision_note");
    });

    it("V2 unique index on (company_id, channel, scope_key) prevents duplicates", async () => {
      const sql = experimentsMigration(TEST_NAMESPACE);
      await pg.client.query(sql);

      // Insert first program
      await pg.client.query(
        `INSERT INTO ${TEST_NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, scope_key) VALUES ($1, $2, $3, $4, $5, $6)`,
        ["p1", "c1", "ch1", "o1", "m1", "own"],
      );

      // Attempt to insert duplicate should fail
      await expect(
        pg.client.query(
          `INSERT INTO ${TEST_NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, scope_key) VALUES ($1, $2, $3, $4, $5, $6)`,
          ["p2", "c1", "ch1", "o1", "m1", "own"],
        ),
      ).rejects.toThrow(/unique/i);
    });
  });

  describe("Constants", () => {
    it("DEFAULT_AUTOPILOT equals 'reviewed'", () => {
      expect(DEFAULT_AUTOPILOT).toBe("reviewed");
    });
  });
});
