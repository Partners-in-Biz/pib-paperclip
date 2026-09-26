/**
 * Google OAuth + Search Console API. Uses native `fetch` (fixed Google hosts,
 * no SSRF risk) with a timeout, injectable for tests.
 */
import { comparableUrl } from "../checks/parse.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const WEBMASTERS = "https://www.googleapis.com/webmasters/v3";
const INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when the stored grant no longer works and a person must reconnect. */
    readonly reconnect: boolean,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export function buildGscAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; loginHint?: string | null }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GSC_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: input.state,
  });
  if (input.loginHint) params.set("login_hint", input.loginHint);
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function timed(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs = 25_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new GoogleApiError(`Google did not answer within ${Math.round(timeoutMs / 1000)} s`, 504, false);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

function googleErrorMessage(body: Record<string, unknown>, status: number): string {
  const err = body.error;
  if (typeof err === "string") return `${err}${typeof body.error_description === "string" ? `: ${body.error_description}` : ""}`;
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return `HTTP ${status}`;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
}

async function tokenRequest(fetchImpl: FetchLike, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await timed(fetchImpl, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const body = await readJson(res);
  if (!res.ok) {
    const reconnect = body.error === "invalid_grant" || body.error === "unauthorized_client" || res.status === 401;
    throw new GoogleApiError(`Google token request failed: ${googleErrorMessage(body, res.status)}`, res.status, reconnect);
  }
  return body;
}

export async function exchangeGoogleCode(
  fetchImpl: FetchLike,
  input: { clientId: string; clientSecret: string; redirectUri: string; code: string },
  now = Date.now(),
): Promise<GoogleTokens> {
  const body = await tokenRequest(fetchImpl, {
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  });
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!accessToken) throw new GoogleApiError("Google returned no access token", 502, false);
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresAt: now + Number(body.expires_in ?? 3600) * 1000,
    scope: typeof body.scope === "string" ? body.scope : GSC_SCOPE,
  };
}

export async function refreshGoogleToken(
  fetchImpl: FetchLike,
  input: { clientId: string; clientSecret: string; refreshToken: string },
  now = Date.now(),
): Promise<GoogleTokens> {
  const body = await tokenRequest(fetchImpl, {
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "refresh_token",
  });
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!accessToken) throw new GoogleApiError("Google returned no access token on refresh", 502, false);
  return {
    accessToken,
    // Google normally keeps the refresh token; keep the old one unless a new one arrives.
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : input.refreshToken,
    expiresAt: now + Number(body.expires_in ?? 3600) * 1000,
    scope: typeof body.scope === "string" ? body.scope : GSC_SCOPE,
  };
}

export function tokenNeedsRefresh(tokens: Pick<GoogleTokens, "expiresAt">, now = Date.now()): boolean {
  return !tokens.expiresAt || tokens.expiresAt - 120_000 <= now;
}

async function api(fetchImpl: FetchLike, accessToken: string, method: string, url: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await timed(fetchImpl, url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await readJson(res);
  if (!res.ok) {
    const message = googleErrorMessage(json, res.status);
    const insufficient = /insufficient|scope/i.test(message) && res.status === 403;
    throw new GoogleApiError(`Search Console: ${message}`, res.status, res.status === 401 || insufficient);
  }
  return json;
}

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

export async function listGscSites(fetchImpl: FetchLike, accessToken: string): Promise<GscSite[]> {
  const body = await api(fetchImpl, accessToken, "GET", `${WEBMASTERS}/sites`);
  const entries = Array.isArray(body.siteEntry) ? body.siteEntry : [];
  return entries
    .map((e) => e as Record<string, unknown>)
    .filter((e) => typeof e.siteUrl === "string")
    .map((e) => ({ siteUrl: String(e.siteUrl), permissionLevel: String(e.permissionLevel ?? "") }));
}

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/** Pick the verified property that covers the sprint's site: a Domain property first, then the URL-prefix one. */
export function pickPropertyForSite(sites: GscSite[], siteUrl: string): string | null {
  let host = "";
  let origin = "";
  try {
    const u = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`);
    host = bareHost(u.hostname);
    origin = comparableUrl(u.origin) ?? "";
  } catch {
    return null;
  }
  const usable = sites.filter((s) => s.permissionLevel !== "siteUnverifiedUser");
  const domain = usable.find((s) => s.siteUrl.toLowerCase() === `sc-domain:${host}`);
  if (domain) return domain.siteUrl;
  const prefix = usable.find((s) => {
    if (s.siteUrl.startsWith("sc-domain:")) return false;
    const c = comparableUrl(s.siteUrl);
    if (!c) return false;
    const cu = new URL(c);
    return c === origin || (bareHost(cu.hostname) === host && cu.pathname === "/");
  });
  return prefix?.siteUrl ?? null;
}

export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function querySearchAnalytics(
  fetchImpl: FetchLike,
  accessToken: string,
  property: string,
  input: { startDate: string; endDate: string; dimensions: string[]; rowLimit?: number; startRow?: number; dimensionFilterGroups?: unknown[] },
): Promise<GscRow[]> {
  const body = await api(fetchImpl, accessToken, "POST", `${WEBMASTERS}/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
    startDate: input.startDate,
    endDate: input.endDate,
    dimensions: input.dimensions,
    rowLimit: Math.min(input.rowLimit ?? 5000, 25000),
    startRow: input.startRow ?? 0,
    ...(input.dimensionFilterGroups ? { dimensionFilterGroups: input.dimensionFilterGroups } : {}),
  });
  const rows = Array.isArray(body.rows) ? body.rows : [];
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      keys: Array.isArray(row.keys) ? row.keys.map(String) : [],
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      ctr: Number(row.ctr ?? 0),
      position: Number(row.position ?? 0),
    };
  });
}

export async function submitSitemap(fetchImpl: FetchLike, accessToken: string, property: string, sitemapUrl: string): Promise<void> {
  await api(fetchImpl, accessToken, "PUT", `${WEBMASTERS}/sites/${encodeURIComponent(property)}/sitemaps/${encodeURIComponent(sitemapUrl)}`);
}

export interface UrlInspection {
  url: string;
  verdict: string | null;
  coverageState: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  lastCrawlTime: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  inspectionResultLink: string | null;
}

export async function inspectUrl(fetchImpl: FetchLike, accessToken: string, property: string, url: string): Promise<UrlInspection> {
  const body = await api(fetchImpl, accessToken, "POST", INSPECT_URL, { inspectionUrl: url, siteUrl: property });
  const result = (body.inspectionResult ?? {}) as Record<string, unknown>;
  const index = (result.indexStatusResult ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    url,
    verdict: s(index.verdict),
    coverageState: s(index.coverageState),
    indexingState: s(index.indexingState),
    robotsTxtState: s(index.robotsTxtState),
    pageFetchState: s(index.pageFetchState),
    lastCrawlTime: s(index.lastCrawlTime),
    googleCanonical: s(index.googleCanonical),
    userCanonical: s(index.userCanonical),
    inspectionResultLink: s(result.inspectionResultLink),
  };
}

// ---------------------------------------------------------------------------
// Aggregation (pure)
// ---------------------------------------------------------------------------

export interface KeywordAggregate {
  impressions: number;
  clicks: number;
  ctr: number;
  /** Impression-weighted average position. */
  position: number | null;
  topPage: string | null;
}

export function normalizeQuery(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Match page+query rows to tracked keywords (case-insensitive exact query) and
 * compute impression-weighted position. Keywords without rows are omitted.
 */
export function aggregateKeywordRows(rows: GscRow[], keywords: Array<{ id: string; phrase: string }>): Map<string, KeywordAggregate> {
  const byQuery = new Map<string, GscRow[]>();
  for (const row of rows) {
    const query = normalizeQuery(row.keys[1] ?? row.keys[0] ?? "");
    if (!query) continue;
    const list = byQuery.get(query) ?? [];
    list.push(row);
    byQuery.set(query, list);
  }
  const out = new Map<string, KeywordAggregate>();
  for (const keyword of keywords) {
    const matches = byQuery.get(normalizeQuery(keyword.phrase));
    if (!matches || matches.length === 0) continue;
    let impressions = 0;
    let clicks = 0;
    let weighted = 0;
    let top: GscRow | null = null;
    for (const row of matches) {
      impressions += row.impressions;
      clicks += row.clicks;
      weighted += row.position * row.impressions;
      if (!top || row.impressions > top.impressions) top = row;
    }
    const position = impressions > 0 ? weighted / impressions : matches.reduce((a, r) => a + r.position, 0) / matches.length;
    out.set(keyword.id, {
      impressions,
      clicks,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position: Number.isFinite(position) && position > 0 ? Math.round(position * 100) / 100 : null,
      topPage: top?.keys.length && top.keys.length > 1 ? top.keys[0]! : null,
    });
  }
  return out;
}

/** Per-page totals from page+query rows, keyed by comparable URL. */
export function aggregatePageRows(rows: GscRow[]): Map<string, KeywordAggregate> {
  const acc = new Map<string, { impressions: number; clicks: number; weighted: number }>();
  for (const row of rows) {
    const page = comparableUrl(row.keys[0] ?? "");
    if (!page) continue;
    const entry = acc.get(page) ?? { impressions: 0, clicks: 0, weighted: 0 };
    entry.impressions += row.impressions;
    entry.clicks += row.clicks;
    entry.weighted += row.position * row.impressions;
    acc.set(page, entry);
  }
  const out = new Map<string, KeywordAggregate>();
  for (const [page, e] of acc) {
    out.set(page, {
      impressions: e.impressions,
      clicks: e.clicks,
      ctr: e.impressions > 0 ? e.clicks / e.impressions : 0,
      position: e.impressions > 0 ? Math.round((e.weighted / e.impressions) * 100) / 100 : null,
      topPage: page,
    });
  }
  return out;
}
