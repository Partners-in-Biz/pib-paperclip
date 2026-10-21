/**
 * The asset path (W5 C35): a rendered image goes to R2, to the scope's Drive "02 Assets" folder, and onto the post.
 *
 * Spike (read from code; a live run is the Dogfood check after deploy): Social has no broker call of its own. It
 * reaches Drive through the kit's `driveSave`, which sends the bytes as base64 in an event to the CRM broker (5 MB cap in
 * the kit). The host worker RPC allows 128M chars, so a PNG over 100 KB passes and no C35a is needed.
 *
 * Order matters: everything that can refuse (alt text, bytes, scope, post state) runs before the R2 write, so a refusal
 * never leaves an orphan. After the R2 write nothing throws away the asset: a Drive or attach failure is reported next
 * to the asset id and the asset keeps its alt text.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { driveSave, formatClientParam, r2PutObject, sameClient, type DriveSaveOptions, type DriveSaveResult } from "@partnersinbiz/pib-plugin-kit";
import { resolveScope, rowScope, scopeFromParams, scopeInput, type ResolvedScope } from "./clients.js";
import { loadSocialConfig } from "./config.js";
import { postMedia } from "./db.js";
import { assertEditable, mediaKindFromMime, SocialError } from "./domain.js";
import { ATTACHMENT_MAX_BYTES, mediaKey, registerAsset } from "./media.js";
import { mediaInfo, shapeNotes, sniffMime } from "./media-info.js";
import { SOCIAL_MEDIA_MIME } from "./platforms.js";
import { requirePost, updatePostRecord, type Viewer } from "./service.js";

export type DriveOutcome = { ok: true; url: string; driveFileId: string } | { ok: false; reason: string };

export interface AssetPathDeps {
  driveSave?: (ctx: Pick<PluginContext, "events">, opts: DriveSaveOptions) => Promise<DriveSaveResult>;
  /** Adds the asset to the post (default: update-post). */
  attach?: (ctx: PluginContext, viewer: Viewer, input: Record<string, unknown>) => Promise<unknown>;
  now?: () => Date;
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov" };

function clean(value: string, max: number): string {
  return value.replace(/[\/\\]/g, "-").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, max);
}

export async function storeRenderedAsset(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, deps: AssetPathDeps = {}) {
  const companyId = viewer.companyId;
  const altText = typeof params.altText === "string" ? params.altText.trim() : "";
  if (!altText) throw new SocialError("altText is required: say what the image shows, for screen readers");
  const encoded = typeof params.contentBase64 === "string" ? params.contentBase64.trim() : "";
  if (!encoded) throw new SocialError("contentBase64 is required: the rendered file, base64 encoded");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) throw new SocialError("The rendered file is empty.");
  if (bytes.length > ATTACHMENT_MAX_BYTES) throw new SocialError("The rendered file is over 64 MB; host it publicly and use import-media-from-url.");
  const mime = sniffMime(bytes);
  if (!mime || !SOCIAL_MEDIA_MIME.includes(mime)) throw new SocialError("The file is not a JPEG, PNG, GIF, WebP, MP4 or MOV; Social cannot store it.");

  // Scope first, before any write: the post's own scope, or the named client, or own work.
  const postId = typeof params.postId === "string" ? params.postId.trim() : "";
  const post = postId ? await requirePost(ctx, viewer, postId) : null;
  let target: ResolvedScope;
  let existing: string[] = [];
  if (post) {
    if (post.scope === "personal") throw new SocialError("store-rendered-asset is for company and client posts, not a personal draft");
    assertEditable(post.status);
    const requested = scopeInput(params);
    const postScope = rowScope(post);
    if (requested !== undefined && !sameClient(requested, postScope.scope)) {
      throw new SocialError("That post belongs to a different client. Leave client out, or pass the post's own client.");
    }
    const media = postMedia(post);
    if (media.some((m) => !m.assetId)) throw new SocialError("This post has media that is not in the media library; replace it with library assets before attaching.");
    existing = media.map((m) => m.assetId as string);
    target = await resolveScope(ctx, companyId, postScope.scope);
  } else {
    target = await scopeFromParams(ctx, companyId, params);
  }

  const config = await loadSocialConfig(ctx, companyId);
  const r2 = await config.r2();
  const name = clean(typeof params.name === "string" ? params.name : "", 120) || "rendered";
  const key = mediaKey(companyId, mime, name);
  const publicUrl = await r2PutObject(r2, key, bytes, mime);
  const info = mediaInfo(bytes, mime);
  const asset = await registerAsset(ctx, companyId, {
    name,
    url: publicUrl,
    mime,
    bytes: bytes.length,
    width: info.width,
    height: info.height,
    durationS: info.durationS,
    r2Key: key,
    kind: mediaKindFromMime(mime),
    altText,
    ...(target.scope ? { client: formatClientParam(target.scope) } : {}),
  }, config);

  // Drive: the scope's own folder. A failure is reported; the R2 asset stays.
  let drive: DriveOutcome;
  const date = (deps.now?.() ?? new Date()).toISOString().split("T")[0];
  const label = clean(target.client?.name ?? "Partners in Biz", 60);
  const fileName = `${date} ${label} ${clean(name.replace(/\.[a-z0-9]+$/i, ""), 80) || "rendered"} v01.${EXT[mime] ?? "bin"}`;
  try {
    const saved = await (deps.driveSave ?? driveSave)(ctx, {
      companyId,
      kind: "social",
      name: fileName,
      mimeType: mime,
      bytes,
      subfolder: "02 Assets",
      timeoutMs: 30_000,
      ...(target.scope ? { client: { kind: target.scope.kind, ref: target.scope.id } } : {}),
    });
    drive = saved.status === "saved" ? { ok: true, url: saved.url, driveFileId: saved.driveFileId } : { ok: false, reason: saved.status === "failed" ? saved.reason : saved.status };
  } catch (error) {
    drive = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!drive.ok) ctx.logger.warn("store-rendered-asset: could not save to Drive; the R2 asset is kept", { assetId: asset.id, reason: drive.reason });

  // Attach: add the asset after the post's current media (same scope was checked above).
  let attached: { ok: true; postId: string } | { ok: false; postId: string; reason: string } | null = null;
  if (post) {
    try {
      await (deps.attach ?? updatePostRecord)(ctx, viewer, { postId: post.id, mediaAssetIds: Array.from(new Set([...existing, asset.id])) });
      attached = { ok: true, postId: post.id };
    } catch (error) {
      attached = { ok: false, postId: post.id, reason: error instanceof Error ? error.message : String(error) };
      ctx.logger.warn("store-rendered-asset: could not attach to the post; the asset is kept", { assetId: asset.id, postId: post.id });
    }
  }
  return { asset, drive, attached, notes: shapeNotes(info, mime) };
}
