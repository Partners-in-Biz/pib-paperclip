/**
 * Owner-push API route: send a critical push notification from an external system to the owner.
 * - Validates required fields: companyId, class, title, body, url.
 * - Enforces class == "critical" (no needs_you etc).
 * - Validates title (1-120 chars), body (1-400 chars).
 * - Parses and validates URL: https only, no userinfo, origin must match Paperclip base.
 * - Rate limits: 10 per hour per company (atomic via takeRateSlot).
 * - Gets owner via getRoles; no owner -> {sent:0, failed:0}.
 * - Sends via sendPush with class "critical" (kill switch, global caps, SSRF re-check, logging all apply).
 * - Never echoes request content in response or logs.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { PluginApiRequestInput, PluginApiResponse } from "@paperclipai/plugin-sdk";
import { getRoles } from "../db.js";
import { listSubscriptionsForUser } from "./store.js";
import { sendPush } from "./send.js";
import { takeRateSlot } from "./store.js";

/** Default Paperclip origin for URL validation. */
const DEFAULT_PAPERCLIP_ORIGIN = "https://paperclip.partnersinbiz.online";

export async function handleOwnerPush(env: { ctx: PluginContext; now: () => Date }, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  try {
    const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? (input.body as Record<string, unknown>) : {};
    const companyId = input.companyId;

    // Validate companyId in body matches resolved companyId
    if (typeof body.companyId !== "string" || !String(body.companyId).trim()) {
      return { status: 400, body: { error: "companyId is required and must be a non-empty string" } };
    }
    if (String(body.companyId).trim() !== companyId) {
      return { status: 400, body: { error: "Body companyId does not match resolved companyId" } };
    }

    // Validate class == "critical"
    if (body.class !== "critical") {
      return { status: 400, body: { error: 'class must be exactly "critical"' } };
    }

    // Validate title: non-empty, <= 120 chars
    if (typeof body.title !== "string" || !String(body.title).trim()) {
      return { status: 400, body: { error: "title is required and must be a non-empty string" } };
    }
    const title = String(body.title).trim();
    if (title.length > 120) {
      return { status: 400, body: { error: "title must be at most 120 characters" } };
    }

    // Validate body: non-empty, <= 400 chars
    if (typeof body.body !== "string" || !String(body.body).trim()) {
      return { status: 400, body: { error: "body is required and must be a non-empty string" } };
    }
    const bodyText = String(body.body).trim();
    if (bodyText.length > 400) {
      return { status: 400, body: { error: "body must be at most 400 characters" } };
    }

    // Validate url: https, no userinfo, origin must match Paperclip base
    if (typeof body.url !== "string" || !String(body.url).trim()) {
      return { status: 400, body: { error: "url is required and must be a non-empty string" } };
    }
    const urlStr = String(body.url).trim();
    let urlObj: URL;
    try {
      urlObj = new URL(urlStr);
    } catch {
      return { status: 400, body: { error: "url must be a valid URL" } };
    }

    // Check https
    if (urlObj.protocol !== "https:") {
      return { status: 400, body: { error: "url must use https protocol" } };
    }

    // Check no userinfo (username or password)
    if (urlObj.username || urlObj.password) {
      return { status: 400, body: { error: "url must not contain userinfo (username or password)" } };
    }

    // Check origin matches Paperclip base
    const urlOrigin = `${urlObj.protocol}//${urlObj.host}`;
    if (urlOrigin !== DEFAULT_PAPERCLIP_ORIGIN) {
      return { status: 400, body: { error: `url origin must be ${DEFAULT_PAPERCLIP_ORIGIN}` } };
    }

    // Check for unknown fields (only companyId, class, title, body, url allowed)
    const allowed = new Set(["companyId", "class", "title", "body", "url"]);
    for (const field of Object.keys(body)) {
      if (!allowed.has(field)) {
        return { status: 400, body: { error: `Unknown field: ${field}` } };
      }
    }

    // Rate limit: 10 per hour per company
    const now = env.now();
    const windowStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    const rateKey = `owner-push:${companyId}`;
    const rateLimitCap = 10;

    const slotTaken = await takeRateSlot(env.ctx, rateKey, windowStart, rateLimitCap);
    if (!slotTaken) {
      return { status: 429, body: { error: "rate limit" } };
    }

    // Get owner
    const roles = await getRoles(env.ctx, companyId);
    const ownerUserId = roles?.ownerUserId ?? null;

    // No owner: return {sent:0, failed:0}
    if (!ownerUserId) {
      return { status: 200, body: { sent: 0, failed: 0 } };
    }

    // Get owner's subscriptions
    const subs = await listSubscriptionsForUser(env.ctx, companyId, ownerUserId);
    const okSubs = subs.filter((s) => s.state === "ok");

    // If no subscriptions, return {sent:0, failed:0}
    if (okSubs.length === 0) {
      return { status: 200, body: { sent: 0, failed: 0 } };
    }

    // Send via sendPush with class "critical"
    const result = await sendPush(
      env.ctx,
      companyId,
      okSubs,
      {
        title,
        body: bodyText,
        url: urlStr,
        tag: "owner-push",
        class: "critical",
      },
      { class: "critical" },
    );

    // Count outcomes: sent = "sent", failed = error/needs_resubscribe/deleted/refused
    const sent = result.devices.filter((d) => d.outcome === "sent").length;
    const failed = result.devices.filter((d) => d.outcome !== "sent" && d.outcome !== "skipped_muted").length;

    return { status: 200, body: { sent, failed } };
  } catch (error) {
    // Log without echoing request content
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, body: { error: message } };
  }
}
