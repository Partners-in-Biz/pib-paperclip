/**
 * Fetch untrusted URLs (client websites) through the host's SSRF-guarded
 * `ctx.http.fetch`. The host does not follow redirects, so we do, re-checking
 * each hop through the guard.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface SafeFetchResult {
  status: number;
  url: string;
  redirects: string[];
  headers: Record<string, string>;
  text: string;
  ms: number;
}

export async function safeFetch(
  ctx: PluginContext,
  url: string,
  init: { method?: string; headers?: Record<string, string>; maxRedirects?: number; maxChars?: number } = {},
): Promise<SafeFetchResult> {
  const maxRedirects = init.maxRedirects ?? 5;
  const maxChars = init.maxChars ?? 2_000_000;
  const redirects: string[] = [];
  let current = normalizeUrl(url);
  const started = Date.now();
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const res = await ctx.http.fetch(current, {
      method: init.method ?? "GET",
      headers: { "User-Agent": "PiB-SEO-Bot/1.0 (+https://partnersinbiz.online)", Accept: "*/*", ...(init.headers ?? {}) },
      redirect: "manual",
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    if (res.status >= 300 && res.status < 400 && headers.location) {
      redirects.push(current);
      current = new URL(headers.location, current).toString();
      continue;
    }
    const text = (await res.text()).slice(0, maxChars);
    return { status: res.status, url: current, redirects, headers, text, ms: Date.now() - started };
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withScheme);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http and https URLs are allowed");
  return parsed.toString();
}

export function siteOrigin(value: string): string {
  return new URL(normalizeUrl(value)).origin;
}
