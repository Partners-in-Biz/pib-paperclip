/**
 * Reliable cross-plugin delivery on top of at-most-once events.
 *
 * Sender: `enqueue` stores the request and emits it; the `redeliver` job
 * re-emits anything not answered yet with backoff; `settleOutbox` records the
 * receiver's result event. Receiver: `receiveOnce` runs the handler once per
 * key and remembers the result, so a re-delivered request just re-sends the
 * same answer.
 *
 * Each plugin that uses it adds `outboxMigration(ns)` and/or
 * `inboxMigration(ns)` to a migration file (replace NS with its namespace).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";

export function outboxMigration(ns: string): string {
  return `CREATE TABLE ${ns}.outbox (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  event text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT outbox_status CHECK (status IN ('pending', 'done', 'failed'))
);
CREATE INDEX outbox_due ON ${ns}.outbox (status, next_attempt_at);
`;
}

export function inboxMigration(ns: string): string {
  return `CREATE TABLE ${ns}.inbox (
  key text PRIMARY KEY,
  company_id text NOT NULL,
  event text NOT NULL,
  result jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);
`;
}

export interface OutboxRow {
  key: string;
  company_id: string;
  event: string;
  payload: Record<string, unknown>;
  status: "pending" | "done" | "failed";
  attempts: number;
  last_error: string | null;
  result: Record<string, unknown> | null;
}

/** Minutes before retry n (1-based). Caps at 6 hours; gives up after 20 tries (~3 days). */
export function backoffMinutes(attempt: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240, 360];
  return steps[Math.min(Math.max(attempt, 1), steps.length) - 1]!;
}

export const OUTBOX_MAX_ATTEMPTS = 20;

function ns(ctx: PluginContext): string {
  const name = ctx.db.namespace;
  if (!/^plugin_[a-z0-9_]+$/.test(name)) throw new Error("Unsafe namespace");
  return name;
}

async function emit(ctx: PluginContext, companyId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  await ctx.events.emit(event, companyId, payload);
}

/**
 * Store the request and emit it now. Enqueueing the same key twice is a
 * no-op (the first payload wins), so callers can enqueue from retries safely.
 */
export async function enqueue(
  ctx: PluginContext,
  companyId: string,
  event: string,
  payload: { key: string } & Record<string, unknown>,
): Promise<{ key: string; created: boolean }> {
  const res = await ctx.db.execute(
    `INSERT INTO ${ns(ctx)}.outbox (key, company_id, event, payload, attempts, next_attempt_at)
     VALUES ($1, $2, $3, $4::jsonb, 1, now() + interval '1 minute')
     ON CONFLICT (key) DO NOTHING`,
    [payload.key, companyId, event, JSON.stringify(payload)],
  );
  const created = (res.rowCount ?? 0) > 0;
  if (created) {
    try {
      await emit(ctx, companyId, event, payload);
    } catch (error) {
      ctx.logger.info("Outbox emit failed; the redeliver job will retry", { key: payload.key, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { key: payload.key, created };
}

/** Job body: re-emit pending requests whose retry time has come. */
export async function redeliver(ctx: PluginContext, options: { limit?: number } = {}): Promise<{ emitted: number; failed: number }> {
  const rows = await ctx.db.query<OutboxRow>(
    `SELECT key, company_id, event, payload, status, attempts, last_error, result
       FROM ${ns(ctx)}.outbox
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY next_attempt_at
      LIMIT ${Math.max(1, Math.min(options.limit ?? 200, 1000))}`,
  );
  let emitted = 0;
  let failed = 0;
  for (const row of rows) {
    const attempts = row.attempts + 1;
    if (attempts > OUTBOX_MAX_ATTEMPTS) {
      await ctx.db.execute(
        `UPDATE ${ns(ctx)}.outbox SET status = 'failed', last_error = $2, settled_at = now() WHERE key = $1 AND status = 'pending'`,
        [row.key, row.last_error ?? "No answer from the receiving plugin"],
      );
      failed += 1;
      continue;
    }
    await ctx.db.execute(
      `UPDATE ${ns(ctx)}.outbox SET attempts = $2, next_attempt_at = now() + ($3 || ' minutes')::interval WHERE key = $1 AND status = 'pending'`,
      [row.key, attempts, String(backoffMinutes(attempts))],
    );
    try {
      await emit(ctx, row.company_id, row.event, row.payload);
      emitted += 1;
    } catch (error) {
      await ctx.db.execute(`UPDATE ${ns(ctx)}.outbox SET last_error = $2 WHERE key = $1`, [row.key, error instanceof Error ? error.message : String(error)]);
    }
  }
  return { emitted, failed };
}

/**
 * Record the receiver's answer. `failed` stops retries (permanent failure);
 * anything else marks it done. Returns the row when this call settled it,
 * null when it was already settled or unknown (so side effects run once).
 */
export async function settleOutbox(
  ctx: PluginContext,
  key: string,
  result: Record<string, unknown>,
  status: "done" | "failed" = "done",
): Promise<OutboxRow | null> {
  const rows = await ctx.db.query<OutboxRow>(
    `SELECT key, company_id, event, payload, status, attempts, last_error, result FROM ${ns(ctx)}.outbox WHERE key = $1`,
    [key],
  );
  const row = rows[0];
  // A late success may settle a row that had been given up on (e.g. posted after a retry).
  if (!row || (row.status !== "pending" && !(row.status === "failed" && status === "done"))) return null;
  const res = await ctx.db.execute(
    `UPDATE ${ns(ctx)}.outbox SET status = $2, result = $3::jsonb, settled_at = now(), last_error = $4 WHERE key = $1 AND status = '${row.status === "failed" ? "failed" : "pending"}'`,
    [key, status, JSON.stringify(result), status === "failed" ? String(result.error ?? "failed") : null],
  );
  return (res.rowCount ?? 0) > 0 ? { ...row, status, result } : null;
}

/** Retry a failed request by hand (e.g. after reconnecting Gmail). */
export async function retryOutbox(ctx: PluginContext, key: string): Promise<boolean> {
  const res = await ctx.db.execute(
    `UPDATE ${ns(ctx)}.outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, settled_at = NULL WHERE key = $1 AND status = 'failed'`,
    [key],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function outboxStatus(ctx: PluginContext, key: string): Promise<OutboxRow | null> {
  const rows = await ctx.db.query<OutboxRow>(
    `SELECT key, company_id, event, payload, status, attempts, last_error, result FROM ${ns(ctx)}.outbox WHERE key = $1`,
    [key],
  );
  return rows[0] ?? null;
}

/**
 * Receiver side: run `handler` once per key. A repeat delivery returns the
 * stored result without running the handler again. When the handler throws,
 * nothing is stored, so the sender's retry runs it again.
 */
export async function receiveOnce<T extends Record<string, unknown>>(
  ctx: PluginContext,
  companyId: string,
  event: string,
  key: string,
  handler: () => Promise<T>,
): Promise<{ result: T; repeat: boolean }> {
  const seen = await ctx.db.query<{ result: T | null }>(`SELECT result FROM ${ns(ctx)}.inbox WHERE key = $1`, [key]);
  if (seen[0]?.result) return { result: seen[0].result, repeat: true };
  const result = await handler();
  await ctx.db.execute(
    `INSERT INTO ${ns(ctx)}.inbox (key, company_id, event, result) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (key) DO UPDATE SET result = EXCLUDED.result`,
    [key, companyId, event, JSON.stringify(result)],
  );
  return { result, repeat: false };
}
