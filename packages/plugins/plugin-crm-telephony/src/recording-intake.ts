import type { PluginContext, PluginWebhookInput, PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { buildPublicWebhookUrl, parseFormParams } from "./twilio-signature.js";
import { getPublicBaseUrl, resolveVerifiedCompany } from "./company-resolve.js";
import { insertOnce } from "./idempotency.js";
import { readSettings } from "./settings.js";

/**
 * Recording webhook handler outcome codes.
 * - "ok": recording created with state 'received'
 * - "duplicate": webhook arrived twice for same recording_sid (row untouched)
 * - "ignored": status not terminal (in-progress, paused, etc.); no write
 * - "bad_signature": signature verification failed
 * - "missing_secret": no TWILIO_AUTH_TOKEN configured
 * - "missing_host": no host header could be derived
 * - "bad_payload": recording_sid or call_sid malformed
 */
export type RecordingOutcome =
  | "ok"
  | "duplicate"
  | "ignored"
  | "bad_signature"
  | "missing_secret"
  | "missing_host"
  | "bad_payload";

/**
 * Handle incoming Twilio recording-status webhooks.
 *
 * Form-encoded body with fields:
 * - RecordingSid (RE[0-9a-f]{32})
 * - CallSid (CA[0-9a-f]{32})
 * - RecordingUrl
 * - RecordingStatus (completed, failed, absent, in-progress, paused, etc.)
 * - RecordingDuration (ignored)
 *
 * Idempotent by recording_sid: second identical webhook for the same
 * recording_sid returns "duplicate" and leaves row untouched even if
 * it was advanced to another state (e.g. 'downloaded') in between.
 */
export async function handleRecordingStatus(
  ctx: PluginContext,
  dbClient: PluginDatabaseClient,
  namespace: string,
  input: PluginWebhookInput,
  pluginId: string,
): Promise<RecordingOutcome> {
  const { headers, rawBody } = input;

  // Derive the public base URL from headers
  const baseUrl = getPublicBaseUrl(headers);
  if (!baseUrl) {
    ctx.logger.warn("recording-status webhook: could not derive host from headers");
    return "missing_host";
  }

  // Build the webhook URL that Twilio signed
  const webhookUrl = buildPublicWebhookUrl({
    baseUrl,
    pluginId,
    endpointKey: "recording-status",
  });

  // Find the company whose token verifies the signature
  const result = await resolveVerifiedCompany(ctx, headers, rawBody, webhookUrl);
  if (!result) {
    ctx.logger.warn("recording-status webhook: no TWILIO_AUTH_TOKEN configured for any company");
    return "missing_secret";
  }
  if ("error" in result) {
    ctx.logger.warn("recording-status webhook: signature verification failed", {
      reason: result.error,
    });
    return result.error as RecordingOutcome;
  }

  const verifiedCompanyId = result.companyId;

  // Parse the form-encoded body
  const params = parseFormParams(rawBody);
  const recordingSid = params.RecordingSid?.[0];
  const callSid = params.CallSid?.[0];
  const recordingUrl = params.RecordingUrl?.[0];
  const recordingStatus = params.RecordingStatus?.[0];

  // Validate RecordingSid format (RE followed by 32 hex chars)
  if (!recordingSid || !/^RE[0-9a-f]{32}$/i.test(recordingSid)) {
    ctx.logger.warn("recording-status webhook: malformed or missing RecordingSid");
    return "bad_payload";
  }

  // Validate CallSid format (CA followed by 32 hex chars)
  if (!callSid || !/^CA[0-9a-f]{32}$/i.test(callSid)) {
    ctx.logger.warn("recording-status webhook: malformed or missing CallSid", {
      recording_sid: recordingSid,
    });
    return "bad_payload";
  }

  if (!recordingStatus) {
    ctx.logger.warn("recording-status webhook: missing RecordingStatus", {
      recording_sid: recordingSid,
    });
    return "bad_payload";
  }

  // Get settings for expiry calculation
  const settings = await readSettings(ctx, verifiedCompanyId);
  const expiresAt = new Date(Date.now() + settings.recordingRetentionDays * 24 * 60 * 60 * 1000);

  // Map status to database state and error
  let state: string;
  let lastError: string | null = null;

  if (recordingStatus === "completed") {
    state = "received";
  } else if (recordingStatus === "failed") {
    state = "failed";
    lastError = "twilio recording failed";
  } else if (recordingStatus === "absent") {
    state = "skipped";
    lastError = "twilio reported no audio (absent)";
  } else {
    // in-progress, paused, and other statuses are ignored
    ctx.logger.debug("recording-status webhook: status ignored", {
      recording_sid: recordingSid,
      status: recordingStatus,
    });
    return "ignored";
  }

  // Insert the recording (idempotent by recording_sid)
  // ON CONFLICT DO NOTHING ensures a second webhook leaves the row untouched
  // even if the row was advanced to a different state (e.g. 'downloaded')
  const inserted = await insertOnce(dbClient, namespace, "recording", {
    company_id: verifiedCompanyId,
    call_sid: callSid,
    recording_sid: recordingSid,
    twilio_url: recordingUrl || null,
    state,
    next_attempt_at: new Date(),
    expires_at: expiresAt,
    last_error: lastError,
  });

  const outcome = inserted ? "ok" : "duplicate";
  ctx.logger.debug("recording-status webhook: completed", {
    recording_sid: recordingSid,
    outcome,
  });

  return outcome;
}
