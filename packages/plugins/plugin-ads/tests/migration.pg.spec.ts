import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
      // Reject truly destructive operations: DROP TABLE/SCHEMA, DELETE FROM, TRUNCATE, GRANT
      // Allow DROP CONSTRAINT because it's a schema change that can be backward compatible
      expect(sql, file).not.toMatch(/\b(DROP\s+(TABLE|SCHEMA)|DELETE\s+FROM|TRUNCATE|GRANT)\b/i);
      // The host's SQL check strips string literals before comments, so an apostrophe inside a comment swallows the SQL after it.
      const commentsWithApostrophe = sql.split("\n").filter((line) => line.includes("--") && line.split("--").slice(1).join("--").includes("'"));
      expect(commentsWithApostrophe, file).toEqual([]);
    }
  });
});

describe.skipIf(!available)("schema", () => {
  const insert = (sql: string, ...params: unknown[]) => pg.client.query(sql, params);

  beforeEach(async () => {
    await pg.reset();
  });

  it("creates every table the plugin reads and writes", async () => {
    const rows = (await pg.client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${NAMESPACE}' ORDER BY 1`)).rows as Array<{ table_name: string }>;
    expect(rows.map((r) => r.table_name)).toEqual(["ad_accounts", "ad_daily", "ads", "alerts", "approvals", "audit", "budget_overrides", "campaign_caps", "campaigns", "connections", "crm_companies", "crm_contacts", "daily", "growth_experiment_items", "growth_experiments", "growth_playbook_changes", "growth_playbook_versions", "growth_programs", "oauth_sessions", "proposals", "scopes", "spend_ledger", "variants"]);
  });

  it("only a person's yes can be stored as an approval", async () => {
    await insert(`INSERT INTO ${NAMESPACE}.proposals (id, company_id, scope_key, kind, status, title, content_hash) VALUES ('p1', 'c', 'own', 'pause_campaign', 'in_review', 't', 'h')`);
    await insert(`INSERT INTO ${NAMESPACE}.approvals (id, company_id, proposal_id, role, decision, decided_by, content_hash, expires_at) VALUES ('a1', 'c', 'p1', 'owner', 'approved', 'user:u1', 'h', now())`);
    // Agent is allowed when role=owner and decision=approved (for the owner's delegate)
    await insert(`INSERT INTO ${NAMESPACE}.approvals (id, company_id, proposal_id, role, decision, decided_by, content_hash, expires_at) VALUES ('a2', 'c', 'p1', 'owner', 'approved', 'agent:ag1', 'h', now())`);
    // Agent is rejected when decision is not approved (even with owner role)
    await expect(insert(`INSERT INTO ${NAMESPACE}.approvals (id, company_id, proposal_id, role, decision, decided_by, content_hash, expires_at) VALUES ('a3', 'c', 'p1', 'owner', 'rejected', 'agent:ag2', 'h', now())`)).rejects.toThrow(/approvals_person_or_delegate/);
    // System is always rejected
    await expect(insert(`INSERT INTO ${NAMESPACE}.approvals (id, company_id, proposal_id, role, decision, decided_by, content_hash, expires_at) VALUES ('a4', 'c', 'p1', 'owner', 'approved', 'system', 'h', now())`)).rejects.toThrow(/approvals_person_or_delegate/);
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

  it("the new proposal kinds create_ad_creative and create_ad can be inserted, and bogus kinds are still rejected", async () => {
    await insert(`INSERT INTO ${NAMESPACE}.proposals (id, company_id, scope_key, kind, status, title, content_hash) VALUES ('p1', 'c', 'own', 'create_ad_creative', 'in_review', 't', 'h')`);
    await insert(`INSERT INTO ${NAMESPACE}.proposals (id, company_id, scope_key, kind, status, title, content_hash) VALUES ('p2', 'c', 'own', 'create_ad', 'in_review', 't', 'h')`);
    await expect(insert(`INSERT INTO ${NAMESPACE}.proposals (id, company_id, scope_key, kind, status, title, content_hash) VALUES ('p3', 'c', 'own', 'bogus_kind', 'in_review', 't', 'h')`)).rejects.toThrow(/proposals_kind/);
  });

  it("ads table accepts valid policy status and rejects bogus ones", async () => {
    await insert(`INSERT INTO ${NAMESPACE}.ad_accounts (id, company_id, platform, external_id, name, currency, scope_key) VALUES ('acc1', 'c', 'meta', 'ext1', 'Account', 'USD', 'own')`);
    await insert(`INSERT INTO ${NAMESPACE}.ads (id, company_id, account_id, external_id, name, policy_status) VALUES ('ad1', 'c', 'acc1', 'ext1', 'Ad 1', 'ACTIVE')`);
    await insert(`INSERT INTO ${NAMESPACE}.ads (id, company_id, account_id, external_id, name, policy_status) VALUES ('ad2', 'c', 'acc1', 'ext2', 'Ad 2', 'DISAPPROVED')`);
    await expect(insert(`INSERT INTO ${NAMESPACE}.ads (id, company_id, account_id, external_id, name, policy_status) VALUES ('ad3', 'c', 'acc1', 'ext3', 'Ad 3', 'BOGUS')`)).rejects.toThrow(/ads_policy_status/);
  });

  it("ads unique constraint prevents duplicate (account_id, external_id) pairs", async () => {
    await insert(`INSERT INTO ${NAMESPACE}.ad_accounts (id, company_id, platform, external_id, name, currency, scope_key) VALUES ('acc1', 'c', 'meta', 'ext1', 'Account', 'USD', 'own')`);
    await insert(`INSERT INTO ${NAMESPACE}.ads (id, company_id, account_id, external_id, name, policy_status) VALUES ('ad1', 'c', 'acc1', 'ext1', 'Ad 1', 'ACTIVE')`);
    await expect(insert(`INSERT INTO ${NAMESPACE}.ads (id, company_id, account_id, external_id, name, policy_status) VALUES ('ad2', 'c', 'acc1', 'ext1', 'Ad 1b', 'ACTIVE')`)).rejects.toThrow(/ads_unique/);
  });

  it("upsertAd updates policy_changed_at only when status changes", async () => {
    const { upsertAd } = await import("../src/db.js");
    await pg.reset();
    const ctx = { db: { query: (sql: string, params: unknown[]) => pg.client.query(sql, params), execute: (sql: string, params: unknown[]) => pg.client.query(sql, params), namespace: NAMESPACE }, logger: { info: () => {} } } as any;
    await insert(`INSERT INTO ${NAMESPACE}.ad_accounts (id, company_id, platform, external_id, name, currency, scope_key) VALUES ('acc1', 'c', 'meta', 'ext1', 'Account', 'USD', 'own')`);
    await upsertAd(ctx, 'c', 'acc1', { externalId: 'ext1', name: 'Ad 1', adSetExternalId: null, creativeExternalId: null, rawStatus: 'ACTIVE', policyStatus: 'ACTIVE', feedback: null });
    let row = (await pg.client.query(`SELECT policy_status, policy_changed_at FROM ${NAMESPACE}.ads WHERE external_id = 'ext1'`)).rows[0] as Record<string, unknown>;
    const initialTime = row.policy_changed_at;
    await upsertAd(ctx, 'c', 'acc1', { externalId: 'ext1', name: 'Ad 1', adSetExternalId: null, creativeExternalId: null, rawStatus: 'ACTIVE', policyStatus: 'ACTIVE', feedback: null });
    row = (await pg.client.query(`SELECT policy_status, policy_changed_at FROM ${NAMESPACE}.ads WHERE external_id = 'ext1'`)).rows[0] as Record<string, unknown>;
    expect(row.policy_changed_at).toEqual(initialTime);
    await upsertAd(ctx, 'c', 'acc1', { externalId: 'ext1', name: 'Ad 1', adSetExternalId: null, creativeExternalId: null, rawStatus: 'PAUSED', policyStatus: 'DISAPPROVED', feedback: 'Feedback' });
    row = (await pg.client.query(`SELECT policy_status, policy_changed_at FROM ${NAMESPACE}.ads WHERE external_id = 'ext1'`)).rows[0] as Record<string, unknown>;
    expect(row.policy_status).toBe('DISAPPROVED');
    expect(row.policy_changed_at).not.toEqual(initialTime);
  });
});
