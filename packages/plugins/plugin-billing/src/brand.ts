/**
 * The sender's look on PDFs: a logo fetched from an https address in the
 * sender settings, and a brand colour. Paperclip's own company logo lives
 * behind a signed-in asset route a plugin worker cannot read, so the address
 * is set in Billing settings (Your business: Logo address).
 *
 * The host's `ctx.http.fetch` hands the body back as text, which breaks a PNG
 * (seen live 2026-11-13: 200 image/png, wrong bytes), so the logo is fetched
 * with Node's fetch, like the R2 reads, behind our own guard: https only,
 * public addresses only (checked again on every redirect), 10 s, 2 MB.
 *
 * Fetching never blocks a document: a slow, missing or odd file gives no logo
 * and the sender's name shows instead.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { pdfImageType } from "@partnersinbiz/pib-plugin-kit";
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

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses (IPv4 and IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (isIP(v) === 4) {
    const [a, b] = v.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(v) === 6) return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
  return true;
}

export type HostCheck = (hostname: string) => Promise<boolean>;

/** The default check: the name resolves, and to public addresses only. */
export const publicHost: HostCheck = async (hostname) => {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || /\.(local|internal|localhost)$/i.test(host)) return false;
  if (isIP(host)) return !isPrivateAddress(host);
  try {
    const all = await lookup(host, { all: true });
    return all.length > 0 && all.every((r) => !isPrivateAddress(r.address));
  } catch {
    return false;
  }
};

/** Download a logo: https, public host on every hop, at most 3 redirects, 10 s and LOGO_MAX_BYTES. */
export async function downloadLogo(url: string, opts: { fetchImpl?: typeof fetch; hostOk?: HostCheck } = {}): Promise<Uint8Array> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const hostOk = opts.hostOk ?? publicHost;
  let current = url;
  for (let hop = 0; hop <= 3; hop += 1) {
    const parsed = new URL(current);
    if (parsed.protocol !== "https:") throw new Error("Logo address must use https");
    if (!(await hostOk(parsed.hostname))) throw new Error("Logo host is not a public address");
    const res = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { Accept: "image/png,image/jpeg,*/*;q=0.5" } });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect ${res.status} without a location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > LOGO_MAX_BYTES) throw new Error("Logo is larger than 2 MB");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > LOGO_MAX_BYTES) throw new Error("Logo is larger than 2 MB");
    return bytes;
  }
  throw new Error("Too many redirects");
}

async function fetchLogo(ctx: PluginContext, url: string, opts: { fetchImpl?: typeof fetch; hostOk?: HostCheck }): Promise<Uint8Array | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.bytes;
  let bytes: Uint8Array | null = null;
  try {
    const got = await downloadLogo(url, opts);
    if (pdfImageType(got)) bytes = got;
    else ctx.logger.info("Document logo skipped: not a PNG or JPEG", { bytes: got.length });
  } catch (error) {
    ctx.logger.info("Document logo could not be fetched", { reason: error instanceof Error ? error.message : String(error) });
  }
  cache.set(url, { at: Date.now(), bytes });
  return bytes;
}

export async function documentBrand(
  ctx: PluginContext,
  sender: Record<string, unknown>,
  settings: BillingSettings,
  opts: { fetchImpl?: typeof fetch; hostOk?: HostCheck } = {},
): Promise<DocBrand> {
  const url = logoAddress(pick(sender, settings, "logoUrl"));
  return {
    logo: url ? await fetchLogo(ctx, url, opts) : null,
    accent: brandColor(pick(sender, settings, "brandColor")),
  };
}

/** Tests only. */
export function clearLogoCache(): void {
  cache.clear();
}
