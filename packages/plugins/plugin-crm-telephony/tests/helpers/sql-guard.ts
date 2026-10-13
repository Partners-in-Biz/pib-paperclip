// Validates SQL and params match host plugin-database.ts rules: one statement,
// scalars only, schema-qualified tables, specific statement kinds.

export function validateParams(sql: string, params: unknown[]): void {
  for (const p of params) {
    if (p === null || p === undefined || typeof p === "string" || typeof p === "number" || typeof p === "boolean") continue;
    throw new Error(`SQL param must be scalar, got ${typeof p}: ${JSON.stringify(p)}`);
  }
}

export function validateRuntimeQuery(sql: string, namespace: string): void {
  const trimmed = sql.trim().toUpperCase();
  if (!/^(WITH\s|SELECT\s)/.test(trimmed)) throw new Error(`query must start with SELECT or WITH, got: ${sql.slice(0, 30)}`);
  if (!sql.includes(`${namespace}.`)) throw new Error(`query must reference schema-qualified table in ${namespace}`);
}

export function validateRuntimeExecute(sql: string, namespace: string): void {
  const trimmed = sql.trim().toUpperCase();
  if (!/^(INSERT|UPDATE|DELETE)\s/.test(trimmed)) throw new Error(`execute must be INSERT/UPDATE/DELETE, got: ${sql.slice(0, 30)}`);
  if (!sql.includes(`${namespace}.`)) throw new Error(`execute must reference schema-qualified table in ${namespace}`);
}
