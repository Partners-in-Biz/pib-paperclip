import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { jevConfigSchema } from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_ID } from "./namespace.js";
import { SKILLS } from "./skills.js";
import { CRM_TOOLS } from "./tools.js";

const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "CRM settings",
  description:
    "Save these settings once for each Paperclip company that uses the CRM. Saving is what lets the scheduled jobs (sequence steps, client sync) act on the company.",
  properties: {
    timezone: { type: "string", title: "Timezone", default: "Africa/Johannesburg" },
    defaultCurrency: { type: "string", title: "Default currency", default: "ZAR", minLength: 3, maxLength: 3 },
    sequenceIssueAssignee: {
      type: "string",
      title: "Who gets sequence step issues",
      description: "contact: the contact's agent or owner (default). none: leave the issue unassigned.",
      enum: ["contact", "none"],
      default: "contact",
    },
    mailFrom: {
      type: "string",
      title: "Send sequence email from",
      description: "A Mailbox (Gmail) address. Leave empty to use the Mailbox's default account.",
    },
    jev: jevConfigSchema() as unknown as JsonSchema,
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.3.0",
  displayName: "CRM",
  description: "Companies, contacts, deals, and sequences for a Paperclip workspace.",
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
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "issues.read",
    "issues.create",
    "issues.wakeup",
    "api.routes.register",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "crm",
    migrationsDir: "migrations",
    coreReadTables: ["heartbeat_runs", "issues"],
  },
  tools: CRM_TOOLS,
  jobs: [
    {
      jobKey: "open-due-steps",
      displayName: "Open due sequence steps",
      description: "Opens a Paperclip issue for each sequence step that is due.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "redeliver-mail",
      displayName: "Resend sequence email requests",
      description: "Re-sends sequence email requests the Mailbox has not answered yet, and hands failed ones to a person.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "emit-recent",
      displayName: "Share recent client changes",
      description: "Re-sends companies and contacts changed in the last 30 minutes to the other PiB plugins.",
      schedule: "*/15 * * * *",
    },
    {
      jobKey: "emit-all",
      displayName: "Share all clients (nightly)",
      description: "Re-sends every company and contact to the other PiB plugins so their client lists stay complete.",
      schedule: "30 1 * * *",
    },
  ],
  skills: SKILLS,
  apiRoutes: [
    {
      routeKey: "record-grant",
      method: "POST",
      path: "/grants",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: "crm-page",
        displayName: "CRM",
        exportName: "CrmPage",
        routePath: "crm",
      },
      {
        type: "sidebar",
        id: "crm-sidebar",
        displayName: "CRM",
        exportName: "CrmSidebar",
        order: 40,
      },
    ],
  },
};

export default manifest;
