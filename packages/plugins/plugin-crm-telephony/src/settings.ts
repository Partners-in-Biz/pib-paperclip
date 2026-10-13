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
  voiceAllowedUserIds: string[];
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

function dedupeStringList(arr: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of arr) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        result.push(trimmed);
      }
    }
  }
  return result.slice(0, 50);
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
  const userIdList = Array.isArray(raw.voiceAllowedUserIds) ? raw.voiceAllowedUserIds : [];

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
    voiceAllowedUserIds: dedupeStringList(userIdList),
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
