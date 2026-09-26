/**
 * Test-only replica of the host's plugin SQL guard
 * (server/src/services/plugin-database.ts), so migrations and runtime SQL are
 * checked against the same rules without importing the server.
 */

export function splitSqlStatements(input: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
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
    if (char === "'" || char === '"') {
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

function normaliseSql(input: string): string {
  return input
    .replace(/'([^']|'')*'/g, "''")
    .replace(/"([^"]|"")*"/g, '""')
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

type SqlRef = { schema: string; table: string; keyword: string };

function extractQualifiedRefs(statement: string): SqlRef[] {
  const refs: SqlRef[] = [];
  for (const match of statement.matchAll(/\b(from|join|references|into|update)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) {
    refs.push({ keyword: match[1]!.toLowerCase(), schema: match[2]!, table: match[3]! });
  }
  for (const match of statement.matchAll(/\b(alter\s+table|create\s+table|create\s+view|drop\s+table|truncate\s+table)\s+(?:if\s+(?:not\s+)?exists\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) {
    refs.push({ keyword: match[1]!.toLowerCase().replace(/\s+/g, " "), schema: match[2]!, table: match[3]! });
  }
  for (const match of statement.matchAll(/\bcreate\s+(?:unique\s+)?index(?:\s+concurrently)?\s+(?:if\s+not\s+exists\s+)?"?[A-Za-z_][A-Za-z0-9_]*"?\s+on\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) {
    refs.push({ keyword: "create index", schema: match[1]!, table: match[2]! });
  }
  return refs;
}

function assertNoBannedSql(statement: string): void {
  const normalized = normaliseSql(statement);
  const banned = [
    /\bcreate\s+extension\b/,
    /\bcreate\s+(?:event\s+)?trigger\b/,
    /\bcreate\s+(?:or\s+replace\s+)?function\b/,
    /\bcreate\s+language\b/,
    /\bgrant\b/,
    /\brevoke\b/,
    /\bsecurity\s+definer\b/,
    /\bcopy\b/,
    /\bcall\b/,
    /\bdo\s+(?:\$\$|language\b)/,
  ];
  const matched = banned.find((pattern) => pattern.test(normalized));
  if (matched) throw new Error(`disallowed clause ${matched.source}`);
}

function assertPublic(ref: SqlRef, coreReadTables: Set<string>): void {
  if (!coreReadTables.has(ref.table)) throw new Error(`public.${ref.table} not whitelisted`);
  if (!["from", "join", "references"].includes(ref.keyword)) throw new Error(`cannot mutate public.${ref.table}`);
}

export function validateMigrationStatement(statement: string, namespace: string): void {
  assertNoBannedSql(statement);
  const normalized = normaliseSql(statement);
  if (/^\s*(drop|truncate)\b/.test(normalized)) throw new Error("destructive migration");
  if (/\bdelete\s+from\b/.test(normalized)) throw new Error("migrations cannot delete data");
  const allowed =
    /^(create|alter|comment)\b/.test(normalized) ||
    /^(insert\s+into|update)\b/.test(normalized) ||
    (normalized.startsWith("with ") && /\b(insert\s+into|update)\b/.test(normalized));
  if (!allowed) throw new Error("DDL or backfill only");
  const refs = extractQualifiedRefs(statement);
  const objectKeywords = new Set(["alter table", "create index", "create table", "create view", "drop table", "into", "truncate table", "update"]);
  if (!refs.some((r) => objectKeywords.has(r.keyword)) && !normalized.startsWith("comment ")) throw new Error("objects must be schema-qualified");
  for (const ref of refs) {
    if (ref.schema === namespace) continue;
    throw new Error(`references schema ${ref.schema}`);
  }
}

export function validateRuntimeQuery(query: string, namespace: string, coreReadTables: string[] = []): void {
  const statements = splitSqlStatements(query);
  if (statements.length !== 1) throw new Error("exactly one statement");
  const statement = statements[0]!;
  assertNoBannedSql(statement);
  const normalized = normaliseSql(statement);
  if (!normalized.startsWith("select ") && !normalized.startsWith("with ")) throw new Error("query must be SELECT");
  if (/\b(insert|update|delete|alter|create|drop|truncate)\b/.test(normalized)) throw new Error("query has mutation/DDL keyword");
  const core = new Set(coreReadTables);
  for (const ref of extractQualifiedRefs(statement)) {
    if (ref.schema === namespace) continue;
    if (ref.schema === "public") {
      assertPublic(ref, core);
      continue;
    }
    throw new Error(`query reads schema ${ref.schema}`);
  }
}

export function validateRuntimeExecute(query: string, namespace: string): void {
  const statements = splitSqlStatements(query);
  if (statements.length !== 1) throw new Error("exactly one statement");
  const statement = statements[0]!;
  assertNoBannedSql(statement);
  const normalized = normaliseSql(statement);
  if (!/^(insert\s+into|update|delete\s+from)\b/.test(normalized)) throw new Error("execute must be INSERT/UPDATE/DELETE");
  if (/\b(alter|create|drop|truncate)\b/.test(normalized)) throw new Error("execute has DDL keyword");
  const refs = extractQualifiedRefs(statement);
  const target = refs.find((r) => ["into", "update", "from"].includes(r.keyword));
  if (!target || target.schema !== namespace) throw new Error("execute target outside namespace");
  for (const ref of refs) if (ref.schema !== namespace) throw new Error("execute references another schema");
}

/** Placeholders must be 1..n and every param used (host bindSql rule); params must be scalars. */
export function validateParams(sql: string, params: unknown[] = []): void {
  const used = new Set<number>();
  for (const match of sql.matchAll(/\$(\d+)/g)) {
    const index = Number(match[1]);
    if (index < 1 || index > params.length) throw new Error(`placeholder $${index} has no param`);
    used.add(index);
  }
  if (used.size !== params.length) throw new Error(`${params.length - used.size} param(s) not referenced`);
  params.forEach((p, i) => {
    if (p !== null && typeof p === "object") throw new Error(`param $${i + 1} is an ${Array.isArray(p) ? "array" : "object"}; send JSON`);
    if (p === undefined) throw new Error(`param $${i + 1} is undefined`);
  });
}
