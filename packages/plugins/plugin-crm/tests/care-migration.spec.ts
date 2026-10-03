import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";

describe("migration 011", () => {
  const sql = readFileSync(new URL("../migrations/011_crm.sql", import.meta.url), "utf8");

  it("passes the host migration guard, with no quotes in comments and nothing deleted", () => {
    for (const statement of splitSqlStatements(sql)) expect(() => validateMigrationStatement(statement, NAMESPACE), statement.slice(0, 80)).not.toThrow();
    for (const line of sql.split("\n").filter((row) => row.trim().startsWith("--"))) expect(line).not.toMatch(/['"`]/);
    expect(sql).not.toMatch(/\bdelete\b/i);
  });

  it("makes the client care tables, each scoped by company", () => {
    const tables = ["client_signals", "client_reports", "care_approvals", "client_actions", "support_cases", "client_feedback", "client_health", "site_monitor", "site_uptime_days", "client_sensitivity", "processing_register"];
    for (const table of tables) {
      expect(sql, table).toContain(`CREATE TABLE ${NAMESPACE}.${table} (`);
      const body = sql.slice(sql.indexOf(`CREATE TABLE ${NAMESPACE}.${table} (`)).split(");")[0]!;
      expect(body, table).toMatch(/company_id text NOT NULL/);
    }
    // One report per client and month, one signal per client, module and month, one approval per subject and attempt.
    expect(sql).toContain("CREATE UNIQUE INDEX client_reports_client ON " + NAMESPACE + ".client_reports (company_id, client_kind, client_ref, period)");
    expect(sql).toContain("(company_id, client_kind, client_ref, module, period)");
    expect(sql).toContain("(company_id, kind, subject_id, seq)");
    expect(sql).toContain("(company_id, source_key) WHERE source_key IS NOT NULL");
  });

  it("is the next numbered migration and no applied migration was edited (there are eleven, in order)", () => {
    const files = readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
    expect(files).toEqual(Array.from({ length: 11 }, (_, i) => `${String(i + 1).padStart(3, "0")}_crm.sql`));
  });
});
