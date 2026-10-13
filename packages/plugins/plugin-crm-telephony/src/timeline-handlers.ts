import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { checkVoiceAccess } from "./access.js";
import { playRecording, type PlaybackError } from "./playback.js";
import { getTimeline, getTranscript, listUnmatched, setContactPrefs, type TimelineResult } from "./timeline.js";
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

function optionalEnum<T extends string | boolean>(obj: unknown, key: string, values: readonly T[]): T | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const val = (obj as Record<string, unknown>)[key];
  if (val == null) return undefined;
  if (typeof val !== "string" && typeof val !== "boolean") throw new Error(`${key} must be a string or boolean`);
  const enumVal = val as T;
  if (!values.includes(enumVal)) {
    throw new Error(`${key} must be one of: ${values.join(", ")}`);
  }
  return enumVal;
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

  ctx.actions.register("telephony.unmatched", async (params, context) => {
    const companyId = requiredCompany(context);
    const settings = await readSettings(ctx, companyId);

    // Check access
    const access = checkVoiceAccess(actorFromContext(context), settings.voiceAllowedUserIds);
    if (!access.ok) return { status: access.status, error: access.error };

    try {
      const limit = optionalInt(params, "limit", 1, 100) ?? 50;

      const items = await listUnmatched(ctx.db, NAMESPACE, {
        companyId,
        limit,
      });

      return { data: items };
    } catch (error) {
      return { status: 400, error: String(error) };
    }
  });

  ctx.actions.register("telephony.contact-prefs.set", async (params, context) => {
    const companyId = requiredCompany(context);
    const settings = await readSettings(ctx, companyId);

    // Check access (user only, requires userId)
    const access = checkVoiceAccess(actorFromContext(context), settings.voiceAllowedUserIds);
    if (!access.ok) return { status: access.status, error: access.error };

    if (!context.actor.userId) {
      return { status: 403, error: "This action requires a signed-in user" };
    }

    try {
      const contactId = requiredString(params, "contactId");
      const doNotRecordRaw = optionalEnum(params, "doNotRecord", [true, false]);
      const doNotRecord = doNotRecordRaw as boolean | undefined;
      const language = optionalEnum(params, "language", ["af", "en"] as const);

      await setContactPrefs(ctx.db, NAMESPACE, {
        companyId,
        contactId,
        userId: context.actor.userId,
        doNotRecord,
        language,
      });

      return { data: { ok: true } };
    } catch (error) {
      return { status: 400, error: String(error) };
    }
  });

  ctx.actions.register("telephony.recording.play", async (params, context) => {
    const companyId = requiredCompany(context);
    const settings = await readSettings(ctx, companyId);

    // Check access (user only, requires userId)
    const access = checkVoiceAccess(actorFromContext(context), settings.voiceAllowedUserIds);
    if (!access.ok) return { status: access.status, error: access.error };

    if (!context.actor.userId) {
      return { status: 403, error: "This action requires a signed-in user" };
    }

    try {
      const callSid = requiredString(params, "callSid");
      const contactId = optionalString(params, "contactId");

      // Resolve R2 config from secrets
      let r2Config = null;
      try {
        const [accountId, bucket, accessKeyId, secretAccessKey] = await Promise.all([
          ctx.secrets.resolve("R2_ACCOUNT_ID", { companyId }),
          ctx.secrets.resolve("R2_BUCKET", { companyId }),
          ctx.secrets.resolve("R2_ACCESS_KEY_ID", { companyId }),
          ctx.secrets.resolve("R2_SECRET_ACCESS_KEY", { companyId }),
        ]);

        if (accountId && bucket && accessKeyId && secretAccessKey) {
          r2Config = { accountId, bucket, accessKeyId, secretAccessKey };
        }
      } catch {
        // Secrets not configured
      }

      const result = await playRecording(ctx.db, NAMESPACE, {
        companyId,
        userId: context.actor.userId,
        callSid,
        contactId,
        r2Config,
      });

      return { data: result };
    } catch (error) {
      if (error instanceof Error && "code" in error && typeof error.code === "string") {
        const code = error.code as string;
        const codeMap: Record<string, number> = {
          not_found: 404,
          r2_not_configured: 503,
          recording_erased: 410,
          no_r2_key: 503,
          invalid_state: 400,
        };
        const status = codeMap[code] ?? 500;
        return { status, error: error.message };
      }
      return { status: 400, error: String(error) };
    }
  });
}
