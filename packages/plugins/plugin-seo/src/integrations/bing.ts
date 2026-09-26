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

// ---------------------------------------------------------------------------
// Site setup through the Bing Webmaster API (AddSite, verification, submissions)
// ---------------------------------------------------------------------------

export interface BingUserSite {
  url: string;
  isVerified: boolean;
  authenticationCode: string | null;
  dnsVerificationCode: string | null;
}

async function bingCall(fetchImpl: FetchLike, apiKey: string, method: string, body?: Record<string, unknown>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetchImpl(`${BASE}/${method}?apikey=${encodeURIComponent(apiKey)}`, {
      method: body ? "POST" : "GET",
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const message = json && typeof json === "object" && typeof (json as { Message?: unknown }).Message === "string" ? (json as { Message: string }).Message : text.slice(0, 200);
      throw new Error(`Bing Webmaster API ${method} returned HTTP ${res.status}${message ? `: ${message}` : ""}`);
    }
    return json && typeof json === "object" && "d" in (json as object) ? (json as { d: unknown }).d : json;
  } finally {
    clearTimeout(timer);
  }
}

function sameSite(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().toLowerCase().replace(/\/+$/, "");
  return norm(a) === norm(b);
}

export async function bingGetUserSites(fetchImpl: FetchLike, apiKey: string): Promise<BingUserSite[]> {
  const d = await bingCall(fetchImpl, apiKey, "GetUserSites");
  const list = Array.isArray(d) ? d : [];
  return list.map((item) => {
    const s = item as Record<string, unknown>;
    return {
      url: String(s.Url ?? ""),
      isVerified: Boolean(s.IsVerified),
      authenticationCode: typeof s.AuthenticationCode === "string" ? s.AuthenticationCode : null,
      dnsVerificationCode: typeof s.DnsVerificationCode === "string" ? s.DnsVerificationCode : null,
    };
  });
}

/** Add the site (no-op when it exists) and return its verification codes. */
export async function bingAddSite(fetchImpl: FetchLike, apiKey: string, siteUrl: string): Promise<BingUserSite> {
  const existing = (await bingGetUserSites(fetchImpl, apiKey)).find((s) => sameSite(s.url, siteUrl));
  if (!existing) await bingCall(fetchImpl, apiKey, "AddSite", { siteUrl });
  const site = existing ?? (await bingGetUserSites(fetchImpl, apiKey)).find((s) => sameSite(s.url, siteUrl));
  if (!site) throw new Error(`Bing did not list ${siteUrl} after AddSite`);
  return site;
}

export async function bingVerifySite(fetchImpl: FetchLike, apiKey: string, siteUrl: string): Promise<boolean> {
  const result = await bingCall(fetchImpl, apiKey, "VerifySite", { siteUrl });
  if (result === true) return true;
  const site = (await bingGetUserSites(fetchImpl, apiKey)).find((s) => sameSite(s.url, siteUrl));
  return Boolean(site?.isVerified);
}

export async function bingSubmitSitemap(fetchImpl: FetchLike, apiKey: string, siteUrl: string, feedUrl: string): Promise<void> {
  await bingCall(fetchImpl, apiKey, "SubmitSitemap", { siteUrl, feedUrl });
}

export async function bingSubmitUrlBatch(fetchImpl: FetchLike, apiKey: string, siteUrl: string, urlList: string[]): Promise<number> {
  const list = [...new Set(urlList)].slice(0, 500);
  if (list.length === 0) return 0;
  await bingCall(fetchImpl, apiKey, "SubmitUrlBatch", { siteUrl, urlList: list });
  return list.length;
}

/** BingSiteAuth.xml and the equivalent meta tag for an authentication code. */
export function bingVerificationFiles(code: string): { file: { path: string; content: string }; meta: string } {
  return {
    file: { path: "/BingSiteAuth.xml", content: `<?xml version="1.0"?>\n<users>\n\t<user>${code}</user>\n</users>\n` },
    meta: `<meta name="msvalidate.01" content="${code}" />`,
  };
}
