import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { COCKPIT_ROUTE, jevConfigSchema, secretField, SETUP_STATUS_ROUTE } from "@partnersinbiz/pib-plugin-kit";
import { CAMPAIGNS_PROJECT_KEY, PLUGIN_ID, PLUGIN_VERSION } from "./namespace.js";
import { SKILLS } from "./skills.js";
import { CAMPAIGN_TOOLS } from "./tools.js";
import { WEBHOOKS } from "./webhook-keys.js";

const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Campaign settings",
  description:
    "Save these settings once for each Paperclip company that runs campaigns. Saving is what lets the scheduled job open due-step issues for the company.",
  properties: {
    timezone: { type: "string", title: "Timezone", default: "Africa/Johannesburg", description: "Also the clock the SMS and WhatsApp send windows use." },
    defaultFromName: { type: "string", title: "Default sender name", default: "Partners in Biz" },
    publicBaseUrl: {
      type: "string",
      title: "Public base URL",
      description: "The https address people reach Paperclip on, e.g. https://paperclip.partnersinbiz.online. Unsubscribe links in emails are built on it. Open the Campaigns page once after saving so the plugin learns its public path.",
    },
    oneClickUnsubscribeUrl: {
      type: "string",
      title: "One-click unsubscribe address (optional)",
      description: "The https address a mail client POSTs to for one-click unsubscribe (RFC 8058), e.g. https://paperclip.partnersinbiz.online/u. It needs the front-door rule from the Campaigns README, which forwards it to the plugin's unsubscribe webhook. Leave empty until that rule is live: the header is only added when this is set.",
    },
    messaging: {
      type: "object",
      title: "SMS and WhatsApp (Twilio)",
      description: "Off until the account SID, the auth token secret and a sender number are saved. Setup lists the steps. Nothing is sent from a company that has not saved all three.",
      properties: {
        accountSid: { type: "string", title: "Twilio account SID", description: "Starts with AC. Twilio console, Account Info." },
        authToken: secretField("Twilio auth token", "Twilio console, Account Info, Auth Token. Store it as a Paperclip secret; never paste it in an issue or chat."),
        smsFrom: { type: "string", title: "SMS sender number", description: "The number SMS goes out from, with country code, e.g. +14155550100. Also the number replies are read from." },
        messagingServiceSid: { type: "string", title: "Messaging Service SID (optional)", description: "Starts with MG. Sends SMS through a Twilio Messaging Service instead of the number above." },
        whatsappFrom: { type: "string", title: "WhatsApp sender number", description: "The number registered as a WhatsApp sender in Twilio, with country code." },
        defaultCountry: { type: "string", title: "Default country code", default: "+27", description: "Used for numbers written with a leading 0, e.g. 082 123 4567." },
        weekdays: { type: "string", title: "Send window, Monday to Friday", default: "08:00-20:00", description: "SMS and WhatsApp marketing is only sent inside these hours (the company timezone). South African direct marketing rules allow 08:00-20:00." },
        saturday: { type: "string", title: "Send window, Saturday", default: "09:00-13:00", description: "Or off." },
        sunday: { type: "string", title: "Send window, Sunday", default: "off", description: "Marketing is not sent on a Sunday unless you set hours here." },
        blackoutDates: { type: "string", title: "No sending on these dates", description: "Public holidays, as YYYY-MM-DD separated by commas, e.g. 2026-12-25, 2026-12-26." },
        inboundWebhookSecret: secretField("Reply webhook secret (optional)", "A shared secret of at least 16 characters, for forwarding replies to the plugin's messaging-inbound webhook as JSON. Replies are also read by polling, so this is optional."),
      },
    },
    jev: jevConfigSchema() as unknown as JsonSchema,
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Campaigns",
  description: "Themed email, SMS and WhatsApp programs that enroll contacts and send or open Paperclip issues for due steps, as PiB or as a client.",
  author: "Partners in Biz",
  categories: ["workspace", "automation"],
  instanceConfigSchema,
  capabilities: [
    "companies.read",
    "access.members.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agent.tools.register",
    "skills.managed",
    "jobs.schedule",
    "events.subscribe",
    "events.emit",
    "secrets.read-ref",
    "agents.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
    "api.routes.register",
    "ui.page.register",
    "ui.sidebar.register",
    // 0.6: the public unsubscribe endpoint, link checks, and the managed Campaigns project (client work opens in the client's own project).
    "webhooks.receive",
    "http.outbound",
    "projects.read",
    "projects.managed",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "campaigns",
    migrationsDir: "migrations",
    coreReadTables: ["heartbeat_runs", "issues"],
  },
  tools: CAMPAIGN_TOOLS,
  webhooks: WEBHOOKS,
  projects: [
    {
      projectKey: CAMPAIGNS_PROJECT_KEY,
      displayName: "Campaigns",
      description: "Campaign work for PiB's own marketing: step issues, replies, failed sends and revisions. A client's campaign work opens in the client's own project.",
      status: "in_progress",
      color: "#0891b2",
    },
  ],
  jobs: [
    {
      jobKey: "open-due-steps",
      displayName: "Open due campaign steps",
      description: "Sends or opens an issue for each due campaign step, launches approved campaigns whose approval event was missed, and moves contacts on when a step issue was closed.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "redeliver-mail",
      displayName: "Resend campaign email requests",
      description: "Re-sends campaign email requests the Mailbox has not answered yet, and hands failed ones to a person.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "poll-messaging",
      displayName: "Read SMS and WhatsApp replies",
      description: "Reads replies and delivery results from the messaging provider for each company that has it set up, and honours STOP words.",
      schedule: "*/10 * * * *",
    },
    {
      jobKey: "setup-status",
      displayName: "Report setup status",
      description: "Tells the Setup plugin what Campaigns still needs, sends the Cockpit snapshot, and announces recent unsubscribes again, for each company.",
      schedule: "19 * * * *",
    },
  ],
  skills: SKILLS,
  apiRoutes: [
    {
      // Read by the CRM client workspace: GET /api/plugins/partnersinbiz.campaigns/api/client-summary?companyId=&kind=&id=
      routeKey: "client-summary",
      method: "GET",
      path: "/client-summary",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    { ...SETUP_STATUS_ROUTE },
    { ...COCKPIT_ROUTE },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: "campaigns-page",
        displayName: "Campaigns",
        exportName: "CampaignsPage",
        routePath: "campaigns",
      },
      {
        type: "sidebar",
        id: "campaigns-sidebar",
        displayName: "Campaigns",
        exportName: "CampaignsSidebar",
        order: 50,
      },
    ],
  },
};

export default manifest;
