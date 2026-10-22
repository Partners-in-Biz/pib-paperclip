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
  };
}

export function toSavePayload(form: SettingsFormState): { payload?: Partial<TelephonySettings>; errors?: Record<string, string> } {
  const errors: Record<string, string> = {};

  // Validate numeric fields
  for (const key of ["maxCallsPerDay", "maxSmsPerDay", "maxWhatsappPerDay", "recordingRetentionDays"] as const) {
    const val = form[key].trim();
    if (!val) {
      errors[key] = "Required";
    } else if (!/^\d+$/.test(val)) {
      errors[key] = "Enter a number";
    }
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  return {
    payload: {
      recordingEnabled: form.recordingEnabled,
      smsEnabled: form.smsEnabled,
      whatsappEnabled: form.whatsappEnabled,
      maxCallsPerDay: Number(form.maxCallsPerDay),
      maxSmsPerDay: Number(form.maxSmsPerDay),
      maxWhatsappPerDay: Number(form.maxWhatsappPerDay),
      recordingRetentionDays: Number(form.recordingRetentionDays),
      allowedHours: { start: form.allowedHoursStart, end: form.allowedHoursEnd, timezone: "Africa/Johannesburg" },
      callerIds: parseLines(form.callerIds),
      whatsappFrom: form.whatsappFrom.trim() || null,
      usMessagingServiceSid: form.usMessagingServiceSid.trim() || null,
      usSmsCampaignStatus: form.usSmsCampaignStatus,
      voiceAllowedUserIds: parseLines(form.voiceAllowedUserIds),
      smsHolidays: parseLines(form.smsHolidays),
    },
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
