import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./namespace.js";
import { SOCIAL_PUBLISH_SKILL } from "./skills.js";
import { SOCIAL_TOOLS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Social",
  description: "Draft, review, and publish posts to org or personal accounts.",
  author: "Partners in Biz",
  categories: ["automation"],
  capabilities: [
    "companies.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agent.tools.register",
    "skills.managed",
    "jobs.schedule",
    "events.subscribe",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: {
    namespaceSlug: "social",
    migrationsDir: "migrations",
    coreReadTables: ["heartbeat_runs"],
  },
  tools: SOCIAL_TOOLS,
  jobs: [
    {
      jobKey: "publish-due",
      displayName: "Publish due posts",
      description: "Claims scheduled posts and records a result for each destination.",
      schedule: "*/5 * * * *",
    },
  ],
  skills: [
    {
      skillKey: "social-publish",
      displayName: "Social publish",
      slug: "social-publish",
      description: "Draft and schedule posts without putting tokens in an issue.",
      markdown: SOCIAL_PUBLISH_SKILL,
    },
  ],
  ui: {
    slots: [
      { type: "page", id: "social-page", displayName: "Social", exportName: "SocialPage", routePath: "social" },
      { type: "sidebar", id: "social-sidebar", displayName: "Social", exportName: "SocialSidebar", order: 41 },
    ],
  },
};

export default manifest;
