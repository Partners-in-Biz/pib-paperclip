import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const migrationFile = "0449_member_restriction.sql";

describe("member restriction migration database support", () => {
  it.runIf(Boolean(process.env.CI))("runs its database tests under CI", () => {
    expect(support.supported).toBe(true);
  });
});

(support.supported ? describe : describe.skip)("member restriction migration (AC-F1)", () => {
  it("defaults existing rows to unrestricted and mode off, and old code still inserts and reads", async () => {
    const database = await startEmbeddedPostgresTestDatabase("member-restriction-migration-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      // Undo the migration (the documented undo), then write rows as before it.
      await sql.unsafe(`ALTER TABLE "companies" DROP CONSTRAINT "companies_member_restriction_mode_check";
        ALTER TABLE "companies" DROP COLUMN "member_restriction_mode";
        ALTER TABLE "company_memberships" DROP COLUMN "restricted", DROP COLUMN "restricted_plugin_keys", DROP COLUMN "restricted_agent_ids";`);
      const [existing] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Existing', 'MR1') RETURNING id`;
      await sql`INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
        VALUES (${existing!.id}, 'user', 'user-existing', 'active', 'operator'),
               (${existing!.id}, 'user', 'user-suspended', 'suspended', 'viewer')`;

      const content = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      await applyPendingMigrations(database.connectionString);

      expect(await sql`SELECT member_restriction_mode FROM companies`).toEqual([{ member_restriction_mode: "off" }]);
      expect(await sql`SELECT restricted, restricted_plugin_keys, restricted_agent_ids FROM company_memberships`).toEqual([
        { restricted: false, restricted_plugin_keys: [], restricted_agent_ids: [] },
        { restricted: false, restricted_plugin_keys: [], restricted_agent_ids: [] },
      ]);

      // Code from before the change names only the columns it knows.
      const [company] = await sql`INSERT INTO companies (name, issue_prefix, status) VALUES ('Old code', 'MR2', 'active')
        RETURNING id, name, issue_prefix, status`;
      const [membership] = await sql`INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
        VALUES (${company!.id}, 'user', 'user-old', 'active', 'owner')
        RETURNING id, company_id, principal_type, principal_id, status, membership_role`;
      expect(await sql`SELECT id, name, issue_prefix, status FROM companies WHERE id = ${company!.id}`).toEqual([company]);
      expect(await sql`SELECT id, company_id, principal_type, principal_id, status, membership_role
        FROM company_memberships WHERE id = ${membership!.id}`).toEqual([membership]);

      await expect(sql`UPDATE companies SET member_restriction_mode = 'audit' WHERE id = ${company!.id}`).rejects.toThrow(
        /companies_member_restriction_mode_check/,
      );
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 90_000);
});
