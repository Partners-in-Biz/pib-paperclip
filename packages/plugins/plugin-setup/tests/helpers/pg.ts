/**
 * A real Postgres (embedded-postgres from the monorepo) behind the plugin's `ctx.db`, checked by the copy of the
 * host's SQL rules in `sql-guard.ts`: SQL the host would refuse fails here. Every migration is applied first.
 * Under CI a missing embedded Postgres is an error, not a skip (PAR-10373).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAMESPACE } from "../../src/namespace.js";
import { freePort } from "./free-port.js";
import { splitSqlStatements, validateMigrationStatement, validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./sql-guard.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN_ROOT = join(here, "../..");
const EMBEDDED = join(PLUGIN_ROOT, "../../db/node_modules/embedded-postgres/dist/index.js");

type PgClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>; connect: () => Promise<void>; end: () => Promise<void> };

/** True when the specs can start a database. Throws under CI instead of returning false. */
export async function embeddedAvailable(): Promise<boolean> {
  // Postgres refuses to start as root (the VPS deploy gate runs as root, PAR-9309).
  const reason = process.getuid?.() === 0 ? "running as root" : await import(EMBEDDED).then(() => null, (error: unknown) => String(error));
  if (reason && process.env.CI) throw new Error(`Database specs must run under CI, but embedded Postgres is not usable: ${reason}`);
  return reason === null;
}

export interface Pg {
  client: PgClient;
  /** The `ctx.db` the plugin sees. */
  db: { namespace: string; query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>; execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> };
  /** Empties every table of the plugin's namespace. */
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * `coreReadTables`: the core tables the guard lets a query read, as the manifest's
 * `database.coreReadTables` does on the host. The test creates them itself.
 */
export async function startPg(opts: { coreReadTables?: string[] } = {}): Promise<Pg> {
  const { default: EmbeddedPostgres } = (await import(EMBEDDED)) as { default: new (opts: Record<string, unknown>) => { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>; getPgClient: () => PgClient } };
  const dir = mkdtempSync(join(tmpdir(), "setup-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "t", password: "t", port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  await client.query(`CREATE SCHEMA ${NAMESPACE}`);
  const migrations = join(PLUGIN_ROOT, "migrations");
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrations, file), "utf8");
    for (const statement of splitSqlStatements(sql)) validateMigrationStatement(statement, NAMESPACE);
    await client.query(sql);
  }
  const db: Pg["db"] = {
    namespace: NAMESPACE,
    // Rows cross the host's JSON RPC: dates arrive as ISO strings.
    query: async (sql, params = []) => {
      validateRuntimeQuery(sql, NAMESPACE, opts.coreReadTables);
      validateParams(sql, params);
      return JSON.parse(JSON.stringify((await client.query(sql, params)).rows));
    },
    execute: async (sql, params = []) => {
      validateRuntimeExecute(sql, NAMESPACE);
      validateParams(sql, params);
      return { rowCount: (await client.query(sql, params)).rowCount ?? 0 };
    },
  };
  return {
    client,
    db,
    async reset() {
      const tables = (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${NAMESPACE}'`)).rows as Array<{ table_name: string }>;
      if (tables.length) await client.query(`TRUNCATE ${tables.map((t) => `${NAMESPACE}.${t.table_name}`).join(", ")} CASCADE`);
    },
    async stop() {
      await client.end();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
