import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { checkVoiceAccess } from "./access.js";
import { getTimeline, getTranscript, type TimelineResult } from "./timeline.js";
import { readSettings } from "./settings.js";
import { NAMESPACE } from "./namespace.js";

// Convert plugin action actor to checkVoiceAccess format
interface VoiceAccessActor {
  actorType: "user" | "agent";
  actorId: string;
  userId?: string;
}

function actorFromContext(context: PluginPerformActionContext): VoiceAccessActor {
  return {
    actorType: context.actor.type === "user" ? "user" : "agent",
    actorId: context.actor.agentId ?? context.actor.userId ?? "unknown",
    userId: context.actor.userId ?? undefined,
  };
}

function requiredCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new Error("Company is required");
  return context.companyId;
}

function requiredString(obj: unknown, key: string): string {
  if (!obj || typeof obj !== "object") throw new Error("Parameters must be an object");
  const val = (obj as Record<string, unknown>)[key];
  if (typeof val !== "string" || !val.trim()) throw new Error(`${key} is required`);
  return val.trim();
}

function requiredUUID(obj: unknown, key: string): string {
  const val = requiredString(obj, key);
  // Simple UUID-like validation (32 hex chars with hyphens)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
    throw new Error(`${key} must be a valid UUID`);
  }
  return val;
}

function requiredE164(obj: unknown, key: string): string {
  const val = requiredString(obj, key);
  if (!/^\+[1-9]\d{6,14}$/.test(val)) throw new Error(`${key} must be a valid E.164 number`);
  return val;
}

function optionalString(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const val = (obj as Record<string, unknown>)[key];
  if (val == null) return undefined;
  if (typeof val !== "string") throw new Error(`${key} must be a string`);
  return val.trim() || undefined;
}

function optionalInt(obj: unknown, key: string, min: number, max: number): number | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const val = (obj as Record<string, unknown>)[key];
  if (val == null) return undefined;
  const n = Number(val);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return n;
}


export async function registerTimelineHandlers(ctx: PluginContext): Promise<void> {
  ctx.actions.register("telephony.timeline", async (params, context) => {
    const companyId = requiredCompany(context);
    const settings = await readSettings(ctx, companyId);

    // Check access
    const access = checkVoiceAccess(actorFromContext(context), settings.voiceAllowedUserIds);
    if (!access.ok) return { status: access.status, error: access.error };

    try {
      const contactId = requiredString(params, "contactId");
      const limit = optionalInt(params, "limit", 1, 100) ?? 100;
      const before = optionalString(params, "before");

      const result = await getTimeline(ctx.db, NAMESPACE, {
        companyId,
        contactId,
        limit,
        before,
      });

      return { data: result };
    } catch (error) {
      return { status: 400, error: String(error) };
    }
  });

  ctx.actions.register("telephony.transcript", async (params, context) => {
    const companyId = requiredCompany(context);
    const settings = await readSettings(ctx, companyId);

    // Check access
    const access = checkVoiceAccess(actorFromContext(context), settings.voiceAllowedUserIds);
    if (!access.ok) return { status: access.status, error: access.error };

    try {
      const callSid = requiredString(params, "callSid");

      const transcript = await getTranscript(ctx.db, NAMESPACE, {
        companyId,
        callSid,
      });

      if (!transcript) return { status: 404, error: "Transcript not found" };

      return { data: transcript };
    } catch (error) {
      return { status: 400, error: String(error) };
    }
  });
}
