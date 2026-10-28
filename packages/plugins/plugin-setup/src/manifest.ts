import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./namespace.js";
import { TEMPLATE_TOOLS } from "./template-tools.js";

export const VERSION = "0.7.7";

export const JOBS = {
  reemitModules: "reemit-modules",
  weeklyFinishSetup: "weekly-finish-setup",
  templateDrift: "template-drift",
} as const;

const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Setup settings",
  description:
    "The Setup page saves this for you the first time you choose modules. Saving is what lets the weekly job open and update the Finish setup issue for this company.",
  properties: {
    ownerCompany: {
      type: "boolean",
      title: "This is Partners in Biz's own company (owner company only)",
      description: "Tick this ONLY on Partners in Biz's own company. It allows PiB-only (scope pib) agent templates in the hire list. Leave it off for every client company.",
      default: false,
    },
    weeklyIssue: {
      type: "boolean",
      title: "Weekly Finish setup issue",
      description: "Open (and keep up to date) one issue listing what is still missing. It closes itself when everything required is done.",
      default: true,
    },
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: VERSION,
  displayName: "Setup",
  description: "Guided setup per company: hire its agents (Team), choose the modules it uses, see what each plugin still needs, fix it with deep links or Do it for me, copy setup from another company, and bring a new company up in one run (New company) from the team template pack.",
  author: "Partners in Biz",
  categories: ["workspace", "automation"],
  instanceConfigSchema,
  capabilities: [
    "companies.read",
    // Entitlements: who is an owner or admin of a company (role checks on save-modules and set-entitlements).
    "access.members.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "events.subscribe",
    "events.emit",
    "jobs.schedule",
    "issues.read",
    "issues.create",
    "issues.update",
    // The hire tasks Setup opens for the CEO must wake it: a plugin-created issue wakes nobody by itself.
    "issues.wakeup",
    "agents.read",
    "agent.tools.register",
    "plugin.state.read",
    "plugin.state.write",
    "api.routes.register",
    "ui.page.register",
    "ui.sidebar.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "setup",
    migrationsDir: "migrations",
  },
  jobs: [
    {
      jobKey: JOBS.reemitModules,
      displayName: "Re-send module switches",
      description: "Every hour, re-sends each company's module choice to the other plugins (events can be lost).",
      schedule: "0 * * * *",
    },
    {
      jobKey: JOBS.weeklyFinishSetup,
      displayName: "Weekly Finish setup issue",
      description: "Mondays 07:00 SAST: opens or updates one Finish setup issue per company, and closes it when nothing required is missing.",
      schedule: "0 5 * * 1",
    },
    {
      jobKey: JOBS.templateDrift,
      displayName: "Template drift",
      description: "Every hour: finds agents behind the team template pack and keeps one Template drift issue per company (the sync work list). Closes it at zero and reports the templates:drift health check.",
      schedule: "30 * * * *",
    },
  ],
  apiRoutes: [
    {
      // Read by every PiB plugin's sidebar (kit setup-client): GET /api/plugins/partnersinbiz.setup/api/modules?companyId=
      routeKey: "modules",
      method: "GET",
      path: "/modules",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      // Read by the ops scripts (new-company.py): GET /api/plugins/partnersinbiz.setup/api/templates?companyId=
      routeKey: "templates",
      method: "GET",
      path: "/templates",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  tools: TEMPLATE_TOOLS,
  ui: {
    slots: [
      {
        type: "page",
        id: "setup-page",
        displayName: "Setup",
        exportName: "SetupPage",
        routePath: "setup",
      },
      {
        type: "sidebar",
        id: "setup-sidebar",
        displayName: "Setup",
        exportName: "SetupSidebar",
        order: 30,
      },
      {
        type: "dashboardWidget",
        id: "setup-progress",
        displayName: "Setup progress",
        exportName: "SetupProgressWidget",
      },
    ],
  },
};

export default manifest;
