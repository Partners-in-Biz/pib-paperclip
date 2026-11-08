/**
 * Media hand-off to Studio: a file added to a company's Social media library is announced as `media.added`
 * (arrives as `plugin.<social id>.media.added`) with its public R2 URL, so Studio can copy it into its own library
 * under the same client. Studio keys the copy on the media id, so a replay or a re-announce never doubles a file.
 * Personal (My Social) media is never announced. Files that came from Studio carry `noAnnounce` and are not sent back.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { listMediaAssets, type MediaAssetRow } from "./db.js";

export const MEDIA_ADDED_EVENT = "media.added";

export function mediaAddedPayload(row: Pick<MediaAssetRow, "id" | "name" | "url" | "kind" | "mime" | "bytes" | "alt_text" | "client_kind" | "client_ref" | "client_name">) {
  return {
    mediaId: row.id,
    url: row.url,
    name: row.name,
    kind: row.kind,
    mime: row.mime,
    bytes: row.bytes == null ? null : Number(row.bytes),
    altText: row.alt_text,
    client: row.client_kind && row.client_ref ? { kind: row.client_kind, id: row.client_ref, name: row.client_name } : null,
  };
}

/** Announce one org media row. Never throws: the upload already succeeded. */
export async function announceMedia(ctx: PluginContext, companyId: string, row: MediaAssetRow): Promise<boolean> {
  if (row.scope === "personal" || row.owner_user_id) return false;
  try {
    await ctx.events.emit(MEDIA_ADDED_EVENT, companyId, mediaAddedPayload(row));
    return true;
  } catch (error) {
    ctx.logger.warn("Media announce failed", { companyId, mediaId: row.id, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** Announce every org media file of the company again (the files added before this hand-off existed). */
export async function announceExistingMedia(ctx: PluginContext, companyId: string): Promise<{ announced: number; total: number }> {
  const rows = await listMediaAssets(ctx, companyId);
  let announced = 0;
  for (const row of rows) if (await announceMedia(ctx, companyId, row)) announced += 1;
  return { announced, total: rows.length };
}
