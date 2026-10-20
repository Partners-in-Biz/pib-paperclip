import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AUTOPILOT, experimentsMigration, experimentsMigrationV1, experimentsScopeAlterMigration } from "../src/experiments.js";
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

  describe("experimentsScopeAlterMigration", () => {
    it("adds scope_key and project_id columns as nullable", async () => {
      // Start with V1
      await pg.client.query(experimentsMigrationV1(TEST_NAMESPACE));

      // Apply the alter migration
      await pg.client.query(experimentsScopeAlterMigration(TEST_NAMESPACE));

      const columns = (await pg.client.query(
        `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'growth_programs'`,
        [TEST_NAMESPACE],
      )).rows as Array<{ column_name: string; is_nullable: string }>;

      const scopeKeyCol = columns.find((c) => c.column_name === "scope_key");
      const projectIdCol = columns.find((c) => c.column_name === "project_id");
      expect(scopeKeyCol).toBeDefined();
      expect(scopeKeyCol!.is_nullable).toBe("YES"); // nullable after alter (backfill happens)
      expect(projectIdCol).toBeDefined();
      expect(projectIdCol!.is_nullable).toBe("YES");
    });

    it("widens autopilot CHECK to include 'reviewed'", async () => {
      // Start with V1
      await pg.client.query(experimentsMigrationV1(TEST_NAMESPACE));

      // Before alter: 'reviewed' should fail
      await expect(
        pg.client.query(
          `INSERT INTO ${TEST_NAMESPACE}.growth_programs (id, company_id, channel, objective, metric) VALUES ($1, $2, $3, $4, $5, $6)`,
          ["p_bad", "c1", "ch1", "o1", "m1", "reviewed"],
        ),
      ).rejects.toThrow();

      // Apply the alter migration
      await pg.client.query(experimentsScopeAlterMigration(TEST_NAMESPACE));

      // After alter: 'reviewed' should succeed
      await pg.client.query(
        `INSERT INTO ${TEST_NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, autopilot, scope_key) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ["p_good", "c1", "ch1", "o1", "m1", "reviewed", "own"],
      );

      const result = (await pg.client.query(
        `SELECT autopilot FROM ${TEST_NAMESPACE}.growth_programs WHERE id = $1`,
        ["p_good"],
      )).rows[0] as { autopilot: string };
      expect(result.autopilot).toBe("reviewed");
    });

    it("backfills scope_key from client_kind and client_ref", async () => {
      // Start with V1 and insert some rows
      await pg.client.query(experimentsMigrationV1(TEST_NAMESPACE));

      // Insert rows with various client kinds
      const rows = [
        ["p_own", "c1", "social", "own_prog", null, null, "own_prog"], // own work
        ["p_company", "c1", "social", "company_prog", "company", "c2", "company_prog"], // company client
        ["p_contact", "c1", "social", "contact_prog", "contact", "ct1", "contact_prog"], // contact client
      ];

      for (const row of rows) {
        await pg.client.query(
          `INSERT INTO ${TEST_NAMESPACE}.growth_programs (id, company_id, channel, objective, client_kind, client_ref, metric) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          row,
        );
      }

      // Apply the alter migration (should backfill scope_key)
      await pg.client.query(experimentsScopeAlterMigration(TEST_NAMESPACE));

      const backfilled = (await pg.client.query(
        `SELECT id, scope_key FROM ${TEST_NAMESPACE}.growth_programs ORDER BY id`,
      )).rows as Array<{ id: string; scope_key: string | null }>;

      expect(backfilled).toHaveLength(3);
      expect(backfilled[0]).toEqual({ id: "p_company", scope_key: "client:company:c2" });
      expect(backfilled[1]).toEqual({ id: "p_contact", scope_key: "client:contact:ct1" });
      expect(backfilled[2]).toEqual({ id: "p_own", scope_key: "own" });
    });

    it("creates partial unique index on (company_id, channel, scope_key) WHERE scope_key IS NOT NULL", async () => {
      // Start with V1
      await pg.client.query(experimentsMigrationV1(TEST_NAMESPACE));

      // Apply the alter migration
      await pg.client.query(experimentsScopeAlterMigration(TEST_NAMESPACE));

      // Check the index exists
      const indexes = (await pg.client.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'growth_programs' AND indexname LIKE '%scope_key%'`,
        [TEST_NAMESPACE],
      )).rows as Array<{ indexname: string }>;

      expect(indexes.length).toBeGreaterThan(0);
      expect(indexes[0]!.indexname).toBe("growth_programs_scope_key");
    });

    it("does not modify the old growth_programs_scope index", async () => {
      // Start with V1 (which creates the old index)
      await pg.client.query(experimentsMigrationV1(TEST_NAMESPACE));

      // Check old index exists
      const oldIndexes = (await pg.client.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = 'growth_programs_scope'`,
        [TEST_NAMESPACE],
      )).rows as Array<{ indexname: string }>;
      expect(oldIndexes.length).toBe(1);

      // Apply the alter migration
      await pg.client.query(experimentsScopeAlterMigration(TEST_NAMESPACE));

      // Check old index still exists
      const oldIndexesAfter = (await pg.client.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = 'growth_programs_scope'`,
        [TEST_NAMESPACE],
      )).rows as Array<{ indexname: string }>;
      expect(oldIndexesAfter.length).toBe(1);
    });
  });

  describe("Social migration path (V1 + alter + Social ALTERs)", () => {
    it("allows old insert statement to succeed on altered schema", async () => {
      // Start with V1
      await pg.client.query(experimentsMigrationV1(TEST_NAMESPACE));

      // Add owner_user_id column like Social does in 012
      await pg.client.query(`ALTER TABLE ${TEST_NAMESPACE}.growth_programs ADD COLUMN IF NOT EXISTS owner_user_id text`);

      // Insert a row using the old insert statement from plugin-social/src/growth/sql.ts
      const oldInsertSql = `
        INSERT INTO ${TEST_NAMESPACE}.growth_programs
          (id, company_id, client_kind, client_ref, client_name, channel, objective, metric, constraints, playbook, playbook_version, autopilot, scoreboard, feature_questions, owner_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::jsonb, $14::jsonb, $15)
         ON CONFLICT DO NOTHING
      `;

      const result = await pg.client.query(oldInsertSql, [
        "p1", // id
        "c1", // company_id
        "company", // client_kind
        "c2", // client_ref
        "Acme", // client_name
        "social", // channel
        "Increase engagement", // objective
        "likes", // metric
        '{"max_spend": 100}', // constraints (jsonb string)
        "# Playbook", // playbook
        1, // playbook_version
        "safe", // autopilot
        '{"wins": 1}', // scoreboard (jsonb string)
        '["hook:question"]', // feature_questions (jsonb string)
        null, // owner_user_id
      ]);

      expect(result.rowCount).toBe(1);

      // Verify the row was inserted
      const rows = (await pg.client.query(`SELECT id FROM ${TEST_NAMESPACE}.growth_programs WHERE id = $1`, ["p1"])).rows as Array<{ id: string }>;
      expect(rows).toHaveLength(1);
    });

    it("V1 + alter + backfill: product-scope writers must use client_kind=company, client_ref=product:x to avoid collision with old index", async () => {
      // Start with V1
      await pg.client.query(experimentsMigrationV1(TEST_NAMESPACE));

      // Add owner_user_id column like Social does in 012
      await pg.client.query(`ALTER TABLE ${TEST_NAMESPACE}.growth_programs ADD COLUMN IF NOT EXISTS owner_user_id text`);

      // Add client_kind CHECK like Social does in 012
      await pg.client.query(
        `ALTER TABLE ${TEST_NAMESPACE}.growth_programs ADD CONSTRAINT growth_programs_client_kind CHECK (client_kind IS NULL OR client_kind IN ('company', 'contact'))`,
      );

      // Insert 'own' program (will be scoped as 'own')
      await pg.client.query(
        `INSERT INTO ${TEST_NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, client_kind, client_ref) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ["p_own", "c1", "social", "o1", "m1", null, null],
      );

      // Apply scope alter migration
      await pg.client.query(experimentsScopeAlterMigration(TEST_NAMESPACE));

      // Insert a product-style program: to avoid collision with the old index (which uses coalesce on null values),
      // the product program must have non-null client_kind/client_ref. Use client_kind='company' with client_ref='product:x'
      // and explicitly set scope_key='product:x'. This way the old index sees (company_id, channel, 'company', 'product:x')
      // which is different from the 'own' program (company_id, channel, '', '')
      await pg.client.query(
        `INSERT INTO ${TEST_NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, client_kind, client_ref, scope_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        ["p_product", "c1", "social", "o2", "m2", "company", "product:x", "product:x"],
      );

      // Verify both rows exist (no collision)
      const rows = (await pg.client.query(
        `SELECT id, scope_key, client_kind, client_ref FROM ${TEST_NAMESPACE}.growth_programs WHERE company_id = $1 AND channel = $2 ORDER BY id`,
        ["c1", "social"],
      )).rows as Array<{ id: string; scope_key: string | null; client_kind: string | null; client_ref: string | null }>;

      expect(rows).toHaveLength(2);
      expect(rows[0]!.id).toBe("p_own");
      expect(rows[0]!.scope_key).toBe("own");
      expect(rows[0]!.client_kind).toBeNull();
      expect(rows[0]!.client_ref).toBeNull();
      expect(rows[1]!.id).toBe("p_product");
      expect(rows[1]!.scope_key).toBe("product:x");
      expect(rows[1]!.client_kind).toBe("company");
      expect(rows[1]!.client_ref).toBe("product:x");
    });
  });

  describe("Constants", () => {
    it("DEFAULT_AUTOPILOT equals 'reviewed'", () => {
      expect(DEFAULT_AUTOPILOT).toBe("reviewed");
    });
  });
});
