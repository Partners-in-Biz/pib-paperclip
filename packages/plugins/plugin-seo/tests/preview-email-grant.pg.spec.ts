/**
 * 0.47.1 (PAR-10129): migration 029 gives the preview service's role pib_preview the grants DECISION_SQL needs, so a client's Approve
 * on the email link is recorded instead of failing with a 500. Runs the real migrations and DECISION_SQL as that role on embedded
 * Postgres. Skipped where embedded Postgres is not available.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { DECISION_SQL } from "../ops/preview-server/decision.mjs";

const requireFromDb = createRequire(new URL("../../../db/package.json", import.meta.url));
type Postgres = (url: string, o?: Record<string, unknown>) => any;
type EmbeddedDbHelper = {
  getEmbeddedPostgresTestSupport(): Promise<{ supported: boolean }>;
  startEmbeddedPostgresTestDatabase(prefix: string): Promise<{ connectionString: string; cleanup(): Promise<void> }>;
};
let postgres: Postgres = (() => { throw new Error("postgres is not installed"); }) as never;
let getEmbeddedPostgresTestSupport: EmbeddedDbHelper["getEmbeddedPostgresTestSupport"] = async () => ({ supported: false });
let startEmbeddedPostgresTestDatabase: EmbeddedDbHelper["startEmbeddedPostgresTestDatabase"] = async () => { throw new Error("embedded postgres is not available"); };
try {
  postgres = requireFromDb("postgres") as Postgres;
  const dbHelperPath = new URL("../../../db/src/test-embedded-postgres.ts", import.meta.url).pathname;
  ({ getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } = (await import(/* @vite-ignore */ dbHelperPath)) as EmbeddedDbHelper);
} catch {
  // keep the skipping stubs
}
const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const MIGRATIONS = join(import.meta.dirname, "../migrations");

describePg("migration 029: pib_preview can record a client's email answer", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let sql: any;

  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("seo-email-grant-");
    sql = postgres(pg.connectionString, { max: 1, onnotice: () => undefined });
    await sql.unsafe("DROP ROLE IF EXISTS pib_preview");
    await sql.unsafe("CREATE ROLE pib_preview NOLOGIN");
    await sql.unsafe(`CREATE SCHEMA ${NAMESPACE}`);
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) await sql.unsafe(readFileSync(join(MIGRATIONS, f), "utf8"));
    await sql.unsafe(`ALTER TABLE ${NAMESPACE}.previews DROP CONSTRAINT previews_sprint_id_fkey`);
    await sql.unsafe(
      `INSERT INTO ${NAMESPACE}.previews (id, company_id, sprint_id, page_url, title, html, expires_at, status, review_status) VALUES ('p1', 'co-1', 'sp-0', 'https://acme.co.za/', 'T', '<html/>', now() + interval '1 day', 'pending', 'passed')`,
    );
  });

  afterAll(async () => {
    await sql?.end();
    await pg?.cleanup();
    // role is cluster-wide on the embedded instance, which is thrown away with pg.cleanup()
  });

  it("an Approve as pib_preview updates the row (no permission error)", async () => {
    await sql.unsafe("SET ROLE pib_preview");
    try {
      expect((await sql.unsafe(DECISION_SQL, ["p1", "approved", "Looks good"])).count).toBe(1);
    } finally {
      await sql.unsafe("RESET ROLE");
    }
    const [row] = await sql.unsafe(`SELECT status, decision_source, decided_by FROM ${NAMESPACE}.previews WHERE id = 'p1'`);
    expect(row).toMatchObject({ status: "approved", decision_source: "email", decided_by: "client:email-link" });
  });

  it("the role still cannot change anything else", async () => {
    await sql.unsafe("SET ROLE pib_preview");
    try {
      await expect(sql.unsafe(`UPDATE ${NAMESPACE}.previews SET html = 'x' WHERE id = 'p1'`)).rejects.toThrow(/permission denied/);
    } finally {
      await sql.unsafe("RESET ROLE");
    }
  });
});
