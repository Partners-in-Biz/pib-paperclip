/**
 * The sender's look on PDFs: a logo fetched from an https address in the
 * sender settings, and a brand colour. Paperclip's own company logo lives
 * behind a signed-in asset route a plugin worker cannot read, so the address
 * is set in Billing settings (Your business: Logo address).
 *
 * Fetching never blocks a document: a slow, missing or odd file gives no logo
 * and the sender's name shows instead.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { pdfImageType, safeFetchBytes } from "@partnersinbiz/pib-plugin-kit";
import type { BillingSettings } from "./config.js";

export interface DocBrand {
  logo: Uint8Array | null;
  accent: string | null;
}

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; bytes: Uint8Array | null }>();

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** An https address of at most 500 characters, or null. */
export function logoAddress(value: unknown): string | null {
  const url = text(value);
  if (!url || url.length > 500 || !/^https:\/\/[^\s"'<>]+$/i.test(url)) return null;
  return url;
}

/** `#rrggbb` / `#rgb`, or null. */
export function brandColor(value: unknown): string | null {
  const v = text(value);
  if (!v) return null;
  const hex = v.startsWith("#") ? v : `#${v}`;
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex) ? hex.toLowerCase() : null;
}

/** The document's own sender first (frozen at send), then today's settings. */
function pick(sender: Record<string, unknown>, settings: BillingSettings, key: string): unknown {
  const own = sender[key];
  if (text(own)) return own;
  const base = settings.sender && typeof settings.sender === "object" ? (settings.sender as Record<string, unknown>)[key] : undefined;
  return base;
}

async function fetchLogo(ctx: PluginContext, url: string): Promise<Uint8Array | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.bytes;
  let bytes: Uint8Array | null = null;
  try {
    const res = await safeFetchBytes(ctx, url, { maxBytes: LOGO_MAX_BYTES, headers: { Accept: "image/png,image/jpeg,*/*;q=0.5" } });
    if (res.status >= 200 && res.status < 300 && pdfImageType(res.bytes)) bytes = res.bytes;
    else ctx.logger.info("Document logo skipped: not a PNG or JPEG", { status: res.status, contentType: res.contentType ?? null });
  } catch (error) {
    ctx.logger.info("Document logo could not be fetched", { reason: error instanceof Error ? error.message : String(error) });
  }
  cache.set(url, { at: Date.now(), bytes });
  return bytes;
}

export async function documentBrand(ctx: PluginContext, sender: Record<string, unknown>, settings: BillingSettings): Promise<DocBrand> {
  const url = logoAddress(pick(sender, settings, "logoUrl"));
  return {
    logo: url ? await fetchLogo(ctx, url) : null,
    accent: brandColor(pick(sender, settings, "brandColor")),
  };
}

/** Tests only. */
export function clearLogoCache(): void {
  cache.clear();
}
