/**
 * A real (embedded) Postgres behind a fake PluginContext that applies the host SQL guard, for the 0.4 specs
 * (approvals, compact tools, erasure). Same wiring as integration.spec.ts, with the pieces those specs need
 * as plain properties: issues with assignees and a list(), comments, wakeups, full-key plugin state, company
 * records (the host's default responsible user) and per-company settings.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAMESPACE } from "../../src/namespace.js";
import * as guard from "./sql-guard.js";
import { freePort } from "./free-port.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_PKG = path.resolve(here, "../../../../db/node_modules");

export const pgAvailable = existsSync(`${DB_PKG}/embedded-postgres/dist/index.js`) && existsSync(`${DB_PKG}/drizzle-orm/postgres-js/index.js`);

export interface TestIssue {
  id: string;
  identifier: string;
  status: string;
  title: string;
  description: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  originKind: string;
  originId: string | null;
  createdAt: string;
}

export interface PgCtx {
  ctx: any;
  q: (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
  issues: Map<string, TestIssue>;
  comments: Array<{ issueId: string; body: string }>;
  wakeups: string[];
  emitted: Array<{ name: string; companyId: string; payload: Record<string, unknown> }>;
  state: Map<string, unknown>;
  configs: Map<string, Record<string, unknown>>;
  companies: Map<string, { defaultResponsibleUserId: string | null }>;
  warnings: string[];
  /** The Cockpit's roles copy, as `registerRoleWatch` stores it. */
  setRoles(companyId: string, roles: Record<string, unknown>): void;
  stop(): Promise<void>;
}

const stateKeyOf = (k: { scopeKind?: string; scopeId?: string; namespace?: string; stateKey: string }) => `${k.scopeKind ?? ""}|${k.scopeId ?? ""}|${k.namespace ?? ""}|${k.stateKey}`;

export async function startPgCtx(): Promise<PgCtx> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "acct-pg2-"));
  const { default: EmbeddedPostgres } = await import(`${DB_PKG}/embedded-postgres/dist/index.js`);
  const { drizzle } = await import(`${DB_PKG}/drizzle-orm/postgres-js/index.js`);
  const sqlTag = (await import(`${DB_PKG}/drizzle-orm/sql/sql.js`)).sql as { raw(s: string): unknown; join(chunks: unknown[], sep: unknown): unknown } & ((strings: TemplateStringsArray, ...values: unknown[]) => unknown);
  const postgres = (await import(`${DB_PKG}/postgres/src/index.js`)).default;
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: "t", password: "t", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("acct2");
  const client = postgres({ host: "127.0.0.1", port, user: "t", password: "t", database: "acct2", onnotice: () => {} });
  const orm = drizzle(client);
  await client.unsafe(`CREATE SCHEMA ${NAMESPACE}`);
  for (const file of readdirSync(path.join(here, "../../migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    for (const statement of guard.splitSqlStatements(readFileSync(path.join(here, "../../migrations", file), "utf8"))) {
      guard.validateMigrationStatement(statement, NAMESPACE);
      await client.unsafe(statement);
    }
  }

  const issues = new Map<string, TestIssue>();
  const comments: PgCtx["comments"] = [];
  const wakeups: string[] = [];
  const emitted: PgCtx["emitted"] = [];
  const state = new Map<string, unknown>();
  const configs = new Map<string, Record<string, unknown>>();
  const companies = new Map<string, { defaultResponsibleUserId: string | null }>();
  const warnings: string[] = [];
  let issueSeq = 0;

  function bindSql(statement: string, params: readonly unknown[] = []) {
    if (params.length === 0) return sqlTag.raw(statement);
    const chunks: unknown[] = [];
    let cursor = 0;
    for (const match of statement.matchAll(/\$(\d+)/g)) {
      chunks.push(sqlTag.raw(statement.slice(cursor, match.index)));
      chunks.push(sqlTag`${params[Number(match[1]) - 1]}`);
      cursor = match.index! + match[0].length;
    }
    chunks.push(sqlTag.raw(statement.slice(cursor)));
    return sqlTag.join(chunks, sqlTag.raw(""));
  }

  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(text: string, params: unknown[] = []) {
        guard.validateRuntimeQuery(text, NAMESPACE, ["issues"]);
        guard.validateParams(text, params);
        const rows = await orm.execute(bindSql(text, JSON.parse(JSON.stringify(params))));
        return JSON.parse(JSON.stringify([...(rows as Iterable<unknown>)]));
      },
      async execute(text: string, params: unknown[] = []) {
        guard.validateRuntimeExecute(text, NAMESPACE);
        guard.validateParams(text, params);
        const result = await orm.execute(bindSql(text, JSON.parse(JSON.stringify(params))));
        return { rowCount: Number((result as { count?: number }).count ?? 0) };
      },
    },
    config: { get: async (companyId?: string) => configs.get(companyId ?? "") ?? {} },
    secrets: { resolve: async () => undefined },
    logger: { info: () => {}, warn: (message: string) => void warnings.push(message), error: () => {}, debug: () => {} },
    state: {
      get: async (k: { stateKey: string }) => state.get(stateKeyOf(k)) ?? null,
      set: async (k: { stateKey: string }, v: unknown) => void state.set(stateKeyOf(k), v),
    },
    events: { emit: async (name: string, companyId: string, payload: Record<string, unknown>) => void emitted.push({ name, companyId, payload }), on: () => () => undefined },
    agents: { list: async () => [], get: async () => null },
    authorization: { grants: { list: async () => [], set: async () => [] } },
    skills: { managed: { reconcile: async () => ({}), reset: async () => ({}) } },
    companies: { get: async (id: string) => (companies.has(id) ? { id, name: "Test Co", issuePrefix: "TST", ...companies.get(id) } : null) },
    issues: {
      create: async (input: Record<string, unknown>) => {
        issueSeq += 1;
        const issue: TestIssue = {
          id: `iss-${issueSeq}`,
          identifier: `TST-${issueSeq}`,
          status: String(input.status ?? "backlog"),
          title: String(input.title),
          description: String(input.description ?? ""),
          assigneeAgentId: (input.assigneeAgentId as string) ?? null,
          assigneeUserId: (input.assigneeUserId as string) ?? null,
          originKind: String(input.originKind),
          originId: (input.originId as string) ?? null,
          createdAt: new Date().toISOString(),
        };
        issues.set(issue.id, issue);
        return issue;
      },
      get: async (id: string) => issues.get(id) ?? null,
      update: async (id: string, patch: Partial<TestIssue>) => {
        const issue = issues.get(id);
        if (!issue) throw new Error("no issue");
        return Object.assign(issue, patch);
      },
      list: async (filter: { status?: string; originKindPrefix?: string }) => [...issues.values()].filter((i) => (!filter.status || i.status === filter.status) && (!filter.originKindPrefix || i.originKind.startsWith(filter.originKindPrefix))),
      requestWakeup: async (issueId: string) => {
        wakeups.push(issueId);
        return { queued: true };
      },
      createComment: async (issueId: string, body: string) => {
        comments.push({ issueId, body });
        return { id: `c-${comments.length}` };
      },
    },
  };

  return {
    ctx,
    q: (text, params = []) => client.unsafe(text, params),
    issues,
    comments,
    wakeups,
    emitted,
    state,
    configs,
    companies,
    warnings,
    setRoles(companyId, roles) {
      state.set(stateKeyOf({ scopeKind: "company", scopeId: companyId, namespace: "pib-cockpit", stateKey: "roles" }), { companyId, updatedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), ...roles });
    },
    async stop() {
      await client.end();
      await pg.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
