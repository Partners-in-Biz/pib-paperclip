import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./namespace.js";
import { PARTNER_SHARE_SKILL } from "./skills.js";
import { PARTNER_TOOLS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Partners",
  description: "Bilateral company links and named record grants.",
  author: "Partners in Biz",
  categories: ["workspace"],
  capabilities: [
    "companies.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agent.tools.register",
    "skills.managed",
    "events.subscribe",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: { namespaceSlug: "partners", migrationsDir: "migrations" },
  tools: PARTNER_TOOLS,
  skills: [
    {
      skillKey: "partner-share",
      displayName: "Partner share",
      slug: "partner-share",
      description: "Propose a named grant. Do not copy the record into the other company.",
      markdown: PARTNER_SHARE_SKILL,
    },
  ],
  ui: {
    slots: [
      { type: "page", id: "partners-page", displayName: "Partners", exportName: "PartnersPage", routePath: "partners" },
      { type: "sidebar", id: "partners-sidebar", displayName: "Partners", exportName: "PartnersSidebar", order: 45 },
    ],
  },
};

export default manifest;
