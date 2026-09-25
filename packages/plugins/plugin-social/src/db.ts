import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";

export function table(ctx: PluginContext, name: string): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace) || !/^[a-z_]+$/.test(name)) throw new Error("Unsafe identifier");
  return `${ctx.db.namespace}.${name}`;
}

export interface AccountRow {
  id: string;
  company_id: string;
  platform: string;
  scope: "org" | "personal";
  owner_user_id: string | null;
  status: string;
  secret_ref: string | null;
  display_name: string;
  external_id?: string | null;
  handle?: string | null;
  avatar_url?: string | null;
  token_enc?: string | null;
  refresh_token_enc?: string | null;
  token_expires_at?: unknown;
  scopes?: unknown;
  updated_at?: unknown;
}

export interface PostRow {
  id: string;
  company_id: string;
  body: string;
  status: "draft" | "review" | "approved" | "scheduled" | "publishing" | "published" | "failed";
  scheduled_at: unknown;
  scope: "org" | "personal";
  owner_user_id: string | null;
  external_id?: string | null;
  error?: string | null;
}

const ACCOUNT_COLS = "id, company_id, platform, scope, owner_user_id, status, secret_ref, display_name, external_id, handle, avatar_url, token_enc, refresh_token_enc, token_expires_at, scopes, updated_at";

export async function listAccounts(ctx: PluginContext, companyId: string): Promise<AccountRow[]> {
  return ctx.db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLS}
       FROM ${table(ctx, "accounts")} WHERE company_id = $1 ORDER BY display_name`,
    [companyId],
  );
}

export async function getAccount(ctx: PluginContext, id: string): Promise<AccountRow | null> {
  const rows = await ctx.db.query<AccountRow>(
    `SELECT ${ACCOUNT_COLS}
       FROM ${table(ctx, "accounts")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertAccount(ctx: PluginContext, row: AccountRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "accounts")}
      (id, company_id, platform, scope, owner_user_id, status, secret_ref, display_name,
       external_id, handle, avatar_url, token_enc, refresh_token_enc, token_expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id) DO UPDATE
       SET status = EXCLUDED.status,
           display_name = EXCLUDED.display_name,
           external_id = EXCLUDED.external_id,
           handle = EXCLUDED.handle,
           avatar_url = EXCLUDED.avatar_url,
           token_enc = EXCLUDED.token_enc,
           refresh_token_enc = EXCLUDED.refresh_token_enc,
           token_expires_at = EXCLUDED.token_expires_at,
           scopes = EXCLUDED.scopes,
           updated_at = now()`,
    [row.id, row.company_id, row.platform, row.scope, row.owner_user_id ?? null, row.status, row.secret_ref ?? null, row.display_name,
     row.external_id ?? null, row.handle ?? null, row.avatar_url ?? null, row.token_enc ?? null, row.refresh_token_enc ?? null,
     row.token_expires_at ?? null, row.scopes ?? []],
  );
}

export async function updateAccountToken(ctx: PluginContext, id: string, fields: {
  token_enc: string;
  refresh_token_enc: string | null;
  token_expires_at: unknown;
  scopes: string[];
  status?: string;
}): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "accounts")}
        SET token_enc = $2, refresh_token_enc = $3, token_expires_at = $4, scopes = $5,
            status = COALESCE($6, status), updated_at = now()
      WHERE id = $1`,
    [id, fields.token_enc, fields.refresh_token_enc, fields.token_expires_at, fields.scopes, fields.status ?? null],
  );
}

export async function setAccountStatus(ctx: PluginContext, id: string, status: string, reason?: string): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "accounts")} SET status = $2, updated_at = now() WHERE id = $1`,
    [id, status],
  );
}

export async function deleteAccount(ctx: PluginContext, companyId: string, id: string): Promise<void> {
  await ctx.db.execute(
    `DELETE FROM ${table(ctx, "accounts")} WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
}

export async function setPostPublishResult(ctx: PluginContext, id: string, status: string, externalId: string | null, error: string | null): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "posts")} SET status = $2, external_id = $3, error = $4, updated_at = now() WHERE id = $1`,
    [id, status, externalId, error],
  );
}

// ── OAuth sessions ──────────────────────────────────────────────────────────
export async function createOauthSession(ctx: PluginContext, session: {
  state: string;
  company_id: string;
  platform: string;
  account_label: string | null;
  extra?: Record<string, unknown>;
  ttlSeconds?: number;
}): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "oauth_sessions")} (state, company_id, platform, account_label, extra, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
    [session.state, session.company_id, session.platform, session.account_label, session.extra ?? {}, session.ttlSeconds ?? 600],
  );
}

export async function getOauthSession(ctx: PluginContext, state: string): Promise<{
  state: string;
  company_id: string;
  platform: string;
  account_label: string | null;
  extra: Record<string, unknown> | null;
} | null> {
  const rows = await ctx.db.query<{
    state: string;
    company_id: string;
    platform: string;
    account_label: string | null;
    extra: Record<string, unknown> | null;
  }>(
    `SELECT state, company_id, platform, account_label, extra
       FROM ${table(ctx, "oauth_sessions")}
      WHERE state = $1 AND expires_at > now() LIMIT 1`,
    [state],
  );
  return rows[0] ?? null;
}

export async function deleteOauthSession(ctx: PluginContext, state: string): Promise<void> {
  await ctx.db.execute(`DELETE FROM ${table(ctx, "oauth_sessions")} WHERE state = $1`, [state]);
}

export async function listPosts(ctx: PluginContext, companyId: string): Promise<PostRow[]> {
  return ctx.db.query<PostRow>(
    `SELECT id, company_id, body, status, scheduled_at, scope, owner_user_id
       FROM ${table(ctx, "posts")} WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId],
  );
}

export async function getPost(ctx: PluginContext, id: string): Promise<PostRow | null> {
  const rows = await ctx.db.query<PostRow>(
    `SELECT id, company_id, body, status, scheduled_at, scope, owner_user_id
       FROM ${table(ctx, "posts")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertPost(ctx: PluginContext, row: PostRow & { overrides?: unknown; media?: unknown }): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "posts")}
      (id, company_id, body, overrides, media, status, scheduled_at, scope, owner_user_id)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)`,
    [row.id, row.company_id, row.body, JSON.stringify(row.overrides ?? {}), JSON.stringify(row.media ?? []), row.status, row.scheduled_at, row.scope, row.owner_user_id],
  );
}

export async function setPostStatus(ctx: PluginContext, id: string, status: string, scheduledAt: string | null): Promise<number> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "posts")}
        SET status = $2, scheduled_at = $3, updated_at = now()
      WHERE id = $1`,
    [id, status, scheduledAt],
  );
  return result.rowCount;
}

export async function claimScheduled(ctx: PluginContext, id: string): Promise<number> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "posts")} SET status = 'publishing', updated_at = now() WHERE id = $1 AND status = 'scheduled'`,
    [id],
  );
  return result.rowCount;
}

export async function duePosts(ctx: PluginContext): Promise<PostRow[]> {
  return ctx.db.query<PostRow>(
    `SELECT id, company_id, body, status, scheduled_at, scope, owner_user_id
       FROM ${table(ctx, "posts")}
      WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= now()`,
  );
}

export async function destinationsFor(ctx: PluginContext, postId: string): Promise<Array<{ id: string; account_id: string }>> {
  return ctx.db.query<{ id: string; account_id: string }>(
    `SELECT id, account_id FROM ${table(ctx, "destinations")} WHERE post_id = $1`,
    [postId],
  );
}

export async function insertDestination(ctx: PluginContext, input: { companyId: string; postId: string; accountId: string }): Promise<string> {
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "destinations")} (id, company_id, post_id, account_id, status, result)
     VALUES ($1, $2, $3, $4, 'pending', '{}'::jsonb)`,
    [id, input.companyId, input.postId, input.accountId],
  );
  return id;
}

export async function saveDestination(ctx: PluginContext, id: string, status: string, result: Record<string, unknown>): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "destinations")} SET status = $2, result = $3::jsonb WHERE id = $1`,
    [id, status, JSON.stringify(result)],
  );
}

export function publicAccount(row: AccountRow): Record<string, unknown> {
  return {
    id: row.id,
    platform: row.platform,
    scope: row.scope,
    ownerUserId: row.owner_user_id,
    status: row.status,
    displayName: row.display_name,
    hasCredential: Boolean(row.secret_ref),
    handle: row.handle ?? null,
    externalId: row.external_id ?? null,
    avatarUrl: row.avatar_url ?? null,
    hasToken: Boolean(row.token_enc),
    tokenExpiresAt: row.token_expires_at ? String(row.token_expires_at) : null,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
  };
}

export function publicPost(row: PostRow): Record<string, unknown> {
  return {
    id: row.id,
    body: row.body,
    status: row.status,
    scope: row.scope,
    ownerUserId: row.owner_user_id,
    scheduledAt: row.scheduled_at instanceof Date ? row.scheduled_at.toISOString() : row.scheduled_at,
  };
}

export interface TemplateRow {
  id: string;
  company_id: string;
  name: string;
  body: string;
  platform: string | null;
}

export async function listTemplates(ctx: PluginContext, companyId: string): Promise<TemplateRow[]> {
  return ctx.db.query<TemplateRow>(
    `SELECT id, company_id, name, body, platform
       FROM ${table(ctx, "templates")}
      WHERE company_id = $1
      ORDER BY name`,
    [companyId],
  );
}

export async function insertTemplate(ctx: PluginContext, template: TemplateRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "templates")} (id, company_id, name, body, platform)
     VALUES ($1, $2, $3, $4, $5)`,
    [template.id, template.company_id, template.name, template.body, template.platform],
  );
}

export interface MetricsRow {
  id: string;
  company_id: string;
  post_id: string;
  views: number | string;
  likes: number | string;
  comments: number | string;
  shares: number | string;
  recorded_at: unknown;
}

export async function insertMetrics(
  ctx: PluginContext,
  input: { companyId: string; postId: string; views: number; likes: number; comments: number; shares: number },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "post_metrics")}
      (id, company_id, post_id, views, likes, comments, shares)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), input.companyId, input.postId, input.views, input.likes, input.comments, input.shares],
  );
}

export async function metricsForPost(ctx: PluginContext, postId: string): Promise<MetricsRow[]> {
  return ctx.db.query<MetricsRow>(
    `SELECT id, company_id, post_id, views, likes, comments, shares, recorded_at
       FROM ${table(ctx, "post_metrics")} WHERE post_id = $1 ORDER BY recorded_at`,
    [postId],
  );
}

export async function metricsForCompany(ctx: PluginContext, companyId: string): Promise<MetricsRow[]> {
  return ctx.db.query<MetricsRow>(
    `SELECT id, company_id, post_id, views, likes, comments, shares, recorded_at
       FROM ${table(ctx, "post_metrics")} WHERE company_id = $1 ORDER BY recorded_at`,
    [companyId],
  );
}

export interface MediaAssetRow {
  id: string;
  company_id: string;
  name: string;
  url: string;
  kind: string;
}

export async function insertMediaAsset(ctx: PluginContext, asset: MediaAssetRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "media_assets")} (id, company_id, name, url, kind)
     VALUES ($1, $2, $3, $4, $5)`,
    [asset.id, asset.company_id, asset.name, asset.url, asset.kind],
  );
}

export async function listMediaAssets(ctx: PluginContext, companyId: string): Promise<MediaAssetRow[]> {
  return ctx.db.query<MediaAssetRow>(
    `SELECT id, company_id, name, url, kind
       FROM ${table(ctx, "media_assets")} WHERE company_id = $1 ORDER BY name`,
    [companyId],
  );
}

export interface RssFeedRow {
  id: string;
  company_id: string;
  url: string;
  account_id: string | null;
  is_active: boolean;
  last_checked_at: unknown;
}

export async function insertRssFeed(ctx: PluginContext, feed: RssFeedRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "rss_feeds")} (id, company_id, url, account_id, is_active)
     VALUES ($1, $2, $3, $4, $5)`,
    [feed.id, feed.company_id, feed.url, feed.account_id, feed.is_active],
  );
}

export async function listRssFeeds(ctx: PluginContext, companyId: string): Promise<RssFeedRow[]> {
  return ctx.db.query<RssFeedRow>(
    `SELECT id, company_id, url, account_id, is_active, last_checked_at
       FROM ${table(ctx, "rss_feeds")} WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId],
  );
}

export async function setRssFeedActive(ctx: PluginContext, companyId: string, id: string, active: boolean): Promise<boolean> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "rss_feeds")} SET is_active = $3 WHERE id = $1 AND company_id = $2`,
    [id, companyId, active],
  );
  return result != null;
}

export interface InboxItemRow {
  id: string;
  company_id: string;
  account_id: string | null;
  kind: string;
  author: string;
  body: string;
  status: string;
  created_at: unknown;
}

export async function insertInboxItem(ctx: PluginContext, item: InboxItemRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "inbox_items")} (id, company_id, account_id, kind, author, body, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [item.id, item.company_id, item.account_id, item.kind, item.author, item.body, item.status],
  );
}

export async function listInboxItems(ctx: PluginContext, companyId: string, limit = 50): Promise<InboxItemRow[]> {
  return ctx.db.query<InboxItemRow>(
    `SELECT id, company_id, account_id, kind, author, body, status, created_at
       FROM ${table(ctx, "inbox_items")} WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [companyId, limit],
  );
}

export async function setInboxItemStatus(ctx: PluginContext, companyId: string, id: string, status: string): Promise<boolean> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "inbox_items")} SET status = $3 WHERE id = $1 AND company_id = $2`,
    [id, companyId, status],
  );
  return result != null;
}

export async function getInboxItem(ctx: PluginContext, companyId: string, id: string): Promise<InboxItemRow | null> {
  const rows = await ctx.db.query<InboxItemRow>(
    `SELECT id, company_id, account_id, kind, author, body, status, created_at
       FROM ${table(ctx, "inbox_items")} WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  );
  return rows[0] ?? null;
}

export async function accountMetrics(ctx: PluginContext, companyId: string): Promise<Array<{ accountId: string; views: number; likes: number; comments: number; shares: number }>> {
  const rows = await ctx.db.query<{ account_id: string; views: string | number; likes: string | number; comments: string | number; shares: string | number }>(
    `SELECT d.account_id, sum(m.views) AS views, sum(m.likes) AS likes, sum(m.comments) AS comments, sum(m.shares) AS shares
       FROM ${table(ctx, "post_metrics")} m
       JOIN ${table(ctx, "destinations")} d ON d.post_id = m.post_id
      WHERE d.company_id = $1
      GROUP BY d.account_id`,
    [companyId],
  );
  return rows.map((row) => ({
    accountId: row.account_id,
    views: Number(row.views ?? 0),
    likes: Number(row.likes ?? 0),
    comments: Number(row.comments ?? 0),
    shares: Number(row.shares ?? 0),
  }));
}
