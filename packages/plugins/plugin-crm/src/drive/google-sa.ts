/**
 * Google service account access (OAuth 2.0 JWT bearer, RFC 7523) for the Drive
 * API. Same flow as plugin-seo's `integrations/google-sa.ts`, kept as its own
 * copy so the CRM does not depend on the SEO package. Tokens are cached in
 * memory for at most 50 minutes (Google issues 60).
 */
import { createSign } from "node:crypto";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const CACHE_MS = 50 * 60 * 1000;

export type GoogleFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
  privateKeyId: string | null;
  projectId: string | null;
  tokenUri: string;
}

export class GoogleAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

/** Parse the JSON key file Google Cloud downloads (Service accounts → Keys → Add key → JSON). */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("The Drive service account key is not valid JSON. Store the whole JSON key file as the secret.");
  }
  if (json.type && json.type !== "service_account") throw new Error(`The Drive key is a "${String(json.type)}" key, not a service account key.`);
  const clientEmail = typeof json.client_email === "string" ? json.client_email.trim() : "";
  const privateKey = typeof json.private_key === "string" ? json.private_key.replace(/\\n/g, "\n") : "";
  if (!clientEmail || !privateKey.includes("PRIVATE KEY")) throw new Error("The Drive service account key has no client_email or private_key.");
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

/** Access token for the service account (cached ~50 min per account and scope set). */
export async function serviceAccountToken(fetchImpl: GoogleFetch, key: ServiceAccountKey, scopes: readonly string[] = [DRIVE_SCOPE], nowMs = Date.now()): Promise<string> {
  const cacheKey = `${key.clientEmail}|${key.privateKeyId ?? ""}|${scopes.join(" ")}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > nowMs) return hit.token;
  const assertion = signServiceAccountJwt(key, scopes, nowMs);
  const res = await fetchImpl(key.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString(),
    signal: AbortSignal.timeout(25_000),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  if (!res.ok || typeof body.access_token !== "string") {
    const detail = typeof body.error === "string" ? `${body.error}${typeof body.error_description === "string" ? `: ${body.error_description}` : ""}` : `HTTP ${res.status}`;
    throw new GoogleAuthError(`Google refused the Drive service account key (${detail}). Check the key and that the service account still exists.`, res.status || 400);
  }
  const lifetime = Math.min(Number(body.expires_in ?? 3600) * 1000 - 60_000, CACHE_MS);
  cache.set(cacheKey, { token: body.access_token, expiresAt: nowMs + Math.max(lifetime, 60_000) });
  return body.access_token;
}
