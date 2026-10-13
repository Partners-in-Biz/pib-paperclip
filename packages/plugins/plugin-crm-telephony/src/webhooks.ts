import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { parseFormParams, verifyTwilioWebhook } from "./twilio-signature.js";
import { decideRecording, buildVoiceTwiml, defaultContactLookup, defaultPrefs } from "./voice-twiml.js";
import { handleCallStatus } from "./call-status.js";

function getParam(params: Record<string, string[]>, key: string) {
  return params[key]?.[0];
}

function getHeader(headers: Record<string, string | string[]>, name: string) {
  const val = headers[name];
  return Array.isArray(val) ? val[0] : val;
}

function escapeXml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export async function handleWebhook(ctx: PluginContext, input: PluginWebhookInput): Promise<void> {
  const companyId = getHeader(input.headers, "x-company-id");
  if (!companyId) return;
  if (input.endpointKey === "call-status") await handleCallStatus(ctx, input, companyId);
}

export async function handleVoiceTwiml(ctx: PluginContext, input: PluginWebhookInput): Promise<string> {
  const companyId = getHeader(input.headers, "x-company-id");
  if (!companyId) return "<Response><Reject/></Response>";

  let authToken: string;
  try {
    authToken = await ctx.secrets.resolve("TWILIO_AUTH_TOKEN", { companyId });
  } catch {
    return "<Response><Reject/></Response>";
  }

  const proto = getHeader(input.headers, "x-forwarded-proto") || "https";
  const host = getHeader(input.headers, "x-forwarded-host") || "localhost";
  const path = getHeader(input.headers, "x-request-path") || "/api/plugins/partnersinbiz.crm-telephony/webhooks/voice-twiml";
  const url = `${proto}://${host}${path}`;

  if (!verifyTwilioWebhook({ authToken, headers: input.headers, rawBody: input.rawBody, url }).ok) {
    return "<Response><Reject/></Response>";
  }

  const params = parseFormParams(input.rawBody);
  const { toE164, record } = await decideRecording(
    { lookup: defaultContactLookup, prefs: defaultPrefs },
    companyId,
    getParam(params, "To") || "",
  );

  return buildVoiceTwiml({
    toE164,
    callerId: getParam(params, "From") || "+27000000000",
    record,
    noticeUrl: record ? "https://example.com/notice" : undefined,
    recordingStatusUrl: record ? `https://host/api/plugins/partnersinbiz.crm-telephony/webhooks/recording-status?c=${companyId}` : undefined,
    xmlEscape: escapeXml,
  });
}
