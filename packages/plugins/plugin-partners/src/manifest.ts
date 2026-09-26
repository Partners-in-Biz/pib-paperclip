import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./namespace.js";
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
  version: "0.1.0",
  displayName: "Partners",
  description: "Bilateral company links and named record grants.",
  author: "Partners in Biz",
  categories: ["workspace"],
  instanceConfigSchema,
  capabilities: [
    "companies.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agent.tools.register",
    "skills.managed",
    "events.subscribe",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: { namespaceSlug: "partners", migrationsDir: "migrations" },
  tools: PARTNER_TOOLS,
  skills: SKILLS,
  ui: {
    slots: [
      { type: "page", id: "partners-page", displayName: "Partners", exportName: "PartnersPage", routePath: "partners" },
      { type: "sidebar", id: "partners-sidebar", displayName: "Partners", exportName: "PartnersSidebar", order: 45 },
    ],
  },
};

export default manifest;
