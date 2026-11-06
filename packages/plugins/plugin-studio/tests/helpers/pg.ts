/**
 * A real Postgres (embedded-postgres from the monorepo) behind the plugin's `ctx.db`, enforcing the host's SQL rules (a copy of
 * server/src/services/plugin-database.ts in `sql-guard.ts`): SQL the host would refuse fails here. The plugin's own migration is applied first.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAMESPACE } from "../../src/namespace.js";
import { freePort } from "./free-port.js";
import { bindLikeHost, validateExecute, validateMigration, validateQuery } from "./sql-guard.js";

const here = fileURLToPath(new URL(".", import.meta.url));
export const PLUGIN_ROOT = join(here, "../..");
const EMBEDDED = join(PLUGIN_ROOT, "../../db/node_modules/embedded-postgres/dist/index.js");
/** The host's own drizzle, so params bind exactly as server/src/services/plugin-database.ts `bindSql` does (a JS array becomes `($n, $n+1)`). */
const DRIZZLE = join(PLUGIN_ROOT, "../../../server/node_modules/drizzle-orm/index.js");
const DRIZZLE_PG = join(PLUGIN_ROOT, "../../../server/node_modules/drizzle-orm/pg-core/index.js");

type DrizzleSql = { raw: (s: string) => unknown; join: (chunks: unknown[], sep: unknown) => unknown } & ((strings: TemplateStringsArray, ...values: unknown[]) => unknown);

/** A copy of the host's `bindSql`, run through the host's drizzle and pg dialect: the real binding path of `ctx.db`. */
export async function hostBinder(): Promise<(statement: string, params?: readonly unknown[]) => { sql: string; values: unknown[] }> {
  const { sql } = (await import(DRIZZLE)) as { sql: DrizzleSql };
  const { PgDialect } = (await import(DRIZZLE_PG)) as { PgDialect: new () => { sqlToQuery: (q: unknown) => { sql: string; params: unknown[] } } };
  const dialect = new PgDialect();
  return (statement, params = []) => {
    bindLikeHost(statement, params.map((p) => (p !== null && typeof p === "object" ? "x" : p))); // placeholder rules only
    if (params.length === 0) return { sql: statement, values: [] };
    const chunks: unknown[] = [];
    let cursor = 0;
    for (const match of statement.matchAll(/\$(\d+)/g)) {
      chunks.push(sql.raw(statement.slice(cursor, match.index)));
      chunks.push(sql`${params[Number(match[1]) - 1]}`);
      cursor = match.index! + match[0].length;
    }
    chunks.push(sql.raw(statement.slice(cursor)));
    const out = dialect.sqlToQuery(sql.join(chunks, sql.raw("")));
    return { sql: out.sql, values: out.params };
  };
}

type PgClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>; connect: () => Promise<void>; end: () => Promise<void> };

export async function embeddedAvailable(): Promise<boolean> {
  try {
    await import(EMBEDDED);
    return true;
  } catch {
    return false;
  }
}

export interface Pg {
  client: PgClient;
  /** The `ctx.db` the plugin sees. */
  db: { namespace: string; query: (sql: string, params?: unknown[]) => Promise<any[]>; execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> };
  statements: string[];
  /** Empties every table of the plugin's namespace. */
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function startPg(opts?: { upTo?: string }): Promise<Pg> {
  const { default: EmbeddedPostgres } = (await import(EMBEDDED)) as { default: new (opts: Record<string, unknown>) => { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>; getPgClient: () => PgClient } };
  const dir = mkdtempSync(join(tmpdir(), "studio-pg-"));
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
    if (opts?.upTo && file.slice(0, 3) > opts.upTo) continue;
    const sql = readFileSync(join(migrations, file), "utf8");
    validateMigration(sql, NAMESPACE, []);
    await client.query(sql);
  }
  const statements: string[] = [];
  const bind = await hostBinder();
  const run = async (sql: string, params: unknown[] = []) => {
    const bound = bind(sql, params);
    statements.push(sql);
    return client.query(bound.sql, bound.values);
  };
  const db: Pg["db"] = {
    namespace: NAMESPACE,
    // Rows cross the host's JSON RPC: dates arrive as ISO strings.
    query: async (sql, params = []) => {
      validateQuery(sql, NAMESPACE, []);
      return JSON.parse(JSON.stringify((await run(sql, params)).rows));
    },
    execute: async (sql, params = []) => {
      validateExecute(sql, NAMESPACE);
      return { rowCount: (await run(sql, params)).rowCount ?? 0 };
    },
  };
  return {
    client,
    db,
    statements,
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
