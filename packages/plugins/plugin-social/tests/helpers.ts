import { vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { setHostResolver, timing } from "../src/oauth/http.js";
import { NAMESPACE } from "../src/namespace.js";

export interface FetchCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

type Handler = (url: URL, init: RequestInit, call: FetchCall) => Response | Promise<Response>;

/** Stub global fetch. Routes are matched in order: `METHOD url-prefix` or a RegExp on "METHOD url". */
export function mockFetch(routes: Array<[string | RegExp, Handler]>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const call: FetchCall = { url, method, headers: new Headers(init.headers as HeadersInit | undefined), body: init.body };
    calls.push(call);
    const key = `${method} ${url}`;
    for (const [pattern, handler] of routes) {
      const match = typeof pattern === "string" ? key.startsWith(pattern) : pattern.test(key);
      if (match) return handler(new URL(url), init, call);
    }
    throw new Error(`Unexpected fetch ${key}`);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function bytes(size: number, mime: string): Response {
  return new Response(new Uint8Array(size).fill(7), { status: 200, headers: { "content-type": mime, "content-length": String(size) } });
}

export function formOf(call: FetchCall): URLSearchParams {
  return new URLSearchParams(typeof call.body === "string" ? call.body : "");
}

export function jsonOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(typeof call.body === "string" ? call.body : "{}") as Record<string, unknown>;
}

/** Public DNS answers and instant sleeps for provider tests. */
export function fastNetwork(): void {
  setHostResolver(async () => ["93.184.216.34"]);
  timing.sleep = async () => undefined;
}

// ── copy of the host SQL guard (server/src/services/plugin-database.ts) ─────

function strip(input: string): string {
  return input
    .replace(/'([^']|'')*'/g, "''")
    .replace(/"([^"]|"")*"/g, "\"\"")
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function norm(input: string): string {
  return strip(input).replace(/\s+/g, " ").trim().toLowerCase();
}

function refs(statement: string): Array<{ keyword: string; schema: string; table: string }> {
  const out: Array<{ keyword: string; schema: string; table: string }> = [];
  for (const m of statement.matchAll(/\b(from|join|references|into|update)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) {
    out.push({ keyword: m[1]!.toLowerCase(), schema: m[2]!, table: m[3]! });
  }
  for (const m of statement.matchAll(/\b(alter\s+table|create\s+table|create\s+view|drop\s+table|truncate\s+table)\s+(?:if\s+(?:not\s+)?exists\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) {
    out.push({ keyword: m[1]!.toLowerCase().replace(/\s+/g, " "), schema: m[2]!, table: m[3]! });
  }
  for (const m of statement.matchAll(/\bcreate\s+(?:unique\s+)?index(?:\s+concurrently)?\s+(?:if\s+not\s+exists\s+)?"?[A-Za-z_][A-Za-z0-9_]*"?\s+on\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) {
    out.push({ keyword: "create index", schema: m[1]!, table: m[2]! });
  }
  return out;
}

const BANNED = [/\bcreate\s+extension\b/, /\bcreate\s+(?:event\s+)?trigger\b/, /\bcreate\s+(?:or\s+replace\s+)?function\b/, /\bgrant\b/, /\brevoke\b/, /\bcopy\b/, /\bcall\b/, /\bdo\s+(?:\$\$|language\b)/];

/** Same splitting rules as the host: semicolons inside quotes and comments do not split. */
export function splitStatements(input: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | "\"" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    const next = input[i + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) i += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === ";") {
      const statement = input.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  const trailing = input.slice(start).trim();
  if (trailing) statements.push(trailing);
  return statements;
}

export function assertMigrationStatement(statement: string, namespace = NAMESPACE): void {
  const n = norm(statement);
  if (!n) return;
  const banned = BANNED.find((re) => re.test(n));
  if (banned) throw new Error(`banned: ${banned.source} in ${statement.slice(0, 80)}`);
  if (/^\s*(drop|truncate)\b/.test(n)) throw new Error("destructive migration");
  if (/\bdelete\s+from\b/.test(n)) throw new Error("migration deletes data");
  if (!(/^(create|alter|comment)\b/.test(n) || /^(insert\s+into|update)\b/.test(n))) throw new Error(`not DDL/backfill: ${statement.slice(0, 80)}`);
  const r = refs(statement);
  if (!r.some((x) => ["alter table", "create index", "create table", "create view", "into", "update"].includes(x.keyword))) {
    throw new Error(`no qualified object: ${statement.slice(0, 80)}`);
  }
  for (const x of r) if (x.schema !== namespace) throw new Error(`schema ${x.schema} outside namespace`);
}

export function assertRuntimeQuery(sql: string, params: unknown[] = [], namespace = NAMESPACE): void {
  if (splitStatements(sql).length !== 1) throw new Error("more than one statement");
  const n = norm(sql);
  const banned = BANNED.find((re) => re.test(n));
  if (banned) throw new Error(`banned ${banned.source}`);
  if (!n.startsWith("select ") && !n.startsWith("with ")) throw new Error(`query must be SELECT: ${sql.slice(0, 60)}`);
  if (/\b(insert|update|delete|alter|create|drop|truncate)\b/.test(n)) throw new Error(`query contains a mutation keyword: ${sql.slice(0, 80)}`);
  for (const x of refs(sql)) {
    if (x.schema === namespace) continue;
    if (x.schema === "public" && x.table === "heartbeat_runs" && ["from", "join"].includes(x.keyword)) continue;
    throw new Error(`query reads ${x.schema}.${x.table}`);
  }
  assertParams(sql, params);
}

export function assertRuntimeExecute(sql: string, params: unknown[] = [], namespace = NAMESPACE): void {
  if (splitStatements(sql).length !== 1) throw new Error("more than one statement");
  const n = norm(sql);
  const banned = BANNED.find((re) => re.test(n));
  if (banned) throw new Error(`banned ${banned.source}`);
  if (!/^(insert\s+into|update|delete\s+from)\b/.test(n)) throw new Error("execute must be INSERT/UPDATE/DELETE");
  if (/\b(alter|create|drop|truncate)\b/.test(n)) throw new Error(`execute contains DDL keyword: ${sql.slice(0, 80)}`);
  const r = refs(sql);
  const target = r.find((x) => ["into", "update", "from"].includes(x.keyword));
  if (!target || target.schema !== namespace) throw new Error("execute target outside namespace");
  for (const x of r) if (x.schema !== namespace) throw new Error("execute references another schema");
  assertParams(sql, params);
}

function assertParams(sql: string, params: unknown[]): void {
  const used = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  for (const i of used) if (i < 1 || i > params.length) throw new Error(`placeholder $${i} has no parameter`);
  if (used.size !== params.length) throw new Error(`every parameter must be referenced (${used.size} used, ${params.length} given)`);
  params.forEach((p, i) => {
    if (Array.isArray(p)) throw new Error(`param $${i + 1} is a JS array; the host spreads arrays. Use JSON + textArrayParam.`);
    if (p !== null && typeof p === "object") throw new Error(`param $${i + 1} is an object; send JSON.stringify(...)`);
  });
}

export interface FakeDb {
  queries: Array<{ sql: string; params: unknown[] }>;
  executes: Array<{ sql: string; params: unknown[] }>;
  queryResult: (sql: string, params: unknown[]) => unknown[];
  executeResult: (sql: string, params: unknown[]) => number;
}

/** A PluginContext whose db validates every statement with the host guard copy. */
export const TEST_UI_BASE = "/_plugins/e588ce00-a14b-49fc-b62d-54b0208daafa/ui/";

export function fakeCtx(overrides: Partial<Record<string, unknown>> = {}, db: Partial<FakeDb> = {}): PluginContext & { fakeDb: FakeDb } {
  const fake: FakeDb = {
    queries: [],
    executes: [],
    queryResult: db.queryResult ?? (() => []),
    executeResult: db.executeResult ?? (() => 1),
  };
  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: async (sql: string, params: unknown[] = []) => {
        assertRuntimeQuery(sql, params);
        fake.queries.push({ sql, params });
        return fake.queryResult(sql, params);
      },
      execute: async (sql: string, params: unknown[] = []) => {
        assertRuntimeExecute(sql, params);
        fake.executes.push({ sql, params });
        return { rowCount: fake.executeResult(sql, params) };
      },
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    // The Social page reports its /_plugins/<installation uuid>/ui/ base on load.
    state: {
      get: async (key: { stateKey?: string }) => (key.stateKey === "plugin-ui-base" ? TEST_UI_BASE : null),
      set: async () => undefined,
      delete: async () => undefined,
    },
    ...overrides,
    fakeDb: fake,
  };
  return ctx as unknown as PluginContext & { fakeDb: FakeDb };
}
