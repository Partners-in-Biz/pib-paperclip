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

/**
 * Get all companies from ctx.companies.list, paginating through all results.
 * Returns empty list if no companies exist or if listing fails.
 */
async function getAllCompanies(ctx: PluginContext): Promise<string[]> {
  const companies: string[] = [];
  let offset = 0;
  const limit = 100;

  try {
    while (true) {
      const batch = await ctx.companies.list({ offset, limit });
      if (batch.length === 0) break;

      for (const company of batch) {
        companies.push(company.id);
      }

      if (batch.length < limit) break;
      offset += limit;
    }
  } catch {
    return [];
  }

  return companies;
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
  const companyIds = await getAllCompanies(ctx);

  let hadToken = false;

  for (const companyId of companyIds) {
    let authToken: string | undefined;
    try {
      authToken = await ctx.secrets.resolve(TWILIO_AUTH_TOKEN, { companyId });
    } catch {
      // Secret not found or not resolvable for this company; skip it
      continue;
    }

    if (!authToken) continue;

    hadToken = true;

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

  // If we tried at least one token and it failed, report bad signature
  if (hadToken) {
    return { error: "bad_signature" };
  }

  // No company had a token to try
  return null;
}
