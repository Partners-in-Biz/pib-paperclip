/**
 * What voice calling needs before the Dialer can place a call, in one place,
 * so the Settings page can say exactly what is missing.
 */
import type { SecretStatus, TelephonySettings } from "./settings.js";
import { buildPublicWebhookUrl } from "./twilio-signature.js";
import { PLUGIN_ID } from "./namespace.js";
import { describeNumber, type NumbersSource } from "./numbers.js";

/** Secrets the REST call and the browser token cannot do without. */
export const VOICE_REQUIRED_SECRETS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
] as const;

/** The old fixed number secrets. Read only to seed the Numbers list; not part of readiness any more. */
export const LEGACY_NUMBER_SECRETS = ["TWILIO_ZA_NUMBER", "TWILIO_US_NUMBER", "TWILIO_WHATSAPP_FROM"] as const;

/**
 * Only needed for a browser-initiated outgoing call through a TwiML app. The
 * Dialer places calls with the REST API and inline TwiML instead, because the
 * Paperclip host answers every plugin webhook with its own JSON and cannot
 * return TwiML. Kept optional for completeness.
 */
export const VOICE_OPTIONAL_SECRETS = ["TWILIO_TWIML_APP_SID"] as const;

export interface VoiceWebhookUrls {
  /** Status callback for every call the Dialer places (set on the REST call, nothing to paste). */
  callStatus: string;
  /** Recording callback (set in the TwiML, nothing to paste). */
  recordingStatus: string;
  /** Where a TwiML app's voice URL would point. Not used by this release. */
  voiceTwiml: string;
}

export function voiceWebhookUrls(baseUrl: string, pluginId: string = PLUGIN_ID): VoiceWebhookUrls {
  return {
    callStatus: buildPublicWebhookUrl({ baseUrl, pluginId, endpointKey: "call-status" }),
    recordingStatus: buildPublicWebhookUrl({ baseUrl, pluginId, endpointKey: "recording-status" }),
    voiceTwiml: buildPublicWebhookUrl({ baseUrl, pluginId, endpointKey: "voice-twiml" }),
  };
}

export interface VoiceReadiness {
  /** True when a call can be placed for at least one region. */
  ready: boolean;
  /** Required secret names that are not set. */
  missingSecrets: string[];
  numbers: {
    total: number;
    enabled: number;
    /** Enabled numbers with purpose voice. */
    voice: number;
    whatsapp: number;
    defaultE164: string | null;
    /** Calling codes served by enabled voice numbers, e.g. ["27", "1"]. */
    voiceRegions: string[];
    source: NumbersSource;
    /** One line per number, for the Settings page. */
    lines: string[];
  };
  twimlApp: "set" | "missing";
  publicBaseUrl: string | null;
  webhooks: VoiceWebhookUrls | null;
  recording: {
    /** The company switched recording on. */
    enabled: boolean;
    /** R2 storage is filled in, so a recording has somewhere to go. */
    r2Configured: boolean;
    /** Calls are recorded only when both hold. */
    active: boolean;
  };
  voiceUsers: number;
  /** Plain sentences, one per thing that stops a call. Empty when ready. */
  blockers: string[];
  /** Things to know that do not stop a call (for example, numbers still seeded from the old secrets). */
  notes: string[];
}

export function describeVoiceReadiness(
  secrets: SecretStatus,
  settings: TelephonySettings,
  r2Configured: boolean,
): VoiceReadiness {
  const missingSecrets = VOICE_REQUIRED_SECRETS.filter((name) => secrets[name] !== "set");
  const enabledNumbers = settings.numbers.filter((n) => n.enabled);
  const voiceNumbers = enabledNumbers.filter((n) => n.purposes.includes("voice"));
  const numbers = {
    total: settings.numbers.length,
    enabled: enabledNumbers.length,
    voice: voiceNumbers.length,
    whatsapp: enabledNumbers.filter((n) => n.purposes.includes("whatsapp")).length,
    defaultE164: enabledNumbers.find((n) => n.isDefault)?.e164 ?? null,
    voiceRegions: Array.from(new Set(voiceNumbers.flatMap((n) => n.regions))),
    source: settings.numbersSource,
    lines: settings.numbers.map(describeNumber),
  };
  const twimlApp = secrets.TWILIO_TWIML_APP_SID === "set" ? "set" : "missing";
  const publicBaseUrl = settings.publicBaseUrl;
  const voiceUsers = settings.voiceAllowedUserIds.length;

  const blockers: string[] = [];
  if (missingSecrets.length > 0) {
    blockers.push(`Add these as company secrets and pick them on the plugin's Configuration page (Plugins → CRM Telephony → Configuration → Credentials): ${missingSecrets.join(", ")}.`);
  }
  if (numbers.voice === 0) {
    blockers.push("Add at least one enabled number with purpose Voice under Numbers on this page (the caller ID; one per country you call, plus a default).");
  }
  const notes: string[] = [];
  if (settings.numbersSource === "secrets") {
    notes.push("The numbers below come from the old secrets (TWILIO_ZA_NUMBER, TWILIO_US_NUMBER, TWILIO_WHATSAPP_FROM). Save them under Numbers once so they can be edited here; the secrets are then no longer read.");
  }
  if (numbers.voice > 0 && !numbers.defaultE164) {
    notes.push("No default number: a lead outside the listed regions cannot be called.");
  }
  if (!publicBaseUrl) {
    blockers.push("Set the public base URL below so Twilio can report call status to this Paperclip.");
  }
  if (voiceUsers === 0) {
    blockers.push("Add at least one user id under Voice user IDs.");
  }

  const active = settings.recordingEnabled && r2Configured;

  return {
    ready: blockers.length === 0,
    missingSecrets: [...missingSecrets],
    numbers,
    twimlApp,
    publicBaseUrl,
    webhooks: publicBaseUrl ? voiceWebhookUrls(publicBaseUrl) : null,
    recording: { enabled: settings.recordingEnabled, r2Configured, active },
    voiceUsers,
    blockers,
    notes,
  };
}
