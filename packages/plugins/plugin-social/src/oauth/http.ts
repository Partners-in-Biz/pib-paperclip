/** HTTP + OAuth1 signing helpers shared by all platform providers. */
import { createHmac } from "node:crypto";

export class ProviderHttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

export async function jfetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  return res;
}

export async function jsonOrThrow(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderHttpError(res.status, text);
  }
  if (!res.ok) {
    throw new ProviderHttpError(res.status, text);
  }
  return data as Record<string, unknown>;
}

/** application/x-www-form-urlencoded POST (used by most token endpoints). */
export async function formPost(
  url: string,
  params: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.set(k, v);
  const res = await jfetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: body.toString(),
  });
  return jsonOrThrow(res);
}

export function basicAuth(login: string, password: string): string {
  return "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** RFC 3986 percent-encode (OAuth1 uses this, not encodeURIComponent). */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function hmacSha1Base64(key: string, data: string): string {
  return createHmac("sha1", key).update(data).digest("base64");
}

export interface OAuth1Token {
  token: string;
  tokenSecret: string;
}

/**
 * Build an OAuth 1.0a Authorization header (HMAC-SHA1).
 * Used for X/Twitter API v1.1/v2 requests.
 */
export function oauth1Header(
  method: string,
  url: string,
  params: Record<string, string> | undefined,
  consumerKey: string,
  consumerSecret: string,
  token: OAuth1Token,
  oauthVerifier?: string,
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: Math.random().toString(36).slice(2) + Date.now().toString(36),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: token.token,
    oauth_version: "1.0",
  };
  if (oauthVerifier) oauthParams.oauth_verifier = oauthVerifier;

  const all: Record<string, string> = { ...(params ?? {}) };
  for (const [k, v] of Object.entries(oauthParams)) all[k] = v;

  const paramStr = Object.keys(all)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(all[k]!)}`)
    .join("&");

  const base = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramStr)}`;
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(token.tokenSecret)}`;
  const signature = hmacSha1Base64(signingKey, base);

  const header = Object.entries({ ...oauthParams, oauth_signature: signature })
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(", ");
  return `OAuth ${header}`;
}
