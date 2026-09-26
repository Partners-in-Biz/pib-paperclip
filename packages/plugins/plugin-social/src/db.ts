/**
 * Data access for the social namespace.
 *
 * Host SQL guard rules (server/src/services/plugin-database.ts):
 * - every table is written as `${namespace}.table`;
 * - one statement per call;
 * - `query` is SELECT/WITH only and never contains the words
 *   insert/update/delete/alter/create/drop/truncate outside string literals;
 * - `execute` is INSERT/UPDATE/DELETE into the namespace only;
 * - JS arrays must never be passed as params (the host spreads them into
 *   `(a, b)`), so arrays travel as JSON and are expanded in SQL.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { textArrayParam } from "@partnersinbiz/pib-plugin-kit";
import type { DestinationStatus, PlatformOverride, PostStatus, SocialPlatform } from "./platforms.js";

/** SQL fragment turning a JSON-array param (`JSON.stringify(list)`) into text[]. */
export { textArrayParam };

export function table(ctx: PluginContext, name: string): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace) || !/^[a-z_]+$/.test(name)) throw new Error("Unsafe identifier");
  return `${ctx.db.namespace}.${name}`;
}

export function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ── Accounts ────────────────────────────────────────────────────────────────

export interface AccountRow {
  id: string;
  company_id: string;
  platform: string;
  scope: "org" | "personal";
  owner_user_id: string | null;
  status: string;
  secret_ref: string | null;
  display_name: string;
  external_id: string | null;
  handle: string | null;
  avatar_url: string | null;
  token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: unknown;
  scopes: unknown;
  client_ref: string | null;
  client_name: string | null;
  last_error: string | null;
  meta: unknown;
  key_version: number | null;
  created_by_user_id: string | null;
  reconnect_issue_id: string | null;
  last_refreshed_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}

const ACCOUNT_COLS = [
  "id", "company_id", "platform", "scope", "owner_user_id", "status", "secret_ref", "display_name", "external_id", "handle",
  "avatar_url", "token_enc", "refresh_token_enc", "token_expires_at", "scopes", "client_ref", "client_name", "last_error", "meta",
  "key_version", "created_by_user_id", "reconnect_issue_id", "last_refreshed_at", "created_at", "updated_at",
].join(", ");

export function accountMeta(row: AccountRow): Record<string, unknown> {
  const meta = json<Record<string, unknown>>(row.meta, {});
  return meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
}

export async function listAccounts(ctx: PluginContext, companyId: string): Promise<AccountRow[]> {
  return ctx.db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM ${table(ctx, "accounts")} WHERE company_id = $1 ORDER BY platform, display_name`,
    [companyId],
  );
}

export async function getAccount(ctx: PluginContext, companyId: string, id: string): Promise<AccountRow | null> {
  const rows = await ctx.db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM ${table(ctx, "accounts")} WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  return rows[0] ?? null;
}

export async function findAccountByExternal(
  ctx: PluginContext,
  companyId: string,
  platform: string,
  externalId: string,
): Promise<AccountRow | null> {
  const rows = await ctx.db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM ${table(ctx, "accounts")}
      WHERE company_id = $1 AND platform = $2 AND external_id = $3
      ORDER BY created_at LIMIT 1`,
    [companyId, platform, externalId],
  );
  return rows[0] ?? null;
}

/** Company ids with accounts that hold tokens (job fan-out). */
export async function companiesWithAccounts(ctx: PluginContext): Promise<string[]> {
  const rows = await ctx.db.query<{ company_id: string }>(
    `SELECT DISTINCT company_id FROM ${table(ctx, "accounts")} WHERE token_enc IS NOT NULL`,
  );
  return rows.map((row) => row.company_id);
}

/** Accounts whose tokens expire before `horizonIso` (refresh job). */
export async function accountsExpiringBefore(ctx: PluginContext, companyId: string, horizonIso: string): Promise<AccountRow[]> {
  return ctx.db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLS} FROM ${table(ctx, "accounts")}
      WHERE company_id = $1 AND token_enc IS NOT NULL AND status <> 'disabled'
        AND token_expires_at IS NOT NULL AND token_expires_at <= $2::timestamptz
      ORDER BY token_expires_at`,
    [companyId, horizonIso],
  );
}

export interface AccountWrite {
  company_id: string;
  platform: SocialPlatform;
  display_name: string;
  external_id: string;
  handle: string | null;
  avatar_url: string | null;
  token_enc: string;
  token_expires_at: string | null;
  scopes: string[];
  meta: Record<string, unknown>;
  key_version: number;
  client_ref: string | null;
  client_name: string | null;
  created_by_user_id: string | null;
}

/** Insert or refresh an account keyed by (company, platform, external id). Keeps the row id stable across reconnects. */
export async function upsertAccount(ctx: PluginContext, input: AccountWrite): Promise<{ id: string; created: boolean }> {
  const existing = await findAccountByExternal(ctx, input.company_id, input.platform, input.external_id);
  if (existing) {
    await ctx.db.execute(
      `UPDATE ${table(ctx, "accounts")}
          SET display_name = $2, handle = $3, avatar_url = $4, token_enc = $5, refresh_token_enc = NULL,
              token_expires_at = $6::timestamptz, scopes = $7::jsonb, meta = $8::jsonb, key_version = $9,
              client_ref = COALESCE($10, client_ref), client_name = COALESCE($11, client_name),
              status = 'connected', last_error = NULL, reconnect_issue_id = NULL, refresh_lock_until = NULL,
              last_refreshed_at = now(), updated_at = now()
        WHERE id = $1`,
      [
        existing.id, input.display_name, input.handle, input.avatar_url, input.token_enc, input.token_expires_at,
        JSON.stringify(input.scopes), JSON.stringify({ ...accountMeta(existing), ...input.meta }), input.key_version,
        input.client_ref, input.client_name,
      ],
    );
    return { id: existing.id, created: false };
  }
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "accounts")}
      (id, company_id, platform, scope, owner_user_id, status, secret_ref, display_name, external_id, handle, avatar_url,
       token_enc, refresh_token_enc, token_expires_at, scopes, meta, key_version, client_ref, client_name, created_by_user_id,
       last_refreshed_at)
     VALUES ($1, $2, $3, 'org', NULL, 'connected', NULL, $4, $5, $6, $7, $8, NULL, $9::timestamptz, $10::jsonb, $11::jsonb, $12, $13, $14, $15, now())`,
    [
      id, input.company_id, input.platform, input.display_name, input.external_id, input.handle, input.avatar_url, input.token_enc,
      input.token_expires_at, JSON.stringify(input.scopes), JSON.stringify(input.meta), input.key_version, input.client_ref,
      input.client_name, input.created_by_user_id,
    ],
  );
  return { id, created: true };
}

export async function saveAccountToken(ctx: PluginContext, id: string, fields: {
  tokenEnc: string;
  keyVersion: number;
  expiresAt: string | null;
  status?: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "accounts")}
        SET token_enc = $2, key_version = $3, token_expires_at = $4::timestamptz,
            status = COALESCE($5, status), meta = CASE WHEN $6::jsonb IS NULL THEN meta ELSE meta || $6::jsonb END,
            last_error = NULL, last_refreshed_at = now(), refresh_lock_until = NULL, updated_at = now()
      WHERE id = $1`,
    [id, fields.tokenEnc, fields.keyVersion, fields.expiresAt, fields.status ?? null, fields.meta ? JSON.stringify(fields.meta) : null],
  );
}

export async function setAccountState(ctx: PluginContext, id: string, fields: {
  status?: string;
  lastError?: string | null;
  reconnectIssueId?: string | null;
}): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "accounts")}
        SET status = COALESCE($2, status),
            last_error = CASE WHEN $3::boolean THEN $4 ELSE last_error END,
            reconnect_issue_id = CASE WHEN $5::boolean THEN $6 ELSE reconnect_issue_id END,
            updated_at = now()
      WHERE id = $1`,
    [
      id, fields.status ?? null,
      fields.lastError !== undefined, fields.lastError ?? null,
      fields.reconnectIssueId !== undefined, fields.reconnectIssueId ?? null,
    ],
  );
}

export async function updateAccountSettings(ctx: PluginContext, companyId: string, id: string, fields: {
  clientRef?: string | null;
  clientName?: string | null;
  meta?: Record<string, unknown>;
  status?: string;
}): Promise<number> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "accounts")}
        SET client_ref = CASE WHEN $3::boolean THEN $4 ELSE client_ref END,
            client_name = CASE WHEN $3::boolean THEN $5 ELSE client_name END,
            meta = CASE WHEN $6::jsonb IS NULL THEN meta ELSE meta || $6::jsonb END,
            status = COALESCE($7, status),
            updated_at = now()
      WHERE id = $1 AND company_id = $2`,
    [
      id, companyId, fields.clientRef !== undefined, fields.clientRef ?? null, fields.clientName ?? null,
      fields.meta ? JSON.stringify(fields.meta) : null, fields.status ?? null,
    ],
  );
  return result.rowCount;
}

/** Disconnect keeps the row (publish history) but drops the tokens. */
export async function disconnectAccount(ctx: PluginContext, companyId: string, id: string, note: string): Promise<number> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "accounts")}
        SET token_enc = NULL, refresh_token_enc = NULL, token_expires_at = NULL, status = 'disabled', last_error = $3,
            updated_at = now()
      WHERE id = $1 AND company_id = $2`,
    [id, companyId, note],
  );
  return result.rowCount;
}

/** Take a short lock before refreshing (refresh tokens may rotate). */
export async function lockAccountRefresh(ctx: PluginContext, id: string, seconds = 120): Promise<boolean> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "accounts")}
        SET refresh_lock_until = now() + make_interval(secs => $2)
      WHERE id = $1 AND (refresh_lock_until IS NULL OR refresh_lock_until < now())`,
    [id, seconds],
  );
  return result.rowCount === 1;
}

export async function unlockAccountRefresh(ctx: PluginContext, id: string): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "accounts")} SET refresh_lock_until = NULL WHERE id = $1`, [id]);
}

/** Tokens sealed by the pre-kit code (no `v<version>.` prefix) cannot be opened; ask for a reconnect. */
export async function flagLegacyTokens(ctx: PluginContext, companyId: string): Promise<number> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "accounts")}
        SET status = 'needs_reconnect',
            last_error = 'Connected before the token security upgrade. Reconnect this account.',
            updated_at = now()
      WHERE company_id = $1 AND token_enc IS NOT NULL AND token_enc !~ '^v[0-9]+[.]'
        AND status IN ('connected', 'expiring')`,
    [companyId],
  );
  return result.rowCount;
}

/** Remove leftover rows that never had a credential (e.g. the fake LinkedIn row). */
export async function deleteJunkAccounts(ctx: PluginContext, companyId: string): Promise<number> {
  const result = await ctx.db.execute(
    `DELETE FROM ${table(ctx, "accounts")}
      WHERE company_id = $1 AND token_enc IS NULL AND secret_ref IS NULL AND status <> 'disabled'`,
    [companyId],
  );
  return result.rowCount;
}

// ── OAuth sessions ──────────────────────────────────────────────────────────

export interface OauthSessionRow {
  state: string;
  company_id: string;
  platform: string;
  account_label: string | null;
  extra: unknown;
  pending_options: string | null;
  created_by_user_id: string | null;
  picker_id: string | null;
  status: string;
  expires_at: unknown;
}

const SESSION_COLS = "state, company_id, platform, account_label, extra, pending_options, created_by_user_id, picker_id, status, expires_at";

export function sessionExtra(row: OauthSessionRow): Record<string, unknown> {
  return json<Record<string, unknown>>(row.extra, {}) ?? {};
}

export async function createOauthSession(ctx: PluginContext, session: {
  state: string;
  companyId: string;
  platform: string;
  label: string | null;
  extra: Record<string, unknown>;
  createdByUserId: string | null;
  ttlSeconds: number;
}): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "oauth_sessions")}
      (state, company_id, platform, account_label, extra, created_by_user_id, status, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'started', now() + make_interval(secs => $7))`,
    [session.state, session.companyId, session.platform, session.label, JSON.stringify(session.extra), session.createdByUserId, session.ttlSeconds],
  );
}

export async function getOauthSession(ctx: PluginContext, state: string): Promise<OauthSessionRow | null> {
  const rows = await ctx.db.query<OauthSessionRow>(
    `SELECT ${SESSION_COLS} FROM ${table(ctx, "oauth_sessions")} WHERE state = $1 AND expires_at > now() LIMIT 1`,
    [state],
  );
  return rows[0] ?? null;
}

export async function getPickerSession(ctx: PluginContext, companyId: string, pickerId: string): Promise<OauthSessionRow | null> {
  const rows = await ctx.db.query<OauthSessionRow>(
    `SELECT ${SESSION_COLS} FROM ${table(ctx, "oauth_sessions")}
      WHERE picker_id = $1 AND company_id = $2 AND status = 'pending_selection' AND expires_at > now() LIMIT 1`,
    [pickerId, companyId],
  );
  return rows[0] ?? null;
}

/** Account choices waiting for this user (fallback when the bridge could not redirect to the picker). */
export async function listPendingPickers(ctx: PluginContext, companyId: string, userId: string | null): Promise<Array<{ picker_id: string; platform: string }>> {
  return ctx.db.query<{ picker_id: string; platform: string }>(
    `SELECT picker_id, platform FROM ${table(ctx, "oauth_sessions")}
      WHERE company_id = $1 AND status = 'pending_selection' AND expires_at > now() AND picker_id IS NOT NULL
        AND ($2::text IS NULL OR created_by_user_id IS NULL OR created_by_user_id = $2)
      ORDER BY created_at DESC LIMIT 5`,
    [companyId, userId],
  );
}

/** Mark a started session as consumed; returns false if another request got there first. */
export async function consumeOauthSession(ctx: PluginContext, state: string): Promise<boolean> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "oauth_sessions")} SET status = 'exchanging' WHERE state = $1 AND status = 'started' AND expires_at > now()`,
    [state],
  );
  return result.rowCount === 1;
}

export async function setSessionPending(ctx: PluginContext, state: string, pickerId: string, pendingOptions: string, ttlSeconds = 1800): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "oauth_sessions")}
        SET status = 'pending_selection', picker_id = $2, pending_options = $3, expires_at = now() + make_interval(secs => $4)
      WHERE state = $1`,
    [state, pickerId, pendingOptions, ttlSeconds],
  );
}

export async function deleteOauthSession(ctx: PluginContext, state: string): Promise<void> {
  await ctx.db.execute(`DELETE FROM ${table(ctx, "oauth_sessions")} WHERE state = $1`, [state]);
}

export async function deleteExpiredOauthSessions(ctx: PluginContext): Promise<void> {
  await ctx.db.execute(`DELETE FROM ${table(ctx, "oauth_sessions")} WHERE expires_at < now() - interval '1 day'`);
}

// ── Mastodon apps ───────────────────────────────────────────────────────────

export interface MastodonAppRow {
  id: string;
  instance_url: string;
  client_id: string;
  client_secret_enc: string;
  redirect_uri: string;
}

export async function getMastodonApp(ctx: PluginContext, companyId: string, instanceUrl: string): Promise<MastodonAppRow | null> {
  const rows = await ctx.db.query<MastodonAppRow>(
    `SELECT id, instance_url, client_id, client_secret_enc, redirect_uri FROM ${table(ctx, "mastodon_apps")}
      WHERE company_id = $1 AND instance_url = $2 LIMIT 1`,
    [companyId, instanceUrl],
  );
  return rows[0] ?? null;
}

export async function saveMastodonApp(ctx: PluginContext, input: {
  companyId: string;
  instanceUrl: string;
  clientId: string;
  clientSecretEnc: string;
  redirectUri: string;
  keyVersion: number;
}): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "mastodon_apps")} (id, company_id, instance_url, client_id, client_secret_enc, redirect_uri, key_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (company_id, instance_url) DO UPDATE
       SET client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc,
           redirect_uri = EXCLUDED.redirect_uri, key_version = EXCLUDED.key_version, updated_at = now()`,
    [randomUUID(), input.companyId, input.instanceUrl, input.clientId, input.clientSecretEnc, input.redirectUri, input.keyVersion],
  );
}

// ── Posts ───────────────────────────────────────────────────────────────────

export interface MediaRef {
  assetId: string | null;
  url: string;
  kind: "image" | "video";
  mime: string | null;
  width: number | null;
  height: number | null;
  durationS: number | null;
  altText: string | null;
  bytes: number | null;
}

export interface PostRow {
  id: string;
  company_id: string;
  body: string;
  overrides: unknown;
  media: unknown;
  status: PostStatus;
  scheduled_at: unknown;
  scope: "org" | "personal";
  owner_user_id: string | null;
  client_ref: string | null;
  client_name: string | null;
  first_comment: string | null;
  source: string | null;
  source_ref: string | null;
  failure_issue_id: string | null;
  published_at: unknown;
  error: string | null;
  created_by_agent_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const POST_COLS = [
  "id", "company_id", "body", "overrides", "media", "status", "scheduled_at", "scope", "owner_user_id", "client_ref", "client_name",
  "first_comment", "source", "source_ref", "failure_issue_id", "published_at", "error", "created_by_agent_id", "created_at", "updated_at",
].join(", ");

export function postMedia(row: Pick<PostRow, "media">): MediaRef[] {
  const raw = json<unknown[]>(row.media, []);
  if (!Array.isArray(raw)) return [];
  const out: MediaRef[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      out.push({ assetId: null, url: item, kind: /\.(mp4|mov|m4v|webm)(\?|$)/i.test(item) ? "video" : "image", mime: null, width: null, height: null, durationS: null, altText: null, bytes: null });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (typeof m.url !== "string" || !m.url) continue;
    out.push({
      assetId: typeof m.assetId === "string" ? m.assetId : null,
      url: m.url,
      kind: m.kind === "video" ? "video" : "image",
      mime: typeof m.mime === "string" ? m.mime : null,
      width: num(m.width),
      height: num(m.height),
      durationS: num(m.durationS),
      altText: typeof m.altText === "string" ? m.altText : null,
      bytes: num(m.bytes),
    });
  }
  return out;
}

export function postOverrides(row: Pick<PostRow, "overrides">): Partial<Record<SocialPlatform, PlatformOverride>> {
  const raw = json<Record<string, unknown>>(row.overrides, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Partial<Record<SocialPlatform, PlatformOverride>>;
}

export async function listPosts(ctx: PluginContext, companyId: string, filter: { status?: string; clientRef?: string; limit?: number } = {}): Promise<PostRow[]> {
  const params: unknown[] = [companyId];
  const where = ["company_id = $1"];
  if (filter.status) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }
  if (filter.clientRef) {
    params.push(filter.clientRef);
    where.push(`client_ref = $${params.length}`);
  }
  params.push(Math.min(Math.max(filter.limit ?? 500, 1), 1000));
  return ctx.db.query<PostRow>(
    `SELECT ${POST_COLS} FROM ${table(ctx, "posts")} WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
}

export async function getPost(ctx: PluginContext, companyId: string, id: string): Promise<PostRow | null> {
  const rows = await ctx.db.query<PostRow>(
    `SELECT ${POST_COLS} FROM ${table(ctx, "posts")} WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  return rows[0] ?? null;
}

export interface PostWrite {
  id: string;
  company_id: string;
  body: string;
  status: PostStatus;
  scope: "org" | "personal";
  owner_user_id: string | null;
  media: MediaRef[];
  overrides: Partial<Record<SocialPlatform, PlatformOverride>>;
  first_comment: string | null;
  client_ref: string | null;
  client_name: string | null;
  source: string;
  source_ref: string | null;
  created_by_agent_id: string | null;
}

export async function insertPost(ctx: PluginContext, row: PostWrite): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "posts")}
      (id, company_id, body, overrides, media, status, scheduled_at, scope, owner_user_id, first_comment, client_ref, client_name,
       source, source_ref, created_by_agent_id)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, NULL, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      row.id, row.company_id, row.body, JSON.stringify(row.overrides), JSON.stringify(row.media), row.status, row.scope, row.owner_user_id,
      row.first_comment, row.client_ref, row.client_name, row.source, row.source_ref, row.created_by_agent_id,
    ],
  );
}

export async function updatePostContent(ctx: PluginContext, companyId: string, id: string, fields: {
  body?: string;
  media?: MediaRef[];
  overrides?: Partial<Record<SocialPlatform, PlatformOverride>>;
  firstComment?: string | null;
  clientRef?: string | null;
  clientName?: string | null;
}): Promise<number> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "posts")}
        SET body = COALESCE($3, body),
            media = COALESCE($4::jsonb, media),
            overrides = COALESCE($5::jsonb, overrides),
            first_comment = CASE WHEN $6::boolean THEN $7 ELSE first_comment END,
            client_ref = CASE WHEN $8::boolean THEN $9 ELSE client_ref END,
            client_name = CASE WHEN $8::boolean THEN $10 ELSE client_name END,
            updated_at = now()
      WHERE id = $1 AND company_id = $2`,
    [
      id, companyId, fields.body ?? null,
      fields.media ? JSON.stringify(fields.media) : null,
      fields.overrides ? JSON.stringify(fields.overrides) : null,
      fields.firstComment !== undefined, fields.firstComment ?? null,
      fields.clientRef !== undefined, fields.clientRef ?? null, fields.clientName ?? null,
    ],
  );
  return result.rowCount;
}

/** Guarded status change: only applies when the post is still in one of `from`. */
export async function setPostStatus(
  ctx: PluginContext,
  companyId: string,
  id: string,
  from: PostStatus[],
  to: PostStatus,
  scheduledAt?: string | null,
): Promise<boolean> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "posts")}
        SET status = $3,
            scheduled_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE scheduled_at END,
            updated_at = now()
      WHERE id = $1 AND company_id = $2 AND status = ANY(${textArrayParam(6)})`,
    [id, companyId, to, scheduledAt !== undefined, scheduledAt ?? null, JSON.stringify(from)],
  );
  return result.rowCount === 1;
}

export async function setPostOutcome(ctx: PluginContext, id: string, fields: {
  status: PostStatus;
  error: string | null;
  publishedAt: boolean;
}): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "posts")}
        SET status = $2, error = $3,
            published_at = CASE WHEN $4::boolean THEN COALESCE(published_at, now()) ELSE published_at END,
            updated_at = now()
      WHERE id = $1`,
    [id, fields.status, fields.error, fields.publishedAt],
  );
}

export async function setPostFailureIssue(ctx: PluginContext, id: string, issueId: string): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "posts")} SET failure_issue_id = $2, updated_at = now() WHERE id = $1`, [id, issueId]);
}

export async function deletePost(ctx: PluginContext, companyId: string, id: string): Promise<number> {
  const result = await ctx.db.execute(
    `DELETE FROM ${table(ctx, "posts")} WHERE id = $1 AND company_id = $2 AND status IN ('draft', 'review', 'approved')`,
    [id, companyId],
  );
  return result.rowCount;
}

/** Posts that are due (scheduled and past time) or already publishing with destinations due now. */
export async function duePostRefs(ctx: PluginContext, limit = 200): Promise<Array<{ id: string; company_id: string }>> {
  return ctx.db.query<{ id: string; company_id: string }>(
    `SELECT p.id, p.company_id
       FROM ${table(ctx, "posts")} p
      WHERE p.scheduled_at IS NOT NULL AND p.scheduled_at <= now()
        AND p.status IN ('scheduled', 'publishing')
        AND EXISTS (
          SELECT 1 FROM ${table(ctx, "destinations")} d
           WHERE d.post_id = p.id AND d.status IN ('pending', 'retrying')
             AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= now())
        )
      ORDER BY p.scheduled_at
      LIMIT $1`,
    [limit],
  );
}

/** Scheduled posts that have no destinations left to try (fail them instead of leaving them stuck). */
export async function scheduledPostsWithoutWork(ctx: PluginContext): Promise<Array<{ id: string; company_id: string }>> {
  return ctx.db.query<{ id: string; company_id: string }>(
    `SELECT p.id, p.company_id
       FROM ${table(ctx, "posts")} p
      WHERE p.status IN ('scheduled', 'publishing') AND p.scheduled_at IS NOT NULL AND p.scheduled_at <= now() - interval '2 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM ${table(ctx, "destinations")} d
           WHERE d.post_id = p.id AND d.status IN ('pending', 'retrying', 'publishing')
        )
      LIMIT 200`,
  );
}

// ── Destinations ────────────────────────────────────────────────────────────

export interface DestinationRow {
  id: string;
  company_id: string;
  post_id: string;
  account_id: string;
  status: DestinationStatus;
  result: unknown;
  attempts: number;
  next_attempt_at: unknown;
  external_id: string | null;
  external_url: string | null;
  last_error: string | null;
  published_at: unknown;
  issue_id: string | null;
  metric_windows: string[] | null;
  created_at: unknown;
  updated_at: unknown;
}

const DEST_COLS = [
  "id", "company_id", "post_id", "account_id", "status", "result", "attempts", "next_attempt_at", "external_id", "external_url",
  "last_error", "published_at", "issue_id", "metric_windows", "created_at", "updated_at",
].join(", ");

export async function destinationsForPost(ctx: PluginContext, postId: string): Promise<DestinationRow[]> {
  return ctx.db.query<DestinationRow>(
    `SELECT ${DEST_COLS} FROM ${table(ctx, "destinations")} WHERE post_id = $1 ORDER BY created_at`,
    [postId],
  );
}

export async function destinationsForCompany(ctx: PluginContext, companyId: string): Promise<DestinationRow[]> {
  return ctx.db.query<DestinationRow>(
    `SELECT ${DEST_COLS} FROM ${table(ctx, "destinations")} WHERE company_id = $1 ORDER BY created_at`,
    [companyId],
  );
}

export async function insertDestination(ctx: PluginContext, input: { companyId: string; postId: string; accountId: string }): Promise<{ id: string; created: boolean }> {
  const id = randomUUID();
  const result = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "destinations")} (id, company_id, post_id, account_id, status, result)
     VALUES ($1, $2, $3, $4, 'pending', '{}'::jsonb)
     ON CONFLICT (post_id, account_id) DO NOTHING`,
    [id, input.companyId, input.postId, input.accountId],
  );
  return { id, created: result.rowCount === 1 };
}

export async function deleteDestination(ctx: PluginContext, companyId: string, postId: string, accountId: string): Promise<number> {
  const result = await ctx.db.execute(
    `DELETE FROM ${table(ctx, "destinations")}
      WHERE post_id = $1 AND account_id = $2 AND company_id = $3 AND status IN ('pending', 'failed')`,
    [postId, accountId, companyId],
  );
  return result.rowCount;
}

/** Atomically claim due destinations of one post for this run; attempts is incremented here. */
export async function claimDestinations(ctx: PluginContext, postId: string, claimToken: string): Promise<DestinationRow[]> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "destinations")}
        SET status = 'publishing', claim_token = $2, claimed_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE post_id = $1 AND status IN ('pending', 'retrying')
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())`,
    [postId, claimToken],
  );
  return ctx.db.query<DestinationRow>(
    `SELECT ${DEST_COLS} FROM ${table(ctx, "destinations")} WHERE claim_token = $1 AND post_id = $2 AND status = 'publishing'`,
    [claimToken, postId],
  );
}

/** Give back claims abandoned by a crashed run. */
export async function releaseStaleClaims(ctx: PluginContext, staleMinutes = 120): Promise<number> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "destinations")}
        SET status = 'retrying', next_attempt_at = now(), claim_token = NULL,
            last_error = COALESCE(last_error, 'Publish run did not finish; retrying'), updated_at = now()
      WHERE status = 'publishing' AND claimed_at < now() - make_interval(mins => $1)`,
    [staleMinutes],
  );
  return result.rowCount;
}

export async function saveDestinationOutcome(ctx: PluginContext, id: string, fields: {
  status: DestinationStatus;
  nextAttemptAt: string | null;
  externalId: string | null;
  externalUrl: string | null;
  lastError: string | null;
  result: Record<string, unknown>;
}): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "destinations")}
        SET status = $2, next_attempt_at = $3::timestamptz,
            external_id = COALESCE($4, external_id), external_url = COALESCE($5, external_url),
            last_error = $6, result = $7::jsonb, claim_token = NULL,
            published_at = CASE WHEN $2 = 'published' THEN COALESCE(published_at, now()) ELSE published_at END,
            updated_at = now()
      WHERE id = $1 AND status <> 'published'`,
    [id, fields.status, fields.nextAttemptAt, fields.externalId, fields.externalUrl, fields.lastError, JSON.stringify(fields.result)],
  );
}

export async function setDestinationIssue(ctx: PluginContext, postId: string, issueId: string): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "destinations")} SET issue_id = $2, updated_at = now() WHERE post_id = $1 AND status = 'failed' AND issue_id IS NULL`,
    [postId, issueId],
  );
}

/** Reset failed destinations of a post for a manual retry. Published ones are never touched. */
export async function resetFailedDestinations(ctx: PluginContext, companyId: string, postId: string): Promise<number> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "destinations")}
        SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, claim_token = NULL, updated_at = now()
      WHERE post_id = $1 AND company_id = $2 AND status IN ('failed', 'retrying')`,
    [postId, companyId],
  );
  return result.rowCount;
}

export async function publishedDestinationsForMetrics(ctx: PluginContext, sinceDays = 32, limit = 500): Promise<Array<DestinationRow & { platform: string }>> {
  return ctx.db.query<DestinationRow & { platform: string }>(
    `SELECT d.id, d.company_id, d.post_id, d.account_id, d.status, d.result, d.attempts, d.next_attempt_at, d.external_id, d.external_url,
            d.last_error, d.published_at, d.issue_id, d.metric_windows, d.created_at, d.updated_at, a.platform
       FROM ${table(ctx, "destinations")} d
       JOIN ${table(ctx, "accounts")} a ON a.id = d.account_id
      WHERE d.status = 'published' AND d.external_id IS NOT NULL AND d.published_at IS NOT NULL
        AND d.published_at >= now() - make_interval(days => $1)
        AND cardinality(d.metric_windows) < 4
        AND a.token_enc IS NOT NULL
      ORDER BY d.published_at
      LIMIT $2`,
    [sinceDays, limit],
  );
}

export async function recentPublishedForAccount(ctx: PluginContext, accountId: string, days = 14, limit = 20): Promise<DestinationRow[]> {
  return ctx.db.query<DestinationRow>(
    `SELECT ${DEST_COLS} FROM ${table(ctx, "destinations")}
      WHERE account_id = $1 AND status = 'published' AND external_id IS NOT NULL
        AND published_at >= now() - make_interval(days => $2)
      ORDER BY published_at DESC
      LIMIT $3`,
    [accountId, days, limit],
  );
}

export async function markMetricWindows(ctx: PluginContext, destinationId: string, windows: string[]): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "destinations")}
        SET metric_windows = ARRAY(SELECT DISTINCT unnest(metric_windows || ${textArrayParam(2)})), updated_at = now()
      WHERE id = $1`,
    [destinationId, JSON.stringify(windows)],
  );
}

export async function setDestinationExternal(ctx: PluginContext, id: string, externalId: string, externalUrl: string | null): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "destinations")} SET external_id = $2, external_url = COALESCE($3, external_url), updated_at = now() WHERE id = $1`,
    [id, externalId, externalUrl],
  );
}

// ── Templates ───────────────────────────────────────────────────────────────

export interface TemplateRow {
  id: string;
  company_id: string;
  name: string;
  body: string;
  platform: string | null;
}

export async function listTemplates(ctx: PluginContext, companyId: string): Promise<TemplateRow[]> {
  return ctx.db.query<TemplateRow>(
    `SELECT id, company_id, name, body, platform FROM ${table(ctx, "templates")} WHERE company_id = $1 ORDER BY name`,
    [companyId],
  );
}

export async function insertTemplate(ctx: PluginContext, template: TemplateRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "templates")} (id, company_id, name, body, platform) VALUES ($1, $2, $3, $4, $5)`,
    [template.id, template.company_id, template.name, template.body, template.platform],
  );
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export interface MetricsRow {
  id: string;
  company_id: string;
  post_id: string;
  destination_id: string | null;
  account_id: string | null;
  platform: string | null;
  metric_window: string | null;
  views: number | string;
  likes: number | string;
  comments: number | string;
  shares: number | string;
  impressions: number | string | null;
  reach: number | string | null;
  saves: number | string | null;
  clicks: number | string | null;
  recorded_at: unknown;
}

const METRIC_COLS = "id, company_id, post_id, destination_id, account_id, platform, metric_window, views, likes, comments, shares, impressions, reach, saves, clicks, recorded_at";

export async function insertMetrics(ctx: PluginContext, input: {
  companyId: string;
  postId: string;
  destinationId?: string | null;
  accountId?: string | null;
  platform?: string | null;
  window?: string | null;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  impressions?: number | null;
  reach?: number | null;
  saves?: number | null;
  clicks?: number | null;
  raw?: Record<string, unknown>;
}): Promise<boolean> {
  const result = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "post_metrics")}
      (id, company_id, post_id, destination_id, account_id, platform, metric_window, views, likes, comments, shares,
       impressions, reach, saves, clicks, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
     ON CONFLICT (destination_id, metric_window) DO NOTHING`,
    [
      randomUUID(), input.companyId, input.postId, input.destinationId ?? null, input.accountId ?? null, input.platform ?? null,
      input.window ?? null, input.views, input.likes, input.comments, input.shares, input.impressions ?? null, input.reach ?? null,
      input.saves ?? null, input.clicks ?? null, JSON.stringify(input.raw ?? {}),
    ],
  );
  return result.rowCount === 1;
}

export async function metricsForPost(ctx: PluginContext, companyId: string, postId: string): Promise<MetricsRow[]> {
  return ctx.db.query<MetricsRow>(
    `SELECT ${METRIC_COLS} FROM ${table(ctx, "post_metrics")} WHERE post_id = $1 AND company_id = $2 ORDER BY recorded_at`,
    [postId, companyId],
  );
}

export async function metricsForCompany(ctx: PluginContext, companyId: string): Promise<MetricsRow[]> {
  return ctx.db.query<MetricsRow>(
    `SELECT ${METRIC_COLS} FROM ${table(ctx, "post_metrics")} WHERE company_id = $1 ORDER BY recorded_at`,
    [companyId],
  );
}

/** Latest snapshot per destination, summed per account. */
export async function accountMetrics(ctx: PluginContext, companyId: string): Promise<Array<{ accountId: string; views: number; likes: number; comments: number; shares: number }>> {
  const rows = await ctx.db.query<{ account_id: string; views: string | number; likes: string | number; comments: string | number; shares: string | number }>(
    `WITH latest AS (
       SELECT DISTINCT ON (COALESCE(m.destination_id, m.id)) m.account_id, m.post_id, m.views, m.likes, m.comments, m.shares
         FROM ${table(ctx, "post_metrics")} m
        WHERE m.company_id = $1
        ORDER BY COALESCE(m.destination_id, m.id), m.recorded_at DESC
     )
     SELECT COALESCE(l.account_id, d.account_id) AS account_id,
            sum(l.views) AS views, sum(l.likes) AS likes, sum(l.comments) AS comments, sum(l.shares) AS shares
       FROM latest l
       LEFT JOIN ${table(ctx, "destinations")} d ON d.post_id = l.post_id AND l.account_id IS NULL
      GROUP BY COALESCE(l.account_id, d.account_id)`,
    [companyId],
  );
  return rows
    .filter((row) => row.account_id)
    .map((row) => ({
      accountId: row.account_id,
      views: Number(row.views ?? 0),
      likes: Number(row.likes ?? 0),
      comments: Number(row.comments ?? 0),
      shares: Number(row.shares ?? 0),
    }));
}

// ── Media ───────────────────────────────────────────────────────────────────

export interface MediaAssetRow {
  id: string;
  company_id: string;
  name: string;
  url: string;
  kind: string;
  r2_key: string | null;
  mime: string | null;
  bytes: number | string | null;
  width: number | null;
  height: number | null;
  duration_s: number | string | null;
  alt_text: string | null;
  client_ref: string | null;
  client_name: string | null;
  created_at: unknown;
}

const MEDIA_COLS = "id, company_id, name, url, kind, r2_key, mime, bytes, width, height, duration_s, alt_text, client_ref, client_name, created_at";

export async function insertMediaAsset(ctx: PluginContext, asset: Omit<MediaAssetRow, "created_at"> & { source_url?: string | null }): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "media_assets")}
      (id, company_id, name, url, kind, r2_key, mime, bytes, width, height, duration_s, alt_text, client_ref, client_name, source_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      asset.id, asset.company_id, asset.name, asset.url, asset.kind, asset.r2_key, asset.mime, asset.bytes == null ? null : Number(asset.bytes),
      asset.width, asset.height, asset.duration_s == null ? null : Number(asset.duration_s), asset.alt_text, asset.client_ref, asset.client_name,
      asset.source_url ?? null,
    ],
  );
}

export async function listMediaAssets(ctx: PluginContext, companyId: string): Promise<MediaAssetRow[]> {
  return ctx.db.query<MediaAssetRow>(
    `SELECT ${MEDIA_COLS} FROM ${table(ctx, "media_assets")} WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId],
  );
}

export async function getMediaAssets(ctx: PluginContext, companyId: string, ids: string[]): Promise<MediaAssetRow[]> {
  if (ids.length === 0) return [];
  return ctx.db.query<MediaAssetRow>(
    `SELECT ${MEDIA_COLS} FROM ${table(ctx, "media_assets")} WHERE company_id = $1 AND id = ANY(${textArrayParam(2)})`,
    [companyId, JSON.stringify(ids)],
  );
}

export function mediaRefFromAsset(asset: MediaAssetRow): MediaRef {
  return {
    assetId: asset.id,
    url: asset.url,
    kind: asset.kind === "video" ? "video" : "image",
    mime: asset.mime,
    width: asset.width == null ? null : Number(asset.width),
    height: asset.height == null ? null : Number(asset.height),
    durationS: num(asset.duration_s),
    altText: asset.alt_text,
    bytes: num(asset.bytes),
  };
}

// ── RSS ─────────────────────────────────────────────────────────────────────

export interface RssFeedRow {
  id: string;
  company_id: string;
  url: string;
  title: string | null;
  account_id: string | null;
  account_ids: string[] | null;
  is_active: boolean;
  last_checked_at: unknown;
  last_error: string | null;
  last_item_at: unknown;
  client_ref: string | null;
  client_name: string | null;
  created_by_user_id: string | null;
}

const FEED_COLS = "id, company_id, url, title, account_id, account_ids, is_active, last_checked_at, last_error, last_item_at, client_ref, client_name, created_by_user_id";

export async function insertRssFeed(ctx: PluginContext, feed: {
  id: string;
  company_id: string;
  url: string;
  account_id: string | null;
  account_ids: string[];
  client_ref: string | null;
  client_name: string | null;
  created_by_user_id: string | null;
}): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "rss_feeds")} (id, company_id, url, account_id, account_ids, is_active, client_ref, client_name, created_by_user_id)
     VALUES ($1, $2, $3, $4, ${textArrayParam(5)}, true, $6, $7, $8)`,
    [feed.id, feed.company_id, feed.url, feed.account_id, JSON.stringify(feed.account_ids), feed.client_ref, feed.client_name, feed.created_by_user_id],
  );
}

export async function listRssFeeds(ctx: PluginContext, companyId: string): Promise<RssFeedRow[]> {
  return ctx.db.query<RssFeedRow>(
    `SELECT ${FEED_COLS} FROM ${table(ctx, "rss_feeds")} WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId],
  );
}

export async function activeRssFeeds(ctx: PluginContext, limit = 100): Promise<RssFeedRow[]> {
  return ctx.db.query<RssFeedRow>(
    `SELECT ${FEED_COLS} FROM ${table(ctx, "rss_feeds")}
      WHERE is_active = true AND (last_checked_at IS NULL OR last_checked_at < now() - interval '10 minutes')
      ORDER BY last_checked_at NULLS FIRST
      LIMIT $1`,
    [limit],
  );
}

export async function setRssFeedActive(ctx: PluginContext, companyId: string, id: string, active: boolean): Promise<boolean> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "rss_feeds")} SET is_active = $3 WHERE id = $1 AND company_id = $2`,
    [id, companyId, active],
  );
  return result.rowCount === 1;
}

export async function markRssFeedChecked(ctx: PluginContext, id: string, fields: { title?: string | null; error: string | null; lastItemAt?: string | null }): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "rss_feeds")}
        SET last_checked_at = now(), last_error = $2, title = COALESCE($3, title),
            last_item_at = COALESCE($4::timestamptz, last_item_at)
      WHERE id = $1`,
    [id, fields.error, fields.title ?? null, fields.lastItemAt ?? null],
  );
}

export async function seenRssKeys(ctx: PluginContext, feedId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await ctx.db.query<{ item_key: string }>(
    `SELECT item_key FROM ${table(ctx, "rss_seen_items")} WHERE feed_id = $1 AND item_key = ANY(${textArrayParam(2)})`,
    [feedId, JSON.stringify(keys)],
  );
  return new Set(rows.map((row) => row.item_key));
}

export async function insertRssSeen(ctx: PluginContext, input: {
  companyId: string;
  feedId: string;
  itemKey: string;
  title: string | null;
  link: string | null;
  publishedAt: string | null;
  postId: string | null;
}): Promise<boolean> {
  const result = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "rss_seen_items")} (id, company_id, feed_id, item_key, title, link, published_at, post_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)
     ON CONFLICT (feed_id, item_key) DO NOTHING`,
    [randomUUID(), input.companyId, input.feedId, input.itemKey, input.title, input.link, input.publishedAt, input.postId],
  );
  return result.rowCount === 1;
}

// ── Inbox ───────────────────────────────────────────────────────────────────

export interface InboxItemRow {
  id: string;
  company_id: string;
  account_id: string | null;
  platform: string | null;
  kind: string;
  author: string;
  body: string;
  status: string;
  external_id: string | null;
  parent_external_id: string | null;
  permalink: string | null;
  destination_id: string | null;
  post_id: string | null;
  reply_draft: string | null;
  reply_body: string | null;
  reply_external_id: string | null;
  replied_at: unknown;
  received_at: unknown;
  client_ref: string | null;
  created_at: unknown;
}

const INBOX_COLS = [
  "id", "company_id", "account_id", "platform", "kind", "author", "body", "status", "external_id", "parent_external_id", "permalink",
  "destination_id", "post_id", "reply_draft", "reply_body", "reply_external_id", "replied_at", "received_at", "client_ref", "created_at",
].join(", ");

export async function insertInboxItem(ctx: PluginContext, item: {
  id: string;
  company_id: string;
  account_id: string | null;
  platform: string | null;
  kind: string;
  author: string;
  body: string;
  status: string;
  external_id?: string | null;
  parent_external_id?: string | null;
  permalink?: string | null;
  destination_id?: string | null;
  post_id?: string | null;
  received_at?: string | null;
  client_ref?: string | null;
}): Promise<boolean> {
  const result = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "inbox_items")}
      (id, company_id, account_id, platform, kind, author, body, status, external_id, parent_external_id, permalink, destination_id,
       post_id, received_at, client_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15)
     ON CONFLICT (account_id, external_id) DO NOTHING`,
    [
      item.id, item.company_id, item.account_id, item.platform, item.kind, item.author, item.body, item.status, item.external_id ?? null,
      item.parent_external_id ?? null, item.permalink ?? null, item.destination_id ?? null, item.post_id ?? null, item.received_at ?? null,
      item.client_ref ?? null,
    ],
  );
  return result.rowCount === 1;
}

export async function listInboxItems(ctx: PluginContext, companyId: string, limit = 50, status?: string): Promise<InboxItemRow[]> {
  const params: unknown[] = [companyId];
  let where = "company_id = $1";
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  params.push(Math.min(Math.max(limit, 1), 500));
  return ctx.db.query<InboxItemRow>(
    `SELECT ${INBOX_COLS} FROM ${table(ctx, "inbox_items")} WHERE ${where}
      ORDER BY COALESCE(received_at, created_at) DESC LIMIT $${params.length}`,
    params,
  );
}

export async function getInboxItem(ctx: PluginContext, companyId: string, id: string): Promise<InboxItemRow | null> {
  const rows = await ctx.db.query<InboxItemRow>(
    `SELECT ${INBOX_COLS} FROM ${table(ctx, "inbox_items")} WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  return rows[0] ?? null;
}

export async function setInboxItemStatus(ctx: PluginContext, companyId: string, id: string, status: string): Promise<boolean> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "inbox_items")} SET status = $3 WHERE id = $1 AND company_id = $2`,
    [id, companyId, status],
  );
  return result.rowCount === 1;
}

export async function saveInboxReply(ctx: PluginContext, companyId: string, id: string, fields: {
  status: string;
  replyDraft?: string | null;
  replyBody?: string | null;
  replyExternalId?: string | null;
  replied: boolean;
}): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "inbox_items")}
        SET status = $3, reply_draft = $4, reply_body = COALESCE($5, reply_body), reply_external_id = COALESCE($6, reply_external_id),
            replied_at = CASE WHEN $7::boolean THEN now() ELSE replied_at END
      WHERE id = $1 AND company_id = $2`,
    [id, companyId, fields.status, fields.replyDraft ?? null, fields.replyBody ?? null, fields.replyExternalId ?? null, fields.replied],
  );
}
