/**
 * Studio hand-off: an asset approved in Studio arrives as `plugin.<studio id>.asset.approved` with a short-lived URL,
 * and lands in this company's media library under the asset's client (or own work). Keyed on the Studio asset id,
 * so a replayed event does not import the file twice.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { importFromUrl } from "./media.js";

export const STUDIO_PLUGIN_ID = "partnersinbiz.studio";
export const STUDIO_ASSET_APPROVED = `plugin.${STUDIO_PLUGIN_ID}.asset.approved` as const;

export interface StudioApproved {
  assetId: string;
  url: string;
  name: string | null;
  altText: string | null;
  client: { kind: string; id: string } | null;
}

export function parseStudioApproved(payload: unknown): StudioApproved | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const assetId = typeof p.assetId === "string" ? p.assetId.trim() : "";
  const url = typeof p.url === "string" ? p.url.trim() : "";
  if (!assetId || !url.startsWith("https://")) return null;
  const c = p.client && typeof p.client === "object" ? (p.client as Record<string, unknown>) : null;
  const client = c && typeof c.kind === "string" && typeof c.id === "string" && c.kind && c.id ? { kind: c.kind, id: c.id } : null;
  return {
    assetId,
    url,
    name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : null,
    altText: typeof p.altText === "string" && p.altText.trim() ? p.altText.trim() : null,
    client,
  };
}

const stateKey = (companyId: string, assetId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "studio-import", stateKey: assetId });

type Importer = (ctx: PluginContext, companyId: string, params: Record<string, unknown>) => Promise<unknown>;

export async function importStudioAsset(ctx: PluginContext, companyId: string, payload: unknown, importer: Importer = (c, id, p) => importFromUrl(c, id, p)) {
  const approved = parseStudioApproved(payload);
  if (!approved) return { status: "ignored" as const, mediaAssetId: null };
  const key = stateKey(companyId, approved.assetId);
  const seen = (await ctx.state.get(key)) as { mediaAssetId?: string | null } | null | undefined;
  if (seen) return { status: "duplicate" as const, mediaAssetId: seen.mediaAssetId ?? null };
  const params: Record<string, unknown> = { url: approved.url, noAnnounce: true };
  if (approved.name) params.name = approved.name;
  if (approved.altText) params.altText = approved.altText;
  if (approved.client) params.client = `${approved.client.kind}:${approved.client.id}`;
  const out = (await importer(ctx, companyId, params)) as { id?: unknown } | null;
  const mediaAssetId = out && typeof out.id === "string" ? out.id : null;
  await ctx.state.set(key, { mediaAssetId, studioAssetId: approved.assetId, importedAt: new Date().toISOString() });
  return { status: "imported" as const, mediaAssetId };
}

export function registerStudioImport(ctx: PluginContext): void {
  ctx.events.on(STUDIO_ASSET_APPROVED, async (event: PluginEvent) => {
    try {
      const out = await importStudioAsset(ctx, event.companyId, event.payload);
      ctx.logger.info("Studio asset import", { companyId: event.companyId, ...out });
    } catch (error) {
      ctx.logger.warn("Studio asset import failed", { companyId: event.companyId, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
