import { randomUUID } from "node:crypto";

export interface LeaseDb {
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface RecordingRow {
  id: string;
  call_sid: string;
  recording_sid: string;
  state: string;
  attempts: number;
  twilio_url: string;
  r2_key: string | null;
  next_attempt_at: string;
  company_id: string;
  bytes: number | null;
  sha256: string | null;
}

export async function claimRecordings(
  db: LeaseDb,
  opts: { namespace: string; states: string[]; limit: number; leaseSeconds: number; token?: string },
): Promise<{ token: string; rows: RecordingRow[] }> {
  if (!/^[a-z0-9_]+$/.test(opts.namespace)) throw new Error(`Invalid namespace: ${opts.namespace}`);
  if (!Array.isArray(opts.states) || opts.states.length === 0 || opts.states.some((s) => typeof s !== "string" || !s))
    throw new Error("states must be non-empty array of strings");
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 100) throw new Error("limit must be 1..100");
  if (!Number.isInteger(opts.leaseSeconds) || opts.leaseSeconds < 30 || opts.leaseSeconds > 3600) throw new Error("leaseSeconds must be 30..3600");

  const isExplicitToken = opts.token !== undefined;
  const token = opts.token ?? randomUUID();
  const ns = opts.namespace;

  if (!isExplicitToken) {
    // Build state IN ($n, $m, ...) with dynamic param indices
    const params: unknown[] = [token, opts.leaseSeconds];
    const stateParams = opts.states.map((s) => `$${(params.push(s), params.length)}`);
    const limitIdx = params.length + 1;
    params.push(opts.limit);

    const sql = `UPDATE ${ns}.tel_recordings
      SET lease_token = $1, lease_until = now() + make_interval(secs => $2::int), updated_at = now()
      WHERE id IN (SELECT id FROM ${ns}.tel_recordings
        WHERE state IN (${stateParams.join(", ")}) AND erased_at IS NULL AND next_attempt_at <= now()
          AND (lease_until IS NULL OR lease_until < now())
        ORDER BY next_attempt_at LIMIT $${limitIdx}::int FOR UPDATE SKIP LOCKED)`;

    await db.execute(sql, params);
  }

  const rows = await db.query<RecordingRow>(
    `SELECT id, call_sid, recording_sid, state, attempts, twilio_url, r2_key, next_attempt_at, company_id, bytes, sha256
     FROM ${ns}.tel_recordings WHERE lease_token = $1::uuid AND lease_until > now() AND erased_at IS NULL`,
    [token],
  );

  return { token, rows };
}

export async function releaseLease(
  db: LeaseDb,
  opts: { namespace: string; token: string; id: string; patch: { state?: string; attempts?: number; nextAttemptAt?: string; lastError?: string } },
): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(opts.namespace)) throw new Error(`Invalid namespace: ${opts.namespace}`);

  const updates = ["lease_token = NULL", "lease_until = NULL", "updated_at = now()"];
  const params: unknown[] = [opts.token, opts.id];
  let idx = 2;

  if (opts.patch.state !== undefined) {
    updates.push(`state = $${++idx}`);
    params.push(opts.patch.state);
  }
  if (opts.patch.attempts !== undefined) {
    updates.push(`attempts = $${++idx}`);
    params.push(opts.patch.attempts);
  }
  if (opts.patch.nextAttemptAt !== undefined) {
    updates.push(`next_attempt_at = $${++idx}`);
    params.push(opts.patch.nextAttemptAt);
  }
  if (opts.patch.lastError !== undefined) {
    updates.push(`last_error = $${++idx}`);
    params.push(opts.patch.lastError);
  }

  const sql = `UPDATE ${opts.namespace}.tel_recordings SET ${updates.join(", ")} WHERE id = $2::uuid AND lease_token = $1::uuid`;
  await db.execute(sql, params);
}
