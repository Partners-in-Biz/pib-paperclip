/**
 * Instance-level config for telephony: secret refs for API keys.
 */
import type { JsonSchema } from "@paperclipai/plugin-sdk";
import { secretField } from "@partnersinbiz/pib-plugin-kit";

export const SECRET_REFS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_TWIML_APP_SID",
  "DEEPGRAM_API_KEY",
  "SMS_PROVIDER_KEY",
] as const;

export const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Telephony credentials",
  description: "Twilio and Deepgram API keys (optional; telephony features are disabled until configured).",
  properties: {
    TWILIO_ACCOUNT_SID: secretField("Twilio Account SID"),
    TWILIO_AUTH_TOKEN: secretField("Twilio Auth Token"),
    TWILIO_API_KEY_SID: secretField("Twilio API Key SID"),
    TWILIO_API_KEY_SECRET: secretField("Twilio API Key Secret"),
    TWILIO_TWIML_APP_SID: secretField("Twilio TwiML App SID"),
    DEEPGRAM_API_KEY: secretField("Deepgram API Key"),
    SMS_PROVIDER_KEY: secretField("SMS provider API key"),
  },
};
