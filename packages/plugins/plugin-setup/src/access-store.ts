/**
 * Setup's access tables (migration 004; PAR-12578 plan, 4.1, 4.2 and 4.4).
 *
 * `rev` goes up by one in the same statement as the change it counts, so two
 * changes at the same time can never end on the same `rev`.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isAccessMode, type AccessMode } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "./namespace.js";

const T = {
  settings: `${NAMESPACE}.access_settings`,
  sync: `${NAMESPACE}.access_sync`,
  refusals: `${NAMESPACE}.access_refusals`,
};

/** Refusals kept per company; the oldest go on insert. */
export const MAX_REFUSALS_PER_COMPANY = 500;

export interface AccessSettings {
  companyId: string;
  mode: AccessMode;
  rev: number;
  grantedUserIds: string[];
  updatedAt: string;
  updatedBy: string | null;
}

export interface AccessSyncRow {
  companyId: string;
  pluginKey: string;
  rev: number;
  syncedAt: string;
}

export interface AccessRefusal {
  companyId: string;
  pluginKey: string;
  userId: string | null;
  key: string;
  permission: string | null;
  viaAgentId: string | null;
  createdAt: string;
}

type Raw = Record<string, unknown>;
type Db = Pick<PluginContext, "db">;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? "" : String(v));
const text = (v: unknown) => (v == null ? null : String(v));

function ids(value: unknown): string[] {
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  return Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === "string" && x.length > 0))] : [];
}

function toSettings(row: Raw): AccessSettings {
  const mode = String(row.mode);
  return {
    companyId: String(row.company_id),
    // The CHECK constraint holds the mode; an unknown one is read as the strictest.
    mode: isAccessMode(mode) ? mode : "enforce",
    rev: Number(row.rev),
    grantedUserIds: ids(row.granted_user_ids),
    updatedAt: iso(row.updated_at),
    updatedBy: text(row.updated_by),
  };
}

const SETTINGS_COLUMNS = "company_id, mode, rev, granted_user_ids, updated_at, updated_by";

/** The company's row, or null when nothing was ever saved (read as `off`, rev 0). */
export async function getAccessSettings(ctx: Db, companyId: string): Promise<AccessSettings | null> {
  const rows = await ctx.db.query<Raw>(`SELECT ${SETTINGS_COLUMNS} FROM ${T.settings} WHERE company_id = $1`, [companyId]);
  return rows[0] ? toSettings(rows[0]) : null;
}

export async function listAccessSettings(ctx: Db): Promise<AccessSettings[]> {
  const rows = await ctx.db.query<Raw>(`SELECT ${SETTINGS_COLUMNS} FROM ${T.settings} ORDER BY company_id`);
  return rows.map(toSettings);
}

/**
 * Puts the person on the grant list without touching `rev`. Called before the
 * grant is saved; an id with no grant is skipped when the payload is built.
 */
export async function addGrantedUser(ctx: Db, companyId: string, userId: string, by: string, now: string): Promise<void> {
  const one = JSON.stringify([userId]);
  await ctx.db.execute(
    `INSERT INTO ${T.settings} (company_id, mode, rev, granted_user_ids, updated_at, updated_by) VALUES ($1, 'off', 0, $2::jsonb, $3, $4)
     ON CONFLICT (company_id) DO UPDATE SET granted_user_ids = ${T.settings}.granted_user_ids || EXCLUDED.granted_user_ids, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
     WHERE NOT ${T.settings}.granted_user_ids @> EXCLUDED.granted_user_ids`,
    [companyId, one, now, by],
  );
}

/** One grant change is complete: `rev` + 1. Returns the new `rev`. */
export async function bumpAccessRev(ctx: Db, companyId: string, by: string, now: string): Promise<number> {
  return returnRev(ctx, companyId, `UPDATE ${T.settings} SET rev = rev + 1, updated_at = $2, updated_by = $3 WHERE company_id = $1`, [companyId, now, by]);
}

/** Takes the person off the grant list and counts the change (`rev` + 1). Called after the grant was removed. */
export async function removeGrantedUser(ctx: Db, companyId: string, userId: string, by: string, now: string): Promise<number> {
  return returnRev(
    ctx,
    companyId,
    `UPDATE ${T.settings} SET granted_user_ids = granted_user_ids - $2::text, rev = rev + 1, updated_at = $3, updated_by = $4 WHERE company_id = $1`,
    [companyId, userId, now, by],
  );
}

/** Sets the switch and counts the change (`rev` + 1). The checks around it belong to the caller. */
export async function setAccessMode(ctx: Db, companyId: string, mode: AccessMode, by: string, now: string): Promise<number> {
  return returnRev(
    ctx,
    companyId,
    `INSERT INTO ${T.settings} (company_id, mode, rev, granted_user_ids, updated_at, updated_by) VALUES ($1, $2, 1, '[]'::jsonb, $3, $4)
     ON CONFLICT (company_id) DO UPDATE SET mode = EXCLUDED.mode, rev = ${T.settings}.rev + 1, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [companyId, mode, now, by],
  );
}

/** ctx.db.execute returns no rows, so the `rev` is read back (a change made at the same time may already be in it). */
async function returnRev(ctx: Db, companyId: string, sql: string, params: unknown[]): Promise<number> {
  await ctx.db.execute(sql, params);
  const row = await getAccessSettings(ctx, companyId);
  return row?.rev ?? 0;
}

// ---------------------------------------------------------------------------
// Confirmations

/** Keeps the highest `rev` a plugin confirmed; an older confirmation arriving late changes nothing. */
export async function recordAccessSync(ctx: Db, row: AccessSyncRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.sync} (company_id, plugin_key, rev, synced_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, plugin_key) DO UPDATE SET rev = EXCLUDED.rev, synced_at = EXCLUDED.synced_at WHERE ${T.sync}.rev <= EXCLUDED.rev`,
    [row.companyId, row.pluginKey, row.rev, row.syncedAt],
  );
}

export async function listAccessSync(ctx: Db, companyId: string): Promise<AccessSyncRow[]> {
  const rows = await ctx.db.query<Raw>(`SELECT company_id, plugin_key, rev, synced_at FROM ${T.sync} WHERE company_id = $1 ORDER BY plugin_key`, [companyId]);
  return rows.map((row) => ({ companyId: String(row.company_id), pluginKey: String(row.plugin_key), rev: Number(row.rev), syncedAt: iso(row.synced_at) }));
}

// ---------------------------------------------------------------------------
// Refusals

/** Stores one refusal and drops the company's oldest beyond the last 500. */
export async function recordAccessRefusal(ctx: Db, row: AccessRefusal): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.refusals} (company_id, plugin_key, user_id, key, permission, via_agent_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [row.companyId, row.pluginKey, row.userId, row.key, row.permission, row.viaAgentId, row.createdAt],
  );
  await ctx.db.execute(
    `DELETE FROM ${T.refusals} WHERE company_id = $1 AND id NOT IN (
       SELECT id FROM ${T.refusals} WHERE company_id = $1 ORDER BY created_at DESC, id DESC LIMIT ${MAX_REFUSALS_PER_COMPANY})`,
    [row.companyId],
  );
}

/** Newest first. */
export async function listAccessRefusals(ctx: Db, companyId: string, limit = MAX_REFUSALS_PER_COMPANY): Promise<AccessRefusal[]> {
  const rows = await ctx.db.query<Raw>(
    `SELECT company_id, plugin_key, user_id, key, permission, via_agent_id, created_at FROM ${T.refusals} WHERE company_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [companyId, Math.max(1, Math.min(MAX_REFUSALS_PER_COMPANY, Math.floor(limit)))],
  );
  return rows.map((row) => ({
    companyId: String(row.company_id),
    pluginKey: String(row.plugin_key),
    userId: text(row.user_id),
    key: String(row.key),
    permission: text(row.permission),
    viaAgentId: text(row.via_agent_id),
    createdAt: iso(row.created_at),
  }));
}
