import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAccount, insertAccount, saveAccount } from "../src/db.js";
import { createAccount } from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";
import { companyEvent } from "../src/sync.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";

describe("migration 013", () => {
  const sql = readFileSync(new URL("../migrations/013_crm.sql", import.meta.url), "utf8");

  it("passes the host migration guard, with no quotes in comments and nothing deleted", () => {
    for (const statement of splitSqlStatements(sql)) expect(() => validateMigrationStatement(statement, NAMESPACE), statement.slice(0, 80)).not.toThrow();
    for (const line of sql.split("\n").filter((row) => row.trim().startsWith("--"))) expect(line).not.toMatch(/['"`]/);
    expect(sql).not.toMatch(/\bdelete\b/i);
    expect(sql).not.toMatch(/^\s*drop\s/im);
  });

  it("only adds the five nullable billing columns to companies, each guarded with IF NOT EXISTS", () => {
    for (const column of ["billing_email", "phone", "address", "vat_number", "registration_number"]) {
      expect(sql, column).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${column} text(,|;)`));
    }
    expect(sql).toContain(`ALTER TABLE ${NAMESPACE}.companies`);
    expect(sql).not.toMatch(/NOT NULL/i);
    expect(sql).not.toMatch(/CREATE TABLE/i);
  });

  it("is the thirteenth migration, in order after the first twelve", () => {
    const files = readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
    expect(files.slice(0, 13)).toEqual(Array.from({ length: 13 }, (_, i) => `${String(i + 1).padStart(3, "0")}_crm.sql`));
  });
});

const available = await embeddedAvailable();

describe.skipIf(!available)("migration 013 on a real Postgres", () => {
  let pg: PgHarness;
  beforeAll(async () => {
    pg = await startPg();
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });

  it("keeps a company written before it, with the billing details empty", async () => {
    const before = await startPg({ upTo: 12 });
    try {
      await before.client.query(`INSERT INTO ${NAMESPACE}.companies (id, company_id, name) VALUES ('old', 'co-1', 'Old Co')`);
      await before.client.query(sql013());
      const row = (await before.client.query(`SELECT name, billing_email, phone, address, vat_number, registration_number FROM ${NAMESPACE}.companies WHERE id = 'old'`)).rows[0];
      expect(row).toEqual({ name: "Old Co", billing_email: null, phone: null, address: null, vat_number: null, registration_number: null });
      // Applying it again changes nothing.
      await expect(before.client.query(sql013())).resolves.toBeDefined();
    } finally {
      await before.stop();
    }
  }, 120_000);

  it("stores, reads back and updates the five fields through the plugin's own queries, and the event carries them", async () => {
    const account = createAccount({
      companyId: "co-1",
      name: "Acme",
      billingEmail: "Accounts@Acme.test",
      phone: "+27 21 555 0100",
      address: "1 Main Rd\nCape Town\n8001",
      vatNumber: "4123456789",
      registrationNumber: "2020/123456/07",
    });
    await insertAccount(pg.ctx, account);
    const read = await getAccount(pg.ctx, account.id);
    expect(read).toMatchObject({ billingEmail: "accounts@acme.test", phone: "+27 21 555 0100", address: "1 Main Rd\nCape Town\n8001", vatNumber: "4123456789", registrationNumber: "2020/123456/07" });

    read!.vatNumber = null;
    read!.phone = "082 000 1111";
    await saveAccount(pg.ctx, read!);
    const row = (await pg.client.query(`SELECT id, name, domain, lifecycle, billing_email, phone, address, vat_number, registration_number, updated_at FROM ${NAMESPACE}.companies WHERE id = $1`, [account.id])).rows[0] as Parameters<typeof companyEvent>[0];
    expect(companyEvent(row).billing).toEqual({
      email: "accounts@acme.test",
      phone: "082 000 1111",
      address: "1 Main Rd\nCape Town\n8001",
      vatNumber: null,
      registrationNumber: "2020/123456/07",
    });
  });
});

function sql013(): string {
  return readFileSync(new URL("../migrations/013_crm.sql", import.meta.url), "utf8");
}
