// Every plugin migration must pass the host's own statement check (server/src/services/plugin-database.ts,
// validatePluginMigrationStatement), or the plugin fails to activate and the deploy rolls back. The Setup 0.6.0 deploy of
// 2026-10-24 (PAR-5153) did exactly that: an apostrophe in a "--" comment ("the plugin's first start") paired with the next
// quote, because the host strips quoted strings BEFORE it strips comments, and the CREATE TABLE vanished from the keyword
// scan. This port of the host's split, strip and statement-type rules runs over every migration in the repo on every
// pull request. Keep it in step with the host when Paperclip is upgraded. Applied migrations must never be edited
// (the host compares checksums), so a failure here is always a new or unapplied file.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Port of splitSqlStatements: ";" ends a statement unless it is inside a quote or a comment.
export function splitSqlStatements(input: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (char === quote) { if (next === quote) i += 1; else quote = null; }
      continue;
    }
    if (char === "-" && next === "-") { lineComment = true; i += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; i += 1; continue; }
    if (char === "'" || char === "\"") { quote = char; continue; }
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

// Port of stripSqlForKeywordScan + normaliseSql, in the host's order: strings first, then comments.
export function normaliseSql(input: string): string {
  return input
    .replace(/'([^']|'')*'/g, "''")
    .replace(/"([^"]|"")*"/g, "\"\"")
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const BANNED = [
  /\bcreate\s+extension\b/, /\bcreate\s+(?:event\s+)?trigger\b/, /\bcreate\s+(?:or\s+replace\s+)?function\b/,
  /\bcreate\s+language\b/, /\bgrant\b/, /\brevoke\b/, /\bsecurity\s+definer\b/, /\bcopy\b/, /\bcall\b/,
  /\bdo\s+(?:\$\$|language\b)/,
];

// The statement-shape part of validatePluginMigrationStatement (the namespace checks need the install id, so they stay on the host).
export function hostStatementProblem(statement: string): string | null {
  const normalized = normaliseSql(statement);
  const banned = BANNED.find((pattern) => pattern.test(normalized));
  if (banned) return `disallowed statement or clause: ${banned.source}`;
  if (/^\s*(drop|truncate)\b/.test(normalized)) return "destructive statement (drop/truncate)";
  if (/\bdelete\s+from\b/.test(normalized)) return "deletes data";
  const allowed = /^(create|alter|comment)\b/.test(normalized) || /^(insert\s+into|update)\b/.test(normalized)
    || (normalized.startsWith("with ") && /\b(insert\s+into|update)\b/.test(normalized));
  if (!allowed) return `the host sees it as "${normalized.slice(0, 60)}", not DDL or a backfill (a quote inside a -- comment?)`;
  return null;
}

const PLUGINS = resolve(__dirname, "..", "..");
function migrationFiles(): string[] {
  const out: string[] = [];
  for (const dir of readdirSync(PLUGINS)) {
    const migrations = join(PLUGINS, dir, "migrations");
    if (!dir.startsWith("plugin-") || !existsSync(migrations)) continue;
    for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) out.push(join(migrations, file));
  }
  return out;
}

describe("plugin migrations pass the host's statement check", () => {
  it("the port reproduces the 2026-10-24 Setup failure and passes its fix", () => {
    const broken = "-- One row per company and module; written by an admin.\n-- Entitled (plan 'pib') by the plugin's first start.\n"
      + "CREATE TABLE plugin_x.entitlements (state text CHECK (state IN ('entitled', 'off')));";
    expect(splitSqlStatements(broken)).toHaveLength(1);
    expect(hostStatementProblem(splitSqlStatements(broken)[0])).toMatch(/not DDL or a backfill/);
    const fixed = broken.replace("(plan 'pib') by the plugin's first start", "(plan pib) by the first start of the plugin");
    expect(hostStatementProblem(splitSqlStatements(fixed)[0])).toBeNull();
    expect(hostStatementProblem("DELETE FROM plugin_x.t")).toMatch(/deletes data/);
    expect(hostStatementProblem("DROP TABLE plugin_x.t")).toMatch(/destructive/);
  });

  const files = migrationFiles();
  it("finds the migrations of the PiB plugins", () => {
    expect(files.length).toBeGreaterThan(50);
  });
  for (const file of files) {
    it(file.slice(PLUGINS.length + 1), () => {
      const statements = splitSqlStatements(readFileSync(file, "utf8"));
      expect(statements.length).toBeGreaterThan(0);
      const problems = statements.map((s, i) => [i, hostStatementProblem(s)] as const).filter(([, p]) => p);
      expect(problems.map(([i, p]) => `statement ${i}: ${p}`)).toEqual([]);
    });
  }
});
