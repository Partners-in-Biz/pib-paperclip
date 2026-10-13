import type { PluginApiRequestInput, PluginApiResponse, PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "./namespace.js";
import { readSettings } from "./settings.js";
import { checkVoiceAccess } from "./access.js";
import { buildVoiceAccessToken, type VoiceTokenInput } from "./voice-token.js";
import { normalizeE164 } from "./phone.js";
import { pickCallerId } from "./caller-id.js";
import { checkCallingHours } from "./tcpa.js";
import { writeAudit } from "./audit.js";

interface VoiceTokenRequest {
  [key: string]: unknown;
}

interface CallsStartRequest {
  to: string;
  contactId?: string;
}

function objectParams(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" ? (params as Record<string, unknown>) : {};
}

function requiredString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val !== "string" || !val.trim()) {
    throw new Error(`Missing or invalid ${key}`);
  }
  return val;
}

async function countOutboundCallsToday(db: PluginContext["db"], companyId: string): Promise<number> {
  const sql = `
    SELECT COUNT(*)::int as count
    FROM ${NAMESPACE}.tel_calls
    WHERE company_id = $1
      AND direction = 'outbound'
      AND DATE(created_at AT TIME ZONE 'UTC') = CURRENT_DATE AT TIME ZONE 'UTC'
  `;

  const result = await db.query(sql, [companyId]);
  const row = Array.isArray(result) ? result[0] : (result as any).rows?.[0];
  return ((row as any)?.count ?? 0) as number;
}

export async function handleApiRequest(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  // Read settings and check access on BOTH routes
  const settings = await readSettings(ctx, input.companyId);
  const accessCheck = checkVoiceAccess(input.actor, settings.voiceAllowedUserIds);

  if (!accessCheck.ok) {
    return { status: accessCheck.status, body: { error: accessCheck.error } };
  }

  if (input.routeKey === "voice-token") {
    return await handleVoiceToken(ctx, input, accessCheck.userId);
  }

  if (input.routeKey === "calls-start") {
    return await handleCallsStart(ctx, input, accessCheck.userId, settings);
  }

  return { status: 404, body: { error: "Unknown route" } };
}

async function handleVoiceToken(ctx: PluginContext, input: PluginApiRequestInput, userId: string): Promise<PluginApiResponse> {
  try {
    // Resolve secrets
    const accountSid = await ctx.secrets.resolve("TWILIO_ACCOUNT_SID", { companyId: input.companyId });
    const apiKeySid = await ctx.secrets.resolve("TWILIO_API_KEY_SID", { companyId: input.companyId });
    const apiKeySecret = await ctx.secrets.resolve("TWILIO_API_KEY_SECRET", { companyId: input.companyId });
    const twimlAppSid = await ctx.secrets.resolve("TWILIO_TWIML_APP_SID", { companyId: input.companyId });

    const missing: string[] = [];
    if (!accountSid) missing.push("TWILIO_ACCOUNT_SID");
    if (!apiKeySid) missing.push("TWILIO_API_KEY_SID");
    if (!apiKeySecret) missing.push("TWILIO_API_KEY_SECRET");
    if (!twimlAppSid) missing.push("TWILIO_TWIML_APP_SID");

    if (missing.length > 0) {
      return { status: 409, body: { error: "secrets_missing", missing } };
    }

    const token = buildVoiceAccessToken({
      accountSid: accountSid!,
      apiKeySid: apiKeySid!,
      apiKeySecret: apiKeySecret!,
      twimlAppSid: twimlAppSid!,
      identity: userId,
      ttlSeconds: 3600,
    });

    // Audit: voice.token action
    await writeAudit(ctx.db, {
      companyId: input.companyId,
      userId,
      action: "voice.token",
    });

    return { status: 200, body: { token, identity: userId, expiresIn: 3600 } };
  } catch (error) {
    return { status: 500, body: { error: String(error instanceof Error ? error.message : error) } };
  }
}

async function handleCallsStart(
  ctx: PluginContext,
  input: PluginApiRequestInput,
  userId: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
): Promise<PluginApiResponse> {
  try {
    const body = objectParams(input.body);

    // Validate input
    const to = requiredString(body, "to");
    const contactId = body.contactId ? String(body.contactId) : undefined;

    // Normalize phone number
    const toE164 = normalizeE164(to);
    if (!toE164) {
      return { status: 400, body: { error: "invalid_number" } };
    }

    // Resolve caller ID numbers for ZA and US
    const zaNumber = await ctx.secrets.resolve("TWILIO_ZA_NUMBER", { companyId: input.companyId });
    const usNumber = await ctx.secrets.resolve("TWILIO_US_NUMBER", { companyId: input.companyId });

    const callerIdPick = pickCallerId(toE164, { za: zaNumber ?? undefined, us: usNumber ?? undefined });
    if (!callerIdPick.ok) {
      const detail = callerIdPick.reason === "caller_id_not_configured" ? { reason: "caller_id_not_configured" } : {};
      return { status: 409, body: { error: callerIdPick.reason, ...detail } };
    }

    // Check calling hours for US numbers
    const hourCheck = checkCallingHours(toE164, new Date());
    if (!hourCheck.ok) {
      // Audit: call.refused action
      await writeAudit(ctx.db, {
        companyId: input.companyId,
        userId,
        action: "call.refused",
        contactId,
        detail: { reason: "outside_calling_hours", to: toE164 },
      });
      return { status: 409, body: { error: "outside_calling_hours" } };
    }

    // Check daily cap
    const todaysCallCount = await countOutboundCallsToday(ctx.db, input.companyId);
    if (todaysCallCount >= settings.maxCallsPerDay) {
      // Audit: call.refused action
      await writeAudit(ctx.db, {
        companyId: input.companyId,
        userId,
        action: "call.refused",
        contactId,
        detail: { reason: "daily_cap_reached", to: toE164 },
      });
      return { status: 429, body: { error: "daily_cap_reached" } };
    }

    // Audit: call.start action
    // Note: Do NOT check contact existence (no cross-plugin read in this PR)
    await writeAudit(ctx.db, {
      companyId: input.companyId,
      userId,
      action: "call.start",
      contactId,
      detail: { to: toE164, callerId: callerIdPick.callerId },
    });

    return { status: 200, body: { to: toE164, callerId: callerIdPick.callerId, contactId } };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Missing or invalid")) {
      return { status: 400, body: { error: error.message } };
    }
    return { status: 500, body: { error: String(error instanceof Error ? error.message : error) } };
  }
}
