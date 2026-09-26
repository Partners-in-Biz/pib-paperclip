/**
 * Media on Cloudflare R2.
 *
 * Browsers upload straight to the bucket with a presigned PUT (the bucket's
 * CORS must allow the Paperclip origin), then register the asset. Agents
 * import from a URL: the worker downloads with native fetch after checking
 * the URL is public https, then PUTs to R2.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { objectKeyFor, r2PutObject, r2Upload } from "@partnersinbiz/pib-plugin-kit";
import { inScope, scopeColumns, scopeFromParams, scopeLabel, scopeOut, type ClientScope } from "./clients.js";
import { loadSocialConfig, r2PublicHost, type SocialConfig } from "./config.js";
import { getMediaAssets, insertMediaAsset, mediaRefFromAsset, type MediaAssetRow, type MediaRef } from "./db.js";
import { mediaKindFromMime, SocialError } from "./domain.js";
import { downloadMedia } from "./oauth/http.js";
import { MEDIA_MAX_BYTES, SOCIAL_MEDIA_MIME } from "./platforms.js";

export const R2_PREFIX = "social";

export function assertUploadable(input: { mime: string; bytes: number }): void {
  if (!SOCIAL_MEDIA_MIME.includes(input.mime)) {
    throw new SocialError(`Unsupported file type ${input.mime}. Use JPEG, PNG, GIF, WebP, MP4 or MOV.`);
  }
  if (!Number.isFinite(input.bytes) || input.bytes <= 0) throw new SocialError("File size is required");
  if (input.bytes > MEDIA_MAX_BYTES) throw new SocialError("Files are limited to 512 MB");
}

export function mediaKey(companyId: string, mime: string, fileName?: string): string {
  return objectKeyFor({ prefix: R2_PREFIX, companyId, mime, fileName });
}

export async function presignUpload(ctx: PluginContext, companyId: string, input: { fileName: string; mime: string; bytes: number }) {
  assertUploadable(input);
  const config = await loadSocialConfig(ctx, companyId);
  const r2 = await config.r2();
  const key = mediaKey(companyId, input.mime, input.fileName);
  const { uploadUrl, publicUrl } = r2Upload(r2, key, 900);
  return { uploadUrl, publicUrl, key, headers: { "Content-Type": input.mime }, expiresInSeconds: 900 };
}

function assetOut(row: MediaAssetRow) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    kind: row.kind,
    mime: row.mime,
    bytes: row.bytes == null ? null : Number(row.bytes),
    width: row.width,
    height: row.height,
    durationS: row.duration_s == null ? null : Number(row.duration_s),
    altText: row.alt_text,
    r2Key: row.r2_key,
    ...scopeOut(row),
  };
}

export { assetOut };

function optionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Keys we issued look like social/<companyId>/<yyyy-mm>/<uuid>[-name].<ext>. */
function assertOwnKey(companyId: string, key: string): void {
  if (!key.startsWith(`${R2_PREFIX}/${companyId}/`) || key.includes("..")) throw new SocialError("That upload key does not belong to this company");
}

export async function registerAsset(
  ctx: PluginContext,
  companyId: string,
  params: Record<string, unknown>,
  config?: SocialConfig,
): Promise<ReturnType<typeof assetOut>> {
  const url = typeof params.url === "string" ? params.url.trim() : "";
  const name = (typeof params.name === "string" && params.name.trim()) || url.split("/").pop() || "Media";
  if (!/^https:\/\//i.test(url)) throw new SocialError("Asset URL must start with https://");
  const mime = typeof params.mime === "string" && params.mime ? params.mime : null;
  const kindInput = typeof params.kind === "string" ? params.kind.toLowerCase() : null;
  const kind = kindInput === "video" || kindInput === "image" ? kindInput : mime ? mediaKindFromMime(mime) : /\.(mp4|mov|m4v)(\?|$)/i.test(url) ? "video" : "image";
  let r2Key = typeof params.r2Key === "string" && params.r2Key ? params.r2Key : null;
  if (r2Key) {
    assertOwnKey(companyId, r2Key);
    const cfg = config ?? (await loadSocialConfig(ctx, companyId));
    const host = r2PublicHost(cfg);
    if (host && new URL(url).host.toLowerCase() !== host) throw new SocialError("The asset URL must be on the R2 public media domain");
  }
  // Media belongs to the scope it was added in: own work unless a client is named.
  const target = await scopeFromParams(ctx, companyId, params);
  const row: MediaAssetRow & { source_url?: string | null } = {
    id: randomUUID(),
    company_id: companyId,
    name: name.slice(0, 200),
    url,
    kind,
    r2_key: r2Key,
    mime,
    bytes: optionalNumber(params.bytes),
    width: optionalNumber(params.width),
    height: optionalNumber(params.height),
    duration_s: optionalNumber(params.durationS),
    alt_text: typeof params.altText === "string" && params.altText.trim() ? params.altText.trim().slice(0, 1500) : null,
    ...scopeColumns(target),
    created_at: null,
    source_url: typeof params.sourceUrl === "string" ? params.sourceUrl : null,
  };
  await insertMediaAsset(ctx, row);
  return assetOut(row);
}

/** Download a public https file and store it on R2 (agent tool). */
export async function importFromUrl(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const sourceUrl = typeof params.url === "string" ? params.url.trim() : "";
  if (!sourceUrl) throw new SocialError("url is required");
  // Refuse an unknown client before downloading anything.
  await scopeFromParams(ctx, companyId, params);
  const config = await loadSocialConfig(ctx, companyId);
  const r2 = await config.r2();
  const file = await downloadMedia(sourceUrl, { maxBytes: MEDIA_MAX_BYTES, label: "Import URL" });
  let mime = file.mime;
  if (mime === "image/jpg") mime = "image/jpeg";
  if (!SOCIAL_MEDIA_MIME.includes(mime)) throw new SocialError(`The URL returned ${mime}; only images (JPEG, PNG, GIF, WebP) and MP4/MOV videos can be imported`);
  const fileName = (typeof params.name === "string" && params.name) || new URL(sourceUrl).pathname.split("/").pop() || "import";
  const key = mediaKey(companyId, mime, fileName);
  const publicUrl = await r2PutObject(r2, key, file.bytes, mime);
  return registerAsset(ctx, companyId, {
    ...params,
    url: publicUrl,
    name: fileName,
    mime,
    bytes: file.size,
    r2Key: key,
    kind: mediaKindFromMime(mime),
    sourceUrl,
  }, config);
}

/**
 * Turn asset ids into the media array stored on a post (keeps the given
 * order). Every asset must belong to the post's scope.
 */
export async function mediaFromAssetIds(ctx: PluginContext, companyId: string, ids: unknown, scope: ClientScope): Promise<MediaRef[] | undefined> {
  if (ids === undefined) return undefined;
  if (ids === null) return [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new SocialError("mediaAssetIds must be a list of media asset ids");
  const unique = Array.from(new Set(ids as string[]));
  const rows = await getMediaAssets(ctx, companyId, unique);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length) throw new SocialError(`Unknown media asset ${missing[0]}. Use list-media-assets or import-media-from-url.`);
  const foreign = rows.find((row) => !inScope(row, scope));
  if (foreign) {
    throw new SocialError(`Media "${foreign.name}" belongs to ${scopeLabel(foreign)}. A post can only use media of its own client (or own work).`);
  }
  return unique.map((id) => mediaRefFromAsset(byId.get(id)!));
}

/** Media on a post whose asset is outside `scope` (legacy posts from before strict scopes). */
export async function foreignMedia(ctx: PluginContext, companyId: string, media: MediaRef[], scope: ClientScope): Promise<MediaAssetRow[]> {
  const ids = Array.from(new Set(media.map((m) => m.assetId).filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return [];
  return (await getMediaAssets(ctx, companyId, ids)).filter((row) => !inScope(row, scope));
}
