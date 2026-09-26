import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { COCKPIT_ROUTE, jevConfigSchema, SETUP_STATUS_ROUTE } from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_ID, PLUGIN_VERSION } from "./namespace.js";
import { SKILLS } from "./skills.js";
import { CAMPAIGN_TOOLS } from "./tools.js";

const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Campaign settings",
  description:
    "Save these settings once for each Paperclip company that runs campaigns. Saving is what lets the scheduled job open due-step issues for the company.",
  properties: {
    timezone: { type: "string", title: "Timezone", default: "Africa/Johannesburg" },
    defaultFromName: { type: "string", title: "Default sender name", default: "Partners in Biz" },
    jev: jevConfigSchema() as unknown as JsonSchema,
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Campaigns",
  description: "Themed email programs that enroll contacts and open Paperclip issues for due steps.",
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
    "issues.read",
    "issues.create",
    "issues.wakeup",
    "plugin.state.read",
    "plugin.state.write",
    "api.routes.register",
    "ui.page.register",
    "ui.sidebar.register",
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
  jobs: [
    {
      jobKey: "open-due-steps",
      displayName: "Open due campaign steps",
      description: "Opens a Paperclip issue for each campaign step that is due.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "redeliver-mail",
      displayName: "Resend campaign email requests",
      description: "Re-sends campaign email requests the Mailbox has not answered yet, and hands failed ones to a person.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "setup-status",
      displayName: "Report setup status",
      description: "Tells the Setup plugin what Campaigns still needs, and sends the Cockpit snapshot, for each company.",
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
