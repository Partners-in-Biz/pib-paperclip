import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { instanceConfigSchema } from "./config.js";
import { NAMESPACE_SLUG, PLUGIN_ID } from "./namespace.js";
import { STUDIO_TOOLS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.55",
  displayName: "Studio",
  description: "Creative assets and image and video generation for people and agents. Every file is saved to private storage and tied to a company, client, project and task. Credits are tracked per client, under monthly caps a company owner sets.",
  author: "Partners in Biz",
  categories: ["automation", "ui"],
  instanceConfigSchema: instanceConfigSchema(),
  capabilities: [
    "companies.read",
    "access.members.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agent.tools.register",
    "projects.read",
    "issues.read",
    "issue.attachments.read",
    "issue.comments.create",
    "issues.wakeup",
    "issues.create",
    "agents.read",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "jobs.schedule",
    "events.subscribe",
    "events.emit",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: {
    namespaceSlug: NAMESPACE_SLUG,
    migrationsDir: "migrations",
    coreReadTables: ["heartbeat_runs"],
  },
  tools: STUDIO_TOOLS,
  jobs: [
    {
      jobKey: "process-queue",
      displayName: "Process generations",
      description: "Submits queued generations, checks running ones and saves finished files.",
      schedule: "* * * * *",
    },
    {
      jobKey: "process-renders",
      displayName: "Process video renders",
      description: "Starts the next queued video render, keeps the running one alive and recovers renders a stopped worker left behind.",
      schedule: "* * * * *",
    },
    {
      jobKey: "sweep-local-files",
      displayName: "Remove local copies",
      description: "Removes the local copies of assets that agents opened more than a day ago.",
      schedule: "23 * * * *",
    },
  ],
  ui: {
    slots: [
      { type: "page", id: "studio-page", displayName: "Studio", exportName: "StudioPage", routePath: "studio" },
      { type: "page", id: "studio-canvas", displayName: "Studio canvas", exportName: "StudioCanvasPage", routePath: "studio-canvas" },
      { type: "page", id: "studio-editor", displayName: "Studio video editor", exportName: "StudioEditorPage", routePath: "studio-editor" },
      { type: "sidebar", id: "studio-sidebar", displayName: "Studio", exportName: "StudioSidebar", order: 42 },
    ],
  },
};

export default manifest;
