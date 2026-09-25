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
}

export interface PostRow {
  id: string;
  company_id: string;
  body: string;
  status: "draft" | "review" | "approved" | "scheduled" | "publishing" | "published" | "failed";
  scheduled_at: unknown;
  scope: "org" | "personal";
  owner_user_id: string | null;
}

export async function listAccounts(ctx: PluginContext, companyId: string): Promise<AccountRow[]> {
  return ctx.db.query<AccountRow>(
    `SELECT id, company_id, platform, scope, owner_user_id, status, secret_ref, display_name
       FROM ${table(ctx, "accounts")} WHERE company_id = $1 ORDER BY display_name`,
    [companyId],
  );
}

export async function getAccount(ctx: PluginContext, id: string): Promise<AccountRow | null> {
  const rows = await ctx.db.query<AccountRow>(
    `SELECT id, company_id, platform, scope, owner_user_id, status, secret_ref, display_name
       FROM ${table(ctx, "accounts")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertAccount(ctx: PluginContext, row: AccountRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "accounts")}
      (id, company_id, platform, scope, owner_user_id, status, secret_ref, display_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [row.id, row.company_id, row.platform, row.scope, row.owner_user_id, row.status, row.secret_ref, row.display_name],
  );
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
