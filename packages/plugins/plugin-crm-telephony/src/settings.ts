import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isSecretRef, readConfig, secretField, SecretResolver } from "@partnersinbiz/pib-plugin-kit";
import type { R2Config } from "./r2-store.js";

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
  usSmsCampaignStatus: "none" | "pending" | "approved" | "rejected";
  usMessagingServiceSid: string | null;
  whatsappFrom: string | null;
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
  const date = new Date(trimmed + "T00:00:00Z");
  if (isNaN(date.getTime())) return null;
  const dateStr = date.toISOString().split("T")[0];
  return dateStr === trimmed ? trimmed : null;
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

function validateWhatsappFrom(value: unknown): string | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  // Accept "whatsapp:+..." or plain "+..."
  const match = trimmed.match(/^(?:whatsapp:)?(\+[1-9]\d{6,14})$/i);
  if (!match) return null;
  return match[1];
}

export interface StateKey {
  scopeKind: "company";
  scopeId: string;
  namespace: "telephony-settings";
  stateKey: string;
}

export function settingsStateKey(companyId: string): StateKey {
  return {
    scopeKind: "company",
    scopeId: companyId,
    namespace: "telephony-settings",
    stateKey: "settings",
  };
}

export function templateSyncStateKey(companyId: string): StateKey {
  return {
    scopeKind: "company",
    scopeId: companyId,
    namespace: "telephony-settings",
    stateKey: "template-sync",
  };
}

export async function readSettings(ctx: PluginContext, companyId: string): Promise<TelephonySettings> {
  let raw: Record<string, unknown> = {};
  try {
    const cfg = await ctx.config.get(companyId);
    raw = cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>) : {};
  } catch {
    raw = {};
  }

  if (ctx.state) {
    try {
      const saved = await ctx.state.get(settingsStateKey(companyId));
      if (saved && typeof saved === "object") {
        raw = { ...raw, ...saved as Record<string, unknown> };
      }
    } catch {
      // Tolerate state errors
    }
  }

  const allowedHours = (raw.allowedHours && typeof raw.allowedHours === "object"
    ? (raw.allowedHours as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const callerIdList = Array.isArray(raw.callerIds) ? raw.callerIds : [];
  const userIdList = Array.isArray(raw.voiceAllowedUserIds) ? raw.voiceAllowedUserIds : [];
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
    voiceAllowedUserIds: dedupeStringList(userIdList),
    usSmsCampaignStatus: validateSmsCampaignStatus(raw.usSmsCampaignStatus),
    usMessagingServiceSid: validateMessagingServiceSid(raw.usMessagingServiceSid),
    whatsappFrom: validateWhatsappFrom(raw.whatsappFrom),
    smsHolidays: validateSmsHolidays(holidaysList),
  };
}

export async function saveSettings(
  ctx: PluginContext,
  companyId: string,
  input: unknown,
): Promise<{ ok: true; settings: TelephonySettings } | { ok: false; errors: Record<string, string> }> {
  const errors: Record<string, string> = {};

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: { _: "Input must be an object" } };
  }

  const params = input as Record<string, unknown>;
  const current = await readSettings(ctx, companyId);
  let updates: Partial<TelephonySettings> = {};

  if ("recordingEnabled" in params) {
    if (typeof params.recordingEnabled !== "boolean") {
      errors.recordingEnabled = "Must be boolean";
    } else {
      updates.recordingEnabled = params.recordingEnabled;
    }
  }

  if ("whatsappEnabled" in params) {
    if (typeof params.whatsappEnabled !== "boolean") {
      errors.whatsappEnabled = "Must be boolean";
    } else {
      updates.whatsappEnabled = params.whatsappEnabled;
    }
  }

  if ("smsEnabled" in params) {
    if (typeof params.smsEnabled !== "boolean") {
      errors.smsEnabled = "Must be boolean";
    } else {
      updates.smsEnabled = params.smsEnabled;
    }
  }

  if ("maxCallsPerDay" in params) {
    const num = Number(params.maxCallsPerDay);
    if (!Number.isInteger(num) || num < 1 || num > 10000) {
      errors.maxCallsPerDay = "Must be integer 1-10000";
    } else {
      updates.maxCallsPerDay = num;
    }
  }

  if ("maxSmsPerDay" in params) {
    const num = Number(params.maxSmsPerDay);
    if (!Number.isInteger(num) || num < 1 || num > 100000) {
      errors.maxSmsPerDay = "Must be integer 1-100000";
    } else {
      updates.maxSmsPerDay = num;
    }
  }

  if ("maxWhatsappPerDay" in params) {
    const num = Number(params.maxWhatsappPerDay);
    if (!Number.isInteger(num) || num < 1 || num > 100000) {
      errors.maxWhatsappPerDay = "Must be integer 1-100000";
    } else {
      updates.maxWhatsappPerDay = num;
    }
  }

  if ("recordingRetentionDays" in params) {
    const num = Number(params.recordingRetentionDays);
    if (!Number.isInteger(num) || num < 1 || num > 365) {
      errors.recordingRetentionDays = "Must be integer 1-365";
    } else {
      updates.recordingRetentionDays = num;
    }
  }

  if ("allowedHours" in params) {
    if (params.allowedHours && typeof params.allowedHours === "object" && !Array.isArray(params.allowedHours)) {
      const ah = params.allowedHours as Record<string, unknown>;
      const start = validateHH_MM(ah.start, "");
      const end = validateHH_MM(ah.end, "");
      if (!start || !end || !(start < end)) {
        errors.allowedHours = "start and end must be valid HH:MM with start < end";
      } else {
        updates.allowedHours = { start, end, timezone: "Africa/Johannesburg" };
      }
    } else {
      errors.allowedHours = "Must be object with start and end";
    }
  }

  if ("callerIds" in params) {
    if (!Array.isArray(params.callerIds)) {
      errors.callerIds = "Must be array of E.164 numbers";
    } else if (params.callerIds.some(v => !validateE164(v))) {
      errors.callerIds = "Contains invalid E.164 numbers";
    } else {
      updates.callerIds = dedupeE164(params.callerIds);
    }
  }

  if ("voiceAllowedUserIds" in params) {
    if (!Array.isArray(params.voiceAllowedUserIds)) {
      errors.voiceAllowedUserIds = "Must be array of strings";
    } else {
      updates.voiceAllowedUserIds = dedupeStringList(params.voiceAllowedUserIds);
    }
  }

  if ("usSmsCampaignStatus" in params) {
    updates.usSmsCampaignStatus = validateSmsCampaignStatus(params.usSmsCampaignStatus);
  }

  if ("usMessagingServiceSid" in params) {
    const val = params.usMessagingServiceSid;
    if (val === null || val === "") {
      updates.usMessagingServiceSid = null;
    } else {
      const validated = validateMessagingServiceSid(val);
      if (validated === null) {
        errors.usMessagingServiceSid = "Invalid Messaging Service SID";
      } else {
        updates.usMessagingServiceSid = validated;
      }
    }
  }

  if ("whatsappFrom" in params) {
    const val = params.whatsappFrom;
    if (val === null || val === "") {
      updates.whatsappFrom = null;
    } else {
      const validated = validateWhatsappFrom(val);
      if (validated === null) {
        errors.whatsappFrom = "Invalid E.164 or whatsapp:E.164 format";
      } else {
        updates.whatsappFrom = validated;
      }
    }
  }

  if ("smsHolidays" in params) {
    if (!Array.isArray(params.smsHolidays)) {
      errors.smsHolidays = "Must be array of ISO dates";
    } else {
      updates.smsHolidays = validateSmsHolidays(params.smsHolidays);
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const merged: TelephonySettings = { ...current, ...updates };

  // Write to state
  await ctx.state.set(settingsStateKey(companyId), merged);

  return { ok: true, settings: merged };
}

export interface SettingsView {
  company: { id: string; name: string | null };
  settings: TelephonySettings;
  secrets: SecretStatus;
  templateSyncRequestedAt: string | null;
}

export async function settingsView(ctx: PluginContext, companyId: string): Promise<SettingsView> {
  const settings = await readSettings(ctx, companyId);
  const status = await secretStatus(ctx, companyId, Array.from(TELEPHONY_SECRET_NAMES));

  let companyName: string | null = null;
  try {
    const company = (await ctx.companies.get(companyId)) as unknown;
    if (company && typeof company === "object") {
      const obj = company as Record<string, unknown>;
      if ("name" in obj) {
        companyName = obj.name as string | null;
      }
    }
  } catch {
    // Tolerate errors
  }

  let templateSyncRequestedAt: string | null = null;
  try {
    const syncState = await ctx.state.get(templateSyncStateKey(companyId));
    if (syncState && typeof syncState === "object" && "requestedAt" in syncState) {
      templateSyncRequestedAt = (syncState as Record<string, unknown>).requestedAt as string | null;
    }
  } catch {
    // Tolerate errors
  }

  return {
    company: { id: companyId, name: companyName },
    settings,
    secrets: status,
    templateSyncRequestedAt,
  };
}

export async function requestTemplateSync(ctx: PluginContext, companyId: string, userId: string): Promise<{ requestedAt: string }> {
  const requestedAt = new Date().toISOString();
  await ctx.state.set(templateSyncStateKey(companyId), { requestedAt, requestedBy: userId });
  return { requestedAt };
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


function hasSecret(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : isSecretRef(value) && Boolean(value.secretId);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Check if R2 settings are filled in (the secret may still fail to resolve). */
export function r2Configured(raw: Record<string, unknown>): boolean {
  const r2 = (raw.r2 && typeof raw.r2 === "object" ? raw.r2 : {}) as Record<string, unknown>;
  return Boolean(text(r2.accountId) && text(r2.bucket) && text(r2.accessKeyId) && r2.secretAccessKey);
}

/** Resolve R2 config for a company. Returns null if not configured or secret missing. */
export async function readR2Config(ctx: PluginContext, companyId: string): Promise<R2Config | null> {
  let raw: Record<string, unknown> = {};
  try {
    raw = await readConfig(ctx, companyId);
  } catch {
    return null;
  }

  if (!r2Configured(raw)) return null;

  const r2Raw = raw.r2 as Record<string, unknown>;
  const secretResolver = new SecretResolver(ctx, companyId, r2Raw);
  const secretAccessKey = await secretResolver.get("secretAccessKey");
  if (!secretAccessKey) return null;

  const prefix = (text(r2Raw.prefix) ?? "crm-telephony").replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9/_-]/g, "-") || "crm-telephony";

  return {
    accountId: text(r2Raw.accountId)!,
    bucket: text(r2Raw.bucket)!,
    accessKeyId: text(r2Raw.accessKeyId)!,
    secretAccessKey,
    prefix,
  };
}
