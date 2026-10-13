import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { instanceConfigSchema } from "./config.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "./namespace.js";
import { TELEPHONY_TOOLS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "CRM Telephony",
  description: "Voice calls, SMS, and WhatsApp messaging integrated with CRM contacts.",
  author: "Partners in Biz",
  categories: ["connector", "automation"],
  instanceConfigSchema,
  capabilities: [
    "agent.tools.register",
    "http.outbound",
    "secrets.read-ref",
    "jobs.schedule",
    "webhooks.receive",
    "database.namespace.read",
    "database.namespace.write",
    "database.namespace.migrate",
    "plugin.state.read",
    "plugin.state.write",
    "ui.page.register",
  ],
  tools: TELEPHONY_TOOLS,
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: { namespaceSlug: "crm_telephony", migrationsDir: "migrations" },
  jobs: [
    {
      jobKey: "media-pipeline",
      displayName: "Media pipeline",
      description: "Process media files and transcriptions",
      schedule: "*/1 * * * *",
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
  ui: {
    slots: [
      { type: "page", id: "telephony-settings", displayName: "Telephony Settings", exportName: "TelephonySettingsPage", routePath: "telephony-settings" },
    ],
  },
};

export default manifest;
