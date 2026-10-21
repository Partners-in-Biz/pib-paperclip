import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { experimentsMigration } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "../src/namespace.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "migrations");
const EMBEDDED = join(ROOT, "../../db/node_modules/embedded-postgres/dist/index.js");
const GROWTH_FILE = "024_seo.sql";
const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf8");
const files = readdirSync(MIGRATIONS).sort();

type Client = { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>; connect: () => Promise<void>; end: () => Promise<void> };
let embedded = true;
try {
  await import(EMBEDDED);
} catch {
  embedded = false;
}

describe("migration 024 text", () => {
  it("contains the kit v2 helper output for our namespace", () => {
    expect(read(GROWTH_FILE)).toContain(experimentsMigration(NAMESPACE).trim());
  });

  it("adds playbook_ref and drops nothing", () => {
    const sql = read(GROWTH_FILE);
    expect(sql).toContain(`ALTER TABLE ${NAMESPACE}.growth_programs ADD COLUMN IF NOT EXISTS playbook_ref text`);
    expect(sql).not.toMatch(/^\s*(DROP|TRUNCATE)\b/im);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("leaves 013 untouched and 024 is the head", () => {
    expect(files[files.length - 1]).toBe(GROWTH_FILE);
    expect(read("013_seo.sql")).toContain(`CREATE TABLE ${NAMESPACE}.playbooks (`);
    expect(read("013_seo.sql")).not.toContain("growth_");
  });
});

describe.skipIf(!embedded)("migration 024 on Postgres", () => {
  let stop: () => Promise<void>;
  let client: Client;

  async function fresh(name: string): Promise<void> {
    await client.query(`DROP SCHEMA IF EXISTS ${NAMESPACE} CASCADE`);
    await client.query(`CREATE SCHEMA ${NAMESPACE}`);
    void name;
  }

  beforeAll(async () => {
    const { default: Pg } = (await import(EMBEDDED)) as { default: new (o: Record<string, unknown>) => { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>; getPgClient: () => Client } };
    const { createServer } = await import("node:net");
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
      s.on("error", reject);
    });
    const dir = mkdtempSync(join(tmpdir(), "seo-growth-pg-"));
    const pg = new Pg({ databaseDir: dir, user: "t", password: "t", port, persistent: false, onLog: () => {}, onError: () => {} });
    await pg.initialise();
    await pg.start();
    client = pg.getPgClient();
    await client.connect();
    stop = async () => {
      await client.end();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }, 120_000);

  afterAll(async () => {
    if (stop) await stop();
  });

  it("applies on a fresh schema, with the whole chain 001-024", async () => {
    await fresh("fresh");
    for (const f of files) await client.query(read(f));
    const cols = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'growth_programs'`, [NAMESPACE])).rows as Array<{ column_name: string }>;
    const names = cols.map((c) => c.column_name);
    expect(names).toEqual(expect.arrayContaining(["scope_key", "project_id", "owner_user_id", "playbook_ref"]));
  });

  it("applies over the previous head (023) with seeded rows and keeps them", async () => {
    await fresh("upgrade");
    for (const f of files.filter((x) => x !== GROWTH_FILE)) await client.query(read(f));
    await client.query(
      `INSERT INTO ${NAMESPACE}.playbooks (id, company_id, scope_key, playbook) VALUES ('pb1', 'co', 'own', '# Own playbook')`,
    );
    await client.query(read(GROWTH_FILE));

    const kept = (await client.query(`SELECT playbook, version FROM ${NAMESPACE}.playbooks WHERE id = 'pb1'`)).rows as Array<{ playbook: string; version: number }>;
    expect(kept).toEqual([{ playbook: "# Own playbook", version: 1 }]);

    await client.query(
      `INSERT INTO ${NAMESPACE}.growth_programs (id, company_id, channel, objective, metric, scope_key, playbook_ref) VALUES ('gp1', 'co', 'seo', 'o', 'm', 'own', 'pb1')`,
    );
    const ref = (await client.query(`SELECT p.playbook_ref, b.playbook FROM ${NAMESPACE}.growth_programs p JOIN ${NAMESPACE}.playbooks b ON b.id = p.playbook_ref`)).rows as Array<{ playbook_ref: string; playbook: string }>;
    expect(ref).toEqual([{ playbook_ref: "pb1", playbook: "# Own playbook" }]);
  });
});
