import type { TelephonySettings } from "../settings.js";
import type { NumberPurpose, TelephonyNumber } from "../numbers.js";

export interface SettingsFormState {
  recordingEnabled: boolean;
  smsEnabled: boolean;
  whatsappEnabled: boolean;
  maxCallsPerDay: string;
  maxSmsPerDay: string;
  maxWhatsappPerDay: string;
  recordingRetentionDays: string;
  allowedHoursStart: string;
  allowedHoursEnd: string;
  callerIds: string;
  whatsappFrom: string;
  usMessagingServiceSid: string;
  usSmsCampaignStatus: "none" | "pending" | "approved" | "rejected";
  voiceAllowedUserIds: string;
  smsHolidays: string;
  publicBaseUrl: string;
  numbers: NumberRow[];
}

/** One editable row of the Numbers list. */
export interface NumberRow {
  e164: string;
  label: string;
  /** Comma-separated calling codes or ISO codes as typed: "27, 1" */
  regions: string;
  voice: boolean;
  sms: boolean;
  whatsapp: boolean;
  enabled: boolean;
  isDefault: boolean;
}

export function numberToRow(n: TelephonyNumber): NumberRow {
  return {
    e164: n.e164, label: n.label, regions: n.regions.join(", "),
    voice: n.purposes.includes("voice"), sms: n.purposes.includes("sms"), whatsapp: n.purposes.includes("whatsapp"),
    enabled: n.enabled, isDefault: n.isDefault,
  };
}

export function emptyNumberRow(isDefault = false): NumberRow {
  return { e164: "", label: "", regions: "", voice: true, sms: false, whatsapp: false, enabled: true, isDefault };
}

/** The rows as the save action wants them; the server validates and keeps exactly one default. */
export function rowsToNumbers(rows: NumberRow[]): Array<{ e164: string; label: string; regions: string[]; purposes: NumberPurpose[]; enabled: boolean; isDefault: boolean }> {
  return rows
    .filter((r) => r.e164.trim() || r.label.trim())
    .map((r) => ({
      e164: r.e164.trim(),
      label: r.label.trim(),
      regions: r.regions.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean),
      purposes: (["voice", "sms", "whatsapp"] as const).filter((p) => r[p]),
      enabled: r.enabled,
      isDefault: r.isDefault,
    }));
}

const E164_SHAPE = /^\+[1-9]\d{6,14}$/;

/** Row-level problems before the save, keyed `numbers.<index>`. */
export function validateNumberRows(rows: NumberRow[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    if (!r.e164.trim() && !r.label.trim()) return;
    const e164 = r.e164.replace(/[\s()-]/g, "");
    if (!E164_SHAPE.test(e164)) errors[`numbers.${i}`] = "Enter the number in E.164, like +27105550100";
    else if (seen.has(e164)) errors[`numbers.${i}`] = "This number is listed twice";
    else if (!r.voice && !r.sms && !r.whatsapp) errors[`numbers.${i}`] = "Tick at least one of Voice, SMS, WhatsApp";
    seen.add(e164);
  });
  return errors;
}

/** Make `index` the default and clear the others. */
export function setDefaultRow(rows: NumberRow[], index: number): NumberRow[] {
  return rows.map((r, i) => ({ ...r, isDefault: i === index }));
}

export function moveRow(rows: NumberRow[], index: number, delta: -1 | 1): NumberRow[] {
  const target = index + delta;
  if (target < 0 || target >= rows.length) return rows;
  const next = rows.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export const SECRET_LABELS = {
  TWILIO_ACCOUNT_SID: "Twilio Account SID",
  TWILIO_AUTH_TOKEN: "Twilio Auth Token",
  TWILIO_API_KEY_SID: "Twilio API Key SID",
  TWILIO_API_KEY_SECRET: "Twilio API Key Secret",
  TWILIO_TWIML_APP_SID: "Twilio TwiML App SID",
  TWILIO_WHATSAPP_FROM: "Twilio WhatsApp From (legacy, seeds Numbers)",
  DEEPGRAM_API_KEY: "Deepgram API Key",
  SMS_PROVIDER_API_KEY: "SMS Provider API Key",
  TEL_BRIDGE_AGENT_NUMBER: "Tel Bridge Agent Number",
  ANTHROPIC_API_KEY: "Anthropic API Key",
} as const;

const parseLines = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter(Boolean);

export function toFormState(settings: TelephonySettings): SettingsFormState {
  return {
    recordingEnabled: settings.recordingEnabled,
    smsEnabled: settings.smsEnabled,
    whatsappEnabled: settings.whatsappEnabled,
    maxCallsPerDay: String(settings.maxCallsPerDay),
    maxSmsPerDay: String(settings.maxSmsPerDay),
    maxWhatsappPerDay: String(settings.maxWhatsappPerDay),
    recordingRetentionDays: String(settings.recordingRetentionDays),
    allowedHoursStart: settings.allowedHours.start,
    allowedHoursEnd: settings.allowedHours.end,
    callerIds: settings.callerIds.join("\n"),
    whatsappFrom: settings.whatsappFrom ?? "",
    usMessagingServiceSid: settings.usMessagingServiceSid ?? "",
    usSmsCampaignStatus: settings.usSmsCampaignStatus,
    voiceAllowedUserIds: settings.voiceAllowedUserIds.join("\n"),
    smsHolidays: settings.smsHolidays.join("\n"),
    publicBaseUrl: settings.publicBaseUrl ?? "",
    numbers: settings.numbers.map(numberToRow),
  };
}

// Same ranges the save action enforces; the server stays the authority.
export const NUMERIC_LIMITS = {
  maxCallsPerDay: { min: 1, max: 10000 },
  maxSmsPerDay: { min: 1, max: 100000 },
  maxWhatsappPerDay: { min: 1, max: 100000 },
  recordingRetentionDays: { min: 1, max: 365 },
} as const;

// A blank input is "no value" (undefined), never 0, so the server cannot receive a silent zero.
const parseNumber = (text: string): number | undefined => (text.trim() === "" ? undefined : Number(text));

export function validateForm(form: SettingsFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const key of Object.keys(NUMERIC_LIMITS) as (keyof typeof NUMERIC_LIMITS)[]) {
    const { min, max } = NUMERIC_LIMITS[key];
    const value = parseNumber(form[key]);
    if (value === undefined) errors[key] = "Required";
    else if (!Number.isInteger(value) || value < min || value > max) errors[key] = `Must be a whole number ${min}-${max}`;
  }
  if (form.publicBaseUrl.trim() && !publicOrigin(form.publicBaseUrl)) {
    errors.publicBaseUrl = "Must be an http(s) address with no path, like https://paperclip.example.com";
  }
  Object.assign(errors, validateNumberRows(form.numbers));
  return errors;
}

/** Same id as `PLUGIN_ID` in src/namespace.ts, which the browser bundle cannot import (node:crypto). */
export const TELEPHONY_PLUGIN_ID = "partnersinbiz.crm-telephony";

/** The origin Twilio would call back to, or null when the text is not a plain http(s) origin. */
export function publicOrigin(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.search || url.hash || url.username || url.password) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export interface WebhookUrlRow {
  key: "call-status" | "recording-status" | "voice-twiml";
  label: string;
  url: string;
  /** What a person does with it. */
  note: string;
}

/** The webhook addresses for a public origin, in the order the Settings page lists them. */
export function voiceWebhookRows(origin: string): WebhookUrlRow[] {
  const base = `${origin}/api/plugins/${TELEPHONY_PLUGIN_ID}/webhooks`;
  return [
    { key: "call-status", label: "Call status callback", url: `${base}/call-status`, note: "Set on every call the Dialer places. Nothing to paste." },
    { key: "recording-status", label: "Recording status callback", url: `${base}/recording-status`, note: "Set in the call's TwiML when recording is on. Nothing to paste." },
    { key: "voice-twiml", label: "TwiML app voice URL", url: `${base}/voice-twiml`, note: "Not used: this host answers webhooks with JSON, not TwiML. Leave the TwiML app's voice URL empty." },
  ];
}

export interface ReadinessRow {
  label: string;
  status: "set" | "missing" | "optional" | "off";
  hint?: string;
}

export interface VoiceReadinessView {
  ready: boolean;
  missingSecrets: string[];
  numbers: { total: number; enabled: number; voice: number; whatsapp: number; defaultE164: string | null; voiceRegions: string[]; source: "settings" | "secrets" | "none"; lines: string[] };
  twimlApp: "set" | "missing";
  publicBaseUrl: string | null;
  recording: { enabled: boolean; r2Configured: boolean; active: boolean };
  voiceUsers: number;
  blockers: string[];
  notes: string[];
}

const VOICE_SECRET_ORDER = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET"] as const;

/** The checklist the Settings page shows for voice calling. */
export function describeVoiceReadiness(voice: VoiceReadinessView, secrets: Record<string, "set" | "missing">): ReadinessRow[] {
  const rows: ReadinessRow[] = VOICE_SECRET_ORDER.map((name) => ({
    label: `${SECRET_LABELS[name]} (${name})`,
    status: secrets[name] === "set" ? "set" : "missing",
  }));
  rows.push({
    label: "Numbers (caller IDs)",
    status: voice.numbers.voice > 0 ? "set" : "missing",
    hint: voice.numbers.voice > 0
      ? `${voice.numbers.voice} for voice${voice.numbers.voiceRegions.length ? `, serving +${voice.numbers.voiceRegions.join(", +")}` : ""}${voice.numbers.defaultE164 ? `; default ${voice.numbers.defaultE164}` : "; no default"}${voice.numbers.source === "secrets" ? " (from the old secrets, not saved yet)" : ""}`
      : "Add one under Numbers below",
  });
  rows.push({ label: "TwiML app SID (TWILIO_TWIML_APP_SID)", status: "optional", hint: "Not needed: calls are placed through the REST API" });
  rows.push({ label: "Public base URL", status: voice.publicBaseUrl ? "set" : "missing", hint: voice.publicBaseUrl ?? undefined });
  rows.push({ label: "Voice user IDs", status: voice.voiceUsers > 0 ? "set" : "missing", hint: voice.voiceUsers > 0 ? `${voice.voiceUsers} allowed` : "Add the user ids who may call" });
  rows.push({
    label: "Recording",
    status: voice.recording.active ? "set" : voice.recording.enabled ? "missing" : "off",
    hint: voice.recording.active ? "On, stored in R2" : voice.recording.enabled ? "On, but R2 storage is not filled in, so calls are not recorded" : "Off",
  });
  return rows;
}

export function toSavePayload(form: SettingsFormState): Partial<TelephonySettings> {
  return {
    recordingEnabled: form.recordingEnabled,
    smsEnabled: form.smsEnabled,
    whatsappEnabled: form.whatsappEnabled,
    maxCallsPerDay: parseNumber(form.maxCallsPerDay),
    maxSmsPerDay: parseNumber(form.maxSmsPerDay),
    maxWhatsappPerDay: parseNumber(form.maxWhatsappPerDay),
    recordingRetentionDays: parseNumber(form.recordingRetentionDays),
    allowedHours: { start: form.allowedHoursStart, end: form.allowedHoursEnd, timezone: "Africa/Johannesburg" },
    callerIds: parseLines(form.callerIds),
    whatsappFrom: form.whatsappFrom.trim() || null,
    usMessagingServiceSid: form.usMessagingServiceSid.trim() || null,
    usSmsCampaignStatus: form.usSmsCampaignStatus,
    voiceAllowedUserIds: parseLines(form.voiceAllowedUserIds),
    smsHolidays: parseLines(form.smsHolidays),
    publicBaseUrl: form.publicBaseUrl.trim() || null,
    numbers: rowsToNumbers(form.numbers) as TelephonyNumber[],
  };
}

export interface SecretStatusRow {
  name: string;
  label: string;
  status: "set" | "missing";
}

export function describeSecretStatus(secrets: Record<string, "set" | "missing">): SecretStatusRow[] {
  const names = Object.keys(SECRET_LABELS);
  return names.map((name) => ({
    name,
    label: SECRET_LABELS[name as keyof typeof SECRET_LABELS],
    status: secrets[name] ?? "missing",
  }));
}
