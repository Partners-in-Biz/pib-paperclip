/**
 * Every SQL statement of the plugin. One statement per call, fully qualified by the plugin namespace, every query scoped by company_id.
 * Parameters are scalars or JSON text (the host JSON-encodes params, so a list goes in as `$n::jsonb`).
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { dayOf, isoTime } from "./dates.js";
import { toInt, toNum } from "./money.js";
import { OWN_SCOPE, type AlertKind, type ProposalKind, type ProposalStatus, type ScopeKey, type StoredPlatform } from "./platforms.js";

export function table(ctx: PluginContext, name: string): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace) || !/^[a-z_]+$/.test(name)) throw new Error("Unsafe identifier");
  return `${ctx.db.namespace}.${name}`;
}

const json = (value: unknown): string => JSON.stringify(value ?? null);

// ── scopes ──────────────────────────────────────────────────────────────────

export interface ScopeRow {
  company_id: string;
  scope_key: ScopeKey;
  client_kind: string | null;
  client_ref: string | null;
  currency: string;
  monthly_cap_minor: number | null;
  alert_pct: number;
  target_cpa_minor: number | null;
  allow_writes: boolean;
  allow_writes_by: string | null;
  allow_writes_at: string | null;
  signoffs: "owner" | "owner_client";
  banned_words: string[];
  brand_note: string | null;
  brand_updated_at: string | null;
  created_at: string | null;
}

function scopeRow(r: Record<string, unknown>): ScopeRow {
  return {
    company_id: String(r.company_id),
    scope_key: String(r.scope_key),
    client_kind: (r.client_kind as string | null) ?? null,
    client_ref: (r.client_ref as string | null) ?? null,
    currency: String(r.currency),
    monthly_cap_minor: r.monthly_cap_minor === null || r.monthly_cap_minor === undefined ? null : toInt(r.monthly_cap_minor),
    alert_pct: toInt(r.alert_pct) || 90,
    target_cpa_minor: r.target_cpa_minor === null || r.target_cpa_minor === undefined ? null : toInt(r.target_cpa_minor),
    allow_writes: r.allow_writes === true,
    allow_writes_by: (r.allow_writes_by as string | null) ?? null,
    allow_writes_at: isoTime(r.allow_writes_at),
    signoffs: r.signoffs === "owner_client" ? "owner_client" : "owner",
    banned_words: Array.isArray(r.banned_words) ? (r.banned_words as unknown[]).filter((w): w is string => typeof w === "string") : [],
    brand_note: (r.brand_note as string | null) ?? null,
    brand_updated_at: isoTime(r.brand_updated_at),
    created_at: isoTime(r.created_at),
  };
}

export async function getScope(ctx: PluginContext, companyId: string, scopeKey: ScopeKey): Promise<ScopeRow | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "scopes")} WHERE company_id = $1 AND scope_key = $2 LIMIT 1`, [companyId, scopeKey]);
  return rows[0] ? scopeRow(rows[0]) : null;
}

export async function listScopes(ctx: PluginContext, companyId: string): Promise<ScopeRow[]> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "scopes")} WHERE company_id = $1 ORDER BY (scope_key = 'own') DESC, scope_key`, [companyId]);
  return rows.map(scopeRow);
}

/** The scope's row, created with safe defaults (no cap, writes off, owner sign-off; a client's scope also asks the client) when it is new. */
export async function ensureScope(ctx: PluginContext, companyId: string, scopeKey: ScopeKey, currency: string): Promise<ScopeRow> {
  const existing = await getScope(ctx, companyId, scopeKey);
  if (existing) return existing;
  const [kind, ref] = scopeKey === OWN_SCOPE ? [null, null] : (scopeKey.split(":") as [string, string]);
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "scopes")} (company_id, scope_key, client_kind, client_ref, currency, signoffs)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (company_id, scope_key) DO NOTHING`,
    [companyId, scopeKey, kind, ref, currency.toUpperCase(), scopeKey === OWN_SCOPE ? "owner" : "owner_client"],
  );
  return (await getScope(ctx, companyId, scopeKey))!;
}

export interface ScopePatch {
  currency?: string;
  monthlyCapMinor?: number | null;
  alertPct?: number;
  targetCpaMinor?: number | null;
  allowWrites?: boolean;
  allowWritesBy?: string | null;
  signoffs?: "owner" | "owner_client";
  bannedWords?: string[];
  brandNote?: string | null;
}

export async function updateScope(ctx: PluginContext, companyId: string, scopeKey: ScopeKey, patch: ScopePatch): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [companyId, scopeKey];
  const add = (column: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };
  if (patch.currency !== undefined) add("currency", patch.currency.toUpperCase());
  if (patch.monthlyCapMinor !== undefined) add("monthly_cap_minor", patch.monthlyCapMinor, "::bigint");
  if (patch.alertPct !== undefined) add("alert_pct", patch.alertPct, "::integer");
  if (patch.targetCpaMinor !== undefined) add("target_cpa_minor", patch.targetCpaMinor, "::bigint");
  if (patch.signoffs !== undefined) add("signoffs", patch.signoffs);
  if (patch.bannedWords !== undefined) {
    add("banned_words", json(patch.bannedWords), "::jsonb");
    sets.push("brand_updated_at = now()");
  }
  if (patch.brandNote !== undefined) add("brand_note", patch.brandNote);
  if (patch.allowWrites !== undefined) {
    add("allow_writes", patch.allowWrites, "::boolean");
    add("allow_writes_by", patch.allowWritesBy ?? null, "::text");
    sets.push("allow_writes_at = now()");
  }
  if (sets.length === 0) return;
  await ctx.db.execute(`UPDATE ${table(ctx, "scopes")} SET ${sets.join(", ")}, updated_at = now() WHERE company_id = $1 AND scope_key = $2`, params);
}

export async function setBudgetOverride(ctx: PluginContext, companyId: string, scopeKey: ScopeKey, month: string, capMinor: number, note: string | null, by: string): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "budget_overrides")} (company_id, scope_key, month, cap_minor, note, set_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (company_id, scope_key, month) DO UPDATE SET cap_minor = EXCLUDED.cap_minor, note = EXCLUDED.note, set_by = EXCLUDED.set_by, set_at = now()`,
    [companyId, scopeKey, month, capMinor, note, by],
  );
}

export async function budgetOverrides(ctx: PluginContext, companyId: string, scopeKey: ScopeKey | null): Promise<Array<{ scope_key: string; month: string; cap_minor: number; note: string | null; set_by: string }>> {
  const rows = await ctx.db.query<Record<string, unknown>>(
    scopeKey === null
      ? `SELECT scope_key, month, cap_minor, note, set_by FROM ${table(ctx, "budget_overrides")} WHERE company_id = $1 ORDER BY month DESC LIMIT 200`
      : `SELECT scope_key, month, cap_minor, note, set_by FROM ${table(ctx, "budget_overrides")} WHERE company_id = $1 AND scope_key = $2 ORDER BY month DESC LIMIT 60`,
    scopeKey === null ? [companyId] : [companyId, scopeKey],
  );
  return rows.map((r) => ({ scope_key: String(r.scope_key), month: String(r.month), cap_minor: toInt(r.cap_minor), note: (r.note as string | null) ?? null, set_by: String(r.set_by) }));
}

/** Removes a scope's month-specific caps (a cap is an amount in the scope's currency: it goes when the currency does). */
export async function clearBudgetOverrides(ctx: PluginContext, companyId: string, scopeKey: ScopeKey): Promise<void> {
  await ctx.db.execute(`DELETE FROM ${table(ctx, "budget_overrides")} WHERE company_id = $1 AND scope_key = $2`, [companyId, scopeKey]);
}

/** The cap that applies to a month: that month's override, else the scope's usual one. */
export async function capFor(ctx: PluginContext, companyId: string, scope: ScopeRow, month: string): Promise<number | null> {
  const rows = await ctx.db.query<{ cap_minor: string | number }>(`SELECT cap_minor FROM ${table(ctx, "budget_overrides")} WHERE company_id = $1 AND scope_key = $2 AND month = $3 LIMIT 1`, [companyId, scope.scope_key, month]);
  return rows[0] ? toInt(rows[0].cap_minor) : scope.monthly_cap_minor;
}

// ── connections ─────────────────────────────────────────────────────────────

export interface ConnectionRow {
  id: string;
  company_id: string;
  platform: StoredPlatform;
  label: string;
  mode: "oauth" | "token";
  token_enc: string | null;
  key_version: number | null;
  token_expires_at: string | null;
  scopes: string[];
  can_write: boolean;
  status: "connected" | "expiring" | "needs_reconnect" | "disabled";
  status_detail: string | null;
  external_user_id: string | null;
  reconnect_issue_id: string | null;
  last_ok_at: string | null;
  created_at: string | null;
}

function connectionRow(r: Record<string, unknown>): ConnectionRow {
  return {
    id: String(r.id),
    company_id: String(r.company_id),
    platform: r.platform as ConnectionRow["platform"],
    label: String(r.label),
    mode: r.mode === "token" ? "token" : "oauth",
    token_enc: (r.token_enc as string | null) ?? null,
    key_version: r.key_version === null || r.key_version === undefined ? null : toInt(r.key_version),
    token_expires_at: isoTime(r.token_expires_at),
    scopes: Array.isArray(r.scopes) ? (r.scopes as unknown[]).filter((s): s is string => typeof s === "string") : [],
    can_write: r.can_write === true,
    status: r.status as ConnectionRow["status"],
    status_detail: (r.status_detail as string | null) ?? null,
    external_user_id: (r.external_user_id as string | null) ?? null,
    reconnect_issue_id: (r.reconnect_issue_id as string | null) ?? null,
    last_ok_at: isoTime(r.last_ok_at),
    created_at: isoTime(r.created_at),
  };
}

export async function getConnection(ctx: PluginContext, companyId: string, id: string): Promise<ConnectionRow | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "connections")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return rows[0] ? connectionRow(rows[0]) : null;
}

export async function listConnections(ctx: PluginContext, companyId: string): Promise<ConnectionRow[]> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "connections")} WHERE company_id = $1 AND status <> 'disabled' ORDER BY created_at`, [companyId]);
  return rows.map(connectionRow);
}

export async function companiesWithConnections(ctx: PluginContext): Promise<string[]> {
  const rows = await ctx.db.query<{ company_id: string }>(`SELECT DISTINCT company_id FROM ${table(ctx, "connections")}`);
  return rows.map((r) => r.company_id);
}

export async function insertConnection(
  ctx: PluginContext,
  row: { companyId: string; platform: StoredPlatform; label: string; mode: "oauth" | "token"; tokenEnc: string | null; keyVersion: number | null; expiresAt: string | null; scopes: string[]; canWrite: boolean; externalUserId: string | null; createdBy: string | null },
): Promise<string> {
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "connections")} (id, company_id, platform, label, mode, token_enc, key_version, token_expires_at, scopes, can_write, external_user_id, last_ok_at, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb, $10, $11, now(), $12)`,
    [id, row.companyId, row.platform, row.label, row.mode, row.tokenEnc, row.keyVersion, row.expiresAt, json(row.scopes), row.canWrite, row.externalUserId, row.createdBy],
  );
  return id;
}

export async function updateConnection(
  ctx: PluginContext,
  companyId: string,
  id: string,
  patch: { tokenEnc?: string | null; keyVersion?: number | null; expiresAt?: string | null; status?: ConnectionRow["status"]; statusDetail?: string | null; reconnectIssueId?: string | null; lastOk?: boolean; canWrite?: boolean; scopes?: string[] },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [companyId, id];
  const add = (column: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };
  if (patch.tokenEnc !== undefined) add("token_enc", patch.tokenEnc, "::text");
  if (patch.keyVersion !== undefined) add("key_version", patch.keyVersion, "::integer");
  if (patch.expiresAt !== undefined) add("token_expires_at", patch.expiresAt, "::timestamptz");
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.statusDetail !== undefined) add("status_detail", patch.statusDetail, "::text");
  if (patch.reconnectIssueId !== undefined) add("reconnect_issue_id", patch.reconnectIssueId, "::text");
  if (patch.canWrite !== undefined) add("can_write", patch.canWrite, "::boolean");
  if (patch.scopes !== undefined) add("scopes", json(patch.scopes), "::jsonb");
  if (patch.lastOk) sets.push("last_ok_at = now()");
  if (sets.length === 0) return;
  await ctx.db.execute(`UPDATE ${table(ctx, "connections")} SET ${sets.join(", ")}, updated_at = now() WHERE company_id = $1 AND id = $2`, params);
}

// ── ad accounts ─────────────────────────────────────────────────────────────

export interface AccountRow {
  id: string;
  company_id: string;
  platform: StoredPlatform;
  external_id: string;
  name: string;
  currency: string;
  timezone: string | null;
  scope_key: ScopeKey;
  connection_id: string | null;
  status: "active" | "paused" | "disabled";
  login_customer_id: string | null;
  conversion_actions: string[];
  last_sync_at: string | null;
  last_sync_ok_at: string | null;
  last_sync_error: string | null;
  consecutive_failures: number;
}

function accountRow(r: Record<string, unknown>): AccountRow {
  return {
    id: String(r.id),
    company_id: String(r.company_id),
    platform: r.platform as AccountRow["platform"],
    external_id: String(r.external_id),
    name: String(r.name),
    currency: String(r.currency),
    timezone: (r.timezone as string | null) ?? null,
    scope_key: String(r.scope_key),
    connection_id: (r.connection_id as string | null) ?? null,
    status: r.status as AccountRow["status"],
    login_customer_id: (r.login_customer_id as string | null) ?? null,
    conversion_actions: Array.isArray(r.conversion_actions) ? (r.conversion_actions as unknown[]).filter((s): s is string => typeof s === "string") : [],
    last_sync_at: isoTime(r.last_sync_at),
    last_sync_ok_at: isoTime(r.last_sync_ok_at),
    last_sync_error: (r.last_sync_error as string | null) ?? null,
    consecutive_failures: toInt(r.consecutive_failures),
  };
}

export async function getAccount(ctx: PluginContext, companyId: string, id: string): Promise<AccountRow | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "ad_accounts")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return rows[0] ? accountRow(rows[0]) : null;
}

export async function findAccount(ctx: PluginContext, companyId: string, platform: string, externalId: string): Promise<AccountRow | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "ad_accounts")} WHERE company_id = $1 AND platform = $2 AND external_id = $3 LIMIT 1`, [companyId, platform, externalId]);
  return rows[0] ? accountRow(rows[0]) : null;
}

export async function listAccounts(ctx: PluginContext, companyId: string, options: { scopeKey?: ScopeKey; includeDisabled?: boolean } = {}): Promise<AccountRow[]> {
  const params: unknown[] = [companyId];
  let where = "company_id = $1";
  if (options.scopeKey) {
    params.push(options.scopeKey);
    where += ` AND scope_key = $${params.length}`;
  }
  if (!options.includeDisabled) where += " AND status <> 'disabled'";
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "ad_accounts")} WHERE ${where} ORDER BY scope_key, platform, name`, params);
  return rows.map(accountRow);
}

export async function insertAccount(
  ctx: PluginContext,
  row: { companyId: string; platform: StoredPlatform; externalId: string; name: string; currency: string; timezone: string | null; scopeKey: ScopeKey; connectionId: string | null; loginCustomerId: string | null; createdBy: string },
): Promise<string> {
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "ad_accounts")} (id, company_id, platform, external_id, name, currency, timezone, scope_key, connection_id, login_customer_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, row.companyId, row.platform, row.externalId, row.name, row.currency.toUpperCase(), row.timezone, row.scopeKey, row.connectionId, row.loginCustomerId, row.createdBy],
  );
  return id;
}

export async function updateAccount(
  ctx: PluginContext,
  companyId: string,
  id: string,
  patch: { status?: AccountRow["status"]; name?: string; connectionId?: string | null; conversionActions?: string[]; syncOk?: boolean; syncError?: string | null; failures?: number; at?: string; partial?: boolean },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [companyId, id];
  const add = (column: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.name !== undefined) add("name", patch.name);
  if (patch.connectionId !== undefined) add("connection_id", patch.connectionId, "::text");
  if (patch.conversionActions !== undefined) add("conversion_actions", json(patch.conversionActions), "::jsonb");
  // The moment comes from the caller's clock, so freshness checks compare like with like.
  const at = patch.at ?? new Date().toISOString();
  if (patch.syncOk === true) {
    add("last_sync_at", at, "::timestamptz");
    // A short read (partial) answered, so the connection works, but it did not cover what a full read must: the last GOOD read stays where it was.
    sets.push(...(patch.partial ? [] : [`last_sync_ok_at = $${params.length}::timestamptz`]), "last_sync_error = NULL", "consecutive_failures = 0");
  } else if (patch.syncOk === false) {
    add("last_sync_error", patch.syncError ?? "The sync failed.", "::text");
    add("last_sync_at", at, "::timestamptz");
    sets.push("consecutive_failures = consecutive_failures + 1");
  }
  if (sets.length === 0) return;
  await ctx.db.execute(`UPDATE ${table(ctx, "ad_accounts")} SET ${sets.join(", ")}, updated_at = now() WHERE company_id = $1 AND id = $2`, params);
}

export async function companiesWithAccounts(ctx: PluginContext): Promise<string[]> {
  const rows = await ctx.db.query<{ company_id: string }>(`SELECT DISTINCT company_id FROM ${table(ctx, "ad_accounts")}`);
  return rows.map((r) => r.company_id);
}

// ── campaigns, daily rollups, the ledger ────────────────────────────────────

export interface CampaignRow {
  id: string;
  account_id: string;
  external_id: string;
  name: string;
  status: "active" | "paused" | "archived" | "other";
  raw_status: string | null;
  objective: string | null;
  channel: string | null;
  daily_budget_minor: number | null;
  lifetime_budget_minor: number | null;
  last_seen_at: string | null;
}

function campaignRow(r: Record<string, unknown>): CampaignRow {
  return {
    id: String(r.id),
    account_id: String(r.account_id),
    external_id: String(r.external_id),
    name: String(r.name),
    status: r.status as CampaignRow["status"],
    raw_status: (r.raw_status as string | null) ?? null,
    objective: (r.objective as string | null) ?? null,
    channel: (r.channel as string | null) ?? null,
    daily_budget_minor: r.daily_budget_minor === null || r.daily_budget_minor === undefined ? null : toInt(r.daily_budget_minor),
    lifetime_budget_minor: r.lifetime_budget_minor === null || r.lifetime_budget_minor === undefined ? null : toInt(r.lifetime_budget_minor),
    last_seen_at: isoTime(r.last_seen_at),
  };
}

export async function upsertCampaign(
  ctx: PluginContext,
  companyId: string,
  accountId: string,
  c: { externalId: string; name: string; status: CampaignRow["status"]; rawStatus: string; objective: string | null; channel: string | null; dailyBudgetMinor: number | null; lifetimeBudgetMinor: number | null },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "campaigns")} (id, company_id, account_id, external_id, name, status, raw_status, objective, channel, daily_budget_minor, lifetime_budget_minor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint, $11::bigint)
     ON CONFLICT (account_id, external_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, raw_status = EXCLUDED.raw_status, objective = EXCLUDED.objective,
       channel = EXCLUDED.channel, daily_budget_minor = EXCLUDED.daily_budget_minor, lifetime_budget_minor = EXCLUDED.lifetime_budget_minor, last_seen_at = now()`,
    [randomUUID(), companyId, accountId, c.externalId, c.name, c.status, c.rawStatus, c.objective, c.channel, c.dailyBudgetMinor, c.lifetimeBudgetMinor],
  );
}

export async function getCampaign(ctx: PluginContext, companyId: string, accountId: string, externalId: string): Promise<CampaignRow | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "campaigns")} WHERE company_id = $1 AND account_id = $2 AND external_id = $3 LIMIT 1`, [companyId, accountId, externalId]);
  return rows[0] ? campaignRow(rows[0]) : null;
}

export async function listCampaigns(ctx: PluginContext, companyId: string, options: { accountId?: string; scopeKey?: ScopeKey; status?: string; limit?: number } = {}): Promise<Array<CampaignRow & { scope_key: string; platform: string; currency: string; account_name: string }>> {
  const params: unknown[] = [companyId];
  let where = "c.company_id = $1";
  if (options.accountId) {
    params.push(options.accountId);
    where += ` AND c.account_id = $${params.length}`;
  }
  if (options.scopeKey) {
    params.push(options.scopeKey);
    where += ` AND a.scope_key = $${params.length}`;
  }
  if (options.status) {
    params.push(options.status);
    where += ` AND c.status = $${params.length}`;
  }
  params.push(Math.min(options.limit ?? 200, 500));
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT c.*, a.scope_key, a.platform, a.currency, a.name AS account_name
       FROM ${table(ctx, "campaigns")} c JOIN ${table(ctx, "ad_accounts")} a ON a.id = c.account_id
      WHERE ${where} ORDER BY (c.status = 'active') DESC, c.name LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({ ...campaignRow(r), scope_key: String(r.scope_key), platform: String(r.platform), currency: String(r.currency), account_name: String(r.account_name) }));
}

export interface DailyInput {
  campaignExternalId: string;
  day: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  conversions: number;
  valueMinor: number;
}

/**
 * Writes one day's numbers and, when the spend differs from the last ledger total for it, one ledger entry. The ledger decides from
 * its own last total, not from the rollup's previous value, so a crash between the two statements is repaired by the next sync.
 */
export async function recordDaily(ctx: PluginContext, companyId: string, account: Pick<AccountRow, "id" | "scope_key" | "currency">, row: DailyInput): Promise<{ ledgerEntry: boolean }> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "daily")} (company_id, account_id, campaign_external_id, day, spend_minor, impressions, clicks, conversions, conversion_value_minor, currency, synced_at)
     VALUES ($1, $2, $3, $4::date, $5::bigint, $6::bigint, $7::bigint, $8::numeric, $9::bigint, $10, now())
     ON CONFLICT (account_id, campaign_external_id, day) DO UPDATE SET spend_minor = EXCLUDED.spend_minor, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
       conversions = EXCLUDED.conversions, conversion_value_minor = EXCLUDED.conversion_value_minor, currency = EXCLUDED.currency, synced_at = now()`,
    [companyId, account.id, row.campaignExternalId, row.day, row.spendMinor, row.impressions, row.clicks, row.conversions, row.valueMinor, account.currency],
  );
  const last = await ctx.db.query<{ seq: number | string; total_minor: number | string }>(
    `SELECT seq, total_minor FROM ${table(ctx, "spend_ledger")} WHERE account_id = $1 AND campaign_external_id = $2 AND day = $3::date ORDER BY seq DESC LIMIT 1`,
    [account.id, row.campaignExternalId, row.day],
  );
  const lastTotal = last[0] ? toInt(last[0].total_minor) : 0;
  if (row.spendMinor === lastTotal) return { ledgerEntry: false };
  const seq = (last[0] ? toInt(last[0].seq) : 0) + 1;
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "spend_ledger")} (id, company_id, account_id, scope_key, campaign_external_id, day, seq, delta_minor, total_minor, currency, kind)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8::bigint, $9::bigint, $10, $11)
     ON CONFLICT (account_id, campaign_external_id, day, seq) DO NOTHING`,
    [randomUUID(), companyId, account.id, account.scope_key, row.campaignExternalId, row.day, seq, row.spendMinor - lastTotal, row.spendMinor, account.currency, seq === 1 ? "first" : "restatement"],
  );
  return { ledgerEntry: true };
}

export interface LedgerRow {
  day: string;
  account_id: string;
  campaign_external_id: string;
  seq: number;
  delta_minor: number;
  total_minor: number;
  currency: string;
  kind: string;
  recorded_at: string | null;
  scope_key: string;
}

export async function listLedger(ctx: PluginContext, companyId: string, options: { scopeKey?: ScopeKey; accountId?: string; since?: string; until?: string; limit?: number }): Promise<LedgerRow[]> {
  const params: unknown[] = [companyId];
  let where = "company_id = $1";
  if (options.scopeKey) {
    params.push(options.scopeKey);
    where += ` AND scope_key = $${params.length}`;
  }
  if (options.accountId) {
    params.push(options.accountId);
    where += ` AND account_id = $${params.length}`;
  }
  if (options.since) {
    params.push(options.since);
    where += ` AND day >= $${params.length}::date`;
  }
  if (options.until) {
    params.push(options.until);
    where += ` AND day <= $${params.length}::date`;
  }
  params.push(Math.min(options.limit ?? 100, 500));
  // `day` is read as text: a date column would be turned into a timestamp in whatever timezone the driver runs in.
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT account_id, campaign_external_id, day::text AS day, seq, delta_minor, total_minor, currency, kind, recorded_at, scope_key FROM ${table(ctx, "spend_ledger")} WHERE ${where} ORDER BY day DESC, recorded_at DESC LIMIT $${params.length}`, params);
  return rows.map((r) => ({
    day: dayOf(r.day) ?? "",
    account_id: String(r.account_id),
    campaign_external_id: String(r.campaign_external_id),
    seq: toInt(r.seq),
    delta_minor: toInt(r.delta_minor),
    total_minor: toInt(r.total_minor),
    currency: String(r.currency),
    kind: String(r.kind),
    recorded_at: isoTime(r.recorded_at),
    scope_key: String(r.scope_key),
  }));
}

export type GroupBy = "platform" | "campaign" | "day" | "scope" | "account";

export interface SummaryRow {
  key: string;
  label: string;
  currency: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  value: number;
  scope_key?: string;
  platform?: string;
  account_id?: string;
  campaign_external_id?: string;
}

/** Totals between two days, grouped. Currencies are never mixed: each group is split by currency. */
export async function summaryRows(
  ctx: PluginContext,
  companyId: string,
  options: { since: string; until: string; groupBy: GroupBy; scopeKey?: ScopeKey; platform?: string; accountId?: string },
): Promise<SummaryRow[]> {
  const params: unknown[] = [companyId, options.since, options.until];
  let where = "d.company_id = $1 AND d.day >= $2::date AND d.day <= $3::date AND a.status <> 'disabled'";
  if (options.scopeKey) {
    params.push(options.scopeKey);
    where += ` AND a.scope_key = $${params.length}`;
  }
  if (options.platform) {
    params.push(options.platform);
    where += ` AND a.platform = $${params.length}`;
  }
  if (options.accountId) {
    params.push(options.accountId);
    where += ` AND a.id = $${params.length}`;
  }
  const groups: Record<GroupBy, { key: string; label: string; extra: string; group: string }> = {
    platform: { key: "a.platform", label: "a.platform", extra: "", group: "a.platform" },
    scope: { key: "a.scope_key", label: "a.scope_key", extra: "a.scope_key AS scope_key", group: "a.scope_key" },
    account: { key: "a.id", label: "a.name", extra: "a.id AS account_id, a.platform AS platform, a.scope_key AS scope_key", group: "a.id, a.name, a.platform, a.scope_key" },
    day: { key: "d.day::text", label: "d.day::text", extra: "", group: "d.day" },
    campaign: {
      key: "(d.account_id || ':' || d.campaign_external_id)",
      label: "COALESCE(c.name, d.campaign_external_id)",
      extra: "d.account_id AS account_id, d.campaign_external_id AS campaign_external_id, a.platform AS platform, a.scope_key AS scope_key",
      group: "d.account_id, d.campaign_external_id, c.name, a.platform, a.scope_key",
    },
  };
  const g = groups[options.groupBy];
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT ${g.key} AS key, ${g.label} AS label, d.currency AS currency${g.extra ? `, ${g.extra}` : ""},
            sum(d.spend_minor)::text AS spend, sum(d.impressions)::text AS impressions, sum(d.clicks)::text AS clicks,
            sum(d.conversions)::text AS conversions, sum(d.conversion_value_minor)::text AS value
       FROM ${table(ctx, "daily")} d
       JOIN ${table(ctx, "ad_accounts")} a ON a.id = d.account_id
       LEFT JOIN ${table(ctx, "campaigns")} c ON c.account_id = d.account_id AND c.external_id = d.campaign_external_id
      WHERE ${where}
      GROUP BY ${g.group}, d.currency
      ORDER BY ${options.groupBy === "day" ? "d.day" : "sum(d.spend_minor) DESC"} ${options.groupBy === "day" ? "" : ", 1"}
      LIMIT 500`,
    params,
  );
  return rows.map((r) => ({
    key: String(r.key),
    label: String(r.label),
    currency: String(r.currency),
    spend: toInt(r.spend),
    impressions: toInt(r.impressions),
    clicks: toInt(r.clicks),
    conversions: toNum(r.conversions),
    value: toInt(r.value),
    ...(r.scope_key !== undefined ? { scope_key: String(r.scope_key) } : {}),
    ...(r.platform !== undefined ? { platform: String(r.platform) } : {}),
    ...(r.account_id !== undefined ? { account_id: String(r.account_id) } : {}),
    ...(r.campaign_external_id !== undefined ? { campaign_external_id: String(r.campaign_external_id) } : {}),
  }));
}

export interface DayRow {
  account_id: string;
  campaign_external_id: string;
  day: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  value: number;
}

/** Per-campaign daily rows of an account (or of every account) since a day: what the alert rules read. */
export async function dailyRows(ctx: PluginContext, companyId: string, since: string, accountId?: string): Promise<DayRow[]> {
  const params: unknown[] = [companyId, since];
  let where = "company_id = $1 AND day >= $2::date";
  if (accountId) {
    params.push(accountId);
    where += ` AND account_id = $${params.length}`;
  }
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT account_id, campaign_external_id, day::text AS day, spend_minor, impressions, clicks, conversions, conversion_value_minor FROM ${table(ctx, "daily")} WHERE ${where} ORDER BY day LIMIT 20000`,
    params,
  );
  return rows.map((r) => ({
    account_id: String(r.account_id),
    campaign_external_id: String(r.campaign_external_id),
    day: dayOf(r.day) ?? "",
    spend: toInt(r.spend_minor),
    impressions: toInt(r.impressions),
    clicks: toInt(r.clicks),
    conversions: toNum(r.conversions),
    value: toInt(r.conversion_value_minor),
  }));
}

/** What the pacing maths needs for a scope's month, all in the scope's currency (accounts in another currency are not counted). */
export async function scopeMonthFacts(
  ctx: PluginContext,
  companyId: string,
  scopeKey: ScopeKey,
  currency: string,
  monthStart: string,
  today: string,
): Promise<{ spentMinor: number; spentTodayMinor: number; recentDaily: number[]; committedDailyMinor: number; mismatchedAccounts: number }> {
  const base = `FROM ${table(ctx, "daily")} d JOIN ${table(ctx, "ad_accounts")} a ON a.id = d.account_id
     WHERE d.company_id = $1 AND a.scope_key = $2 AND a.currency = $3 AND a.status <> 'disabled'`;
  const spent = await ctx.db.query<{ spent: string | null; today: string | null }>(
    `SELECT sum(d.spend_minor)::text AS spent, sum(d.spend_minor) FILTER (WHERE d.day = $5::date)::text AS today ${base} AND d.day >= $4::date AND d.day <= $5::date`,
    [companyId, scopeKey, currency, monthStart, today],
  );
  const recent = await ctx.db.query<{ day: string; spend: string }>(
    `SELECT d.day::text AS day, sum(d.spend_minor)::text AS spend ${base} AND d.day >= $4::date AND d.day < $5::date GROUP BY d.day ORDER BY d.day DESC LIMIT 7`,
    [companyId, scopeKey, currency, monthStart, today],
  );
  const committed = await ctx.db.query<{ daily: string | null }>(
    `SELECT sum(c.daily_budget_minor)::text AS daily FROM ${table(ctx, "campaigns")} c JOIN ${table(ctx, "ad_accounts")} a ON a.id = c.account_id
      WHERE c.company_id = $1 AND a.scope_key = $2 AND a.currency = $3 AND a.status = 'active' AND c.status = 'active'`,
    [companyId, scopeKey, currency],
  );
  const mismatched = await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table(ctx, "ad_accounts")} WHERE company_id = $1 AND scope_key = $2 AND currency <> $3 AND status <> 'disabled'`, [companyId, scopeKey, currency]);
  return {
    spentMinor: toInt(spent[0]?.spent),
    spentTodayMinor: toInt(spent[0]?.today),
    recentDaily: recent.map((r) => toInt(r.spend)).reverse(),
    committedDailyMinor: toInt(committed[0]?.daily),
    mismatchedAccounts: toInt(mismatched[0]?.n),
  };
}

// ── alerts ──────────────────────────────────────────────────────────────────

export interface AlertRow {
  id: string;
  scope_key: string;
  account_id: string | null;
  campaign_external_id: string | null;
  kind: AlertKind;
  severity: "info" | "warn" | "bad";
  dedupe_key: string;
  title: string;
  body: string;
  detail: Record<string, unknown>;
  status: "open" | "acknowledged" | "resolved";
  issue_id: string | null;
  note: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

function alertRow(r: Record<string, unknown>): AlertRow {
  return {
    id: String(r.id),
    scope_key: String(r.scope_key),
    account_id: (r.account_id as string | null) ?? null,
    campaign_external_id: (r.campaign_external_id as string | null) ?? null,
    kind: r.kind as AlertKind,
    severity: r.severity as AlertRow["severity"],
    dedupe_key: String(r.dedupe_key),
    title: String(r.title),
    body: String(r.body),
    detail: r.detail && typeof r.detail === "object" ? (r.detail as Record<string, unknown>) : {},
    status: r.status as AlertRow["status"],
    issue_id: (r.issue_id as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    first_seen_at: isoTime(r.first_seen_at),
    last_seen_at: isoTime(r.last_seen_at),
  };
}

export async function getAlert(ctx: PluginContext, companyId: string, id: string): Promise<AlertRow | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "alerts")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return rows[0] ? alertRow(rows[0]) : null;
}

export async function findAlert(ctx: PluginContext, companyId: string, dedupeKey: string): Promise<AlertRow | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "alerts")} WHERE company_id = $1 AND dedupe_key = $2 LIMIT 1`, [companyId, dedupeKey]);
  return rows[0] ? alertRow(rows[0]) : null;
}

export async function listAlerts(ctx: PluginContext, companyId: string, options: { scopeKey?: ScopeKey; status?: string; limit?: number } = {}): Promise<AlertRow[]> {
  const params: unknown[] = [companyId];
  let where = "company_id = $1";
  if (options.scopeKey) {
    params.push(options.scopeKey);
    where += ` AND scope_key = $${params.length}`;
  }
  if (options.status) {
    params.push(options.status);
    where += ` AND status = $${params.length}`;
  }
  params.push(Math.min(options.limit ?? 100, 300));
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "alerts")} WHERE ${where} ORDER BY (status = 'open') DESC, last_seen_at DESC LIMIT $${params.length}`, params);
  return rows.map(alertRow);
}

export async function insertAlert(
  ctx: PluginContext,
  companyId: string,
  a: { scopeKey: string; accountId: string | null; campaignExternalId: string | null; kind: AlertKind; severity: AlertRow["severity"]; dedupeKey: string; title: string; body: string; detail: Record<string, unknown> },
): Promise<string> {
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "alerts")} (id, company_id, scope_key, account_id, campaign_external_id, kind, severity, dedupe_key, title, body, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (company_id, dedupe_key) DO NOTHING`,
    [id, companyId, a.scopeKey, a.accountId, a.campaignExternalId, a.kind, a.severity, a.dedupeKey, a.title, a.body, json(a.detail)],
  );
  return id;
}

export async function touchAlert(ctx: PluginContext, companyId: string, id: string, patch: { body?: string; detail?: Record<string, unknown>; severity?: AlertRow["severity"] }): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "alerts")} SET last_seen_at = now(), body = COALESCE($3::text, body), detail = COALESCE($4::jsonb, detail), severity = COALESCE($5::text, severity)
      WHERE company_id = $1 AND id = $2`,
    [companyId, id, patch.body ?? null, patch.detail ? json(patch.detail) : null, patch.severity ?? null],
  );
}

export async function setAlertState(ctx: PluginContext, companyId: string, id: string, status: AlertRow["status"], note: string | null): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "alerts")} SET status = $3, note = COALESCE($4::text, note), resolved_at = CASE WHEN $3::text = 'resolved' THEN now() ELSE resolved_at END WHERE company_id = $1 AND id = $2`,
    [companyId, id, status, note],
  );
}

export async function setAlertIssue(ctx: PluginContext, companyId: string, id: string, issueId: string): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "alerts")} SET issue_id = $3 WHERE company_id = $1 AND id = $2`, [companyId, id, issueId]);
}

// ── proposals and approvals ─────────────────────────────────────────────────

export interface ProposalRow {
  id: string;
  company_id: string;
  scope_key: string;
  account_id: string | null;
  kind: ProposalKind;
  status: ProposalStatus;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  impact: Record<string, unknown>;
  content_hash: string;
  precheck: Record<string, unknown>;
  review_state: "not_required" | "pending" | "pass" | "changes" | "waived";
  review_notes: string | null;
  review_by: string | null;
  review_at: string | null;
  review_hash: string | null;
  requires_signoffs: Array<"owner" | "client">;
  cap_state: "no_cap" | "within" | "exceeds";
  origin: string;
  origin_ref: string | null;
  approval_issue_id: string | null;
  client_ask_issue_id: string | null;
  client_action_ref: string | null;
  expires_at: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  executed_at: string | null;
  execution: Record<string, unknown> | null;
  error: string | null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function proposalRow(r: Record<string, unknown>): ProposalRow {
  return {
    id: String(r.id),
    company_id: String(r.company_id),
    scope_key: String(r.scope_key),
    account_id: (r.account_id as string | null) ?? null,
    kind: r.kind as ProposalKind,
    status: r.status as ProposalStatus,
    title: String(r.title),
    summary: String(r.summary ?? ""),
    payload: jsonObject(r.payload),
    impact: jsonObject(r.impact),
    content_hash: String(r.content_hash),
    precheck: jsonObject(r.precheck),
    review_state: r.review_state as ProposalRow["review_state"],
    review_notes: (r.review_notes as string | null) ?? null,
    review_by: (r.review_by as string | null) ?? null,
    review_at: isoTime(r.review_at),
    review_hash: (r.review_hash as string | null) ?? null,
    requires_signoffs: Array.isArray(r.requires_signoffs) ? (r.requires_signoffs as unknown[]).filter((s): s is "owner" | "client" => s === "owner" || s === "client") : ["owner"],
    cap_state: r.cap_state as ProposalRow["cap_state"],
    origin: String(r.origin ?? "agent"),
    origin_ref: (r.origin_ref as string | null) ?? null,
    approval_issue_id: (r.approval_issue_id as string | null) ?? null,
    client_ask_issue_id: (r.client_ask_issue_id as string | null) ?? null,
    client_action_ref: (r.client_action_ref as string | null) ?? null,
    expires_at: isoTime(r.expires_at),
    created_by: (r.created_by as string | null) ?? null,
    created_at: isoTime(r.created_at),
    updated_at: isoTime(r.updated_at),
    executed_at: isoTime(r.executed_at),
    execution: r.execution && typeof r.execution === "object" ? (r.execution as Record<string, unknown>) : null,
    error: (r.error as string | null) ?? null,
  };
}

export async function getProposal(ctx: PluginContext, companyId: string, id: string): Promise<ProposalRow | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "proposals")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return rows[0] ? proposalRow(rows[0]) : null;
}

export async function proposalByIssue(ctx: PluginContext, companyId: string, issueId: string): Promise<ProposalRow | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "proposals")} WHERE company_id = $1 AND approval_issue_id = $2 LIMIT 1`, [companyId, issueId]);
  return rows[0] ? proposalRow(rows[0]) : null;
}

export async function listProposals(ctx: PluginContext, companyId: string, options: { scopeKey?: ScopeKey; status?: string; open?: boolean; limit?: number } = {}): Promise<ProposalRow[]> {
  const params: unknown[] = [companyId];
  let where = "company_id = $1";
  if (options.scopeKey) {
    params.push(options.scopeKey);
    where += ` AND scope_key = $${params.length}`;
  }
  if (options.status) {
    params.push(options.status);
    where += ` AND status = $${params.length}`;
  }
  if (options.open) where += " AND status IN ('needs_changes', 'in_review', 'approved', 'executing')";
  params.push(Math.min(options.limit ?? 100, 300));
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "proposals")} WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return rows.map(proposalRow);
}

export async function insertProposal(
  ctx: PluginContext,
  p: {
    id: string;
    companyId: string;
    scopeKey: string;
    accountId: string | null;
    kind: ProposalKind;
    status: ProposalStatus;
    title: string;
    summary: string;
    payload: Record<string, unknown>;
    impact: Record<string, unknown>;
    contentHash: string;
    precheck: Record<string, unknown>;
    reviewState: ProposalRow["review_state"];
    requiresSignoffs: Array<"owner" | "client">;
    capState: ProposalRow["cap_state"];
    origin: string;
    originRef: string | null;
    expiresAt: string;
    createdBy: string | null;
  },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "proposals")} (id, company_id, scope_key, account_id, kind, status, title, summary, payload, impact, content_hash, precheck, review_state, requires_signoffs, cap_state, origin, origin_ref, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12::jsonb, $13, $14::jsonb, $15, $16, $17, $18::timestamptz, $19)`,
    [p.id, p.companyId, p.scopeKey, p.accountId, p.kind, p.status, p.title, p.summary, json(p.payload), json(p.impact), p.contentHash, json(p.precheck), p.reviewState, json(p.requiresSignoffs), p.capState, p.origin, p.originRef, p.expiresAt, p.createdBy],
  );
}

export interface ProposalPatch {
  status?: ProposalStatus;
  title?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  impact?: Record<string, unknown>;
  contentHash?: string;
  precheck?: Record<string, unknown>;
  reviewState?: ProposalRow["review_state"];
  reviewNotes?: string | null;
  reviewBy?: string | null;
  reviewHash?: string | null;
  requiresSignoffs?: Array<"owner" | "client">;
  capState?: ProposalRow["cap_state"];
  approvalIssueId?: string | null;
  clientAskIssueId?: string | null;
  clientActionRef?: string | null;
  expiresAt?: string;
  execution?: Record<string, unknown> | null;
  error?: string | null;
  executedNow?: boolean;
}

export async function updateProposal(ctx: PluginContext, companyId: string, id: string, patch: ProposalPatch): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [companyId, id];
  const add = (column: string, value: unknown, cast = "") => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.title !== undefined) add("title", patch.title);
  if (patch.summary !== undefined) add("summary", patch.summary);
  if (patch.payload !== undefined) add("payload", json(patch.payload), "::jsonb");
  if (patch.impact !== undefined) add("impact", json(patch.impact), "::jsonb");
  if (patch.contentHash !== undefined) add("content_hash", patch.contentHash);
  if (patch.precheck !== undefined) add("precheck", json(patch.precheck), "::jsonb");
  if (patch.reviewState !== undefined) {
    add("review_state", patch.reviewState);
    sets.push("review_at = now()");
  }
  if (patch.reviewNotes !== undefined) add("review_notes", patch.reviewNotes, "::text");
  if (patch.reviewBy !== undefined) add("review_by", patch.reviewBy, "::text");
  if (patch.reviewHash !== undefined) add("review_hash", patch.reviewHash, "::text");
  if (patch.requiresSignoffs !== undefined) add("requires_signoffs", json(patch.requiresSignoffs), "::jsonb");
  if (patch.capState !== undefined) add("cap_state", patch.capState);
  if (patch.approvalIssueId !== undefined) add("approval_issue_id", patch.approvalIssueId, "::text");
  if (patch.clientAskIssueId !== undefined) add("client_ask_issue_id", patch.clientAskIssueId, "::text");
  if (patch.clientActionRef !== undefined) add("client_action_ref", patch.clientActionRef, "::text");
  if (patch.expiresAt !== undefined) add("expires_at", patch.expiresAt, "::timestamptz");
  if (patch.execution !== undefined) add("execution", patch.execution === null ? null : json(patch.execution), "::jsonb");
  if (patch.error !== undefined) add("error", patch.error, "::text");
  if (patch.executedNow) sets.push("executed_at = now()");
  if (sets.length === 0) return;
  await ctx.db.execute(`UPDATE ${table(ctx, "proposals")} SET ${sets.join(", ")}, updated_at = now() WHERE company_id = $1 AND id = $2`, params);
}

/** Moves a proposal from one status to another only if it is still in the first (a guard against two things happening at once). */
export async function transitionProposal(ctx: PluginContext, companyId: string, id: string, from: ProposalStatus[], to: ProposalStatus): Promise<boolean> {
  const res = await ctx.db.execute(
    `UPDATE ${table(ctx, "proposals")} SET status = $3, updated_at = now() WHERE company_id = $1 AND id = $2 AND status = ANY(ARRAY(SELECT jsonb_array_elements_text($4::jsonb)))`,
    [companyId, id, to, json(from)],
  );
  return res.rowCount > 0;
}

export interface ApprovalRow {
  id: string;
  proposal_id: string;
  role: "owner" | "client";
  decision: "approved" | "rejected";
  decided_by: string;
  content_hash: string;
  over_cap_ack: boolean;
  note: string | null;
  evidence_ref: string | null;
  expires_at: string | null;
  consumed_at: string | null;
  created_at: string | null;
}

function approvalRow(r: Record<string, unknown>): ApprovalRow {
  return {
    id: String(r.id),
    proposal_id: String(r.proposal_id),
    role: r.role === "client" ? "client" : "owner",
    decision: r.decision === "rejected" ? "rejected" : "approved",
    decided_by: String(r.decided_by),
    content_hash: String(r.content_hash),
    over_cap_ack: r.over_cap_ack === true,
    note: (r.note as string | null) ?? null,
    evidence_ref: (r.evidence_ref as string | null) ?? null,
    expires_at: isoTime(r.expires_at),
    consumed_at: isoTime(r.consumed_at),
    created_at: isoTime(r.created_at),
  };
}

export async function insertApproval(
  ctx: PluginContext,
  a: { companyId: string; proposalId: string; role: "owner" | "client"; decision: "approved" | "rejected"; decidedBy: string; contentHash: string; overCapAck: boolean; note: string | null; evidenceRef: string | null; expiresAt: string },
): Promise<string> {
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "approvals")} (id, company_id, proposal_id, role, decision, decided_by, content_hash, over_cap_ack, note, evidence_ref, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
    [id, a.companyId, a.proposalId, a.role, a.decision, a.decidedBy, a.contentHash, a.overCapAck, a.note, a.evidenceRef, a.expiresAt],
  );
  return id;
}

export async function listApprovals(ctx: PluginContext, companyId: string, proposalId: string): Promise<ApprovalRow[]> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "approvals")} WHERE company_id = $1 AND proposal_id = $2 ORDER BY created_at`, [companyId, proposalId]);
  return rows.map(approvalRow);
}

export async function getApproval(ctx: PluginContext, companyId: string, id: string): Promise<ApprovalRow | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT * FROM ${table(ctx, "approvals")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return rows[0] ? approvalRow(rows[0]) : null;
}

/** Marks an approval used. Returns false when somebody else used it first: an approval runs one change, once. */
export async function consumeApproval(ctx: PluginContext, companyId: string, id: string): Promise<boolean> {
  const res = await ctx.db.execute(`UPDATE ${table(ctx, "approvals")} SET consumed_at = now() WHERE company_id = $1 AND id = $2 AND consumed_at IS NULL`, [companyId, id]);
  return res.rowCount > 0;
}

// ── audit and OAuth sessions ────────────────────────────────────────────────

export async function audit(ctx: PluginContext, companyId: string, entry: { actor: string; action: string; scopeKey?: string | null; subject?: string | null; detail?: Record<string, unknown> }): Promise<void> {
  try {
    await ctx.db.execute(
      `INSERT INTO ${table(ctx, "audit")} (id, company_id, actor, action, scope_key, subject, detail) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [randomUUID(), companyId, entry.actor, entry.action, entry.scopeKey ?? null, entry.subject ?? null, json(entry.detail ?? {})],
    );
  } catch (error) {
    ctx.logger.warn("Ads audit entry could not be written", { action: entry.action, error: error instanceof Error ? error.message : String(error) });
  }
}

/** True when the trail already holds this action for this subject (so a note or a step is made once, however often the job runs). */
export async function hasAudit(ctx: PluginContext, companyId: string, action: string, subject: string): Promise<boolean> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT 1 AS one FROM ${table(ctx, "audit")} WHERE company_id = $1 AND action = $2 AND subject = $3 LIMIT 1`, [companyId, action, subject]);
  return rows.length > 0;
}

export async function listAudit(ctx: PluginContext, companyId: string, limit = 60): Promise<Array<{ at: string | null; actor: string; action: string; scope_key: string | null; subject: string | null; detail: Record<string, unknown> }>> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT at, actor, action, scope_key, subject, detail FROM ${table(ctx, "audit")} WHERE company_id = $1 ORDER BY at DESC LIMIT $2`, [companyId, Math.min(limit, 200)]);
  return rows.map((r) => ({ at: isoTime(r.at), actor: String(r.actor), action: String(r.action), scope_key: (r.scope_key as string | null) ?? null, subject: (r.subject as string | null) ?? null, detail: jsonObject(r.detail) }));
}

export async function createOauthSession(ctx: PluginContext, s: { state: string; companyId: string; platform: string; userId: string | null; ttlSeconds: number }): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "oauth_sessions")} (state, company_id, platform, created_by_user_id, expires_at) VALUES ($1, $2, $3, $4, now() + ($5::text || ' seconds')::interval)`,
    [s.state, s.companyId, s.platform, s.userId, String(s.ttlSeconds)],
  );
}

export async function getOauthSession(ctx: PluginContext, state: string): Promise<{ state: string; company_id: string; platform: string; created_by_user_id: string | null; consumed: boolean; expired: boolean } | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT state, company_id, platform, created_by_user_id, consumed, (expires_at < now()) AS expired FROM ${table(ctx, "oauth_sessions")} WHERE state = $1 LIMIT 1`, [state]);
  const r = rows[0];
  return r ? { state: String(r.state), company_id: String(r.company_id), platform: String(r.platform), created_by_user_id: (r.created_by_user_id as string | null) ?? null, consumed: r.consumed === true, expired: r.expired === true } : null;
}

/** Marks the sign-in used. False when it already was: a callback runs once. */
export async function consumeOauthSession(ctx: PluginContext, state: string): Promise<boolean> {
  const res = await ctx.db.execute(`UPDATE ${table(ctx, "oauth_sessions")} SET consumed = true WHERE state = $1 AND consumed = false AND expires_at > now()`, [state]);
  return res.rowCount > 0;
}

export async function deleteExpiredOauthSessions(ctx: PluginContext): Promise<void> {
  await ctx.db.execute(`DELETE FROM ${table(ctx, "oauth_sessions")} WHERE expires_at < now() - interval '1 day'`);
}

// ── client names (the CRM projection) ───────────────────────────────────────

/** `{ "company:<id>": "Name" }` for the clients that have a scope here. */
export async function clientNames(ctx: PluginContext, companyId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const companies = await ctx.db.query<{ id: string; name: string }>(`SELECT id, name FROM ${table(ctx, "crm_companies")} WHERE company_id = $1 AND deleted = false LIMIT 2000`, [companyId]);
  for (const c of companies) out[`company:${c.id}`] = c.name;
  const contacts = await ctx.db.query<{ id: string; name: string }>(`SELECT id, name FROM ${table(ctx, "crm_contacts")} WHERE company_id = $1 AND deleted = false LIMIT 2000`, [companyId]);
  for (const c of contacts) out[`contact:${c.id}`] = c.name;
  return out;
}

export async function clientName(ctx: PluginContext, companyId: string, scopeKey: ScopeKey): Promise<string | null> {
  if (scopeKey === OWN_SCOPE) return null;
  const [kind, id] = scopeKey.split(":") as [string, string];
  const rows = await ctx.db.query<{ name: string }>(
    kind === "company"
      ? `SELECT name FROM ${table(ctx, "crm_companies")} WHERE company_id = $1 AND id = $2 AND deleted = false LIMIT 1`
      : `SELECT name FROM ${table(ctx, "crm_contacts")} WHERE company_id = $1 AND id = $2 AND deleted = false LIMIT 1`,
    [companyId, id],
  );
  return rows[0]?.name ?? null;
}
