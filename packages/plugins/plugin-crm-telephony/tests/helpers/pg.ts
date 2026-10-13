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

type PgClient = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect: () => Promise<void>;
  end: () => Promise<void>;
};

export async function embeddedAvailable(): Promise<boolean> {
  try {
    await import(EMBEDDED);
    return true;
  } catch {
    return false;
  }
}

function bindLikeHost(statement: string, params: readonly unknown[]): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const sql = statement.replace(/\$(\d+)/g, (_whole, digits: string) => {
    values.push(params[Number(digits) - 1]);
    return `$${values.length}`;
  });
  return { sql, values };
}

export interface PgDb {
  namespace: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}

export interface PgHarness {
  db: PgDb;
  client: PgClient;
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function startPg(options: { migrations?: string[] } = {}): Promise<PgHarness> {
  const { default: EmbeddedPostgres } = (await import(EMBEDDED)) as {
    default: new (opts: Record<string, unknown>) => {
      initialise: () => Promise<void>;
      start: () => Promise<void>;
      stop: () => Promise<void>;
      getPgClient: () => PgClient;
    };
  };
  const dir = mkdtempSync(join(tmpdir(), "tel-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "t", password: "t", port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  await client.query(`CREATE SCHEMA ${NAMESPACE}`);
  const migrations = join(PLUGIN_ROOT, "migrations");
  for (const file of readdirSync(migrations).sort()) {
    if (options.migrations && !options.migrations.includes(file)) continue;
    const sql = readFileSync(join(migrations, file), "utf8");
    for (const statement of splitSqlStatements(sql)) validateMigrationStatement(statement, NAMESPACE);
    await client.query(sql);
  }
  const db: PgDb = {
    namespace: NAMESPACE,
    async query<T>(sql: string, params: unknown[] = []) {
      validateRuntimeQuery(sql, NAMESPACE);
      validateParams(sql, params);
      const bound = bindLikeHost(sql, params);
      return JSON.parse(JSON.stringify((await client.query(bound.sql, bound.values)).rows)) as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      validateRuntimeExecute(sql, NAMESPACE);
      validateParams(sql, params);
      const bound = bindLikeHost(sql, params);
      return { rowCount: (await client.query(bound.sql, bound.values)).rowCount ?? 0 };
    },
  };
  return {
    db,
    client,
    async reset() {
      const tables = (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = '${NAMESPACE}'`)).rows as Array<{ tablename: string }>;
      if (tables.length > 0) await client.query(`TRUNCATE ${tables.map((row) => `${NAMESPACE}.${row.tablename}`).join(", ")} CASCADE`);
    },
    async stop() {
      await client.end();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
