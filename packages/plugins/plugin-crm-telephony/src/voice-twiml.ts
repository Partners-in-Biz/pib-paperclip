/**
 * The TwiML a voice request would get, and the `voice-twiml` webhook.
 *
 * The Paperclip host answers every plugin webhook with its own JSON body, so a
 * plugin cannot return TwiML to Twilio from this endpoint. The Dialer therefore
 * places calls through the REST API with inline TwiML (see voice-dial.ts). This
 * handler still verifies a request that arrives here and logs what it would
 * have answered, so a TwiML app pointed at it is diagnosed, not silently dropped.
 */
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { buildPublicWebhookUrl, parseFormParams } from "./twilio-signature.js";
import { getPublicBaseUrl, resolveVerifiedCompany } from "./company-resolve.js";
import { pickCallerId } from "./caller-id.js";
import { normalizeE164 } from "./phone.js";
import { buildDialTwiml } from "./twiml.js";
import { resolveTelephonySecret } from "./secrets.js";

export type VoiceTwimlRefusal = "bad_number" | "unsupported_region" | "caller_id_not_configured";

export interface VoiceTwimlOptions {
  record: boolean;
  recordingStatusCallbackUrl?: string;
  statusCallbackUrl?: string;
}

/** Pure: the TwiML for a `To` number given the company's numbers, or why not. */
export function twimlForVoiceRequest(
  params: { To?: string | null },
  numbers: { za?: string; us?: string },
  opts: VoiceTwimlOptions,
): { ok: true; twiml: string; callerId: string; to: string } | { ok: false; reason: VoiceTwimlRefusal } {
  const to = params.To ? normalizeE164(params.To) : null;
  if (!to) return { ok: false, reason: "bad_number" };
  const pick = pickCallerId(to, numbers);
  if (!pick.ok) return { ok: false, reason: pick.reason };
  const twiml = buildDialTwiml({
    to,
    callerId: pick.callerId,
    record: opts.record,
    recordingStatusCallbackUrl: opts.recordingStatusCallbackUrl,
    statusCallbackUrl: opts.statusCallbackUrl,
  });
  return { ok: true, twiml, callerId: pick.callerId, to };
}

export type VoiceTwimlOutcome = "ok" | "refused" | "bad_signature" | "missing_secret" | "missing_host" | "bad_payload";

export async function handleVoiceTwiml(
  ctx: PluginContext,
  input: PluginWebhookInput,
  pluginId: string,
): Promise<VoiceTwimlOutcome> {
  const { headers, rawBody } = input;
  const baseUrl = getPublicBaseUrl(headers);
  if (!baseUrl) return "missing_host";
  const webhookUrl = buildPublicWebhookUrl({ baseUrl, pluginId, endpointKey: "voice-twiml" });

  const verified = await resolveVerifiedCompany(ctx, headers, rawBody, webhookUrl);
  if (!verified) return "missing_secret";
  if ("error" in verified) {
    ctx.logger.warn("voice-twiml webhook: signature verification failed", { reason: verified.error });
    return verified.error as VoiceTwimlOutcome;
  }

  const params = parseFormParams(rawBody);
  const numbers: { za?: string; us?: string } = {};
  for (const [key, name] of [["za", "TWILIO_ZA_NUMBER"], ["us", "TWILIO_US_NUMBER"]] as const) {
    const value = await resolveTelephonySecret(ctx, verified.companyId, name);
    if (value) numbers[key] = value;
  }

  const result = twimlForVoiceRequest({ To: params.To?.[0] ?? null }, numbers, { record: false });
  ctx.logger.warn(
    "voice-twiml webhook: this host cannot answer Twilio with TwiML. Calls are placed by the Dialer through the REST API with inline TwiML; remove the TwiML app voice URL that points here.",
    { to_ok: result.ok, reason: result.ok ? undefined : result.reason },
  );
  return result.ok ? "ok" : "refused";
}
