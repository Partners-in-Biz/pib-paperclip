import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./namespace.js";

export const VERSION = "0.1.0";

export const JOBS = {
  reemitModules: "reemit-modules",
  weeklyFinishSetup: "weekly-finish-setup",
} as const;

const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Setup settings",
  description:
    "The Setup page saves this for you the first time you choose modules. Saving is what lets the weekly job open and update the Finish setup issue for this company.",
  properties: {
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
  description: "Guided setup per company: choose the modules it uses, see what each plugin still needs, fix it with deep links or Do it for me, and copy setup from another company.",
  author: "Partners in Biz",
  categories: ["workspace", "automation"],
  instanceConfigSchema,
  capabilities: [
    "companies.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "events.subscribe",
    "events.emit",
    "jobs.schedule",
    "issues.read",
    "issues.create",
    "issues.update",
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
  ],
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
        order: 10,
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
