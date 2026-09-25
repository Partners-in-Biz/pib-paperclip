import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./namespace.js";
import { CAMPAIGN_SKILL } from "./skills.js";
import { CAMPAIGN_TOOLS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Campaigns",
  description: "Themed email programs that enroll contacts and open Paperclip issues for due steps.",
  author: "Partners in Biz",
  categories: ["workspace", "automation"],
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
  skills: [
    {
      skillKey: "campaigns",
      displayName: "Campaigns",
      slug: "campaigns",
      description: "Run themed email programs that enroll contacts and open issues for due steps.",
      markdown: CAMPAIGN_SKILL,
    },
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
