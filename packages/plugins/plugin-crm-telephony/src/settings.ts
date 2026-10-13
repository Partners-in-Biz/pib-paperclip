import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Company settings for telephony: recording, hours, caller IDs, caps, users, Twilio status.
 * Stored in plugin state (company scope, key "settings") separate from instanceConfigSchema secrets.
 */

export interface AllowedHours {
  /** Mon-Fri 08:00-20:00, Sat 09:00-13:00, Sun none. SAST times, HH:MM format. */
  monday?: { start: string; end: string };
  tuesday?: { start: string; end: string };
  wednesday?: { start: string; end: string };
  thursday?: { start: string; end: string };
  friday?: { start: string; end: string };
  saturday?: { start: string; end: string };
  sunday?: never; // No calls on Sunday
}

export interface TelephonySettings {
  recordingEnabled: boolean;
  allowedHours: AllowedHours;
  callerIds: { za?: string; us?: string };
  caps: { callsPerDay: number; messagesPerDay: number };
  allowlistUserIds: string[];
  tenDlcStatus: "unknown" | "not_started" | "pending" | "approved" | "rejected";
  templateSyncRequestedAt?: string; // ISO timestamp, managed separately from user input
}

export interface FieldError {
  field: string;
  message: string;
}

export interface SecretStatus {
  [key: string]: "set" | "missing";
}

const HOUR_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const E164_REGEX = /^\+[1-9]\d{1,14}$/;
const TIMEZONE = "Africa/Johannesburg";

export const DEFAULT_SETTINGS: TelephonySettings = {
  recordingEnabled: false,
  allowedHours: {
    monday: { start: "08:00", end: "20:00" },
    tuesday: { start: "08:00", end: "20:00" },
    wednesday: { start: "08:00", end: "20:00" },
    thursday: { start: "08:00", end: "20:00" },
    friday: { start: "08:00", end: "20:00" },
    saturday: { start: "09:00", end: "13:00" },
  },
  callerIds: {},
  caps: { callsPerDay: 50, messagesPerDay: 200 },
  allowlistUserIds: [],
  tenDlcStatus: "unknown",
};

function validateHours(hours: unknown): FieldError[] {
  const errors: FieldError[] = [];
  if (!hours || typeof hours !== "object" || Array.isArray(hours)) return errors;
  const obj = hours as Record<string, unknown>;

  for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]) {
    const window = obj[day];
    if (!window) continue;
    if (typeof window !== "object" || Array.isArray(window)) {
      errors.push({ field: `allowedHours.${day}`, message: "Invalid time window" });
      continue;
    }
    const w = window as Record<string, unknown>;
    const start = typeof w.start === "string" ? w.start : "";
    const end = typeof w.end === "string" ? w.end : "";
    if (!HOUR_REGEX.test(start)) errors.push({ field: `allowedHours.${day}.start`, message: "Invalid HH:MM format" });
    if (!HOUR_REGEX.test(end)) errors.push({ field: `allowedHours.${day}.end`, message: "Invalid HH:MM format" });
    if (HOUR_REGEX.test(start) && HOUR_REGEX.test(end) && start >= end) {
      errors.push({ field: `allowedHours.${day}`, message: "Start time must be before end time" });
    }
  }
  return errors;
}

function validateCallerIds(ids: unknown): FieldError[] {
  const errors: FieldError[] = [];
  if (!ids || typeof ids !== "object" || Array.isArray(ids)) return errors;
  const obj = ids as Record<string, unknown>;

  for (const [country, value] of Object.entries(obj)) {
    if (value == null || value === "") continue; // Optional fields
    if (typeof value !== "string" || !E164_REGEX.test(value)) {
      errors.push({ field: `callerIds.${country}`, message: "Invalid E.164 format (e.g., +11234567890)" });
    }
  }
  return errors;
}

function validateCaps(caps: unknown): FieldError[] {
  const errors: FieldError[] = [];
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) {
    errors.push({ field: "caps", message: "Caps must be an object" });
    return errors;
  }
  const obj = caps as Record<string, unknown>;
  const callsPerDay = Number(obj.callsPerDay);
  const messagesPerDay = Number(obj.messagesPerDay);

  if (!Number.isInteger(callsPerDay) || callsPerDay < 0 || callsPerDay > 10000) {
    errors.push({ field: "caps.callsPerDay", message: "Must be an integer from 0 to 10000" });
  }
  if (!Number.isInteger(messagesPerDay) || messagesPerDay < 0 || messagesPerDay > 10000) {
    errors.push({ field: "caps.messagesPerDay", message: "Must be an integer from 0 to 10000" });
  }
  return errors;
}

export function validateSettings(raw: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [];

  // Validate boolean flags
  if (raw.recordingEnabled != null && typeof raw.recordingEnabled !== "boolean") {
    errors.push({ field: "recordingEnabled", message: "Must be a boolean" });
  }

  // Validate tenDlcStatus enum
  const status = raw.tenDlcStatus;
  if (status != null && !["unknown", "not_started", "pending", "approved", "rejected"].includes(status as string)) {
    errors.push({ field: "tenDlcStatus", message: "Invalid status" });
  }

  // Validate sub-objects
  errors.push(...validateHours(raw.allowedHours));
  errors.push(...validateCallerIds(raw.callerIds));
  errors.push(...validateCaps(raw.caps));

  // Validate allowlistUserIds
  const allowlist = raw.allowlistUserIds;
  if (allowlist != null) {
    if (!Array.isArray(allowlist)) {
      errors.push({ field: "allowlistUserIds", message: "Must be an array" });
    } else {
      for (let i = 0; i < allowlist.length; i++) {
        if (typeof allowlist[i] !== "string") {
          errors.push({ field: `allowlistUserIds[${i}]`, message: "Must be a string" });
        }
      }
    }
  }

  return errors;
}

export function normalizeSettings(raw: Record<string, unknown>): TelephonySettings {
  const recordingEnabled = raw.recordingEnabled === true;

  const allowedHours: AllowedHours = {};
  const rawHours = (raw.allowedHours && typeof raw.allowedHours === "object" && !Array.isArray(raw.allowedHours)
    ? raw.allowedHours
    : {}) as Record<string, unknown>;

  for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]) {
    const w = rawHours[day];
    if (w && typeof w === "object" && !Array.isArray(w)) {
      const window = w as Record<string, unknown>;
      const start = String(window.start ?? "").trim();
      const end = String(window.end ?? "").trim();
      if (HOUR_REGEX.test(start) && HOUR_REGEX.test(end) && start < end) {
        (allowedHours as Record<string, unknown>)[day] = { start, end };
      } else {
        // If provided but invalid, use defaults
        (allowedHours as Record<string, unknown>)[day] = DEFAULT_SETTINGS.allowedHours[day as keyof typeof DEFAULT_SETTINGS.allowedHours];
      }
    } else {
      // If not provided, use defaults
      const defaultWindow = DEFAULT_SETTINGS.allowedHours[day as keyof typeof DEFAULT_SETTINGS.allowedHours];
      if (defaultWindow) {
        (allowedHours as Record<string, unknown>)[day] = defaultWindow;
      }
    }
  }

  const rawIds = (raw.callerIds && typeof raw.callerIds === "object" && !Array.isArray(raw.callerIds)
    ? raw.callerIds
    : {}) as Record<string, unknown>;
  const callerIds: { za?: string; us?: string } = {};
  for (const country of ["za", "us"]) {
    const id = String(rawIds[country] ?? "").trim();
    if (id && E164_REGEX.test(id)) {
      (callerIds as Record<string, unknown>)[country] = id;
    }
  }

  const rawCaps = (raw.caps && typeof raw.caps === "object" && !Array.isArray(raw.caps) ? raw.caps : {}) as Record<string, unknown>;
  const callsPerDay = Number(rawCaps.callsPerDay);
  const messagesPerDay = Number(rawCaps.messagesPerDay);
  const caps = {
    callsPerDay: Number.isInteger(callsPerDay) && callsPerDay >= 0 && callsPerDay <= 10000 ? callsPerDay : DEFAULT_SETTINGS.caps.callsPerDay,
    messagesPerDay: Number.isInteger(messagesPerDay) && messagesPerDay >= 0 && messagesPerDay <= 10000 ? messagesPerDay : DEFAULT_SETTINGS.caps.messagesPerDay,
  };

  const rawAllowlist = raw.allowlistUserIds;
  const allowlistUserIds = Array.isArray(rawAllowlist)
    ? [...new Set(rawAllowlist.filter((id) => typeof id === "string" && id.trim()).map((id) => (id as string).trim()))]
    : [];

  const status = raw.tenDlcStatus;
  const tenDlcStatus = ["not_started", "pending", "approved", "rejected"].includes(status as string) ? (status as any) : "unknown";

  return {
    recordingEnabled,
    allowedHours,
    callerIds,
    caps,
    allowlistUserIds,
    tenDlcStatus,
  };
}

/**
 * Check the presence of configured secrets.
 * Returns a map of secret ref to "set" | "missing".
 * Secret values are never returned.
 */
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
