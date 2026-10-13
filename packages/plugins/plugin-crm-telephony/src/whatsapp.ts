import type { PluginContext, PluginWebhookInput, PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { normalizeE164 } from "./phone.js";
import { buildPublicWebhookUrl, parseFormParams } from "./twilio-signature.js";
import { writeAudit } from "./audit.js";
import { insertOnce } from "./idempotency.js";
import { getPublicBaseUrl, resolveVerifiedCompany } from "./company-resolve.js";
import { isWindowOpen } from "./wa-window.js";

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

  // Insert the message (idempotent by MessageSid)
  const inserted = await insertOnce(dbClient, namespace, "message", {
    company_id: verifiedCompanyId,
    channel: "whatsapp",
    direction: "inbound",
    provider_msg_id: messageSid,
    contact_id: null, // No contact matching in this PR
    from_e164: fromE164,
    to_e164: toE164,
    body: body || null,
    status: "received",
    received_at: new Date(),
  });

  // Write audit entry (only if this is a new message)
  if (inserted) {
    await writeAudit(dbClient, namespace, {
      companyId: verifiedCompanyId,
      userId: "system",
      action: "wa.inbound",
      contactId: null,
      detail: {
        sid: messageSid,
        from: fromE164,
        to: toE164,
        numMedia,
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
