import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "./namespace.js";
import { insertOnce } from "./idempotency.js";
import { parseFormParams, verifyTwilioWebhook } from "./twilio-signature.js";

function getParam(params: Record<string, string[]>, key: string): string | undefined {
  const arr = params[key];
  return arr && arr.length > 0 ? arr[0] : undefined;
}

function getHeader(headers: Record<string, string | string[]>, name: string): string | undefined {
  const val = headers[name];
  return Array.isArray(val) ? val[0] : val;
}

export async function handleCallStatus(
  ctx: PluginContext,
  input: PluginWebhookInput,
  companyId: string,
  webhookUrl?: string,
): Promise<void> {
  let authToken: string;
  try {
    authToken = await ctx.secrets.resolve("TWILIO_AUTH_TOKEN", { companyId });
  } catch {
    ctx.logger.warn("Failed to resolve TWILIO_AUTH_TOKEN for call-status webhook");
    return;
  }

  const url = webhookUrl || `${getHeader(input.headers, "x-forwarded-proto") || "https"}://${getHeader(input.headers, "x-forwarded-host") || "localhost"}${getHeader(input.headers, "x-request-path") || "/api/plugins/partnersinbiz.crm-telephony/webhooks/call-status"}`;
  const verification = verifyTwilioWebhook({ authToken, headers: input.headers, rawBody: input.rawBody, url });

  if (!verification.ok) {
    ctx.logger.warn("Call status webhook signature verification failed", { reason: verification.reason });
    return;
  }

  const params = parseFormParams(input.rawBody);
  const callSid = getParam(params, "CallSid");
  const callStatus = getParam(params, "CallStatus");
  if (!callSid || !callStatus) return;

  const isTerminal = ["completed", "busy", "no-answer", "failed", "canceled"].includes(callStatus);
  const inserted = await insertOnce(
    { execute: (sql, p) => ctx.db.execute(sql, p) },
    NAMESPACE,
    "call",
    {
      company_id: companyId,
      call_sid: callSid,
      status: callStatus === "in-progress" ? "in-progress" : callStatus,
      answered_at: callStatus === "in-progress" ? new Date().toISOString() : null,
      ended_at: isTerminal ? new Date().toISOString() : null,
      duration_s: isTerminal ? parseInt(getParam(params, "CallDuration") || "0", 10) : null,
      from_e164: "",
      to_e164: "",
      user_id: "",
      direction: "inbound",
    },
  );

  ctx.logger.debug(inserted ? "Inserted call status record" : "Call status already exists (duplicate delivery)", { callSid });
}
