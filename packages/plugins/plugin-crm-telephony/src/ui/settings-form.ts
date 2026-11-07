import type { TelephonySettings } from "../settings.js";

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
}

export const SECRET_LABELS = {
  TWILIO_ACCOUNT_SID: "Twilio Account SID",
  TWILIO_AUTH_TOKEN: "Twilio Auth Token",
  TWILIO_API_KEY_SID: "Twilio API Key SID",
  TWILIO_API_KEY_SECRET: "Twilio API Key Secret",
  TWILIO_TWIML_APP_SID: "Twilio TwiML App SID",
  TWILIO_ZA_NUMBER: "Twilio ZA Number",
  TWILIO_US_NUMBER: "Twilio US Number",
  TWILIO_WHATSAPP_FROM: "Twilio WhatsApp From",
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
  numbers: { za: "set" | "missing"; us: "set" | "missing" };
  twimlApp: "set" | "missing";
  publicBaseUrl: string | null;
  recording: { enabled: boolean; r2Configured: boolean; active: boolean };
  voiceUsers: number;
  blockers: string[];
}

const VOICE_SECRET_ORDER = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET"] as const;

/** The checklist the Settings page shows for voice calling. */
export function describeVoiceReadiness(voice: VoiceReadinessView, secrets: Record<string, "set" | "missing">): ReadinessRow[] {
  const rows: ReadinessRow[] = VOICE_SECRET_ORDER.map((name) => ({
    label: `${SECRET_LABELS[name]} (${name})`,
    status: secrets[name] === "set" ? "set" : "missing",
  }));
  rows.push({ label: "Twilio number for +27 calls (TWILIO_ZA_NUMBER)", status: voice.numbers.za, hint: voice.numbers.za === "missing" && voice.numbers.us === "set" ? "Optional while only US numbers are called" : undefined });
  rows.push({ label: "Twilio number for +1 calls (TWILIO_US_NUMBER)", status: voice.numbers.us, hint: voice.numbers.us === "missing" && voice.numbers.za === "set" ? "Optional while only South African numbers are called" : undefined });
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
