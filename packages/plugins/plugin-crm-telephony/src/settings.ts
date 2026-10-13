import type { JsonSchema, PluginContext } from "@paperclipai/plugin-sdk";
import { readConfig, secretField } from "@partnersinbiz/pib-plugin-kit";

export interface TelephonySettings {
  recordingEnabled: boolean;
  whatsappEnabled: boolean;
  smsEnabled: boolean;
  maxCallsPerDay: number;
  maxMessagesPerDay: number;
  allowedHours: {
    startHour: number;
    endHour: number;
    days: string[];
    timezone: string;
  };
  callerIds: {
    za: string | null;
    us: string | null;
  };
  secrets?: Record<string, string | undefined>;
}

export interface SecretStatus {
  [key: string]: "set" | "missing";
}

export const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "CRM Telephony settings",
  description: "Configure call recording, WhatsApp, SMS, and rate limits for each company.",
  properties: {
    recordingEnabled: {
      type: "boolean",
      title: "Enable call recording",
      default: false,
    },
    whatsappEnabled: {
      type: "boolean",
      title: "Enable WhatsApp",
      default: false,
    },
    smsEnabled: {
      type: "boolean",
      title: "Enable SMS",
      default: false,
    },
    maxCallsPerDay: {
      type: "integer",
      title: "Max calls per day",
      default: 50,
      minimum: 1,
      maximum: 10000,
    },
    maxMessagesPerDay: {
      type: "integer",
      title: "Max messages per day",
      default: 200,
      minimum: 1,
      maximum: 100000,
    },
    allowedHours: {
      type: "object",
      title: "Operating hours",
      properties: {
        startHour: { type: "integer", title: "Start hour (0-23)", default: 8, minimum: 0, maximum: 23 },
        endHour: { type: "integer", title: "End hour (0-23)", default: 20, minimum: 0, maximum: 23 },
        days: { type: "array", title: "Operating days", items: { type: "string" }, default: ["mon", "tue", "wed", "thu", "fri", "sat"] },
        timezone: { type: "string", title: "Timezone", default: "Africa/Johannesburg" },
      },
    },
    callerIds: {
      type: "object",
      title: "Caller IDs",
      properties: {
        za: { type: "string", title: "South Africa number (E.164)" },
        us: { type: "string", title: "US number (E.164)" },
      },
    },
    secrets: {
      type: "object",
      title: "API secrets",
      properties: {
        TWILIO_ACCOUNT_SID: secretField("Twilio Account SID"),
        TWILIO_AUTH_TOKEN: secretField("Twilio Auth Token"),
        TWILIO_API_KEY_SID: secretField("Twilio API Key SID"),
        TWILIO_API_KEY_SECRET: secretField("Twilio API Key Secret"),
        TWILIO_TWIML_APP_SID: secretField("Twilio TwiML App SID"),
        DEEPGRAM_API_KEY: secretField("Deepgram API Key"),
        SMS_PROVIDER_API_KEY: secretField("SMS Provider API Key"),
        ANTHROPIC_API_KEY: secretField("Anthropic API Key"),
        R2_ACCESS_KEY_ID: secretField("R2 Access Key ID"),
        R2_SECRET_ACCESS_KEY: secretField("R2 Secret Access Key"),
      },
    },
  },
};

function clampInt(value: unknown, min: number, max: number, defaultVal: number): number {
  const num = Number(value);
  return Number.isInteger(num) && num >= min && num <= max ? num : defaultVal;
}

function validateCallerId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // E.164 format: +1234567890 to +9999999999
  if (/^\+[1-9]\d{1,14}$/.test(trimmed)) return trimmed;
  return null;
}

export async function readSettings(ctx: PluginContext, companyId: string): Promise<TelephonySettings> {
  let raw: Record<string, unknown> = {};
  try {
    raw = await readConfig(ctx, companyId);
  } catch {
    raw = {};
  }

  const allowedHours = (raw.allowedHours && typeof raw.allowedHours === "object" ? raw.allowedHours : {}) as Record<string, unknown>;
  const callerIds = (raw.callerIds && typeof raw.callerIds === "object" ? raw.callerIds : {}) as Record<string, unknown>;

  return {
    recordingEnabled: raw.recordingEnabled === true,
    whatsappEnabled: raw.whatsappEnabled === true,
    smsEnabled: raw.smsEnabled === true,
    maxCallsPerDay: clampInt(raw.maxCallsPerDay, 1, 10000, 50),
    maxMessagesPerDay: clampInt(raw.maxMessagesPerDay, 1, 100000, 200),
    allowedHours: {
      startHour: clampInt(allowedHours.startHour, 0, 23, 8),
      endHour: clampInt(allowedHours.endHour, 0, 23, 20),
      days: Array.isArray(allowedHours.days) ? allowedHours.days.filter((d) => typeof d === "string") : ["mon", "tue", "wed", "thu", "fri", "sat"],
      timezone: typeof allowedHours.timezone === "string" && allowedHours.timezone.trim() ? allowedHours.timezone.trim() : "Africa/Johannesburg",
    },
    callerIds: {
      za: validateCallerId(callerIds.za),
      us: validateCallerId(callerIds.us),
    },
  };
}

export async function secretStatus(ctx: PluginContext, companyId: string, settings: TelephonySettings): Promise<SecretStatus> {
  let raw: Record<string, unknown> = {};
  try {
    raw = await readConfig(ctx, companyId);
  } catch {
    raw = {};
  }

  const secrets = (raw.secrets && typeof raw.secrets === "object" ? raw.secrets : {}) as Record<string, unknown>;
  const secretNames = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_API_KEY_SID",
    "TWILIO_API_KEY_SECRET",
    "TWILIO_TWIML_APP_SID",
    "DEEPGRAM_API_KEY",
    "SMS_PROVIDER_API_KEY",
    "ANTHROPIC_API_KEY",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ];

  const result: SecretStatus = {};
  for (const name of secretNames) {
    const ref = secrets[name];
    try {
      const value = await ctx.secrets.resolve(ref as any, { companyId });
      // Immediately discard the value; never store or return it
      result[name] = value ? "set" : "missing";
    } catch {
      result[name] = "missing";
    }
  }
  return result;
}
