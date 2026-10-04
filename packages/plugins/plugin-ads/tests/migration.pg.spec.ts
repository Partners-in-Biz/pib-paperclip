import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NAMESPACE, pluginNamespace } from "../src/namespace.js";
import { embeddedAvailable, PLUGIN_ROOT, startPg, type Pg } from "./helpers/pg.js";

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

describe("migration files", () => {
  it("name the plugin's own namespace and no other schema", () => {
    expect(pluginNamespace()).toBe(NAMESPACE);
    for (const file of readdirSync(join(PLUGIN_ROOT, "migrations"))) {
      const sql = readFileSync(join(PLUGIN_ROOT, "migrations", file), "utf8");
      const schemas = new Set([...sql.matchAll(/\b(plugin_[a-z0-9_]+)\./g)].map((m) => m[1]));
      expect([...schemas], file).toEqual([NAMESPACE]);
      expect(sql, file).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bTRUNCATE\b|\bGRANT\b/i);
      // The host's SQL check strips string literals before comments, so an apostrophe inside a comment swallows the SQL after it.
      const commentsWithApostrophe = sql.split("\n").filter((line) => line.includes("--") && line.split("--").slice(1).join("--").includes("'"));
      expect(commentsWithApostrophe, file).toEqual([]);
    }
  });
});

describe.skipIf(!available)("schema", () => {
  const insert = (sql: string, ...params: unknown[]) => pg.client.query(sql, params);

  it("creates every table the plugin reads and writes", async () => {
    const rows = (await pg.client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${NAMESPACE}' ORDER BY 1`)).rows as Array<{ table_name: string }>;
    expect(rows.map((r) => r.table_name)).toEqual(["ad_accounts", "alerts", "approvals", "audit", "budget_overrides", "campaigns", "connections", "crm_companies", "crm_contacts", "daily", "oauth_sessions", "proposals", "scopes", "spend_ledger"]);
  });

  it("only a person's yes can be stored as an approval", async () => {
    await insert(`INSERT INTO ${NAMESPACE}.proposals (id, company_id, scope_key, kind, status, title, content_hash) VALUES ('p1', 'c', 'own', 'pause_campaign', 'in_review', 't', 'h')`);
    await insert(`INSERT INTO ${NAMESPACE}.approvals (id, company_id, proposal_id, role, decision, decided_by, content_hash, expires_at) VALUES ('a1', 'c', 'p1', 'owner', 'approved', 'user:u1', 'h', now())`);
    await expect(insert(`INSERT INTO ${NAMESPACE}.approvals (id, company_id, proposal_id, role, decision, decided_by, content_hash, expires_at) VALUES ('a2', 'c', 'p1', 'owner', 'approved', 'agent:ag1', 'h', now())`)).rejects.toThrow(/approvals_person/);
    await expect(insert(`INSERT INTO ${NAMESPACE}.approvals (id, company_id, proposal_id, role, decision, decided_by, content_hash, expires_at) VALUES ('a3', 'c', 'p1', 'owner', 'approved', 'system', 'h', now())`)).rejects.toThrow(/approvals_person/);
  });

  it("changes are off by default and a cap can be missing, but a scope is either own or one client", async () => {
    await insert(`INSERT INTO ${NAMESPACE}.scopes (company_id, scope_key) VALUES ('c', 'own')`);
    const row = (await pg.client.query(`SELECT allow_writes, monthly_cap_minor, signoffs, alert_pct FROM ${NAMESPACE}.scopes WHERE scope_key = 'own'`)).rows[0] as Record<string, unknown>;
    expect(row).toEqual({ allow_writes: false, monthly_cap_minor: null, signoffs: "owner", alert_pct: 90 });
    await expect(insert(`INSERT INTO ${NAMESPACE}.scopes (company_id, scope_key) VALUES ('c', 'company:x')`)).rejects.toThrow(/scopes_client/);
    await expect(insert(`INSERT INTO ${NAMESPACE}.scopes (company_id, scope_key, alert_pct) VALUES ('c', 'own2', 20)`)).rejects.toThrow();
  });

  it("an alert is one row per dedupe key, and a day's ledger entries are numbered", async () => {
    await insert(`INSERT INTO ${NAMESPACE}.alerts (id, company_id, scope_key, kind, severity, dedupe_key, title, body) VALUES ('al1', 'c', 'own', 'spend_spike', 'warn', 'k1', 't', 'b')`);
    await expect(insert(`INSERT INTO ${NAMESPACE}.alerts (id, company_id, scope_key, kind, severity, dedupe_key, title, body) VALUES ('al2', 'c', 'own', 'spend_spike', 'warn', 'k1', 't', 'b')`)).rejects.toThrow(/alerts_dedupe/);
  });
});
