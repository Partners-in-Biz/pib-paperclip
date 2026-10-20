/**
 * A copy of the host's plugin SQL rules (server/src/services/plugin-database.ts)
 * so tests fail on SQL the host would refuse: one statement, SELECT/WITH only
 * for query, INSERT/UPDATE/DELETE into the own namespace for execute, no
 * banned words, fully qualified names, migration rules, and the host's
 * placeholder binding (every `$n` occurrence becomes its own parameter, and
 * every parameter must be used).
 */

type SqlRef = { schema: string; table: string; keyword: string };

function splitSqlStatements(input: string): string[] {
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

function strip(input: string): string {
  return input
    .replace(/'([^']|'')*'/g, "''")
    .replace(/"([^"]|"")*"/g, "\"\"")
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function normalise(input: string): string {
  return strip(input).replace(/\s+/g, " ").trim().toLowerCase();
}

function refs(statement: string): SqlRef[] {
  const out: SqlRef[] = [];
  for (const m of statement.matchAll(/\b(from|join|references|into|update)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) {
    out.push({ keyword: m[1]!.toLowerCase(), schema: m[2]!, table: m[3]! });
  }
  for (const m of statement.matchAll(/\b(alter\s+table|create\s+table|create\s+view|drop\s+table|truncate\s+table)\s+(?:if\s+(?:not\s+)?exists\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) {
    out.push({ keyword: m[1]!.toLowerCase(), schema: m[2]!, table: m[3]! });
  }
  for (const m of statement.matchAll(/\bcreate\s+(?:unique\s+)?index(?:\s+concurrently)?\s+(?:if\s+not\s+exists\s+)?"?[A-Za-z_][A-Za-z0-9_]*"?\s+on\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) {
    out.push({ keyword: "create index", schema: m[1]!, table: m[2]! });
  }
  return out;
}

function assertNoBanned(statement: string): void {
  const n = normalise(statement);
  const banned = [/\bcreate\s+extension\b/, /\bcreate\s+(?:event\s+)?trigger\b/, /\bcreate\s+(?:or\s+replace\s+)?function\b/, /\bcreate\s+language\b/, /\bgrant\b/, /\brevoke\b/, /\bsecurity\s+definer\b/, /\bcopy\b/, /\bcall\b/, /\bdo\s+(?:\$\$|language\b)/];
  const hit = banned.find((p) => p.test(n));
  if (hit) throw new Error(`Plugin SQL contains a disallowed statement or clause: ${hit.source}\n${statement}`);
}

function assertPublic(ref: SqlRef, core: Set<string>): void {
  if (!core.has(ref.table)) throw new Error(`Plugin SQL references public.${ref.table}, which is not whitelisted`);
  if (!["from", "join", "references"].includes(ref.keyword)) throw new Error(`Plugin SQL cannot mutate public.${ref.table}`);
}

export function validateMigrationStatement(statement: string, namespace: string, core: string[] = []): void {
  assertNoBanned(statement);
  const n = normalise(statement);
  if (/^\s*(drop|truncate)\b/.test(n)) throw new Error("Destructive plugin migrations are not allowed");
  if (/\bdelete\s+from\b/.test(n)) throw new Error("Plugin migrations cannot delete data");
  const ok = /^(create|alter|comment)\b/.test(n) || /^(insert\s+into|update)\b/.test(n) || (n.startsWith("with ") && /\b(insert\s+into|update)\b/.test(n));
  if (!ok) throw new Error(`Plugin migrations may contain DDL or namespace-scoped backfill statements only:\n${statement}`);
  const r = refs(statement);
  const objectKeywords = new Set(["alter table", "create index", "create table", "create view", "drop table", "into", "truncate table", "update"]);
  if (!r.some((x) => objectKeywords.has(x.keyword)) && !n.startsWith("comment ")) throw new Error(`Plugin migration objects must use fully qualified schema names:\n${statement}`);
  const coreSet = new Set(core);
  for (const ref of r) {
    if (ref.schema === namespace) continue;
    if (ref.schema === "public") {
      assertPublic(ref, coreSet);
      continue;
    }
    throw new Error(`Plugin SQL references schema "${ref.schema}" outside namespace "${namespace}"`);
  }
}

export function validateMigration(sql: string, namespace: string, core: string[] = []): string[] {
  const statements = splitSqlStatements(sql);
  for (const statement of statements) validateMigrationStatement(statement, namespace, core);
  return statements;
}

export function validateQuery(sql: string, namespace: string, core: string[] = []): void {
  const statements = splitSqlStatements(sql);
  if (statements.length !== 1) throw new Error(`Plugin runtime SQL must contain exactly one statement:\n${sql}`);
  const statement = statements[0]!;
  assertNoBanned(statement);
  const n = normalise(statement);
  if (!n.startsWith("select ") && !n.startsWith("with ")) throw new Error(`ctx.db.query only allows SELECT statements:\n${sql}`);
  if (/\b(insert|update|delete|alter|create|drop|truncate)\b/.test(n)) throw new Error(`ctx.db.query cannot contain mutation or DDL keywords:\n${sql}`);
  const coreSet = new Set(core);
  for (const ref of refs(statement)) {
    if (ref.schema === namespace) continue;
    if (ref.schema === "public") {
      assertPublic(ref, coreSet);
      continue;
    }
    throw new Error(`ctx.db.query cannot read schema "${ref.schema}":\n${sql}`);
  }
}

export function validateExecute(sql: string, namespace: string): void {
  const statements = splitSqlStatements(sql);
  if (statements.length !== 1) throw new Error(`Plugin runtime SQL must contain exactly one statement:\n${sql}`);
  const statement = statements[0]!;
  assertNoBanned(statement);
  const n = normalise(statement);
  if (!/^(insert\s+into|update|delete\s+from)\b/.test(n)) throw new Error(`ctx.db.execute only allows INSERT, UPDATE, or DELETE:\n${sql}`);
  if (/\b(alter|create|drop|truncate)\b/.test(n)) throw new Error(`ctx.db.execute cannot contain DDL keywords:\n${sql}`);
  const r = refs(statement);
  const target = r.find((x) => ["into", "update", "from"].includes(x.keyword));
  if (!target || target.schema !== namespace) throw new Error(`ctx.db.execute target must be inside plugin namespace "${namespace}":\n${sql}`);
  for (const ref of r) if (ref.schema !== namespace) throw new Error(`ctx.db.execute cannot reference public or other non-plugin schemas:\n${sql}`);
}

/**
 * The host binds each `$n` occurrence as its own parameter (drizzle chunks),
 * so `$2` used twice is sent twice and every occurrence must be typeable on
 * its own. Returns SQL with sequential placeholders and the expanded values.
 */
export function bindLikeHost(statement: string, params: readonly unknown[] = []): { sql: string; values: unknown[] } {
  if (params.length === 0) return { sql: statement, values: [] };
  const values: unknown[] = [];
  const seen = new Set<number>();
  const sql = statement.replace(/\$(\d+)/g, (_whole, digits: string) => {
    const index = Number(digits);
    if (!Number.isInteger(index) || index < 1 || index > params.length) throw new Error(`SQL placeholder $${digits} has no matching parameter`);
    seen.add(index);
    values.push(params[index - 1]);
    return `$${values.length}`;
  });
  if (seen.size !== params.length) throw new Error(`Every ctx.db parameter must be referenced by a $n placeholder:\n${statement}`);
  for (const value of values) {
    if (value !== null && typeof value === "object") throw new Error(`Pass arrays and objects as JSON strings (the host JSON-encodes params):\n${statement}`);
  }
  return { sql, values };
}
