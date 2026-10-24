import type { PluginContext } from "@paperclipai/plugin-sdk";
import { TWILIO_AUTH_TOKEN } from "./secret-names.js";
import { verifyTwilioWebhook } from "./twilio-signature.js";
import { readHeader, type HeaderBag } from "./http-util.js";

/**
 * Derive the public base URL from request headers.
 *
 * Security note: a forged Host header cannot help an attacker because the signature
 * is still verified against the company's auth token, which only that company knows.
 *
 * Protocol: x-forwarded-proto (first value) or default to 'https'
 * Host: x-forwarded-host (first value) or host header
 *
 * Returns null if no host header could be found.
 */
export function getPublicBaseUrl(headers: HeaderBag): string | null {
  // Get protocol: prefer x-forwarded-proto, default to https
  const xForwardedProto = readHeader(headers, "x-forwarded-proto");
  const proto = xForwardedProto || "https";

  // Get host: prefer x-forwarded-host, fall back to host header
  const xForwardedHost = readHeader(headers, "x-forwarded-host");
  const hostHeader = readHeader(headers, "host");
  const host = xForwardedHost || hostHeader;

  if (!host) {
    return null;
  }

  return `${proto}://${host}`;
}

/** Twilio signatures are base64 of an HMAC-SHA1 digest: 20 bytes, 28 chars. */
const SIGNATURE_SHAPE = /^[A-Za-z0-9+/]{27}=$/;

/** How long the company list and tokens are reused between unauthenticated hits. */
export const TOKEN_CACHE_TTL_MS = 60_000;

type TokenEntry = { companyId: string; authToken: string };
const tokenCache = new WeakMap<object, { at: number; entries: TokenEntry[] }>();

/**
 * List companies (paginated) and resolve each one's TWILIO_AUTH_TOKEN.
 * Cached briefly per plugin context so a flood of unsigned requests cannot
 * cause a company list plus one secret lookup per company on every hit.
 */
async function loadTokens(ctx: PluginContext): Promise<TokenEntry[]> {
  const cached = tokenCache.get(ctx);
  if (cached && Date.now() - cached.at < TOKEN_CACHE_TTL_MS) return cached.entries;

  const ids: string[] = [];
  let offset = 0;
  const limit = 100;
  try {
    while (true) {
      const batch = await ctx.companies.list({ offset, limit });
      if (batch.length === 0) break;
      for (const company of batch) ids.push(company.id);
      if (batch.length < limit) break;
      offset += limit;
    }
  } catch {
    return [];
  }

  const entries: TokenEntry[] = [];
  for (const companyId of ids) {
    try {
      const authToken = await ctx.secrets.resolve(TWILIO_AUTH_TOKEN, { companyId });
      if (authToken) entries.push({ companyId, authToken });
    } catch {
      // Secret not found or not resolvable for this company; skip it
    }
  }
  tokenCache.set(ctx, { at: Date.now(), entries });
  return entries;
}

/**
 * Find which company's TWILIO_AUTH_TOKEN can verify the webhook signature.
 *
 * Try each company in ctx.companies.list, resolve its TWILIO_AUTH_TOKEN secret,
 * and verify the signature. The first company whose token verifies wins.
 * Skip companies where the secret cannot be resolved.
 *
 * Returns { companyId } if a company verified, { error } if verification failed,
 * or null if no company had a token to try.
 */
export async function resolveVerifiedCompany(
  ctx: PluginContext,
  headers: HeaderBag,
  rawBody: string,
  webhookUrl: string,
): Promise<{ companyId: string } | { error: string } | null> {
  // Cheap reject first: a malformed or missing signature never costs a lookup.
  const signature = readHeader(headers, "x-twilio-signature");
  if (!signature || !SIGNATURE_SHAPE.test(signature)) {
    return { error: "bad_signature" };
  }

  const entries = await loadTokens(ctx);
  if (entries.length === 0) return null;

  for (const { companyId, authToken } of entries) {
    const result = verifyTwilioWebhook({
      authToken,
      headers,
      rawBody,
      url: webhookUrl,
    });

    if (result.ok) {
      return { companyId };
    }
  }

  return { error: "bad_signature" };
}
