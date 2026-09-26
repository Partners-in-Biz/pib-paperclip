/**
 * A real Postgres (embedded-postgres from the monorepo) behind a fake
 * PluginContext that enforces the host's SQL rules. Tests that need it skip
 * when embedded-postgres is not installed.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../../src/namespace.js";
import { bindLikeHost, validateExecute, validateMigration, validateQuery } from "./sql-guard.js";

const here = fileURLToPath(new URL(".", import.meta.url));
/** Plugin root (overridable so scratch scripts that bundle this file still find it). */
const PLUGIN_ROOT = process.env.BILLING_PLUGIN_ROOT ?? join(here, "../..");
const EMBEDDED = join(PLUGIN_ROOT, "../../db/node_modules/embedded-postgres/dist/index.js");

type PgClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>; connect: () => Promise<void>; end: () => Promise<void> };

export interface Harness {
  ctx: PluginContext;
  client: PgClient;
  emitted: Array<{ name: string; companyId: string; payload: unknown }>;
  issues: Map<string, { id: string; companyId: string; title: string; description?: string; status: string; assigneeUserId?: string | null; originId?: string | null }>;
  handlers: Map<string, Array<(event: PluginEvent) => Promise<void>>>;
  config: Map<string, Record<string, unknown>>;
  statements: string[];
  actions: Map<string, (params: Record<string, unknown>, context: unknown) => Promise<unknown>>;
  tools: Map<string, (params: unknown, run: unknown) => Promise<unknown>>;
  jobs: Map<string, (job: unknown) => Promise<void>>;
  call: <T = any>(action: string, params?: Record<string, unknown>, context?: unknown) => Promise<T>;
  runJob: (key: string) => Promise<void>;
  reset: () => Promise<void>;
  stop: () => Promise<void>;
  deliver: (name: string, companyId: string, payload: unknown, extra?: Partial<PluginEvent>) => Promise<void>;
}

export async function embeddedAvailable(): Promise<boolean> {
  try {
    await import(EMBEDDED);
    return true;
  } catch {
    return false;
  }
}

const TABLES_IN_ORDER = [
  "credit_applications", "payments", "credit_notes", "reminders", "pops", "invoice_lines", "invoice_grants", "recurring_invoices",
  "time_entries", "subscriptions", "retainer_plans", "bill_payments", "bill_lines", "bills", "quote_lines", "quotes", "invoices",
  "expenses", "numbering_counters", "number_claims", "client_prefixes", "outbox", "inbox", "decisions", "deliveries",
  "decision_issues", "fx_rates", "dunning_optouts", "crm_companies", "crm_contacts",
];

export async function startHarness(): Promise<Harness> {
  const { default: EmbeddedPostgres } = (await import(EMBEDDED)) as { default: new (opts: Record<string, unknown>) => { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>; getPgClient: () => PgClient } };
  const dir = mkdtempSync(join(tmpdir(), "billing-pg-"));
  const port = 56000 + Math.floor(Math.random() * 3000);
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
    validateMigration(sql, NAMESPACE, ["issues"]);
    await client.query(sql);
  }

  const emitted: Harness["emitted"] = [];
  const issues: Harness["issues"] = new Map();
  const handlers: Harness["handlers"] = new Map();
  const config: Harness["config"] = new Map();
  const statements: string[] = [];
  const state = new Map<string, unknown>();
  const actions: Harness["actions"] = new Map();
  const tools: Harness["tools"] = new Map();
  const jobs: Harness["jobs"] = new Map();
  let issueSeq = 0;

  const run = async (sql: string, params: unknown[] = []) => {
    const bound = bindLikeHost(sql, params);
    statements.push(sql);
    return client.query(bound.sql, bound.values);
  };

  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: async (sql: string, params: unknown[] = []) => {
        validateQuery(sql, NAMESPACE, ["issues"]);
        // Rows cross the host's JSON RPC: dates arrive as ISO strings.
        return JSON.parse(JSON.stringify((await run(sql, params)).rows));
      },
      execute: async (sql: string, params: unknown[] = []) => {
        validateExecute(sql, NAMESPACE);
        return { rowCount: (await run(sql, params)).rowCount ?? 0 };
      },
    },
    events: {
      emit: async (name: string, companyId: string, payload: unknown) => {
        emitted.push({ name, companyId, payload: JSON.parse(JSON.stringify(payload)) });
      },
      on: (name: string, fn: (event: PluginEvent) => Promise<void>) => {
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
        return () => undefined;
      },
    },
    issues: {
      create: async (input: { companyId: string; title: string; description?: string; status?: string; assigneeUserId?: string | null; originId?: string | null }) => {
        issueSeq += 1;
        const issue = { id: `issue-${issueSeq}`, companyId: input.companyId, title: input.title, description: input.description, status: input.status ?? "todo", assigneeUserId: input.assigneeUserId ?? null, originId: input.originId ?? null, identifier: `PIB-${issueSeq}` };
        issues.set(issue.id, issue);
        return issue;
      },
      get: async (id: string) => issues.get(id) ?? null,
      update: async (id: string, patch: { status?: string }) => {
        const issue = issues.get(id);
        if (!issue) throw new Error("no issue");
        Object.assign(issue, patch);
        return issue;
      },
      requestWakeup: async () => ({ queued: true }),
    },
    config: { get: async (companyId: string) => config.get(companyId) ?? {} },
    secrets: { resolve: async (ref: { secretId: string }) => `secret-${ref.secretId}` },
    state: {
      get: async (key: { stateKey: string }) => state.get(key.stateKey) ?? null,
      set: async (key: { stateKey: string }, value: unknown) => {
        state.set(key.stateKey, value);
      },
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    actions: { register: (key: string, fn: (params: Record<string, unknown>, context: unknown) => Promise<unknown>) => actions.set(key, fn) },
    tools: { register: (name: string, _decl: unknown, fn: (params: unknown, run: unknown) => Promise<unknown>) => tools.set(name, fn) },
    jobs: { register: (key: string, fn: (job: unknown) => Promise<void>) => jobs.set(key, fn) },
    skills: { managed: { reconcile: async () => ({}), reset: async () => ({}) } },
  } as unknown as PluginContext;

  return {
    ctx,
    client,
    emitted,
    issues,
    handlers,
    config,
    statements,
    actions,
    tools,
    jobs,
    async call(action, params = {}, context = userContext()) {
      const fn = actions.get(action);
      if (!fn) throw new Error(`No action ${action}`);
      return (await fn(params, context)) as never;
    },
    async runJob(key) {
      const fn = jobs.get(key);
      if (!fn) throw new Error(`No job ${key}`);
      await fn({ jobKey: key, runId: "run", trigger: "manual", scheduledAt: new Date().toISOString() });
    },
    async reset() {
      for (const name of TABLES_IN_ORDER) await client.query(`DELETE FROM ${NAMESPACE}.${name}`);
      emitted.length = 0;
      issues.clear();
      config.clear();
    },
    async stop() {
      await client.end();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
    async deliver(name, companyId, payload, extra = {}) {
      for (const fn of handlers.get(name) ?? []) {
        await fn({ eventId: `evt-${Math.random()}`, eventType: name as PluginEvent["eventType"], occurredAt: new Date().toISOString(), companyId, payload, ...extra });
      }
    },
  };
}

export const COMPANY = "11111111-1111-1111-1111-111111111111";

export const SETTINGS = {
  defaultCurrency: "ZAR",
  defaultTaxRate: 15,
  defaultTaxCode: "za_std_15",
  defaultDueDays: 14,
  sender: { name: "Partners in Biz", vatNumber: "4123456789", email: "billing@pib.test" },
  payment: { bankName: "FNB", accountName: "PiB", accountNumber: "62000000000", branchCode: "250655" },
  email: { enabled: true },
  ledger: { enabled: true },
};

export async function seedClient(h: Harness, input: { id: string; name: string; email?: string; kind?: "company" | "contact" }) {
  if ((input.kind ?? "contact") === "contact") {
    await h.client.query(
      `INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, emails, updated_at) VALUES ($1, $2, $3, $4, now())`,
      [input.id, COMPANY, input.name, input.email ? [input.email] : []],
    );
  } else {
    await h.client.query(`INSERT INTO ${NAMESPACE}.crm_companies (id, company_id, name, updated_at) VALUES ($1, $2, $3, now())`, [input.id, COMPANY, input.name]);
  }
}

export function userContext(companyId = COMPANY) {
  return { companyId, actor: { type: "user" as const, userId: "user-1", agentId: null, runId: null, companyId } };
}

export function agentContext(companyId = COMPANY) {
  return { companyId, actor: { type: "agent" as const, userId: null, agentId: "agent-1", runId: "run-1", companyId } };
}
