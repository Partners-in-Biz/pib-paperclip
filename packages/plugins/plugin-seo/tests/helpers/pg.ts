/**
 * A real Postgres (embedded-postgres from the monorepo) behind a minimal
 * PluginContext (db, issues.get, logger) that enforces SQL rules for growth tables.
 * Tests that need it skip when embedded-postgres is not installed.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../../src/namespace.js";

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

export interface PgHarness {
  ctx: PluginContext;
  client: PgClient;
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

const GROWTH_TABLES = ["growth_programs", "growth_experiments", "growth_experiment_items"];

export async function startPg(): Promise<PgHarness> {
  const { default: EmbeddedPostgres } = (await import(EMBEDDED)) as { default: new (opts: Record<string, unknown>) => { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>; getPgClient: () => PgClient } };
  const dir = mkdtempSync(join(tmpdir(), "seo-pg-"));
  const port = 5432 + Math.floor(Math.random() * 1000);
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "t", password: "t", port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  await client.query(`CREATE SCHEMA ${NAMESPACE}`);
  const migrations = join(PLUGIN_ROOT, "migrations");
  for (const file of readdirSync(migrations).sort()) {
    const sql = readFileSync(join(migrations, file), "utf8");
    await client.query(sql);
  }
  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: async (sql: string, params: unknown[] = []) => {
        return JSON.parse(JSON.stringify((await client.query(sql, params)).rows));
      },
      execute: async (sql: string, params: unknown[] = []) => {
        return { rowCount: (await client.query(sql, params)).rowCount ?? 0 };
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    issues: { get: async () => null },
  } as unknown as PluginContext;
  return {
    ctx,
    client,
    async reset() {
      for (const name of GROWTH_TABLES) await client.query(`DELETE FROM ${NAMESPACE}.${name}`);
    },
    async stop() {
      await client.end();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
