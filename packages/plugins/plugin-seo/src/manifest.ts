import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./namespace.js";
import { SEO_SPRINT_SKILL } from "./skills.js";
import { SEO_TOOLS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "SEO",
  description: "Sprints for one site. Tasks are Paperclip issues tagged with the sprint.",
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
    "issues.create",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: { namespaceSlug: "seo", migrationsDir: "migrations" },
  tools: SEO_TOOLS,
  skills: [
    {
      skillKey: "seo-sprint",
      displayName: "SEO sprint",
      slug: "seo-sprint",
      description: "Record rank and audit findings, and open a Paperclip issue for work a person must do.",
      markdown: SEO_SPRINT_SKILL,
    },
  ],
  ui: {
    slots: [
      { type: "page", id: "seo-page", displayName: "SEO", exportName: "SeoPage", routePath: "seo" },
      { type: "sidebar", id: "seo-sidebar", displayName: "SEO", exportName: "SeoSidebar", order: 44 },
    ],
  },
};

export default manifest;
