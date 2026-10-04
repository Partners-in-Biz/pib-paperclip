/**
 * Tables of the site events (migration 012): the write keys and the daily rollup. One statement per call, our own namespace only,
 * scalar params. There is no table of raw events: a count is added to a daily row and nothing finer is kept.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { asStringList, table } from "./db.js";
import { CONSENT_MODES, EVENT_KEY_STATUSES, type ConsentMode, type EventKeyStatus } from "./site-events-form.js";
import type { ClientKind } from "./refs.js";

function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

const int = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

export interface EventKey {
  id: string;
  companyId: string;
  /** Null for our own site: its counts are ours. */
  clientKind: ClientKind | null;
  clientRef: string | null;
  label: string;
  siteId: string | null;
  siteUrl: string | null;
  /** The site's own hosts: a referrer from one of them is not a referral, and an event from another host is refused. */
  hosts: string[];
  writeKey: string;
  previousKey: string | null;
  previousKeyUntil: string | null;
  status: EventKeyStatus;
  canary: boolean;
  consentMode: ConsentMode;
  rateLimitPerHour: number;
  acceptedCount: number;
  rejectedCount: number;
  lastEventAt: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

interface KeyRow {
  id: string;
  company_id: string;
  client_kind: string | null;
  client_ref: string | null;
  label: string;
  site_id: string | null;
  site_url: string | null;
  hosts: unknown;
  write_key: string;
  previous_key: string | null;
  previous_key_until: unknown;
  status: string;
  canary: boolean | null;
  consent_mode: string;
  rate_limit_per_hour: unknown;
  accepted_count: unknown;
  rejected_count: unknown;
  last_event_at: unknown;
  created_by: string | null;
  created_at: unknown;
}

const KEY_COLUMNS = `id, company_id, client_kind, client_ref, label, site_id, site_url, hosts, write_key, previous_key, previous_key_until, status, canary,
  consent_mode, rate_limit_per_hour, accepted_count, rejected_count, last_event_at, created_by, created_at`;

function mapKey(row: KeyRow): EventKey {
  return {
    id: row.id,
    companyId: row.company_id,
    clientKind: row.client_kind === "company" || row.client_kind === "contact" ? row.client_kind : null,
    clientRef: row.client_ref ?? null,
    label: row.label,
    siteId: row.site_id ?? null,
    siteUrl: row.site_url ?? null,
    hosts: asStringList(row.hosts),
    writeKey: row.write_key,
    previousKey: row.previous_key ?? null,
    previousKeyUntil: iso(row.previous_key_until),
    status: (EVENT_KEY_STATUSES as readonly string[]).includes(row.status) ? (row.status as EventKeyStatus) : "active",
    canary: row.canary === true,
    consentMode: (CONSENT_MODES as readonly string[]).includes(row.consent_mode) ? (row.consent_mode as ConsentMode) : "anonymous",
    rateLimitPerHour: int(row.rate_limit_per_hour) || 3000,
    acceptedCount: int(row.accepted_count),
    rejectedCount: int(row.rejected_count),
    lastEventAt: iso(row.last_event_at),
    createdBy: row.created_by ?? null,
    createdAt: iso(row.created_at),
  };
}

export type NewEventKey = Omit<EventKey, "previousKey" | "previousKeyUntil" | "acceptedCount" | "rejectedCount" | "lastEventAt" | "createdAt">;

export async function insertEventKey(ctx: PluginContext, key: NewEventKey): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "event_keys")}
      (id, company_id, client_kind, client_ref, label, site_id, site_url, hosts, write_key, status, canary, consent_mode, rate_limit_per_hour, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14)`,
    [key.id, key.companyId, key.clientKind, key.clientRef, key.label, key.siteId, key.siteUrl, JSON.stringify(key.hosts), key.writeKey, key.status, key.canary, key.consentMode, key.rateLimitPerHour, key.createdBy],
  );
}

export async function getEventKey(ctx: PluginContext, companyId: string, id: string): Promise<EventKey | null> {
  const rows = await ctx.db.query<KeyRow>(`SELECT ${KEY_COLUMNS} FROM ${table(ctx, "event_keys")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return rows[0] ? mapKey(rows[0]) : null;
}

/** The key a write key belongs to: its current key, else one it was rotated away from (valid during the grace period). */
export async function findEventKey(ctx: PluginContext, writeKey: string, now: Date = new Date()): Promise<EventKey | null> {
  const current = await ctx.db.query<KeyRow>(`SELECT ${KEY_COLUMNS} FROM ${table(ctx, "event_keys")} WHERE write_key = $1 LIMIT 1`, [writeKey]);
  if (current[0]) return mapKey(current[0]);
  const previous = await ctx.db.query<KeyRow>(`SELECT ${KEY_COLUMNS} FROM ${table(ctx, "event_keys")} WHERE previous_key = $1 LIMIT 1`, [writeKey]);
  const row = previous[0] ? mapKey(previous[0]) : null;
  if (!row?.previousKeyUntil || Date.parse(row.previousKeyUntil) <= now.getTime()) return null;
  return row;
}

export async function listEventKeys(ctx: PluginContext, companyId: string, scope?: { kind: ClientKind; id: string } | "own"): Promise<EventKey[]> {
  const rows =
    scope && scope !== "own"
      ? await ctx.db.query<KeyRow>(`SELECT ${KEY_COLUMNS} FROM ${table(ctx, "event_keys")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 ORDER BY created_at LIMIT 200`, [companyId, scope.kind, scope.id])
      : scope === "own"
        ? await ctx.db.query<KeyRow>(`SELECT ${KEY_COLUMNS} FROM ${table(ctx, "event_keys")} WHERE company_id = $1 AND client_kind IS NULL ORDER BY created_at LIMIT 200`, [companyId])
        : await ctx.db.query<KeyRow>(`SELECT ${KEY_COLUMNS} FROM ${table(ctx, "event_keys")} WHERE company_id = $1 ORDER BY created_at LIMIT 500`, [companyId]);
  return rows.map(mapKey);
}

/** Rewrites what a person or agent may change (never the counters or the keys). */
export async function saveEventKeySettings(ctx: PluginContext, key: Pick<EventKey, "companyId" | "id" | "label" | "status" | "consentMode" | "hosts" | "siteId" | "siteUrl" | "rateLimitPerHour">): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "event_keys")} SET label = $3, status = $4, consent_mode = $5, hosts = $6::jsonb, site_id = $7, site_url = $8, rate_limit_per_hour = $9, updated_at = now() WHERE company_id = $1 AND id = $2`,
    [key.companyId, key.id, key.label, key.status, key.consentMode, JSON.stringify(key.hosts), key.siteId, key.siteUrl, key.rateLimitPerHour],
  );
}

export async function saveRotatedEventKey(ctx: PluginContext, input: { companyId: string; id: string; writeKey: string; previousKey: string; previousKeyUntil: string }): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "event_keys")} SET write_key = $3, previous_key = $4, previous_key_until = $5::timestamptz, updated_at = now() WHERE company_id = $1 AND id = $2`,
    [input.companyId, input.id, input.writeKey, input.previousKey, input.previousKeyUntil],
  );
}

/** Counts a request on its key. */
export async function bumpEventKey(ctx: PluginContext, id: string, accepted: number, rejected: number): Promise<void> {
  if (accepted > 0) await ctx.db.execute(`UPDATE ${table(ctx, "event_keys")} SET accepted_count = accepted_count + ${Math.max(1, Math.trunc(accepted))}, last_event_at = now() WHERE id = $1`, [id]);
  else if (rejected > 0) await ctx.db.execute(`UPDATE ${table(ctx, "event_keys")} SET rejected_count = rejected_count + ${Math.max(1, Math.trunc(rejected))} WHERE id = $1`, [id]);
}

// ---------------------------------------------------------------------------
// The daily rollup
// ---------------------------------------------------------------------------

export interface RollupRow {
  day: string;
  kind: string;
  name: string;
  channel: string;
  firstChannel: string;
  n: number;
}

export interface RollupKey {
  companyId: string;
  keyId: string;
  day: string;
  kind: string;
  name: string;
  channel: string;
  firstChannel: string;
}

/**
 * Adds one to a daily count. An update first (the common case), then an insert for the first event of the day, then an update again if
 * another request inserted the row in between: no statement here depends on the database's upsert, so the same code runs everywhere.
 */
export async function bumpRollup(ctx: PluginContext, row: RollupKey, by = 1): Promise<void> {
  const step = Math.max(1, Math.trunc(by));
  const where = `company_id = $1 AND key_id = $2 AND day = $3 AND kind = $4 AND name = $5 AND channel = $6 AND first_channel = $7`;
  const params = [row.companyId, row.keyId, row.day, row.kind, row.name, row.channel, row.firstChannel];
  const update = () => ctx.db.execute(`UPDATE ${table(ctx, "site_event_daily")} SET n = n + ${step}, updated_at = now() WHERE ${where}`, params);
  if (((await update())?.rowCount ?? 0) > 0) return;
  const inserted = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "site_event_daily")} (company_id, key_id, day, kind, name, channel, first_channel, n)
     VALUES ($1, $2, $3, $4, $5, $6, $7, ${step})
     ON CONFLICT (company_id, key_id, day, kind, name, channel, first_channel) DO NOTHING`,
    params,
  );
  if ((inserted?.rowCount ?? 0) === 0) await update();
}

interface DailyDbRow {
  day: string;
  kind: string;
  name: string;
  channel: string;
  first_channel: string;
  n: unknown;
}

/** The names already used for a kind on a day (to cap how many distinct ones a site can create). */
export async function namesOnDay(ctx: PluginContext, companyId: string, keyId: string, day: string, kind: string): Promise<Set<string>> {
  const rows = await ctx.db.query<{ name: string }>(`SELECT name FROM ${table(ctx, "site_event_daily")} WHERE company_id = $1 AND key_id = $2 AND day = $3 AND kind = $4 LIMIT 400`, [companyId, keyId, day, kind]);
  return new Set(rows.map((row) => row.name));
}

/** Every daily row of a key in `[from, to)` (days as `YYYY-MM-DD`). */
export async function rollupRows(ctx: PluginContext, companyId: string, keyId: string, from: string, to: string): Promise<RollupRow[]> {
  const rows = await ctx.db.query<DailyDbRow>(
    `SELECT day, kind, name, channel, first_channel, n FROM ${table(ctx, "site_event_daily")} WHERE company_id = $1 AND key_id = $2 AND day >= $3 AND day < $4 ORDER BY day LIMIT 20000`,
    [companyId, keyId, from, to],
  );
  return rows.map((row) => ({ day: String(row.day).slice(0, 10), kind: row.kind, name: row.name ?? "", channel: row.channel ?? "", firstChannel: row.first_channel ?? "", n: int(row.n) }));
}

/** Daily rows older than `beforeDay` go (the hourly job). */
export async function purgeRollup(ctx: PluginContext, beforeDay: string): Promise<void> {
  await ctx.db.execute(`DELETE FROM ${table(ctx, "site_event_daily")} WHERE day < $1`, [beforeDay]);
}

/** Everything the site events hold for a client that is being deleted: its keys (so the public key stops counting) and every count. Idempotent. */
export async function deleteEventDataOfClient(ctx: PluginContext, companyId: string, kind: ClientKind, ref: string): Promise<{ keys: number }> {
  const keys = await listEventKeys(ctx, companyId, { kind, id: ref });
  for (const key of keys) {
    await ctx.db.execute(`DELETE FROM ${table(ctx, "site_event_daily")} WHERE company_id = $1 AND key_id = $2`, [companyId, key.id]);
    await ctx.db.execute(`DELETE FROM ${table(ctx, "public_hits")} WHERE scope = 'ev' AND subject = $1`, [key.id]);
    await ctx.db.execute(`DELETE FROM ${table(ctx, "event_keys")} WHERE company_id = $1 AND id = $2`, [companyId, key.id]);
  }
  return { keys: keys.length };
}

