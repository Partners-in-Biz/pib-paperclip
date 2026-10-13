import { createHmac, createHash } from "node:crypto";
import { readHeader, timingSafeStringEqual, type HeaderBag } from "./http-util.js";

export function buildPublicWebhookUrl({
  baseUrl,
  pluginId,
  endpointKey,
  rawQuery,
}: {
  baseUrl: string;
  pluginId: string;
  endpointKey: string;
  rawQuery?: string;
}): string {
  // Validate baseUrl with WHATWG URL API
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Invalid base URL");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Base URL must use http: or https:");
  }

  if (url.search || url.hash) {
    throw new Error("Base URL must not have query or hash");
  }

  if (url.username || url.password) {
    throw new Error("Base URL must not have credentials");
  }

  // Remove trailing slashes from base
  let base = url.href;
  if (base.endsWith("/")) {
    base = base.slice(0, -1);
  }

  let result = `${base}/api/plugins/${pluginId}/webhooks/${endpointKey}`;

  if (rawQuery) {
    // Remove leading ? if present
    const query = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
    result += `?${query}`;
  }

  // NOTE: Port-bearing URLs are signed exactly as configured (no with/without-port retry),
  // so the configured baseUrl must match the URL registered in the Twilio console.
  return result;
}

export function parseFormParams(rawBody: string): Record<string, string[]> {
  const params: Record<string, string[]> = {};
  const searchParams = new URLSearchParams(rawBody);

  for (const [key, value] of searchParams) {
    if (!params[key]) {
      params[key] = [];
    }
    params[key].push(value);
  }

  return params;
}

export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string | string[]> = {},
): string {
  const data = url + Object.keys(params)
    .sort()
    .map((key) => {
      const value = params[key];
      if (Array.isArray(value)) {
        return value.map((v) => key + v).join("");
      }
      return key + value;
    })
    .join("");

  return createHmac("sha1", authToken).update(data).digest("base64");
}

export function verifyTwilioWebhook({
  authToken,
  headers,
  rawBody,
  url,
}: {
  authToken: string;
  headers: HeaderBag;
  rawBody: string;
  url: string;
}): { ok: true; variant: "form" | "json" } | { ok: false; reason: "missing_auth_token" | "missing_signature" | "bad_signature" | "bad_body_hash" } {
  if (!authToken) {
    return { ok: false, reason: "missing_auth_token" };
  }

  const signature = readHeader(headers, "x-twilio-signature");
  if (!signature) {
    return { ok: false, reason: "missing_signature" };
  }

  try {
    const urlObj = new URL(url);
    const bodySHA256 = urlObj.searchParams.get("bodySHA256");

    if (bodySHA256) {
      // JSON variant: verify body hash first
      const bodyHash = createHash("sha256").update(rawBody).digest("hex");
      if (!timingSafeStringEqual(bodySHA256, bodyHash)) {
        return { ok: false, reason: "bad_body_hash" };
      }

      // Compute signature over the full URL (including all query params) with no form params
      const expectedSignature = computeTwilioSignature(authToken, url);

      if (!timingSafeStringEqual(signature, expectedSignature)) {
        return { ok: false, reason: "bad_signature" };
      }

      return { ok: true, variant: "json" };
    } else {
      // Form variant: parse form params
      const params = parseFormParams(rawBody);
      const expectedSignature = computeTwilioSignature(authToken, url, params);

      if (!timingSafeStringEqual(signature, expectedSignature)) {
        return { ok: false, reason: "bad_signature" };
      }

      return { ok: true, variant: "form" };
    }
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}
