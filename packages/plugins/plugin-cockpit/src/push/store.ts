/**
 * Push notification store: subscriptions, rate limiting, and delivery log.
 * All operations are scoped by company and/or user when applicable.
 */

import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../namespace.js";
import { PUSH_SPIKE_NAMESPACE, VAPID_KEY_STATE_KEY } from "./keys.js";

const T = {
  keys: `${NAMESPACE}.push_keys`,
  subscriptions: `${NAMESPACE}.push_subscriptions`,
  log: `${NAMESPACE}.push_log`,
  rate: `${NAMESPACE}.push_rate`,
  seenAssignee: `${NAMESPACE}.push_seen_assignee`,
};

type Raw = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface PushSubscription {
  id: string;
  companyId: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceLabel: string | null;
  createdAt: string;
  lastOkAt: string | null;
  lastError: string | null;
  state: "ok" | "muted" | "needs_resubscribe";
}

function subscriptionFrom(row: Raw): PushSubscription {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    userId: String(row.user_id),
    endpoint: String(row.endpoint),
    p256dh: String(row.p256dh),
    auth: String(row.auth),
    deviceLabel: row.device_label ? String(row.device_label) : null,
    createdAt: String(row.created_at),
    lastOkAt: row.last_ok_at ? String(row.last_ok_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    state: String(row.state) as "ok" | "muted" | "needs_resubscribe",
  };
}

export async function upsertSubscription(
  ctx: PluginContext,
  opts: { companyId: string; userId: string; endpoint: string; p256dh: string; auth: string; deviceLabel?: string | null },
): Promise<PushSubscription> {
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${T.subscriptions} (id, company_id, user_id, endpoint, p256dh, auth, device_label, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'ok')
     ON CONFLICT (endpoint) DO UPDATE SET
       company_id = $2, user_id = $3, p256dh = $5, auth = $6,
       device_label = $7, state = 'ok', last_error = NULL, updated_at = now()`,
    [id, opts.companyId, opts.userId, opts.endpoint, opts.p256dh, opts.auth, opts.deviceLabel ?? null],
  );
  const rows = await ctx.db.query<Raw>(
    `SELECT id, company_id, user_id, endpoint, p256dh, auth, device_label, created_at, last_ok_at, last_error, state, updated_at
     FROM ${T.subscriptions} WHERE endpoint = $1`,
    [opts.endpoint],
  );
  if (!rows[0]) {
    throw new Error("Failed to read upserted subscription");
  }
  return subscriptionFrom(rows[0]!);
}

export async function listSubscriptionsForUser(ctx: PluginContext, companyId: string, userId: string): Promise<PushSubscription[]> {
  const rows = await ctx.db.query<Raw>(
    `SELECT id, company_id, user_id, endpoint, p256dh, auth, device_label, created_at, last_ok_at, last_error, state
     FROM ${T.subscriptions} WHERE company_id = $1 AND user_id = $2`,
    [companyId, userId],
  );
  return rows.map(subscriptionFrom);
}

export async function deleteSubscription(ctx: PluginContext, companyId: string, userId: string, endpoint: string): Promise<boolean> {
  const res = await ctx.db.execute(`DELETE FROM ${T.subscriptions} WHERE company_id = $1 AND user_id = $2 AND endpoint = $3`, [companyId, userId, endpoint]);
  return (res.rowCount ?? 0) > 0;
}

export async function setSubscriptionState(ctx: PluginContext, endpoint: string, state: "ok" | "muted" | "needs_resubscribe", lastError?: string | null): Promise<boolean> {
  if (!["ok", "muted", "needs_resubscribe"].includes(state)) {
    throw new Error(`Invalid state: ${state}`);
  }
  const res = await ctx.db.execute(
    `UPDATE ${T.subscriptions} SET state = $1, last_error = $2, updated_at = now() WHERE endpoint = $3`,
    [state, lastError ?? null, endpoint],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function markSubscriptionOk(ctx: PluginContext, endpoint: string): Promise<boolean> {
  const res = await ctx.db.execute(
    `UPDATE ${T.subscriptions} SET state = 'ok', last_ok_at = now(), last_error = NULL, updated_at = now() WHERE endpoint = $1`,
    [endpoint],
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Push Log
// ---------------------------------------------------------------------------

export interface PushLogEntry {
  id: string;
  companyId: string;
  class: string;
  issueRef: string | null;
  title: string | null;
  status: "sent" | "collapsed" | "deferred" | "dropped" | "capped";
  createdAt: string;
}

export async function appendPushLog(
  ctx: PluginContext,
  opts: { companyId: string; class: string; issueRef?: string | null; title?: string | null; status: "sent" | "collapsed" | "deferred" | "dropped" | "capped"; createdAt?: Date | null },
): Promise<void> {
  const id = randomUUID();
  const createdAt = opts.createdAt ? opts.createdAt.toISOString() : new Date().toISOString();
  await ctx.db.execute(
    `INSERT INTO ${T.log} (id, company_id, class, issue_ref, title, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, opts.companyId, opts.class, opts.issueRef ?? null, opts.title ?? null, opts.status, createdAt],
  );
}

export async function countPushLog(ctx: PluginContext, companyId: string, status: string, since: Date): Promise<number> {
  const rows = await ctx.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${T.log} WHERE company_id = $1 AND status = $2 AND created_at >= $3`,
    [companyId, status, since.toISOString()],
  );
  return rows[0] ? Number(rows[0].n) : 0;
}

export async function listRecentPushLog(ctx: PluginContext, companyId: string, since: Date): Promise<PushLogEntry[]> {
  const rows = await ctx.db.query<Raw>(
    `SELECT id, company_id, class, issue_ref, title, status, created_at FROM ${T.log}
     WHERE company_id = $1 AND created_at >= $2
     ORDER BY created_at DESC`,
    [companyId, since.toISOString()],
  );
  return rows.map((row) => ({
    id: String(row.id),
    companyId: String(row.company_id),
    class: String(row.class),
    issueRef: row.issue_ref ? String(row.issue_ref) : null,
    title: row.title ? String(row.title) : null,
    status: String(row.status) as "sent" | "collapsed" | "deferred" | "dropped" | "capped",
    createdAt: String(row.created_at),
  }));
}

// ---------------------------------------------------------------------------
// Rate Limiting
// ---------------------------------------------------------------------------

export async function takeRateSlot(ctx: PluginContext, key: string, windowStart: Date, cap: number): Promise<boolean> {
  // First, try to insert a new row if it doesn't exist
  await ctx.db.execute(`INSERT INTO ${T.rate} (key, window_start, n) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`, [key, windowStart.toISOString()]);

  // Then, try to increment n if it's still under cap
  const res = await ctx.db.execute(`UPDATE ${T.rate} SET n = n + 1 WHERE key = $1 AND window_start = $2 AND n < $3`, [key, windowStart.toISOString(), cap]);

  return (res.rowCount ?? 0) === 1;
}

// ---------------------------------------------------------------------------
// VAPID Keys
// ---------------------------------------------------------------------------

export interface VapidKey {
  publicKey: string;
  privateKey: string;
  created: boolean;
}

export async function createKeyIfAbsent(ctx: PluginContext, opts: { publicKey: string; privateKey: string }): Promise<VapidKey> {
  // Try to insert; first writer wins
  const res = await ctx.db.execute(`INSERT INTO ${T.keys} (id, public_key, private_key) VALUES ('vapid', $1, $2) ON CONFLICT DO NOTHING`, [opts.publicKey, opts.privateKey]);

  // Read the stored key
  const rows = await ctx.db.query<Raw>(`SELECT public_key, private_key FROM ${T.keys} WHERE id = 'vapid'`, []);

  if (!rows[0]) {
    throw new Error("Failed to read stored VAPID key");
  }

  const storedKey = rows[0];
  const created = (res.rowCount ?? 0) === 1;

  return {
    publicKey: String(storedKey.public_key),
    privateKey: String(storedKey.private_key),
    created,
  };
}

export async function getKey(ctx: PluginContext): Promise<VapidKey | null> {
  const rows = await ctx.db.query<Raw>(`SELECT public_key, private_key FROM ${T.keys} WHERE id = 'vapid'`, []);

  if (!rows[0]) {
    return null;
  }

  return {
    publicKey: String(rows[0].public_key),
    privateKey: String(rows[0].private_key),
    created: false, // When reading existing key, created is always false
  };
}

export async function importSpikeKey(ctx: PluginContext): Promise<{ imported: boolean }> {
  const spikeKey = await ctx.state.get({
    scopeKind: "instance",
    namespace: PUSH_SPIKE_NAMESPACE,
    stateKey: VAPID_KEY_STATE_KEY,
  });

  if (!spikeKey || typeof spikeKey !== "object") {
    return { imported: false };
  }

  const key = spikeKey as Record<string, unknown>;
  if (typeof key.publicKey !== "string" || typeof key.privateKey !== "string") {
    return { imported: false };
  }

  const result = await createKeyIfAbsent(ctx, { publicKey: key.publicKey, privateKey: key.privateKey });
  return { imported: result.created };
}

// ---------------------------------------------------------------------------
// Seen Assignee
// ---------------------------------------------------------------------------

export async function upsertSeenAssignee(ctx: PluginContext, companyId: string, issueId: string, assigneeUserId: string | null): Promise<string | null> {
  // Get the previous assignee first
  const prevRows = await ctx.db.query<{ assignee_user_id: string | null }>(
    `SELECT assignee_user_id FROM ${T.seenAssignee} WHERE company_id = $1 AND issue_id = $2`,
    [companyId, issueId],
  );
  const prevAssignee = prevRows[0]?.assignee_user_id ?? null;

  // Upsert the new value
  await ctx.db.execute(
    `INSERT INTO ${T.seenAssignee} (company_id, issue_id, assignee_user_id) VALUES ($1, $2, $3)
     ON CONFLICT (company_id, issue_id) DO UPDATE SET assignee_user_id = $3, updated_at = now()`,
    [companyId, issueId, assigneeUserId],
  );

  return prevAssignee;
}

export async function getSeenAssignee(ctx: PluginContext, companyId: string, issueId: string): Promise<string | null> {
  const rows = await ctx.db.query<{ assignee_user_id: string | null }>(
    `SELECT assignee_user_id FROM ${T.seenAssignee} WHERE company_id = $1 AND issue_id = $2`,
    [companyId, issueId],
  );
  return rows[0]?.assignee_user_id ?? null;
}
