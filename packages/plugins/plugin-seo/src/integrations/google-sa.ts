/**
 * Google service account access (OAuth 2.0 JWT bearer, RFC 7523) for Search
 * Console and the Site Verification API. One service account serves every
 * sprint: it becomes a verified owner of our own sites (meta tag / file via
 * the site repo) and is added as a user on client properties.
 *
 * Tokens are cached in memory for at most 50 minutes (Google issues 60).
 */
import { createSign } from "node:crypto";
import { GOOGLE_TOKEN_URL, GoogleApiError, type FetchLike } from "./google.js";

export const SA_SCOPES = ["https://www.googleapis.com/auth/webmasters", "https://www.googleapis.com/auth/siteverification"] as const;
export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const SITE_VERIFICATION = "https://www.googleapis.com/siteVerification/v1";
const WEBMASTERS = "https://www.googleapis.com/webmasters/v3";
const CACHE_MS = 50 * 60 * 1000;

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
  privateKeyId: string | null;
  projectId: string | null;
  tokenUri: string;
}

/** Parse the JSON key file Google Cloud downloads (Service accounts → Keys → Add key → JSON). */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("The Google service account key is not valid JSON. Paste the whole JSON key file.");
  }
  if (json.type && json.type !== "service_account") throw new Error(`The Google key is a "${String(json.type)}" key, not a service account key.`);
  const clientEmail = typeof json.client_email === "string" ? json.client_email.trim() : "";
  const privateKey = typeof json.private_key === "string" ? json.private_key.replace(/\\n/g, "\n") : "";
  if (!clientEmail || !privateKey.includes("PRIVATE KEY")) throw new Error("The Google service account key has no client_email or private_key.");
  return {
    clientEmail,
    privateKey,
    privateKeyId: typeof json.private_key_id === "string" ? json.private_key_id : null,
    projectId: typeof json.project_id === "string" ? json.project_id : null,
    tokenUri: typeof json.token_uri === "string" && json.token_uri.startsWith("https://") ? json.token_uri : GOOGLE_TOKEN_URL,
  };
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** RS256-signed JWT assertion for the token endpoint. */
export function signServiceAccountJwt(key: ServiceAccountKey, scopes: readonly string[], nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(key.privateKeyId ? { kid: key.privateKeyId } : {}) };
  const claims = { iss: key.clientEmail, scope: scopes.join(" "), aud: key.tokenUri, iat, exp: iat + 3600 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(input).end().sign(key.privateKey);
  return `${input}.${b64url(signature)}`;
}

const cache = new Map<string, { token: string; expiresAt: number }>();

/** For tests. */
export function clearServiceAccountTokenCache(): void {
  cache.clear();
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

function errorText(body: Record<string, unknown>, status: number): string {
  const err = body.error;
  if (typeof err === "string") return `${err}${typeof body.error_description === "string" ? `: ${body.error_description}` : ""}`;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") return (err as { message: string }).message;
  return `HTTP ${status}`;
}

/** Access token for the service account (cached ~50 min per account and scope set). */
export async function serviceAccountToken(fetchImpl: FetchLike, key: ServiceAccountKey, scopes: readonly string[] = SA_SCOPES, nowMs = Date.now()): Promise<string> {
  const cacheKey = `${key.clientEmail}|${key.privateKeyId ?? ""}|${scopes.join(" ")}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > nowMs) return hit.token;
  const assertion = signServiceAccountJwt(key, scopes, nowMs);
  const res = await timed(fetchImpl, key.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString(),
  });
  const body = await readJson(res);
  if (!res.ok || typeof body.access_token !== "string") {
    throw new GoogleApiError(`Google refused the service account key (${errorText(body, res.status)}). Check the key in the SEO settings and that the service account still exists.`, res.status || 400, false);
  }
  const lifetime = Math.min(Number(body.expires_in ?? 3600) * 1000 - 60_000, CACHE_MS);
  cache.set(cacheKey, { token: body.access_token, expiresAt: nowMs + Math.max(lifetime, 60_000) });
  return body.access_token;
}

async function call(fetchImpl: FetchLike, token: string, method: string, url: string, label: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await timed(fetchImpl, url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await readJson(res);
  if (!res.ok) throw new GoogleApiError(`${label}: ${errorText(json, res.status)}`, res.status, false);
  return json;
}

// ---------------------------------------------------------------------------
// Site Verification API
// ---------------------------------------------------------------------------

export type VerificationMethod = "META" | "FILE" | "DNS_TXT";
export type VerificationSite = { type: "SITE" | "INET_DOMAIN"; identifier: string };

/** A URL-prefix site (`https://example.com/`) or a domain (`example.com` / `sc-domain:example.com`). */
export function verificationSite(input: { siteUrl: string; domain?: boolean }): VerificationSite {
  const url = new URL(/^https?:\/\//i.test(input.siteUrl) ? input.siteUrl : `https://${input.siteUrl.replace(/^sc-domain:/, "")}`);
  if (input.domain || input.siteUrl.startsWith("sc-domain:")) return { type: "INET_DOMAIN", identifier: url.hostname.replace(/^www\./, "") };
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return { type: "SITE", identifier: `${url.origin}${path}` };
}

/** The Search Console property for a verification site. */
export function propertyFor(site: VerificationSite): string {
  return site.type === "INET_DOMAIN" ? `sc-domain:${site.identifier}` : site.identifier;
}

export async function getVerificationToken(fetchImpl: FetchLike, token: string, site: VerificationSite, method: VerificationMethod): Promise<{ method: VerificationMethod; token: string }> {
  if (site.type === "INET_DOMAIN" && method !== "DNS_TXT") throw new Error("A domain property can only be verified with a DNS TXT record (method DNS_TXT).");
  if (site.type === "SITE" && method === "DNS_TXT") throw new Error("Use META or FILE for a URL-prefix site; DNS_TXT is for domain properties.");
  const body = await call(fetchImpl, token, "POST", `${SITE_VERIFICATION}/token`, "Site Verification", { site, verificationMethod: method });
  if (typeof body.token !== "string" || !body.token) throw new GoogleApiError("Site Verification returned no token", 502, false);
  return { method, token: body.token };
}

/** Verify the site; on success the service account becomes a verified owner. */
export async function insertWebResource(fetchImpl: FetchLike, token: string, site: VerificationSite, method: VerificationMethod): Promise<{ id: string | null; owners: string[] }> {
  const body = await call(fetchImpl, token, "POST", `${SITE_VERIFICATION}/webResource?verificationMethod=${method}`, "Site Verification", { site });
  return { id: typeof body.id === "string" ? body.id : null, owners: Array.isArray(body.owners) ? body.owners.map(String) : [] };
}

/** Search Console `sites.add` for a property the caller has verified. */
export async function addSearchConsoleSite(fetchImpl: FetchLike, token: string, property: string): Promise<void> {
  await call(fetchImpl, token, "PUT", `${WEBMASTERS}/sites/${encodeURIComponent(property)}`, "Search Console");
}

/** What the agent has to put on the site for a verification token. */
export function verificationChange(method: VerificationMethod, token: string): { kind: "meta" | "file" | "dns"; detail: Record<string, string> } {
  if (method === "META") {
    const content = /content="([^"]+)"/.exec(token)?.[1] ?? token;
    return { kind: "meta", detail: { tag: token.startsWith("<") ? token : `<meta name="google-site-verification" content="${content}" />`, content, nextjs: `export const metadata = { verification: { google: "${content}" } } (root layout)` } };
  }
  if (method === "FILE") {
    return { kind: "file", detail: { path: `/${token}`, content: `google-site-verification: ${token}`, nextjs: `public/${token}` } };
  }
  return { kind: "dns", detail: { type: "TXT", host: "@ (the bare domain)", value: token } };
}

/** Search Console users page for a property (where a person adds the service account). */
export function gscUsersLink(property: string): string {
  return `https://search.google.com/search-console/users?resource_id=${encodeURIComponent(property)}`;
}

/** Search Console URL Inspection page for one URL. */
export function gscInspectLink(property: string, url: string): string {
  return `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(property)}&id=${encodeURIComponent(url)}`;
}

// ---------------------------------------------------------------------------
// Setup probe: are the two APIs enabled for the service account's project?
// ---------------------------------------------------------------------------

export type ApiProbe = { state: "on" } | { state: "off"; message: string } | { state: "unknown"; message: string };

/** Google's answer when an API is not enabled for the project. */
export function isApiDisabled(status: number, message: string): boolean {
  return status === 403 && /has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(message);
}

async function probe(fetchImpl: FetchLike, token: string, url: string, label: string): Promise<ApiProbe> {
  try {
    await call(fetchImpl, token, "GET", url, label);
    return { state: "on" };
  } catch (error) {
    const status = error instanceof GoogleApiError ? error.status : 0;
    const message = error instanceof Error ? error.message : String(error);
    return isApiDisabled(status, message) ? { state: "off", message } : { state: "unknown", message };
  }
}

/** Lists (read-only) against both APIs; a disabled API answers 403 SERVICE_DISABLED. */
export async function probeServiceAccountApis(fetchImpl: FetchLike, token: string): Promise<{ siteVerification: ApiProbe; searchConsole: ApiProbe }> {
  const [siteVerification, searchConsole] = await Promise.all([
    probe(fetchImpl, token, `${SITE_VERIFICATION}/webResource`, "Site Verification"),
    probe(fetchImpl, token, `${WEBMASTERS}/sites`, "Search Console"),
  ]);
  return { siteVerification, searchConsole };
}
