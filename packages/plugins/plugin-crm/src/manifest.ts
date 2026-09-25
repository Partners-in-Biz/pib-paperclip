import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./namespace.js";
import { CRM_OUTBOUND_SKILL, CRM_RECORDS_SKILL } from "./skills.js";
import { CRM_TOOLS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "CRM",
  description: "Companies, contacts, deals, and sequences for a Paperclip workspace.",
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
  ],
  skills: [
    {
      skillKey: "crm-records",
      displayName: "CRM records",
      slug: "crm-records",
      description: "Create and update people and companies without overwriting human-owned fields.",
      markdown: CRM_RECORDS_SKILL,
    },
    {
      skillKey: "crm-outbound",
      displayName: "CRM outbound",
      slug: "crm-outbound",
      description: "Enroll contacts in sequences and complete steps only by the sequence rule.",
      markdown: CRM_OUTBOUND_SKILL,
    },
  ],
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
