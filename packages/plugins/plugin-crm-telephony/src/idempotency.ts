export type SqlExecutor = {
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
};

const SID_TARGETS = {
  call: { table: "tel_calls", column: "call_sid" },
  recording: { table: "tel_recordings", column: "recording_sid" },
  message: { table: "tel_messages", column: "provider_msg_id" },
} as const;

type SidKind = keyof typeof SID_TARGETS;

function assertIdentifier(value: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe identifier: ${value}`);
  }
}

export async function insertOnce(
  db: SqlExecutor,
  namespace: string,
  kind: SidKind,
  values: Record<string, unknown>,
): Promise<boolean> {
  const target = SID_TARGETS[kind];
  const sidColumn = target.column;

  // Validate namespace and all column names
  assertIdentifier(namespace);
  for (const col of Object.keys(values)) {
    assertIdentifier(col);
  }

  // Validate SID presence and value
  const sidValue = values[sidColumn];
  if (typeof sidValue !== "string" || sidValue === "") {
    throw new Error(`Missing or empty SID column '${sidColumn}'`);
  }

  // Check table is allowlisted
  if (!Object.values(SID_TARGETS).find((t) => t.table === target.table)) {
    throw new Error(`Disallowed table: ${target.table}`);
  }

  const cols = Object.keys(values);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  const sql = `INSERT INTO ${namespace}.${target.table} (${cols.join(",")}) VALUES (${placeholders}) ON CONFLICT (${sidColumn}) DO NOTHING`;
  const params = cols.map((col) => values[col]);

  const result = await db.execute(sql, params);
  return result.rowCount === 1;
}
