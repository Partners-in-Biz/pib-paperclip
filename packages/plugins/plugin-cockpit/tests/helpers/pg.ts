/**
 * A real Postgres (embedded-postgres from the monorepo) behind a minimal
 * PluginContext that enforces the host's SQL rules (one statement, SELECT
 * for query, namespace-only writes, scalar params bound per placeholder).
 * Tests that need it skip when embedded-postgres is not installed.
 */
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Env } from "../../src/env.js";
import { NAMESPACE } from "../../src/namespace.js";
import { splitSqlStatements, validateMigrationStatement, validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./sql-guard.js";
import { freePort } from "./free-port.js";

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

/** Like the host: each `$n` occurrence is its own bound value. */
function bindLikeHost(statement: string, params: readonly unknown[]): { sql: string; values: unknown[] } {
  if (params.length === 0) return { sql: statement, values: [] };
  const values: unknown[] = [];
  const sql = statement.replace(/\$(\d+)/g, (_whole, digits: string) => {
    values.push(params[Number(digits) - 1]);
    return `$${values.length}`;
  });
  return { sql, values };
}

/**
 * With COCKPIT_SQL_DUMP=<file>, every runtime statement the tests run is
 * appended there (one JSON line each), so the host's REAL guard can be run over
 * them outside the test run (the guard here is a replica).
 */
function dumpSql(kind: "query" | "execute", sql: string): void {
  const file = process.env.COCKPIT_SQL_DUMP;
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ kind, sql })}\n`);
  } catch {
    // diagnostics only
  }
}

export interface FakeIssueRow {
  id: string;
  companyId: string;
  identifier: string;
  title: string;
  description?: string;
  originKind?: string | null;
  parentId?: string | null;
}

export interface FakeComment {
  id: string;
  companyId: string;
  issueId: string;
  body: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdByRunId?: string | null;
  deletedAt?: string | null;
}

export interface PgHarness {
  ctx: PluginContext;
  env: Env;
  client: PgClient;
  issues: Map<string, FakeIssueRow>;
  comments: FakeComment[];
  config: Map<string, Record<string, unknown>>;
  statements: string[];
  clock: { now: Date };
  fetchCalls: Array<{ state: unknown; questions: Record<string, unknown> }>;
  setJev: (fn: ((state: any, questions: Record<string, any>) => Record<string, any> | null) | null) => void;
  addIssue: (row: Omit<FakeIssueRow, "companyId"> & { companyId?: string }) => FakeIssueRow;
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

export const COMPANY = "11111111-1111-1111-1111-111111111111";
export const OTHER_COMPANY = "22222222-2222-2222-2222-222222222222";

export async function startPg(): Promise<PgHarness> {
  const { default: EmbeddedPostgres } = (await import(EMBEDDED)) as { default: new (opts: Record<string, unknown>) => { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>; getPgClient: () => PgClient } };
  const dir = mkdtempSync(join(tmpdir(), "cockpit-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "t", password: "t", port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  await client.query(`CREATE SCHEMA ${NAMESPACE}`);
  // Stand-in for the host's core table the Cockpit may read.
  await client.query(
    `CREATE TABLE public.heartbeat_runs (id uuid PRIMARY KEY, company_id uuid NOT NULL, agent_id uuid NOT NULL, status text NOT NULL, started_at timestamptz, finished_at timestamptz, error text, error_code text, context_snapshot jsonb, retry_of_run_id uuid, usage_json jsonb, continuation_attempt integer)`,
  );
  // The core issue columns the operations watch reads (watch.ts), and the blocker relations.
  await client.query(
    `CREATE TABLE public.issues (id uuid PRIMARY KEY, company_id uuid NOT NULL, identifier text, title text NOT NULL DEFAULT '', description text, status text NOT NULL, hidden_at timestamptz, assignee_agent_id uuid, assignee_user_id text, blocked_transition_at timestamptz, unblock_descriptor jsonb, priority text, origin_kind text, origin_id text, project_id uuid, parent_id uuid, completed_at timestamptz, started_at timestamptz, execution_policy jsonb, execution_state jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
  );
  await client.query(`CREATE TABLE public.projects (id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL, status text NOT NULL DEFAULT 'backlog', archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
  await client.query(`CREATE TABLE public.issue_relations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, issue_id uuid NOT NULL, related_issue_id uuid NOT NULL, type text NOT NULL DEFAULT 'blocks')`);
  for (const file of readdirSync(join(PLUGIN_ROOT, "migrations")).sort()) {
    const sql = readFileSync(join(PLUGIN_ROOT, "migrations", file), "utf8");
    for (const statement of splitSqlStatements(sql)) validateMigrationStatement(statement, NAMESPACE);
    await client.query(sql);
  }

  const issues = new Map<string, FakeIssueRow>();
  const comments: FakeComment[] = [];
  const config = new Map<string, Record<string, unknown>>();
  const statements: string[] = [];
  const state = new Map<string, unknown>();
  const clock = { now: new Date() };
  const fetchCalls: PgHarness["fetchCalls"] = [];
  let jev: ((state: any, questions: Record<string, any>) => Record<string, any> | null) | null = null;

  const run = async (sql: string, params: unknown[] = []) => {
    validateParams(sql, params);
    const bound = bindLikeHost(sql, params);
    statements.push(sql);
    return client.query(bound.sql, bound.values);
  };

  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: async (sql: string, params: unknown[] = []) => {
        dumpSql("query", sql);
        validateRuntimeQuery(sql, NAMESPACE, ["issues", "heartbeat_runs", "issue_relations", "projects"]);
        return JSON.parse(JSON.stringify((await run(sql, params)).rows));
      },
      execute: async (sql: string, params: unknown[] = []) => {
        dumpSql("execute", sql);
        validateRuntimeExecute(sql, NAMESPACE);
        return { rowCount: (await run(sql, params)).rowCount ?? 0 };
      },
    },
    issues: {
      get: async (ref: string, companyId: string) => {
        const row = issues.get(ref) ?? [...issues.values()].find((i) => i.identifier === ref) ?? null;
        return row && row.companyId === companyId ? { ...row } : null;
      },
      listComments: async (issueId: string, companyId: string) => comments.filter((c) => c.issueId === issueId && c.companyId === companyId).map((c) => ({ ...c })),
    },
    config: { get: async (companyId: string) => config.get(companyId) ?? {} },
    secrets: { resolve: async (ref: { secretId: string }) => `secret-${ref.secretId}` },
    state: {
      get: async (key: { stateKey: string; scopeId?: string; namespace?: string }) => state.get(`${key.scopeId ?? ""}:${key.namespace ?? ""}:${key.stateKey}`) ?? null,
      set: async (key: { stateKey: string; scopeId?: string; namespace?: string }, value: unknown) => {
        state.set(`${key.scopeId ?? ""}:${key.namespace ?? ""}:${key.stateKey}`, value);
      },
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  } as unknown as PluginContext;

  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { state: unknown; questions: Record<string, unknown> };
    fetchCalls.push({ state: body.state, questions: body.questions });
    const answers = jev ? jev(body.state, body.questions) : null;
    if (!answers) return new Response("down", { status: 503 });
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 1234 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const env: Env = {
    ctx,
    skills: { ensure: async () => [], force: async () => [] },
    now: () => clock.now,
    fetchImpl,
  };

  let seq = 0;
  return {
    ctx,
    env,
    client,
    issues,
    comments,
    config,
    statements,
    clock,
    fetchCalls,
    setJev: (fn) => {
      jev = fn;
    },
    addIssue: (row) => {
      seq += 1;
      const full: FakeIssueRow = { companyId: COMPANY, description: "", originKind: null, parentId: null, ...row, id: row.id ?? `issue-${seq}` };
      issues.set(full.id, full);
      return full;
    },
    async reset() {
      for (const table of ["memory_feedback", "memory_briefs", "memory_facts", "crm_companies", "crm_contacts", "asks", "activity", "onboarding", "health_warnings", "company_profile", "attestations", "client_revenue", "closeout_reviews", "improvements", "goals", "goal_values", "business_reviews", "credentials", "roles", "health_issues", "brief_issues", "snapshots", "acceptance_runs", "acceptance_requests", "plugin_versions", "eval_results"]) await client.query(`DELETE FROM ${NAMESPACE}.${table}`);
      await client.query("DELETE FROM public.heartbeat_runs");
      await client.query("DELETE FROM public.issue_relations");
      await client.query("DELETE FROM public.issues");
      await client.query("DELETE FROM public.projects");
      issues.clear();
      comments.length = 0;
      config.clear();
      fetchCalls.length = 0;
      jev = null;
      clock.now = new Date();
    },
    async stop() {
      await client.end();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
