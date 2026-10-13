import type { PluginContext, PluginWebhookInput, PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { normalizeE164 } from "./phone.js";
import { TWILIO_AUTH_TOKEN } from "./secret-names.js";
import { buildPublicWebhookUrl, parseFormParams, verifyTwilioWebhook } from "./twilio-signature.js";
import { writeAudit } from "./audit.js";
import { insertOnce } from "./idempotency.js";
import { readHeader } from "./http-util.js";
import { isWindowOpen } from "./wa-window.js";
import { matchContactsByPhone } from "./contact-match.js";
import { applyWaOptOut } from "./optout.js";

/**
 * Webhook handler status codes.
 * - null: request was valid but had no matching company (should not happen in practice)
 * - "bad_signature": signature verification failed
 * - "missing_secret": no TWILIO_AUTH_TOKEN configured for any company that can be resolved
 * - "missing_host": no host header could be derived for URL construction
 * - "unparseable_number": from/to phone number could not be normalized
 * - "ok": successfully processed
 */
export type WaOutcome =
  | "ok"
  | "bad_signature"
  | "missing_secret"
  | "missing_host"
  | "unparseable_number"
  | null;

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
function getPublicBaseUrl(headers: Record<string, string | string[] | undefined>): string | null {
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
async function resolveVerifiedCompany(
  ctx: PluginContext,
  headers: Record<string, string | string[] | undefined>,
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

/**
 * Handle incoming WhatsApp messages.
 */
export async function handleWaInbound(
  ctx: PluginContext,
  dbClient: PluginDatabaseClient,
  namespace: string,
  input: PluginWebhookInput,
  pluginId: string,
): Promise<WaOutcome> {
  const { headers, rawBody } = input;

  // Derive the public base URL from headers
  const baseUrl = getPublicBaseUrl(headers);
  if (!baseUrl) {
    ctx.logger.warn("wa-inbound webhook: could not derive host from headers");
    return "missing_host";
  }

  // Build the webhook URL that Twilio signed
  const webhookUrl = buildPublicWebhookUrl({
    baseUrl,
    pluginId,
    endpointKey: "wa-inbound",
  });

  // Find the company whose token verifies the signature
  const result = await resolveVerifiedCompany(ctx, headers, rawBody, webhookUrl);
  if (!result) {
    ctx.logger.warn("wa-inbound webhook: no TWILIO_AUTH_TOKEN configured for any company");
    return "missing_secret";
  }
  if ("error" in result) {
    ctx.logger.warn("wa-inbound webhook: signature verification failed", {
      reason: result.error,
    });
    return result.error as WaOutcome;
  }

  const verifiedCompanyId = result.companyId;

  // Parse the form-encoded body
  const params = parseFormParams(rawBody);
  const messageSid = params.MessageSid?.[0];
  const from = params.From?.[0];
  const to = params.To?.[0];
  const body = params.Body?.[0];
  const waId = params.WaId?.[0];
  const numMedia = params.NumMedia?.[0] ? Number(params.NumMedia[0]) : 0;

  // Strip whatsapp: prefix and normalize phone numbers
  const fromNumber = from?.replace(/^whatsapp:/, "");
  const toNumber = to?.replace(/^whatsapp:/, "");

  if (!messageSid || !fromNumber || !toNumber) {
    ctx.logger.warn("wa-inbound webhook: missing required fields");
    return null;
  }

  const fromE164 = normalizeE164(fromNumber);
  const toE164 = normalizeE164(toNumber);

  if (!fromE164 || !toE164) {
    ctx.logger.warn("wa-inbound webhook: could not normalize phone numbers", {
      from: fromE164 ? "ok" : "invalid",
      to: toE164 ? "ok" : "invalid",
    });
    return "unparseable_number";
  }

  // Match the inbound number to a contact
  const match = await matchContactsByPhone(dbClient, namespace, verifiedCompanyId, fromE164);

  // Insert the message (idempotent by MessageSid)
  const inserted = await insertOnce(dbClient, namespace, "message", {
    company_id: verifiedCompanyId,
    channel: "whatsapp",
    direction: "inbound",
    provider_msg_id: messageSid,
    contact_id: match.contactId,
    ambiguous: match.ambiguous,
    from_e164: fromE164,
    to_e164: toE164,
    body: body || null,
    status: "received",
    received_at: new Date(),
  });

  // Apply opt-out on EVERY delivery (including duplicates)
  const optOutResult = await applyWaOptOut(dbClient, namespace, {
    companyId: verifiedCompanyId,
    e164: fromE164,
    candidateIds: match.candidateIds,
    providerMsgId: messageSid,
    body: body || "",
  });

  // Write audit entry (only if this is a new message)
  if (inserted) {
    await writeAudit(dbClient, namespace, {
      companyId: verifiedCompanyId,
      userId: "system",
      action: "wa.inbound",
      contactId: match.contactId,
      detail: {
        sid: messageSid,
        from: fromE164,
        to: toE164,
        numMedia,
        ambiguous: match.ambiguous,
        candidateCount: match.candidateIds.length,
        optOut: optOutResult.optedOut,
      },
    });
  }

  // Write separate audit action for opt-out only when the number opt-out was first created
  if (optOutResult.optedOut && optOutResult.numberOptOutCreated) {
    await writeAudit(dbClient, namespace, {
      companyId: verifiedCompanyId,
      userId: "system",
      action: "wa_opt_out",
      contactId: match.contactId,
      detail: {
        candidateCount: match.candidateIds.length,
      },
    });
  }

  return "ok";
}

/**
 * Handle WhatsApp message status updates.
 */
export async function handleWaStatus(
  ctx: PluginContext,
  dbClient: PluginDatabaseClient,
  namespace: string,
  input: PluginWebhookInput,
  pluginId: string,
): Promise<WaOutcome> {
  const { headers, rawBody } = input;

  // Derive the public base URL from headers
  const baseUrl = getPublicBaseUrl(headers);
  if (!baseUrl) {
    ctx.logger.warn("wa-status webhook: could not derive host from headers");
    return "missing_host";
  }

  // Build the webhook URL that Twilio signed
  const webhookUrl = buildPublicWebhookUrl({
    baseUrl,
    pluginId,
    endpointKey: "wa-status",
  });

  // Find the company whose token verifies the signature
  const result = await resolveVerifiedCompany(ctx, headers, rawBody, webhookUrl);
  if (!result) {
    ctx.logger.warn("wa-status webhook: no TWILIO_AUTH_TOKEN configured for any company");
    return "missing_secret";
  }
  if ("error" in result) {
    ctx.logger.warn("wa-status webhook: signature verification failed", {
      reason: result.error,
    });
    return result.error as WaOutcome;
  }

  const verifiedCompanyId = result.companyId;

  // Parse the form-encoded body
  const params = parseFormParams(rawBody);
  const messageSid = params.MessageSid?.[0];
  const messageStatus = params.MessageStatus?.[0];
  const smsStatus = params.SmsStatus?.[0];

  if (!messageSid) {
    ctx.logger.warn("wa-status webhook: missing MessageSid");
    return null;
  }

  // Prefer MessageStatus (WhatsApp) over SmsStatus (SMS fallback)
  const newStatus = messageStatus || smsStatus;
  if (!newStatus) {
    ctx.logger.debug("wa-status webhook: no status value");
    return null;
  }

  // Map status values to ranks (higher = more progressed)
  const statusRanks: Record<string, number> = {
    queued: 1,
    sent: 2,
    delivered: 3,
    read: 4,
    failed: 5, // Terminal
    undelivered: 5, // Terminal
  };

  const newRank = statusRanks[newStatus] ?? 0;
  if (newRank === 0) {
    ctx.logger.debug("wa-status webhook: unknown status value", { status: newStatus });
    return null;
  }

  // Update status atomically, only if new rank is higher and not already terminal
  await dbClient.execute(
    `UPDATE ${namespace}.tel_messages
     SET status = $1, updated_at = now()
     WHERE provider_msg_id = $2
       AND company_id = $3
       AND (
         (status IN ('queued', 'sent', 'delivered', 'read') AND $4::int > (
           SELECT COALESCE(
             CASE
               WHEN status = 'queued' THEN 1
               WHEN status = 'sent' THEN 2
               WHEN status = 'delivered' THEN 3
               WHEN status = 'read' THEN 4
               WHEN status IN ('failed', 'undelivered') THEN 5
               ELSE 0
             END,
             0
           )
           FROM ${namespace}.tel_messages
           WHERE provider_msg_id = $2
         ))
       )`,
    [newStatus, messageSid, verifiedCompanyId, newRank],
  );

  return "ok";
}
