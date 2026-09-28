/**
 * A real Postgres (embedded-postgres from the monorepo) behind a minimal
 * PluginContext (db, issues.get, logger) that enforces the host's SQL rules,
 * for checking the SQL the fake db cannot run (joins, FILTER, public.issues).
 * Tests that need it skip when embedded-postgres is not installed.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../../src/namespace.js";
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
  /** Issues `ctx.issues.get` returns (also insert them into `public.issues` for SQL joins). */
  issues: Map<string, { id: string; companyId: string; status: string; title?: string; originId?: string | null; assigneeAgentId?: string | null }>;
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

const TABLES = ["reply_log", "campaign_step_events", "campaign_enrollments", "campaign_steps", "campaigns", "suppressions", "outbox", "inbox", "decisions", "crm_contacts", "crm_companies", "campaign_templates"];

export async function startPg(): Promise<PgHarness> {
  const { default: EmbeddedPostgres } = (await import(EMBEDDED)) as { default: new (opts: Record<string, unknown>) => { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>; getPgClient: () => PgClient } };
  const dir = mkdtempSync(join(tmpdir(), "campaigns-pg-"));
  const port = 59000 + Math.floor(Math.random() * 3000);
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "t", password: "t", port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  await client.query(`CREATE SCHEMA ${NAMESPACE}`);
  // The columns of Paperclip's issues table the plugin reads.
  await client.query(`CREATE TABLE public.issues (
    id uuid PRIMARY KEY, company_id uuid NOT NULL, title text NOT NULL DEFAULT 'Issue', status text NOT NULL,
    origin_kind text NOT NULL DEFAULT 'manual', origin_id text, assignee_agent_id uuid, assignee_user_id text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  const migrations = join(PLUGIN_ROOT, "migrations");
  for (const file of readdirSync(migrations).sort()) {
    const sql = readFileSync(join(migrations, file), "utf8");
    for (const statement of splitSqlStatements(sql)) validateMigrationStatement(statement, NAMESPACE);
    await client.query(sql);
  }
  const issues: PgHarness["issues"] = new Map();
  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: async (sql: string, params: unknown[] = []) => {
        validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs", "issues"]);
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
    issues: { get: async (id: string) => issues.get(id) ?? null },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  } as unknown as PluginContext;
  return {
    ctx,
    client,
    issues,
    async reset() {
      for (const name of TABLES) await client.query(`DELETE FROM ${NAMESPACE}.${name}`);
      await client.query("DELETE FROM public.issues");
      issues.clear();
    },
    async stop() {
      await client.end();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
