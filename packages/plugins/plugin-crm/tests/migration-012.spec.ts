import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";

describe("migration 012", () => {
  const sql = readFileSync(new URL("../migrations/012_crm.sql", import.meta.url), "utf8");

  it("passes the host migration guard, with no quotes in comments and nothing deleted", () => {
    for (const statement of splitSqlStatements(sql)) expect(() => validateMigrationStatement(statement, NAMESPACE), statement.slice(0, 80)).not.toThrow();
    for (const line of sql.split("\n").filter((row) => row.trim().startsWith("--"))) expect(line).not.toMatch(/['"`]/);
    expect(sql).not.toMatch(/\bdelete\b/i);
    expect(sql).not.toMatch(/^\s*drop\s/im);
  });

  it("makes the e-sign, site event and attribution tables, each scoped by company", () => {
    const tables = ["sign_documents", "sign_tokens", "sign_events", "esign_clients", "public_hits", "event_keys", "site_event_daily", "revenue_events", "channel_costs"];
    for (const table of tables) {
      expect(sql, table).toContain(`CREATE TABLE ${NAMESPACE}.${table} (`);
      if (table !== "public_hits") expect(sql.slice(sql.indexOf(`CREATE TABLE ${NAMESPACE}.${table} (`)).split(");")[0]!, table).toMatch(/company_id text NOT NULL/);
    }
    // A token is stored only as a hash, a page id and a write key are unique, one audit row per sequence number.
    expect(sql).toContain("token_hash text PRIMARY KEY");
    expect(sql).not.toMatch(/\btoken text\b/);
    expect(sql).toContain("sign_documents_page ON " + NAMESPACE + ".sign_documents (page_id)");
    expect(sql).toContain("sign_events_seq ON " + NAMESPACE + ".sign_events (doc_id, seq)");
    expect(sql).toContain("event_keys_write_key ON " + NAMESPACE + ".event_keys (write_key)");
    // No raw event table: only the compact daily rollup.
    expect(sql).not.toMatch(/CREATE TABLE \S+\.(raw_events|site_events)\b/);
  });

  it("is numbered after the first eleven, with no gap in the first twelve", () => {
    const files = readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
    expect(files.slice(0, 12)).toEqual(Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(3, "0")}_crm.sql`));
  });
});

const available = await embeddedAvailable();

describe.skipIf(!available)("migration 012 on a real Postgres", () => {
  let pg: PgHarness;
  beforeAll(async () => {
    pg = await startPg();
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });

  it("applies on top of the first eleven, and the new approval kinds are allowed while an old wrong one is not", async () => {
    const insert = (kind: string, id: string) =>
      pg.client.query(`INSERT INTO ${NAMESPACE}.care_approvals (id, company_id, kind, subject_id) VALUES ($1, 'co-1', $2, $1)`, [id, kind]);
    for (const [index, kind] of ["client_action", "erasure", "esign_request", "esign_reminder", "esign_copy"].entries()) await insert(kind, `a-${index}`);
    await expect(insert("something_else", "a-bad")).rejects.toThrow(/care_approvals_kind/);
  });

  it("keeps the old client_leads rows and gives them the outcome new", async () => {
    await pg.client.query(`INSERT INTO ${NAMESPACE}.client_leads (id, key, company_id, client_kind, client_ref, source) VALUES ('l1', 'k1', 'co-1', 'company', 'c1', 'form')`);
    const row = (await pg.client.query(`SELECT outcome, value_minor FROM ${NAMESPACE}.client_leads WHERE id = 'l1'`)).rows[0] as { outcome: string; value_minor: unknown };
    expect(row.outcome).toBe("new");
    expect(row.value_minor).toBeNull();
    await expect(pg.client.query(`UPDATE ${NAMESPACE}.client_leads SET outcome = 'bogus' WHERE id = 'l1'`)).rejects.toThrow(/client_leads_outcome/);
  });

  it("refuses a second document with the same page id, a second audit row with the same sequence, and a bad status", async () => {
    const doc = (id: string, page: string, status = "draft") =>
      pg.client.query(`INSERT INTO ${NAMESPACE}.sign_documents (id, company_id, client_kind, client_ref, kind, title, content, content_sha256, consent_text, consent_sha256, page_id, status) VALUES ($1, 'co-1', 'company', 'c1', 'proposal', 'T', 'x', 'h', 'c', 'h', $2, $3)`, [id, page, status]);
    await doc("d1", "page-1");
    await expect(doc("d2", "page-1")).rejects.toThrow(/sign_documents_page/);
    await expect(doc("d3", "page-3", "signed-ish")).rejects.toThrow(/sign_documents_status/);
    const event = (id: string, seq: number) =>
      pg.client.query(`INSERT INTO ${NAMESPACE}.sign_events (id, company_id, doc_id, seq, kind, actor, prev_hash, hash, at) VALUES ($1, 'co-1', 'd1', $2, 'created', 'system', 'p', 'h', 'now')`, [id, seq]);
    await event("e1", 1);
    await expect(event("e2", 1)).rejects.toThrow(/sign_events_seq/);
  });
});
