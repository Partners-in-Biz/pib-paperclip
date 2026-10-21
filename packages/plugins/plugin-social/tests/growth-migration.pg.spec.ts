import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { experimentsScopeAlterMigration } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "../src/namespace.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const EMBEDDED = fileURLToPath(new URL("../../../db/node_modules/embedded-postgres/dist/index.js", import.meta.url));
const FILE = readFileSync(join(MIGRATIONS, "018_social.sql"), "utf8");
const available = await import(EMBEDDED).then(() => true, () => false);

type PgClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; connect: () => Promise<void>; end: () => Promise<void> };
const T = `${NAMESPACE}.growth_programs`;

describe("018_social.sql", () => {
  it("contains the kit scope-alter helper output for this namespace", () => {
    expect(FILE).toContain(experimentsScopeAlterMigration(NAMESPACE).trim());
  });
});

describe.skipIf(!available)("growth scope migration (postgres)", () => {
  let client: PgClient;
  let stop: () => Promise<void>;
  const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
  const oldInsert = (id: string, kind: string | null, ref: string | null, channel = "linkedin") =>
    q(`INSERT INTO ${T} (id, company_id, client_kind, client_ref, channel, objective, metric) VALUES ($1, 'c', $2, $3, $4, 'o', 'm')`, [id, kind, ref, channel]);

  beforeAll(async () => {
    const { default: EmbeddedPostgres } = (await import(EMBEDDED)) as { default: new (o: Record<string, unknown>) => { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>; getPgClient: () => PgClient } };
    const { createServer } = await import("node:net");
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const dir = mkdtempSync(join(tmpdir(), "social-pg-"));
    const pg = new EmbeddedPostgres({ databaseDir: dir, user: "t", password: "t", port, persistent: false, onLog: () => {}, onError: () => {} });
    await pg.initialise();
    await pg.start();
    client = pg.getPgClient();
    await client.connect();
    await client.query(`CREATE SCHEMA ${NAMESPACE}`);
    // Previous head: 001-017, then seed programs as the old code wrote them (no scope_key).
    for (const f of readdirSync(MIGRATIONS).sort().filter((n) => n < "018")) await client.query(readFileSync(join(MIGRATIONS, f), "utf8"));
    await oldInsert("own1", null, null);
    await oldInsert("cli1", "company", "acme");
    await oldInsert("cli2", "contact", "joe");
    await client.query(FILE);
    stop = async () => {
      await client.end();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }, 90_000);
  afterAll(async () => {
    await stop?.();
  });

  it("backfills scope_key for seeded programs both ways and keeps them", async () => {
    const rows = (await q(`SELECT id, scope_key FROM ${T} ORDER BY id`)).rows;
    expect(rows).toEqual([
      { id: "cli1", scope_key: "client:company:acme" },
      { id: "cli2", scope_key: "client:contact:joe" },
      { id: "own1", scope_key: "own" },
    ]);
  });

  it("accepts reviewed autopilot and still rejects unknown values", async () => {
    await q(`INSERT INTO ${T} (id, company_id, channel, objective, metric, autopilot, scope_key) VALUES ('r1', 'c', 'x', 'o', 'm', 'reviewed', 'own')`);
    await expect(q(`INSERT INTO ${T} (id, company_id, channel, objective, metric, autopilot, scope_key) VALUES ('r2', 'c', 'y', 'o', 'm', 'bogus', 'own')`)).rejects.toThrow(/growth_programs_autopilot/);
  });

  it("the old insert (no scope_key) still passes, and a duplicate scope is rejected", async () => {
    await oldInsert("old2", "company", "beta", "x");
    expect((await q(`SELECT scope_key FROM ${T} WHERE id = 'old2'`)).rows).toEqual([{ scope_key: null }]);
    await expect(q(`INSERT INTO ${T} (id, company_id, client_kind, client_ref, channel, objective, metric, scope_key) VALUES ('d1', 'c', 'company', 'zz', 'linkedin', 'o', 'm', 'client:company:acme')`)).rejects.toThrow(/growth_programs_scope_key/);
  });

  it("re-running the file is idempotent", async () => {
    await q(FILE);
  });
});
