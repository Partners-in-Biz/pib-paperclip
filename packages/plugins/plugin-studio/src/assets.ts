/** The asset library: files in private storage, tied to a company, client, project and the work that used them. */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { scopeOfRow, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { StudioConfig } from "./config.js";
import { iso, num, table } from "./db.js";
import { errorText, StudioError } from "./errors.js";
import { assertOwnKey, assetKey, extFor, getObject, kindFor, localCopy, MAX_ASSET_BYTES, objectUrl, putObject, sha256Hex, sniffMime, type PrivateBucket } from "./storage.js";
import { cutPoster, ensurePoster, POSTER_MIME } from "./video-edit/poster.js";
import { downloadObjectToWorkdir, withRenderWorkdir } from "./video-edit/workdir.js";
import { assertReachable, loadIssue, scopeForWork, scopeInput } from "./scope.js";

export const LINK_TARGETS = ["issue", "goal", "project", "campaign", "social_post", "ad", "seo_page", "video", "book"] as const;

export interface AssetRow {
  id: string;
  company_id: string;
  client_kind: string | null;
  client_ref: string | null;
  client_name: string | null;
  project_id: string | null;
  name: string;
  kind: string;
  alt_text: string | null;
  status: string;
  source: string;
  generation_id: string | null;
  current_version: unknown;
  created_at: unknown;
  r2_key: string;
  mime: string;
  bytes: unknown;
}

const ASSET_SELECT = (ctx: PluginContext, extraColumns = "") =>
  `SELECT a.id, a.company_id, a.client_kind, a.client_ref, a.client_name, a.project_id, a.name, a.kind, a.alt_text, a.status, a.source, a.generation_id, a.current_version, a.created_at, v.r2_key, v.mime, v.bytes${extraColumns}
   FROM ${table(ctx, "assets")} a JOIN ${table(ctx, "asset_versions")} v ON v.asset_id = a.id AND v.version = a.current_version`;

/** What people and agents see. No storage key and no URL. */
export function assetOut(row: AssetRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    mime: row.mime,
    bytes: num(row.bytes),
    altText: row.alt_text,
    status: row.status,
    source: row.source,
    client: row.client_ref ? { kind: row.client_kind, id: row.client_ref, name: row.client_name } : null,
    projectId: row.project_id,
    generationId: row.generation_id,
    version: num(row.current_version),
    createdAt: iso(row.created_at),
  };
}

export async function getAssetRow(ctx: PluginContext, companyId: string, assetId: string): Promise<AssetRow> {
  const rows = await ctx.db.query<AssetRow>(`${ASSET_SELECT(ctx)} WHERE a.company_id = $1 AND a.id = $2`, [companyId, assetId]);
  if (!rows[0]) throw new StudioError(`Asset ${assetId} was not found in this company.`, "unknown_asset");
  return rows[0];
}

export interface StoreInput {
  id?: string;
  companyId: string;
  scope: ClientScope;
  clientName: string | null;
  projectId: string | null;
  issueId: string | null;
  name: string;
  altText?: string | null;
  source: "generated" | "attachment" | "drive" | "layout" | "social" | "edit";
  sourceRef: string | null;
  generationId?: string | null;
  agentId?: string | null;
  userId?: string | null;
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
}

/**
 * Upload, then record. The id can be fixed by the caller and every write is idempotent, so a restart partway through
 * repeats the work and ends in the same state.
 */
export async function storeAsset(ctx: PluginContext, config: StudioConfig, input: StoreInput): Promise<string> {
  const id = input.id ?? randomUUID();
  const key = assetKey(input.companyId, input.scope, id, 1, extFor(input.mime));
  await putObject(await config.bucket(), input.companyId, key, input.bytes, input.mime);
  const { bytes, ...rest } = input;
  await recordStoredAsset(ctx, { ...rest, id, key, size: bytes.length, sha256: sha256Hex(bytes) });
  return id;
}

/**
 * Record a file that is already in R2 at `key` (a streamed Drive import, PAR-8125). Same rows and links as storeAsset;
 * every write is idempotent.
 */
export async function recordStoredAsset(ctx: PluginContext, input: Omit<StoreInput, "bytes"> & { id: string; key: string; size: number; sha256: string }): Promise<void> {
  const { id, key } = input;
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "assets")} (id, company_id, client_kind, client_ref, client_name, project_id, name, kind, alt_text, source, source_ref, generation_id, created_by_agent_id, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT (id) DO NOTHING`,
    [id, input.companyId, input.scope?.kind ?? null, input.scope?.id ?? null, input.clientName, input.projectId, input.name, kindFor(input.mime), input.altText ?? null, input.source, input.sourceRef, input.generationId ?? null, input.agentId ?? null, input.userId ?? null],
  );
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "asset_versions")} (asset_id, version, company_id, r2_key, mime, bytes, sha256) VALUES ($1, 1, $2, $3, $4, $5, $6) ON CONFLICT (asset_id, version) DO NOTHING`,
    [id, input.companyId, key, input.mime, input.size, input.sha256],
  );
  if (input.issueId) await addLink(ctx, input.companyId, id, "issue", input.issueId);
  if (input.projectId) await addLink(ctx, input.companyId, id, "project", input.projectId);
}

export async function addLink(ctx: PluginContext, companyId: string, assetId: string, type: string, targetId: string): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "asset_links")} (company_id, asset_id, target_type, target_id) VALUES ($1, $2, $3, $4) ON CONFLICT (asset_id, target_type, target_id) DO NOTHING`,
    [companyId, assetId, type, targetId],
  );
}

export interface ListFilter {
  /** `undefined` lists every scope in the company (people's page only). */
  scope?: ClientScope;
  projectId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  kind?: string | null;
  status?: string | null;
  limit?: number;
  /** Newest first unless "oldest". */
  sort?: "newest" | "oldest" | null;
}

interface ListRow extends AssetRow {
  gen_prompt: string | null;
  gen_model: string | null;
  gen_credits: unknown;
}

function listWhere(ctx: PluginContext, companyId: string, filter: ListFilter): { where: string; params: unknown[] } {
  const params: unknown[] = [companyId];
  let where = "WHERE a.company_id = $1";
  if (filter.scope !== undefined) {
    if (filter.scope) {
      params.push(filter.scope.kind, filter.scope.id);
      where += ` AND a.client_kind = $${params.length - 1} AND a.client_ref = $${params.length}`;
    } else where += " AND a.client_ref IS NULL";
  }
  if (filter.projectId) {
    params.push(filter.projectId);
    where += ` AND a.project_id = $${params.length}`;
  }
  if (filter.kind) {
    params.push(filter.kind);
    where += ` AND a.kind = $${params.length}`;
  }
  if (filter.status) {
    params.push(filter.status);
    where += ` AND a.status = $${params.length}`;
  }
  if (filter.targetType && filter.targetId) {
    params.push(filter.targetType, filter.targetId);
    where += ` AND EXISTS (SELECT 1 FROM ${table(ctx, "asset_links")} l WHERE l.asset_id = a.id AND l.target_type = $${params.length - 1} AND l.target_id = $${params.length})`;
  }
  return { where, params };
}

/** Each asset plus the prompt, model and cost of the generation that made it (null for imports), for library cards. */
export async function listAssets(ctx: PluginContext, companyId: string, filter: ListFilter) {
  const { where, params } = listWhere(ctx, companyId, filter);
  params.push(Math.min(Math.max(filter.limit ?? 50, 1), 200));
  const order = filter.sort === "oldest" ? "ASC" : "DESC";
  const select = ASSET_SELECT(ctx, ", g.prompt AS gen_prompt, g.model AS gen_model, COALESCE(g.actual_credits, g.estimated_credits) AS gen_credits");
  const rows = await ctx.db.query<ListRow>(
    `${select} LEFT JOIN ${table(ctx, "generations")} g ON g.id = a.generation_id AND g.company_id = a.company_id ${where} ORDER BY a.created_at ${order} LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    ...assetOut(row),
    prompt: row.gen_prompt ?? null,
    model: row.gen_model ?? null,
    credits: row.gen_credits === null || row.gen_credits === undefined ? null : num(row.gen_credits),
  }));
}

/** How many assets each status holds under the same filters (the status filter itself is ignored), for filter chips. */
export async function countAssetsByStatus(ctx: PluginContext, companyId: string, filter: ListFilter): Promise<Record<string, number>> {
  const { where, params } = listWhere(ctx, companyId, { ...filter, status: null });
  const rows = await ctx.db.query<{ status: string; n: unknown }>(`SELECT a.status, COUNT(*) AS n FROM ${table(ctx, "assets")} a ${where} GROUP BY a.status`, params);
  const out: Record<string, number> = { all: 0 };
  for (const r of rows) {
    out[r.status] = num(r.n);
    out.all += num(r.n);
  }
  return out;
}

/** Agents get a path on this machine, because the host redacts signed URLs in what they read. */
export async function assetFileForAgent(ctx: PluginContext, companyId: string, assetId: string, projectId: string | null) {
  const row = await getAssetRow(ctx, companyId, assetId);
  await assertReachable(ctx, companyId, scopeOfRow(row), projectId);
  assertOwnKey(companyId, row.r2_key);
  const bucket = await new StudioConfig(ctx, companyId).bucket();
  const path = await localCopy(companyId, row.id, num(row.current_version), extFor(row.mime), () => getObject(bucket, companyId, row.r2_key));
  return { ...assetOut(row), path };
}

/**
 * For a person's browser, after an access check in the action (or a share page). Short-lived. Pass one `config` for a
 * whole request or job run: each new StudioConfig costs a secret lookup, and the host allows 30 a minute per company.
 */
export async function assetUrlForPerson(ctx: PluginContext, companyId: string, assetId: string, expiresSec = 300, config: StudioConfig = new StudioConfig(ctx, companyId)): Promise<string> {
  const row = await getAssetRow(ctx, companyId, assetId);
  return objectUrl(await config.bucket(), companyId, "GET", row.r2_key, expiresSec);
}

/** The largest picture a Layout card reads, and the bytes for it: a canvas can't read a storage link back. */
const MAX_LAYOUT_SOURCE_BYTES = 25 * 1024 * 1024;

export async function assetBytesForPerson(ctx: PluginContext, companyId: string, assetId: string): Promise<{ mime: string; base64: string }> {
  const row = await getAssetRow(ctx, companyId, assetId);
  const isVideo = row.mime.startsWith("video/");
  if (!isVideo && !row.mime.startsWith("image/")) throw new StudioError("Only pictures and videos can go on a Layout card, and this file isn't one.", "bad_asset");
  assertOwnKey(companyId, row.r2_key);
  const bucket = await new StudioConfig(ctx, companyId).bucket();
  // A video is drawn as its first frame (PAR-8364), made once per asset version.
  if (isVideo) {
    const poster = await ensurePoster(companyId, row.r2_key, num(row.current_version), {
      read: (key) => getObject(bucket, companyId, key).catch(() => null),
      make: () => withRenderWorkdir(`poster-${row.id}`, MAX_ASSET_BYTES, async (dir) => {
        await downloadObjectToWorkdir(bucket, companyId, row.r2_key, dir, "input.bin");
        return cutPoster(dir, "input.bin");
      }),
      write: (key, bytes) => putObject(bucket, companyId, key, bytes as Uint8Array<ArrayBuffer>, POSTER_MIME),
    });
    if (poster.length > MAX_LAYOUT_SOURCE_BYTES) throw new StudioError("That picture is too large to lay out here.", "bad_asset");
    return { mime: POSTER_MIME, base64: Buffer.from(poster).toString("base64") };
  }
  const bytes = await getObject(bucket, companyId, row.r2_key);
  if (bytes.length > MAX_LAYOUT_SOURCE_BYTES) throw new StudioError("That picture is too large to lay out here.", "bad_asset");
  return { mime: row.mime, base64: Buffer.from(bytes).toString("base64") };
}

export interface PreviewBatch {
  urls: Record<string, string>;
  /** Assets that exist but got no link this time; the page retries them soon. */
  failed: string[];
  /** Safe to show a person; null when every known asset got a link. */
  error: string | null;
}

/**
 * Preview links for many assets with one settings read and one secret lookup (PAR-8102). Unknown assets are left out
 * quietly; a storage or secret failure is reported in `error` so the page can say so and retry, never hidden.
 */
export async function assetUrlsForPerson(ctx: PluginContext, companyId: string, assetIds: string[], expiresSec = 300, config?: StudioConfig): Promise<PreviewBatch> {
  const urls: Record<string, string> = {};
  if (!assetIds.length) return { urls, failed: [], error: null };
  let bucket: PrivateBucket;
  try {
    bucket = await (config ?? new StudioConfig(ctx, companyId)).bucket();
  } catch (error) {
    ctx.logger.warn("Studio previews not signed", { assets: assetIds.length, error: errorText(error) });
    const why = error instanceof StudioError ? error.message : "Studio couldn't read its storage settings just now.";
    return { urls, failed: [...assetIds], error: `Previews couldn't load. ${why}` };
  }
  const failed: string[] = [];
  for (const id of assetIds) {
    try {
      const row = await getAssetRow(ctx, companyId, id);
      urls[id] = objectUrl(bucket, companyId, "GET", row.r2_key, expiresSec);
    } catch (error) {
      if (error instanceof StudioError && error.code === "unknown_asset") continue;
      failed.push(id);
    }
  }
  return { urls, failed, error: failed.length ? `${failed.length} preview${failed.length === 1 ? "" : "s"} couldn't load.` : null };
}

export async function linkAsset(ctx: PluginContext, companyId: string, params: Record<string, unknown>, runProjectId: string | null) {
  const assetId = String(params.assetId ?? "").trim();
  const targetType = String(params.targetType ?? "").trim();
  const targetId = String(params.targetId ?? "").trim();
  if (!assetId || !targetId) throw new StudioError("assetId and targetId are required.", "bad_link");
  if (!(LINK_TARGETS as readonly string[]).includes(targetType)) throw new StudioError(`targetType must be one of: ${LINK_TARGETS.join(", ")}.`, "bad_link");
  const row = await getAssetRow(ctx, companyId, assetId);
  const scope = scopeOfRow(row);
  await assertReachable(ctx, companyId, scope, runProjectId);
  let id = targetId;
  if (targetType === "issue") {
    const issue = await loadIssue(ctx, companyId, targetId);
    await assertReachable(ctx, companyId, scope, issue.projectId);
    id = issue.id;
  } else if (targetType === "project") {
    await assertReachable(ctx, companyId, scope, targetId);
  }
  await addLink(ctx, companyId, assetId, targetType, id);
  return { assetId, targetType, targetId: id };
}

/** A file an agent made: attach it to the issue, then import it here by attachment id. Agents can't name a path. */
export async function importFromAttachment(ctx: PluginContext, companyId: string, params: Record<string, unknown>, actor: { agentId?: string | null; userId?: string | null }) {
  const issueRef = String(params.issueId ?? "").trim();
  const attachmentId = String(params.attachmentId ?? "").trim();
  if (!issueRef || !attachmentId) throw new StudioError("issueId and attachmentId are required.", "bad_import");
  const issue = await loadIssue(ctx, companyId, issueRef);
  const target = await scopeForWork(ctx, companyId, scopeInput(params), issue.projectId);
  const sourceRef = `attachment:${issue.id}:${attachmentId}`;
  const existing = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "assets")} WHERE company_id = $1 AND source_ref = $2`, [companyId, sourceRef]);
  if (existing[0]) return { ...assetOut(await getAssetRow(ctx, companyId, existing[0].id)), reused: true };

  const attachments = await ctx.issues.listAttachments(issue.id, companyId);
  const meta = attachments.find((row) => row.id === attachmentId);
  if (!meta) throw new StudioError("That attachment isn't on that issue.", "unknown_attachment");
  if (meta.byteSize > MAX_ASSET_BYTES) throw new StudioError(`The file is ${Math.round(meta.byteSize / 1024 / 1024)} MB; Studio takes up to ${MAX_ASSET_BYTES / 1024 / 1024} MB.`, "too_large");
  const content = await ctx.issues.getAttachmentContent(attachmentId, companyId, { maxBytes: MAX_ASSET_BYTES });
  if (!content) throw new StudioError("That attachment could not be read.", "unknown_attachment");
  const bytes = new Uint8Array(Buffer.from(content.contentBase64, "base64"));
  const mime = sniffMime(bytes);
  if (!mime) throw new StudioError("Studio stores JPEG, PNG, GIF and WebP images and MP4 and MOV videos, and this file is none of those.", "unsupported_type");
  const name = (typeof params.name === "string" && params.name.trim()) || content.originalFilename || "attachment";
  const id = await storeAsset(ctx, new StudioConfig(ctx, companyId), {
    companyId,
    scope: target.scope,
    clientName: target.client?.name ?? null,
    projectId: issue.projectId,
    issueId: issue.id,
    name,
    altText: typeof params.altText === "string" ? params.altText : null,
    source: "attachment",
    sourceRef,
    agentId: actor.agentId,
    userId: actor.userId,
    bytes,
    mime,
  });
  return { ...assetOut(await getAssetRow(ctx, companyId, id)), reused: false };
}
