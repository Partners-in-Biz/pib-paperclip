/**
 * A real Postgres (embedded-postgres from the monorepo) behind a minimal PluginContext (db, logger) that enforces the host's
 * SQL rules, for checking what the fake db cannot run: the migrations themselves, the counters of the site events, the
 * hash chain of the audit trail and the array lookups. Tests that need it skip when embedded-postgres is not installed.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../../src/namespace.js";
import { freePort } from "./free-port.js";
import { splitSqlStatements, validateMigrationStatement, validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./sql-guard.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN_ROOT = join(here, "../..");
const EMBEDDED = join(PLUGIN_ROOT, "../../db/node_modules/embedded-postgres/dist/index.js");

type PgClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>; connect: () => Promise<void>; end: () => Promise<void> };

export async function embeddedAvailable(): Promise<boolean> {
  try {
    await import(EMBEDDED);
    return true;
  } catch {
    return false;
  }
}

/** The host binds every `$n` occurrence as its own parameter. */
function bindLikeHost(statement: string, params: readonly unknown[]): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const sql = statement.replace(/\$(\d+)/g, (_whole, digits: string) => {
    values.push(params[Number(digits) - 1]);
    return `$${values.length}`;
  });
  return { sql, values };
}

export interface PgHarness {
  ctx: PluginContext;
  client: PgClient;
  /** Applies one migration file again on the same database (an idempotence check is the caller's to make). */
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

/** Starts a database with every migration applied, each statement first checked against the host's migration rules. */
export async function startPg(options: { upTo?: number } = {}): Promise<PgHarness> {
  const { default: EmbeddedPostgres } = (await import(EMBEDDED)) as { default: new (opts: Record<string, unknown>) => { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>; getPgClient: () => PgClient } };
  const dir = mkdtempSync(join(tmpdir(), "crm-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "t", password: "t", port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  await client.query(`CREATE SCHEMA ${NAMESPACE}`);
  // The columns of Paperclip's issues and cost tables the plugin reads (empty: the SQL under test does not need rows in them).
  await client.query(`CREATE TABLE public.issues (id uuid PRIMARY KEY, company_id uuid NOT NULL, title text NOT NULL DEFAULT 'Issue', status text NOT NULL, origin_kind text NOT NULL DEFAULT 'manual', origin_id text, assignee_agent_id uuid, assignee_user_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  const migrations = join(PLUGIN_ROOT, "migrations");
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    if (options.upTo && Number(file.slice(0, 3)) > options.upTo) continue;
    const sql = readFileSync(join(migrations, file), "utf8");
    for (const statement of splitSqlStatements(sql)) validateMigrationStatement(statement, NAMESPACE);
    await client.query(sql);
  }
  // The plugin's own small state store (the per-installation salt lives there): in memory is enough here.
  const stateStore = new Map<string, unknown>();
  const stateKey = (key: unknown) => JSON.stringify(key);
  const ctx = {
    state: { get: async (key: unknown) => stateStore.get(stateKey(key)) ?? null, set: async (key: unknown, value: unknown) => void stateStore.set(stateKey(key), value) },
    db: {
      namespace: NAMESPACE,
      query: async (sql: string, params: unknown[] = []) => {
        validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs", "issues", "cost_events"]);
        validateParams(sql, params);
        const bound = bindLikeHost(sql, params);
        // Rows cross the host's JSON RPC: dates arrive as ISO strings.
        return JSON.parse(JSON.stringify((await client.query(bound.sql, bound.values)).rows));
      },
      execute: async (sql: string, params: unknown[] = []) => {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        const bound = bindLikeHost(sql, params);
        return { rowCount: (await client.query(bound.sql, bound.values)).rowCount ?? 0 };
      },
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  } as unknown as PluginContext;
  return {
    ctx,
    client,
    async reset() {
      const tables = (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = '${NAMESPACE}'`)).rows as Array<{ tablename: string }>;
      for (const row of tables) await client.query(`TRUNCATE ${NAMESPACE}.${row.tablename} CASCADE`);
    },
    async stop() {
      await client.end();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
