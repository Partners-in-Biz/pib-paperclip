import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { experimentsMigration } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

describe.skipIf(!available)("growth migration (006)", () => {
  beforeEach(async () => {
    await pg.reset();
  });

  it("006_growth.sql text equals the experimentsMigration helper output", () => {
    const migrationPath = fileURLToPath(new URL("../migrations/006_growth.sql", import.meta.url));
    const migrationText = readFileSync(migrationPath, "utf8");
    const helperOutput = experimentsMigration(NAMESPACE);
    expect(migrationText.trim()).toBe(helperOutput.trim());
  });

  it("applies on a fresh schema and creates all growth tables", async () => {
    // Tables and indices should exist
    const tables = (await pg.client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'growth_%' ORDER BY 1`,
      [NAMESPACE],
    )).rows as Array<{ table_name: string }>;

    expect(tables.map((r) => r.table_name)).toEqual([
      "growth_experiment_items",
      "growth_experiments",
      "growth_playbook_changes",
      "growth_playbook_versions",
      "growth_programs",
    ]);

    // Verify scope_key is NOT NULL on growth_programs
    const columns = (await pg.client.query(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'growth_programs' AND column_name = 'scope_key'`,
      [NAMESPACE],
    )).rows as Array<{ column_name: string; is_nullable: string }>;

    expect(columns).toHaveLength(1);
    expect(columns[0]!.is_nullable).toBe("NO");

    // Verify unique index on (company_id, channel, scope_key) rejects duplicates
    await pg.client.query(
      `INSERT INTO ${NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, scope_key) VALUES ($1, $2, $3, $4, $5, $6)`,
      ["p1", "c1", "ch1", "obj1", "m1", "own"],
    );

    await expect(
      pg.client.query(
        `INSERT INTO ${NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, scope_key) VALUES ($1, $2, $3, $4, $5, $6)`,
        ["p2", "c1", "ch1", "obj1", "m1", "own"],
      ),
    ).rejects.toThrow(/unique/i);
  });

  it("applies over previous migrations and preserves seeded rows in existing tables", async () => {
    let pgPrev: Pg | null = null;
    try {
      // Start a separate pg with only migrations up to 005
      pgPrev = await startPg({ upTo: "005" });

      // Confirm growth_programs does not exist yet
      const growthCheck = await pgPrev.client.query(
        `SELECT to_regclass('${NAMESPACE}.growth_programs')`,
      );
      expect(growthCheck.rows[0]).toEqual({ to_regclass: null });

      // Seed rows into pre-006 tables BEFORE applying 006
      await pgPrev.client.query(
        `INSERT INTO ${NAMESPACE}.scopes (company_id, scope_key) VALUES ($1, $2)`,
        ["c1", "own"],
      );

      await pgPrev.client.query(
        `INSERT INTO ${NAMESPACE}.proposals (id, company_id, scope_key, kind, status, title, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ["prop1", "c1", "own", "pause_campaign", "in_review", "Test proposal", "hash1"],
      );

      await pgPrev.client.query(
        `INSERT INTO ${NAMESPACE}.ad_accounts (id, company_id, platform, external_id, name, currency, scope_key) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ["acc1", "c1", "meta", "ext1", "Test Account", "USD", "own"],
      );

      // Read and apply migration 006
      const migrationPath = fileURLToPath(new URL("../migrations/006_growth.sql", import.meta.url));
      const migrationText = readFileSync(migrationPath, "utf8");
      await pgPrev.client.query(migrationText);

      // Verify seeded rows are unchanged
      const scopes = (await pgPrev.client.query(
        `SELECT company_id, scope_key FROM ${NAMESPACE}.scopes WHERE scope_key = 'own'`,
      )).rows as Array<{ company_id: string; scope_key: string }>;
      expect(scopes).toHaveLength(1);
      expect(scopes[0]).toEqual({ company_id: "c1", scope_key: "own" });

      const proposals = (await pgPrev.client.query(
        `SELECT id, company_id FROM ${NAMESPACE}.proposals WHERE id = 'prop1'`,
      )).rows as Array<{ id: string; company_id: string }>;
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toEqual({ id: "prop1", company_id: "c1" });

      const accounts = (await pgPrev.client.query(
        `SELECT id, company_id FROM ${NAMESPACE}.ad_accounts WHERE id = 'acc1'`,
      )).rows as Array<{ id: string; company_id: string }>;
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toEqual({ id: "acc1", company_id: "c1" });

      // Verify new growth tables exist and are empty
      const programs = (await pgPrev.client.query(`SELECT COUNT(*) as count FROM ${NAMESPACE}.growth_programs`))
        .rows[0] as { count: string };
      expect(parseInt(programs.count)).toBe(0);

      const playbooks = (await pgPrev.client.query(`SELECT COUNT(*) as count FROM ${NAMESPACE}.growth_playbook_versions`))
        .rows[0] as { count: string };
      expect(parseInt(playbooks.count)).toBe(0);

      const experiments = (await pgPrev.client.query(`SELECT COUNT(*) as count FROM ${NAMESPACE}.growth_experiments`))
        .rows[0] as { count: string };
      expect(parseInt(experiments.count)).toBe(0);

      const items = (await pgPrev.client.query(`SELECT COUNT(*) as count FROM ${NAMESPACE}.growth_experiment_items`))
        .rows[0] as { count: string };
      expect(parseInt(items.count)).toBe(0);

      const changes = (await pgPrev.client.query(`SELECT COUNT(*) as count FROM ${NAMESPACE}.growth_playbook_changes`))
        .rows[0] as { count: string };
      expect(parseInt(changes.count)).toBe(0);
    } finally {
      if (pgPrev) await pgPrev.stop();
    }
  });
});
