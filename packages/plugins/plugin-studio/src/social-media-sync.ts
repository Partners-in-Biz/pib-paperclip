/**
 * Social media -> Studio library. A file added to a company's Social media library arrives as
 * `plugin.<social id>.media.added` with its public R2 URL; it is copied into Studio's library under the same client
 * (or own work), so it shows in a card's file picker. The source ref `social:<scope>:<mediaId>` is unique per company,
 * so a replay or a re-announce returns the first copy and never doubles a file.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { formatClientParam, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { storeAsset } from "./assets.js";
import { StudioConfig } from "./config.js";
import { table } from "./db.js";
import { StudioError } from "./errors.js";
import { resolveScope, scopeInput } from "./scope.js";
import { MAX_ASSET_BYTES, sniffMime } from "./storage.js";

export const SOCIAL_PLUGIN_ID = "partnersinbiz.social";
export const SOCIAL_MEDIA_ADDED = `plugin.${SOCIAL_PLUGIN_ID}.media.added` as const;

export interface SocialMediaAdded {
  mediaId: string;
  url: string;
  name: string | null;
  altText: string | null;
  client: { kind: string; id: string } | null;
}

export function parseMediaAdded(payload: unknown): SocialMediaAdded | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const mediaId = typeof p.mediaId === "string" ? p.mediaId.trim() : "";
  const url = typeof p.url === "string" ? p.url.trim() : "";
  if (!mediaId || !/^https:\/\//i.test(url)) return null;
  const c = p.client && typeof p.client === "object" ? (p.client as Record<string, unknown>) : null;
  const client = c && typeof c.kind === "string" && typeof c.id === "string" && c.kind && c.id ? { kind: c.kind, id: c.id } : null;
  return {
    mediaId,
    url,
    name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : null,
    altText: typeof p.altText === "string" && p.altText.trim() ? p.altText.trim() : null,
    client,
  };
}

export function socialSourceRef(scope: ClientScope, mediaId: string): string {
  return `social:${scope ? formatClientParam(scope) : "own"}:${mediaId}`;
}

async function download(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new StudioError(`Social's media file could not be read (${res.status}).`, "social_media_unreadable");
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_ASSET_BYTES) throw new StudioError(`The file is ${Math.round(declared / 1024 / 1024)} MB; Studio takes up to ${MAX_ASSET_BYTES / 1024 / 1024} MB.`, "too_large");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_ASSET_BYTES) throw new StudioError(`Studio takes files up to ${MAX_ASSET_BYTES / 1024 / 1024} MB.`, "too_large");
  return bytes;
}

export async function importSocialMedia(ctx: PluginContext, companyId: string, payload: unknown, fetchBytes: (url: string) => Promise<Uint8Array<ArrayBuffer>> = download) {
  const media = parseMediaAdded(payload);
  if (!media) return { status: "ignored" as const, assetId: null };
  const resolved = await resolveScope(ctx, companyId, scopeInput({ client: media.client ? `${media.client.kind}:${media.client.id}` : null }) ?? null);
  const sourceRef = socialSourceRef(resolved.scope, media.mediaId);
  const existing = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "assets")} WHERE company_id = $1 AND source_ref = $2`, [companyId, sourceRef]);
  if (existing[0]) return { status: "duplicate" as const, assetId: existing[0].id };
  const bytes = await fetchBytes(media.url);
  const mime = sniffMime(bytes);
  if (!mime) throw new StudioError("Studio stores JPEG, PNG, GIF and WebP images and MP4 and MOV videos, and this file is none of those.", "unsupported_type");
  const name = media.name ?? (new URL(media.url).pathname.split("/").pop() || "Social media");
  const id = await storeAsset(ctx, new StudioConfig(ctx, companyId), {
    companyId,
    scope: resolved.scope,
    clientName: resolved.client?.name ?? null,
    projectId: null,
    issueId: null,
    name,
    altText: media.altText,
    source: "social",
    sourceRef,
    bytes,
    mime,
  });
  return { status: "imported" as const, assetId: id };
}

export function registerSocialMediaSync(ctx: PluginContext): void {
  ctx.events.on(SOCIAL_MEDIA_ADDED, async (event: PluginEvent) => {
    try {
      const out = await importSocialMedia(ctx, event.companyId, event.payload);
      ctx.logger.info("Social media import", { companyId: event.companyId, ...out });
    } catch (error) {
      ctx.logger.warn("Social media import failed", { companyId: event.companyId, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
