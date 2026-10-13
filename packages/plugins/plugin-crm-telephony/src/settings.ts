import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface TelephonySettings {
  recordingEnabled: boolean;
  whatsappEnabled: boolean;
  smsEnabled: boolean;
  maxCallsPerDay: number;
  maxSmsPerDay: number;
  maxWhatsappPerDay: number;
  recordingRetentionDays: number;
  allowedHours: { start: string; end: string; timezone: string };
  callerIds: string[];
  usSmsCampaignStatus: "none" | "pending" | "approved" | "rejected";
  usMessagingServiceSid: string | null;
  smsHolidays: string[];
}

export interface SecretStatus {
  [key: string]: "set" | "missing";
}

function clampInt(value: unknown, min: number, max: number, defaultVal: number): number {
  const num = Number(value);
  return Number.isInteger(num) && num >= min && num <= max ? num : defaultVal;
}

function validateHH_MM(value: unknown, defaultVal: string): string {
  if (typeof value !== "string") return defaultVal;
  const match = value.trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return defaultVal;
  const [, h, m] = match;
  const hNum = Number(h);
  const mNum = Number(m);
  if (hNum < 0 || hNum > 23 || mNum < 0 || mNum > 59) return defaultVal;
  return `${h}:${m}`;
}

function validateE164(value: unknown): string | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) return null;
  return trimmed;
}

function dedupeE164(arr: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of arr) {
    const valid = validateE164(item);
    if (valid && !seen.has(valid)) {
      seen.add(valid);
      result.push(valid);
    }
  }
  return result.slice(0, 10);
}

function validateMessagingServiceSid(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^MG[0-9a-f]{32}$/i.test(trimmed)) return trimmed;
  return null;
}

function validateSmsCampaignStatus(
  value: unknown,
): "none" | "pending" | "approved" | "rejected" {
  if (value === "pending" || value === "approved" || value === "rejected") {
    return value;
  }
  return "none";
}

function validateIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  // Validate it's a real date by checking that parsing and formatting returns the same date
  const date = new Date(trimmed + "T00:00:00Z");
  if (isNaN(date.getTime())) return null;
  // Re-format to check it didn't roll over (e.g., 2026-02-30 becomes 2026-03-02)
  const dateStr = date.toISOString().split("T")[0];
  if (dateStr !== trimmed) return null;
  return trimmed;
}

function validateSmsHolidays(arr: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const valid = validateIsoDate(item);
    if (valid && !seen.has(valid)) {
      seen.add(valid);
      result.push(valid);
    }
  }
  return result.slice(0, 40);
}

export async function readSettings(ctx: PluginContext, companyId: string): Promise<TelephonySettings> {
  let raw: Record<string, unknown> = {};
  try {
    const cfg = await ctx.config.get(companyId);
    raw = cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>) : {};
  } catch {
    raw = {};
  }

  const allowedHours = (raw.allowedHours && typeof raw.allowedHours === "object"
    ? (raw.allowedHours as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const callerIdList = Array.isArray(raw.callerIds) ? raw.callerIds : [];
  const holidaysList = Array.isArray(raw.smsHolidays) ? raw.smsHolidays : [];

  return {
    recordingEnabled: raw.recordingEnabled === true,
    whatsappEnabled: raw.whatsappEnabled === true,
    smsEnabled: raw.smsEnabled === true,
    maxCallsPerDay: clampInt(raw.maxCallsPerDay, 1, 10000, 50),
    maxSmsPerDay: clampInt(raw.maxSmsPerDay, 1, 100000, 200),
    maxWhatsappPerDay: clampInt(raw.maxWhatsappPerDay, 1, 100000, 200),
    recordingRetentionDays: clampInt(raw.recordingRetentionDays, 1, 365, 30),
    allowedHours: {
      start: validateHH_MM(allowedHours.start, "08:00"),
      end: validateHH_MM(allowedHours.end, "18:00"),
      timezone: "Africa/Johannesburg",
    },
    callerIds: dedupeE164(callerIdList),
    usSmsCampaignStatus: validateSmsCampaignStatus(raw.usSmsCampaignStatus),
    usMessagingServiceSid: validateMessagingServiceSid(raw.usMessagingServiceSid),
    smsHolidays: validateSmsHolidays(holidaysList),
  };
}

export async function secretStatus(ctx: PluginContext, companyId: string, refs: string[]): Promise<SecretStatus> {
  const result: SecretStatus = {};
  for (const ref of refs) {
    try {
      const value = await ctx.secrets.resolve(ref, { companyId });
      result[ref] = value ? "set" : "missing";
    } catch {
      result[ref] = "missing";
    }
  }
  return result;
}
