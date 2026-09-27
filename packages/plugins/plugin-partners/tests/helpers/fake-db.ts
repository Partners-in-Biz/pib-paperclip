/**
 * Test-only in-memory stand-in for a plugin namespace.
 *
 * Every statement first passes the host SQL guard replica. Simple statements
 * run generically: single-table SELECT with AND-ed conditions, ORDER BY and
 * LIMIT; INSERT … VALUES with ON CONFLICT DO NOTHING / DO UPDATE; UPDATE and
 * DELETE with AND-ed conditions. Anything else (joins, EXISTS, OR, GROUP BY)
 * needs a route, so an unexpected statement fails loudly instead of passing.
 */
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./sql-guard.js";

export type Row = Record<string, any>;
export type Store = Record<string, Row[]>;
export type Route = [RegExp, (params: unknown[], store: Store, sql: string) => Row[]];

export interface FakeDbOptions {
  namespace: string;
  coreReadTables?: string[];
  routes?: Route[];
  /** Column defaults per table, applied on INSERT. */
  defaults?: Record<string, Row>;
}

function splitTop(input: string, separator: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === "'") {
        if (input[i + 1] === "'") i += 1;
        else quote = false;
      }
      continue;
    }
    if (ch === "'") quote = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0) {
      separator.lastIndex = 0;
      const rest = input.slice(i);
      const match = separator.exec(rest);
      if (match && match.index === 0) {
        out.push(input.slice(start, i));
        i += match[0].length - 1;
        start = i + 1;
      }
    }
  }
  out.push(input.slice(start));
  return out.map((part) => part.trim()).filter((part) => part.length > 0);
}

const nowIso = () => new Date().toISOString();

function evalExpr(raw: string, params: unknown[], row?: Row): unknown {
  const expr = raw.trim();
  let m: RegExpExecArray | null;
  if ((m = /^\$(\d+)(?:::(\w+))?$/.exec(expr))) {
    const value = params[Number(m[1]) - 1];
    if (m[2] === "jsonb" && typeof value === "string") return JSON.parse(value);
    return value;
  }
  if (/^now\(\)$/i.test(expr)) return nowIso();
  if ((m = /^now\(\)\s*\+\s*interval\s*'(\d+)\s*(minute|minutes|day|days)'$/i.exec(expr))) {
    const unit = m[2]!.startsWith("day") ? 86_400_000 : 60_000;
    return new Date(Date.now() + Number(m[1]) * unit).toISOString();
  }
  if ((m = /^now\(\)\s*\+\s*\(\$(\d+)\s*\|\|\s*' (minutes|days)'\)::interval$/i.exec(expr))) {
    const unit = m[2] === "days" ? 86_400_000 : 60_000;
    return new Date(Date.now() + Number(params[Number(m[1]) - 1]) * unit).toISOString();
  }
  if ((m = /^ARRAY\(SELECT jsonb_array_elements_text\(\$(\d+)::jsonb\)\)$/i.exec(expr))) {
    return JSON.parse(String(params[Number(m[1]) - 1]));
  }
  if (/^null$/i.test(expr)) return null;
  if (/^true$/i.test(expr)) return true;
  if (/^false$/i.test(expr)) return false;
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
  if ((m = /^'((?:[^']|'')*)'(?:::\w+)?$/.exec(expr))) return m[1]!.replace(/''/g, "'");
  if (row && (m = /^EXCLUDED\.(\w+)$/i.exec(expr))) return row[m[1]!];
  if (row && (m = /^(?:\w+\.)?(\w+)$/.exec(expr)) && m[1]! in row) return row[m[1]!];
  throw new Error(`fake db: unsupported expression "${expr}"`);
}

function timeOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return Date.parse(String(value));
}

function matches(row: Row, where: string | undefined, params: unknown[]): boolean {
  if (!where) return true;
  for (const cond of splitTop(where, /^\s+AND\s+/i)) {
    let m: RegExpExecArray | null;
    if (/\sOR\s/i.test(cond)) throw new Error(`fake db: OR needs a route: ${cond}`);
    if ((m = /^(?:\w+\.)?(\w+)\s+IS\s+NOT\s+NULL$/i.exec(cond))) {
      if (row[m[1]!] == null) return false;
      continue;
    }
    if ((m = /^(?:\w+\.)?(\w+)\s+IS\s+NULL$/i.exec(cond))) {
      if (row[m[1]!] != null) return false;
      continue;
    }
    if ((m = /^(?:\w+\.)?(\w+)\s*=\s*ANY\((ARRAY\(.+\))\)$/i.exec(cond))) {
      const list = evalExpr(m[2]!, params) as unknown[];
      if (!list.includes(row[m[1]!])) return false;
      continue;
    }
    if ((m = /^\$(\d+)\s*=\s*ANY\((\w+)\)$/i.exec(cond))) {
      const list = row[m[2]!];
      if (!Array.isArray(list) || !list.includes(params[Number(m[1]) - 1])) return false;
      continue;
    }
    if ((m = /^(?:\w+\.)?(\w+)\s*(=|<>)\s*(.+)$/.exec(cond))) {
      const value = evalExpr(m[3]!, params);
      const equal = row[m[1]!] === value;
      if (m[2] === "=" ? !equal : equal) return false;
      continue;
    }
    if ((m = /^(?:\w+\.)?(\w+)\s*(<=|>=|<|>)\s*(.+)$/.exec(cond))) {
      const left = timeOf(row[m[1]!]);
      const right = timeOf(evalExpr(m[3]!, params));
      if (Number.isNaN(left)) return false;
      const ok = m[2] === "<=" ? left <= right : m[2] === ">=" ? left >= right : m[2] === "<" ? left < right : left > right;
      if (!ok) return false;
      continue;
    }
    throw new Error(`fake db: unsupported condition "${cond}"`);
  }
  return true;
}

export function createFakeDb(store: Store, options: FakeDbOptions) {
  const ns = options.namespace;
  const routes = options.routes ?? [];
  const tableRe = (kw: string) => new RegExp(`${kw}\\s+${ns}\\.(\\w+)`, "i");
  const rowsOf = (name: string) => (store[name] ??= []);
  const log = { queries: [] as Array<{ sql: string; params: unknown[] }>, executes: [] as Array<{ sql: string; params: unknown[] }> };

  function select(sql: string, params: unknown[]): Row[] {
    const flat = sql.replace(/\s+/g, " ").trim();
    if (/\b(JOIN|UNION|EXISTS|GROUP BY|count\(|max\(|jsonb_agg)\b/i.test(flat) || /\bIN \(SELECT/i.test(flat)) {
      throw new Error(`fake db: query needs a route: ${flat.slice(0, 160)}`);
    }
    const m = /^SELECT .+? FROM (\S+)(?: (?!WHERE\b|ORDER\b|LIMIT\b)(\w+))?(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\S+))?$/i.exec(flat);
    if (!m) throw new Error(`fake db: cannot parse query ${flat.slice(0, 160)}`);
    const name = m[1]!.split(".")[1]!;
    let rows = rowsOf(name).filter((row) => matches(row, m[3], params));
    if (m[4]) {
      const keys = splitTop(m[4], /^,/).map((part) => {
        const [col, dir] = part.trim().split(/\s+/);
        return { col: col!.replace(/^\w+\./, ""), desc: /desc/i.test(dir ?? "") };
      });
      rows = [...rows].sort((a, b) => {
        for (const { col, desc } of keys) {
          const x = a[col];
          const y = b[col];
          if (x === y) continue;
          const cmp = x == null ? -1 : y == null ? 1 : x < y ? -1 : 1;
          return desc ? -cmp : cmp;
        }
        return 0;
      });
    }
    if (m[5]) rows = rows.slice(0, Number(evalExpr(m[5], params)));
    return rows.map((row) => ({ ...row }));
  }

  function insert(sql: string, params: unknown[]): { rowCount: number } {
    const flat = sql.replace(/\s+/g, " ").trim();
    const name = tableRe("INTO").exec(flat)![1]!;
    const m = /\(([^)]+)\) VALUES \((.+?)\)(?: ON CONFLICT \(([^)]+)\)(?: WHERE [^D]+?)? DO (NOTHING|UPDATE SET (.+?)(?: WHERE .+)?))?$/i.exec(flat);
    if (!m) throw new Error(`fake db: cannot parse insert ${flat.slice(0, 160)}`);
    const columns = m[1]!.split(",").map((col) => col.trim());
    const values = splitTop(m[2]!, /^,/);
    if (values.length !== columns.length) throw new Error(`fake db: ${columns.length} columns, ${values.length} values`);
    const row: Row = { created_at: nowIso(), ...(options.defaults?.[name] ?? {}) };
    columns.forEach((col, index) => {
      row[col] = evalExpr(values[index]!, params);
    });
    const rows = rowsOf(name);
    const conflictCols = m[3] ? m[3].split(",").map((col) => col.trim()) : ["id" in row ? "id" : "key"];
    const existing = rows.find((other) => conflictCols.every((col) => row[col] != null && other[col] === row[col]));
    if (existing) {
      if (!m[3]) throw new Error(`fake db: duplicate key in ${name}`);
      if (/^NOTHING$/i.test(m[4]!)) return { rowCount: 0 };
      for (const assignment of splitTop(m[5]!, /^,/)) {
        const [col, expr] = assignment.split(/=(.*)/s).map((part) => part.trim());
        existing[col!] = evalExpr(expr!, params, row);
      }
      return { rowCount: 1 };
    }
    rows.push(row);
    return { rowCount: 1 };
  }

  function update(sql: string, params: unknown[]): { rowCount: number } {
    const flat = sql.replace(/\s+/g, " ").trim();
    const name = tableRe("UPDATE").exec(flat)![1]!;
    const m = /SET (.+?) WHERE (.+)$/i.exec(flat);
    if (!m) throw new Error(`fake db: cannot parse update ${flat.slice(0, 160)}`);
    const targets = rowsOf(name).filter((row) => matches(row, m[2], params));
    const assignments = splitTop(m[1]!, /^,/).map((assignment) => {
      const index = assignment.indexOf("=");
      return [assignment.slice(0, index).trim(), assignment.slice(index + 1).trim()] as const;
    });
    for (const row of targets) {
      for (const [col, expr] of assignments) row[col] = evalExpr(expr, params, row);
    }
    return { rowCount: targets.length };
  }

  function remove(sql: string, params: unknown[]): { rowCount: number } {
    const flat = sql.replace(/\s+/g, " ").trim();
    const name = tableRe("FROM").exec(flat)![1]!;
    const where = /WHERE (.+)$/i.exec(flat)?.[1];
    const rows = rowsOf(name);
    const keep = rows.filter((row) => !matches(row, where, params));
    const removed = rows.length - keep.length;
    store[name] = keep;
    return { rowCount: removed };
  }

  return {
    namespace: ns,
    log,
    async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
      validateRuntimeQuery(sql, ns, options.coreReadTables ?? []);
      validateParams(sql, params);
      log.queries.push({ sql, params });
      for (const [pattern, handler] of routes) if (pattern.test(sql)) return handler(params, store, sql) as T[];
      return select(sql, params) as T[];
    },
    async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      validateRuntimeExecute(sql, ns);
      validateParams(sql, params);
      log.executes.push({ sql, params });
      const head = sql.trim().slice(0, 6).toUpperCase();
      if (head === "INSERT") return insert(sql, params);
      if (head === "UPDATE") return update(sql, params);
      if (head === "DELETE") return remove(sql, params);
      throw new Error("fake db: unsupported statement");
    },
  };
}
