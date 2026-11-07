import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { readSettings } from "./settings.js";
import { checkVoiceAccess } from "./access.js";
import { buildVoiceAccessToken } from "./voice-token.js";
import { resolveTelephonySecret } from "./secrets.js";

export async function voiceTokenAction(
  ctx: PluginContext,
  context: PluginPerformActionContext,
  opts?: { nowSeconds?: number },
): Promise<{ token: string; identity: string; expiresAt: string }> {
  const { companyId } = context;

  // 1. Validate company context
  if (!companyId) {
    throw new Error("A company is required");
  }

  // 2. Read settings and check access before any secret resolution
  const settings = await readSettings(ctx, companyId);

  // Adapt PluginPerformActionContext actor to PluginApiRequestInput["actor"] shape
  const actor: PluginApiRequestInput["actor"] = {
    actorType: context.actor.type === "system" ? "agent" : context.actor.type,
    userId: context.actor.userId ?? undefined,
    actorId: context.actor.userId ?? context.actor.agentId ?? "unknown",
    agentId: context.actor.agentId ?? undefined,
  };

  const access = checkVoiceAccess(actor, settings.voiceAllowedUserIds);
  if (!access.ok) {
    throw new Error(access.error);
  }

  // 3. Resolve secrets
  const accountSid = await resolveTelephonySecret(ctx, companyId, "TWILIO_ACCOUNT_SID");
  const apiKeySid = await resolveTelephonySecret(ctx, companyId, "TWILIO_API_KEY_SID");
  const apiKeySecret = await resolveTelephonySecret(ctx, companyId, "TWILIO_API_KEY_SECRET");
  // Optional: only a browser-initiated outgoing call needs a TwiML app.
  const twimlAppSid = await resolveTelephonySecret(ctx, companyId, "TWILIO_TWIML_APP_SID");

  if (!accountSid || !apiKeySid || !apiKeySecret) {
    throw new Error("Twilio voice credentials are not configured");
  }

  // 4. Build token
  const iat = opts?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = 3600;

  const token = buildVoiceAccessToken({
    accountSid,
    apiKeySid,
    apiKeySecret,
    twimlAppSid,
    identity: access.userId,
    ttlSeconds,
    nowSeconds: iat,
  });

  const expiresAt = new Date((iat + ttlSeconds) * 1000).toISOString();

  // 5. Return exactly { token, identity, expiresAt }
  return {
    token,
    identity: access.userId,
    expiresAt,
  };
}
