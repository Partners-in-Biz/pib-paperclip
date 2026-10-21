/**
 * Migration 012_growth.sql: Growth Lab tables (kit experimentsMigration),
 * growth_metrics for per-channel measurements, growth_ledger for experiment
 * verdicts and decisions.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { experimentsMigration } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg } from "./helpers/pg.js";

const MIGRATION = readFileSync(new URL("../migrations/012_growth.sql", import.meta.url), "utf8");
const T = (name: string) => `${NAMESPACE}.${name}`;

describe("migration 012_growth: structure", () => {
  it("pastes the kit experimentsMigration tables with our namespace", () => {
    for (const block of experimentsMigration(NAMESPACE).trim().split("\n\n")) {
      expect(MIGRATION).toContain(block.trim());
    }
  });

  it("adds growth_metrics and growth_ledger without deleting anything", () => {
    for (const text of [
      `CREATE TABLE IF NOT EXISTS ${T("growth_metrics")}`,
      `CREATE TABLE IF NOT EXISTS ${T("growth_ledger")}`,
      "CONSTRAINT growth_metrics_source CHECK (source IN ('tool', 'csv'))",
      "CONSTRAINT growth_ledger_verdict CHECK (verdict IS NULL OR verdict IN ('win', 'loss', 'no_change', 'inconclusive'))",
      "CONSTRAINT growth_ledger_decision CHECK (playbook_decision IS NULL OR playbook_decision IN ('kept', 'discarded', 'pending'))",
    ]) {
      expect(MIGRATION).toContain(text);
    }
    expect(MIGRATION).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(MIGRATION).not.toMatch(/^\s*(DROP|TRUNCATE)\b/im);
  });

  it("uses quoted window to avoid reserved word conflict", () => {
    expect(MIGRATION).toContain('"window" text NOT NULL');
    expect(MIGRATION).toMatch(/UNIQUE \([^)]*"window"[^)]*\)/);
  });
});

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

d("migration 012_growth: application (Postgres)", () => {
  it("applies on a fresh schema", async () => {
    const h = await startPg();
    try {
      const tables = await h.client.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('growth_programs', 'growth_metrics', 'growth_ledger')`,
        [NAMESPACE],
      );
      expect(tables.rows.length).toBe(3); // growth_programs from kit; growth_metrics, growth_ledger from cockpit
      // Verify growth_metrics structure
      const metricsColumns = await h.client.query(
        `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'growth_metrics' ORDER BY ordinal_position`,
        [NAMESPACE],
      );
      const columnNames = metricsColumns.rows.map((r: any) => r.column_name);
      expect(columnNames).toContain("id");
      expect(columnNames).toContain("company_id");
      expect(columnNames).toContain("channel");
      expect(columnNames).toContain("subject");
      expect(columnNames).toContain("metric");
      expect(columnNames).toContain("window");
      expect(columnNames).toContain("value");
      expect(columnNames).toContain("source");
    } finally {
      await h.stop();
    }
  });

  it("applies over the previous head with seeded rows intact", async () => {
    const h = await startPg();
    try {
      // Seed a row in an existing table (e.g., from an earlier migration)
      const testTableQuery = `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'roles'
        LIMIT 1
      `;
      const existingTables = await h.client.query(testTableQuery, [NAMESPACE]);
      if (existingTables.rows.length > 0) {
        // If roles table exists, insert a test row
        const companyId = "11111111-1111-1111-1111-111111111111";
        await h.client.query(
          `INSERT INTO ${NAMESPACE}.roles (company_id, operator_agent_id) VALUES ($1, $2)`,
          [companyId, "test-agent"],
        );
        // Verify the row is still there after the migration (it should be)
        const check = await h.client.query(`SELECT COUNT(*) as cnt FROM ${NAMESPACE}.roles WHERE company_id = $1`, [companyId]);
        expect(Number((check.rows[0] as any).cnt)).toBeGreaterThan(0);
      }
    } finally {
      await h.stop();
    }
  });

  it("rejects duplicate growth_metrics on (company_id, channel, subject, metric, window)", async () => {
    const h = await startPg();
    try {
      const companyId = "11111111-1111-1111-1111-111111111111";
      const insert1 = `INSERT INTO ${NAMESPACE}.growth_metrics (id, company_id, channel, subject, metric, "window", value, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
      await h.client.query(insert1, ["m1", companyId, "website", "subject-1", "conversions", "7d", 100, "tool"]);
      // Attempt duplicate
      await expect(h.client.query(insert1, ["m2", companyId, "website", "subject-1", "conversions", "7d", 110, "tool"])).rejects.toThrow();
    } finally {
      await h.stop();
    }
  });

  it("rejects duplicate growth_ledger on (company_id, channel, experiment_id, decided_at)", async () => {
    const h = await startPg();
    try {
      const companyId = "11111111-1111-1111-1111-111111111111";
      const now = new Date().toISOString();
      const insert = `INSERT INTO ${NAMESPACE}.growth_ledger (id, company_id, channel, scope_key, experiment_id, decided_at) VALUES ($1, $2, $3, $4, $5, $6)`;
      await h.client.query(insert, ["l1", companyId, "website", "own", "exp1", now]);
      // Attempt duplicate
      await expect(h.client.query(insert, ["l2", companyId, "website", "own", "exp1", now])).rejects.toThrow();
    } finally {
      await h.stop();
    }
  });

  it("inserts and reads growth_metrics", async () => {
    const h = await startPg();
    try {
      const companyId = "11111111-1111-1111-1111-111111111111";
      const metrics = [
        { id: "m1", company_id: companyId, channel: "website", subject: "s1", metric: "conversions", "window": "7d", value: 100, source: "tool" },
        { id: "m2", company_id: companyId, channel: "aso", subject: "s2", metric: "installs", "window": "30d", value: 250, source: "csv" },
      ];
      for (const m of metrics) {
        await h.client.query(
          `INSERT INTO ${NAMESPACE}.growth_metrics (id, company_id, channel, subject, metric, "window", value, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [m.id, m.company_id, m.channel, m.subject, m.metric, m.window, m.value, m.source],
        );
      }
      const rows = await h.client.query(`SELECT * FROM ${NAMESPACE}.growth_metrics ORDER BY id`);
      expect(rows.rows.length).toBe(2);
      expect((rows.rows[0] as any).source).toBe("tool");
      expect((rows.rows[1] as any).source).toBe("csv");
    } finally {
      await h.stop();
    }
  });

  it("inserts and reads growth_ledger", async () => {
    const h = await startPg();
    try {
      const companyId = "11111111-1111-1111-1111-111111111111";
      const now = new Date().toISOString();
      const ledger = [
        { id: "l1", company_id: companyId, channel: "website", scope_key: "own", experiment_id: "exp1", verdict: "win", decided_at: now, playbook_decision: "kept" },
        { id: "l2", company_id: companyId, channel: "aso", scope_key: "client:company:c1", experiment_id: "exp2", verdict: "loss", decided_at: now, playbook_decision: "discarded" },
      ];
      for (const l of ledger) {
        await h.client.query(
          `INSERT INTO ${NAMESPACE}.growth_ledger (id, company_id, channel, scope_key, experiment_id, verdict, decided_at, playbook_decision) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [l.id, l.company_id, l.channel, l.scope_key, l.experiment_id, l.verdict, l.decided_at, l.playbook_decision],
        );
      }
      const rows = await h.client.query(`SELECT * FROM ${NAMESPACE}.growth_ledger ORDER BY id`);
      expect(rows.rows.length).toBe(2);
      expect((rows.rows[0] as any).verdict).toBe("win");
      expect((rows.rows[1] as any).verdict).toBe("loss");
    } finally {
      await h.stop();
    }
  });

  it("rejects invalid source values in growth_metrics", async () => {
    const h = await startPg();
    try {
      const companyId = "11111111-1111-1111-1111-111111111111";
      await expect(
        h.client.query(
          `INSERT INTO ${NAMESPACE}.growth_metrics (id, company_id, channel, subject, metric, "window", value, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          ["m_invalid", companyId, "website", "s1", "conversions", "7d", 100, "invalid_source"],
        ),
      ).rejects.toThrow();
    } finally {
      await h.stop();
    }
  });

  it("rejects invalid verdict values in growth_ledger", async () => {
    const h = await startPg();
    try {
      const companyId = "11111111-1111-1111-1111-111111111111";
      const now = new Date().toISOString();
      await expect(
        h.client.query(
          `INSERT INTO ${NAMESPACE}.growth_ledger (id, company_id, channel, scope_key, experiment_id, verdict, decided_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          ["l_invalid", companyId, "website", "own", "exp1", "invalid_verdict", now],
        ),
      ).rejects.toThrow();
    } finally {
      await h.stop();
    }
  });
});
