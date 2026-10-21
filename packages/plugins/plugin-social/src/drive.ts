/**
 * Save published posts and media to company Drive.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { driveSave, DRIVE_SUBFOLDERS, type DriveSaveOptions, type DriveSaveResult } from "@partnersinbiz/pib-plugin-kit";
import type { MediaRef } from "./db.js";
import type { SocialPlatform } from "./platforms.js";

export interface SaveToDriveOptions {
  companyId: string;
  post: { id: string; body: string };
  platform: SocialPlatform;
  media: MediaRef[];
  publishedAt?: Date;
  driveSave?: (ctx: Pick<PluginContext, "events">, opts: DriveSaveOptions) => Promise<DriveSaveResult>;
}

/**
 * Sanitize filename parts to match /^\d{4}-\d{2}-\d{2}\s+.+\s+v\d+\.\w+$/
 * No / \ or control chars.
 */
function sanitizePart(part: string): string {
  return part
    .replace(/[\/\\]/g, "-")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 200);
}

function getFileExtension(mimeType: string | null, url: string): string {
  // Try to extract from URL first
  const urlMatch = url.match(/\.([a-z0-9]+)(?:\?|$)/i);
  if (urlMatch) return urlMatch[1].toLowerCase();

  // Fall back to mime type
  if (!mimeType || mimeType === "application/octet-stream") {
    return "bin";
  }
  const ext = mimeType.split("/")[1]?.split("+")[0] ?? "bin";
  return ext.replace(/[^a-z0-9]/g, "");
}

function shortId(postId: string): string {
  return postId.replace(/-/g, "").slice(0, 8);
}

export async function saveToDrive(ctx: PluginContext, opts: SaveToDriveOptions): Promise<void> {
  const drive = opts.driveSave || driveSave;
  const publishDate = opts.publishedAt || new Date();
  const dateStr = publishDate.toISOString().split("T")[0];
  const platformLabel = sanitizePart(opts.platform);
  const postId = shortId(opts.post.id);

  // Save caption/text as text/plain
  try {
    const captionName = `${dateStr} ${platformLabel} ${postId} caption v1.txt`;
    const captionBytes = Buffer.from(opts.post.body, "utf-8");
    const result = await drive(ctx, {
      companyId: opts.companyId,
      kind: "social",
      name: captionName,
      mimeType: "text/plain",
      bytes: captionBytes,
      subfolder: "02 Assets",
      timeoutMs: 10000,
    });
    if (result.status === "failed") {
      ctx.logger.warn("Failed to save post caption to Drive", { status: result.status, reason: (result as any).reason });
    }
  } catch (error) {
    ctx.logger.warn("Error saving post caption to Drive", { error: error instanceof Error ? error.message : String(error) });
  }

  // Save media items
  for (let i = 0; i < opts.media.length; i++) {
    const media = opts.media[i];
    if (!media.url || !media.url.startsWith("https://")) continue;

    try {
      const ext = getFileExtension(media.mime, media.url);
      const mediaLabel = sanitizePart(`media ${i + 1}`);
      const mediaName = `${dateStr} ${platformLabel} ${postId} ${mediaLabel} v1.${ext}`;

      const result = await drive(ctx, {
        companyId: opts.companyId,
        kind: "social",
        name: mediaName,
        mimeType: media.mime || "application/octet-stream",
        publicUrl: media.url,
        subfolder: "02 Assets",
        timeoutMs: 10000,
      });

      if (result.status === "failed") {
        ctx.logger.warn("Failed to save post media to Drive", { index: i, status: result.status, reason: (result as any).reason });
      }
    } catch (error) {
      ctx.logger.warn("Error saving post media to Drive", { index: i, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
