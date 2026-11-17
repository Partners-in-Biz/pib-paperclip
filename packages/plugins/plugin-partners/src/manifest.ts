import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { COCKPIT_ROUTE, SETUP_STATUS_ROUTE } from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_ID, PLUGIN_VERSION } from "./namespace.js";
import { SKILLS } from "./skills.js";
import { PARTNER_TOOLS } from "./tools.js";

const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Partner settings",
  description: "Save once for each Paperclip company that shares records with partners.",
  properties: {
    requireOwnerForGrants: {
      type: "boolean",
      title: "Only owners and admins accept grants",
      default: true,
    },
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Partners",
  description: "Bilateral company links and named record grants.",
  author: "Partners in Biz",
  categories: ["workspace"],
  instanceConfigSchema,
  capabilities: [
    "companies.read",
    // A3 (PAR-12643): the access guard reads the caller's role (ctx.access.members.list). A new capability: a stop-first deploy.
    "access.members.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agent.tools.register",
    "skills.managed",
    "events.subscribe",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "jobs.schedule",
    "api.routes.register",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  // A3 (PAR-12643): heartbeat_runs is read-only; the access guard finds the acting person of a tool call. Stop-first.
  database: { namespaceSlug: "partners", migrationsDir: "migrations", coreReadTables: ["heartbeat_runs"] },
  tools: PARTNER_TOOLS,
  skills: SKILLS,
  jobs: [
    {
      jobKey: "setup-status",
      displayName: "Report setup status",
      description: "Tells the Setup plugin what Partners still needs, and sends the Cockpit snapshot, for each company.",
      schedule: "23 * * * *",
    },
  ],
  apiRoutes: [{ ...SETUP_STATUS_ROUTE }, { ...COCKPIT_ROUTE }],
  ui: {
    slots: [
      { type: "page", id: "partners-page", displayName: "Partners", exportName: "PartnersPage", routePath: "partners" },
      { type: "sidebar", id: "partners-sidebar", displayName: "Partners", exportName: "PartnersSidebar", order: 45 },
    ],
  },
};

export default manifest;
