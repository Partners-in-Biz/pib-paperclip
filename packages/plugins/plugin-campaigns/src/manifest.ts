import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./namespace.js";
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
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
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
    "issues.read",
    "issues.create",
    "issues.wakeup",
    "plugin.state.read",
    "plugin.state.write",
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
  ],
  skills: SKILLS,
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
