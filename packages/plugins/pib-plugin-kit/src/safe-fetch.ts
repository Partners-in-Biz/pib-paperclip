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

export interface SafeFetchBytesResult {
  status: number;
  url: string;
  contentType?: string;
  bytes: Uint8Array;
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

export async function safeFetchBytes(
  ctx: PluginContext,
  url: string,
  init: { method?: string; headers?: Record<string, string>; maxRedirects?: number; maxBytes?: number } = {},
): Promise<SafeFetchBytesResult> {
  const maxRedirects = init.maxRedirects ?? 5;
  const maxBytes = init.maxBytes ?? 26_214_400; // 25 MiB
  let current = normalizeUrl(url);
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
      current = new URL(headers.location, current).toString();
      continue;
    }
    // Check Content-Length header early to reject oversized responses without buffering
    const contentLength = headers["content-length"];
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (!isNaN(size) && size > maxBytes) {
        throw new Error(`Response exceeds maxBytes limit (${size} > ${maxBytes}) fetching ${url}`);
      }
    }
    const contentType = headers["content-type"];
    let bytes: Uint8Array;
    // Try to use body stream if available, otherwise fall back to arrayBuffer
    if (res.body && typeof res.body.getReader === "function") {
      const chunks: Uint8Array[] = [];
      let totalSize = 0;
      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalSize += value.length;
          if (totalSize > maxBytes) {
            throw new Error(`Response exceeds maxBytes limit (streamed data > ${maxBytes}) fetching ${url}`);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      bytes = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
    } else {
      // Fallback for responses without a readable body stream
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        throw new Error(`Response exceeds maxBytes limit (${buffer.byteLength} > ${maxBytes}) fetching ${url}`);
      }
      bytes = new Uint8Array(buffer);
    }
    return { status: res.status, url: current, contentType: contentType || undefined, bytes };
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
