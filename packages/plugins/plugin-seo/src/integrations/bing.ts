/**
 * Bing Webmaster Tools. Only inbound link counts are used (GetLinkCounts):
 * the response is `{ d: { Links: [{ Url, Count }], TotalPages } }` — pages of
 * the site and how many external links point at each. The old platform's
 * "backlink discovery" read fields this endpoint does not return, so it never
 * discovered anything; this reports totals only.
 */
import type { FetchLike } from "./google.js";

const BASE = "https://ssl.bing.com/webmaster/api.svc/json";

export interface BingLinkCounts {
  totalInboundLinks: number;
  pages: Array<{ url: string; count: number }>;
  totalPages: number | null;
}

export function parseBingLinkCounts(json: unknown): BingLinkCounts {
  const root = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const d = root.d;
  const container = (d && typeof d === "object" && !Array.isArray(d) ? d : {}) as Record<string, unknown>;
  const list = Array.isArray(container.Links) ? container.Links : Array.isArray(d) ? d : null;
  if (!list) throw new Error("Unexpected Bing GetLinkCounts response");
  const pages = list
    .map((item) => item as Record<string, unknown>)
    .map((item) => ({ url: String(item.Url ?? item.url ?? ""), count: Number(item.Count ?? item.count ?? 0) }))
    .filter((p) => p.url && Number.isFinite(p.count));
  return {
    totalInboundLinks: pages.reduce((sum, p) => sum + p.count, 0),
    pages: pages.sort((a, b) => b.count - a.count),
    totalPages: typeof container.TotalPages === "number" ? container.TotalPages : null,
  };
}

export async function fetchBingLinkCounts(fetchImpl: FetchLike, input: { apiKey: string; siteUrl: string; page?: number }): Promise<BingLinkCounts> {
  const params = new URLSearchParams({ siteUrl: input.siteUrl, page: String(input.page ?? 0), apikey: input.apiKey });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetchImpl(`${BASE}/GetLinkCounts?${params.toString()}`, { signal: controller.signal, headers: { Accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) throw new Error(`Bing Webmaster API returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    return parseBingLinkCounts(text ? JSON.parse(text) : {});
  } finally {
    clearTimeout(timer);
  }
}
