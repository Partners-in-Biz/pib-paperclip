import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { secretField } from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_ID, PLUGIN_VERSION } from "./namespace.js";
import { TELEPHONY_TOOLS } from "./tools.js";

const secret = (title: string, description?: string) => secretField(title, description) as unknown as JsonSchema;

/**
 * Per-company configuration (Plugins → CRM Telephony → Configuration). Every
 * credential is a secret picked from the company's secrets; the host stores a
 * secret reference and a binding at `secrets.<NAME>`, which is the only way a
 * plugin can read a secret value (see src/secrets.ts). Feature switches, caps
 * and hours live on the plugin's own Telephony settings page.
 */
export const instanceConfigSchema: JsonSchema = {
  type: "object",
  properties: {
    secrets: {
      type: "object",
      title: "Credentials",
      description: "Pick the company secret for each one. Voice calling needs the first four; the numbers themselves are set under Numbers in Telephony settings.",
      properties: {
        TWILIO_ACCOUNT_SID: secret("Twilio Account SID", "Starts with AC. Twilio console → Account info."),
        TWILIO_AUTH_TOKEN: secret("Twilio Auth Token", "Twilio console → Account info. Signs the webhooks Twilio sends here."),
        TWILIO_API_KEY_SID: secret("Twilio API Key SID", "Starts with SK. Twilio console → Account → API keys & tokens → Create API key (Standard)."),
        TWILIO_API_KEY_SECRET: secret("Twilio API Key Secret", "Shown once when the API key is created."),
        TWILIO_TWIML_APP_SID: secret("Twilio TwiML App SID (optional)", "Not needed: the Dialer places calls through the REST API."),
        TWILIO_WHATSAPP_FROM: secret("Twilio WhatsApp sender (legacy)", "Only read to seed the Numbers list in Telephony settings when it is empty. Add numbers there instead."),
        DEEPGRAM_API_KEY: secret("Deepgram API key", "Transcribes recordings. Only with recording on."),
        ANTHROPIC_API_KEY: secret("Anthropic API key", "Summarises transcripts. Only with recording on."),
      },
    } as unknown as JsonSchema,
    r2: {
      type: "object",
      title: "Recording storage (Cloudflare R2)",
      description: "Where recordings are kept. Calls are recorded only when this is filled in and Recording is on in Telephony settings.",
      properties: {
        accountId: { type: "string", title: "R2 account id" },
        bucket: { type: "string", title: "Bucket" },
        accessKeyId: { type: "string", title: "Access key id" },
        secretAccessKey: secret("Secret access key"),
        prefix: { type: "string", title: "Key prefix", description: "Default crm-telephony" },
      },
    } as unknown as JsonSchema,
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "CRM Telephony",
  description: "Voice calls, SMS, and WhatsApp messaging integrated with CRM contacts.",
  author: "Partners in Biz",
  categories: ["connector", "automation"],
  capabilities: [
    "agent.tools.register",
    "companies.read",
    "events.emit",
    "events.subscribe",
    "http.outbound",
    "issues.create",
    "secrets.read-ref",
    "jobs.schedule",
    "webhooks.receive",
    "database.namespace.read",
    "database.namespace.write",
    "database.namespace.migrate",
    "ui.page.register",
    "plugin.state.read",
    "plugin.state.write",
  ],
  tools: TELEPHONY_TOOLS,
  instanceConfigSchema,
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  ui: {
    slots: [
      {
        type: "page",
        id: "dialer-page",
        displayName: "Dialer",
        exportName: "DialerPage",
        routePath: "dialer",
      },
      {
        type: "page",
        id: "telephony-settings",
        displayName: "Telephony settings",
        exportName: "TelephonySettingsPage",
        routePath: "telephony-settings",
      },
    ],
  },
  database: { namespaceSlug: "crm_telephony", migrationsDir: "migrations" },
  jobs: [
    {
      jobKey: "media-pipeline",
      displayName: "Media pipeline",
      description: "Process media files and transcriptions",
      schedule: "*/1 * * * *",
    },
    {
      jobKey: "retention",
      displayName: "Retention and hard delete",
      description: "Nightly purge of expired recordings, erasure tombstones and old transcript text",
      schedule: "0 2 * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: "voice-twiml",
      displayName: "Voice TwiML response",
      description: "Webhook for Twilio voice call responses",
    },
    {
      endpointKey: "call-status",
      displayName: "Call status updates",
      description: "Webhook for Twilio call status callbacks",
    },
    {
      endpointKey: "recording-status",
      displayName: "Recording status",
      description: "Webhook for call recording completion",
    },
    {
      endpointKey: "wa-inbound",
      displayName: "WhatsApp inbound",
      description: "Webhook for incoming WhatsApp messages",
    },
    {
      endpointKey: "wa-status",
      displayName: "WhatsApp status",
      description: "Webhook for WhatsApp message status updates",
    },
    {
      endpointKey: "sms-inbound",
      displayName: "SMS inbound",
      description: "Webhook for incoming SMS messages",
    },
  ],
};

export default manifest;
