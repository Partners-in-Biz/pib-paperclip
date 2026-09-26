import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { instanceConfigSchema } from "./config.js";
import { SYNC_JOB_KEY } from "./constants.js";
import { PLUGIN_ID } from "./namespace.js";
import { SKILLS } from "./skills.js";
import { MAILBOX_TOOLS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.2.0",
  displayName: "Mailbox",
  description:
    "The company's Gmail hub: connect Gmail, sync and triage the inbox, and send mail for every PiB plugin. Agents draft on delegated mailboxes; sending stays off unless the delegation allows it.",
  author: "Partners in Biz",
  categories: ["connector"],
  instanceConfigSchema,
  capabilities: [
    "companies.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agent.tools.register",
    "skills.managed",
    "jobs.schedule",
    "events.subscribe",
    "events.emit",
    "api.routes.register",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: { namespaceSlug: "mailbox", migrationsDir: "migrations" },
  tools: MAILBOX_TOOLS,
  skills: SKILLS,
  jobs: [
    {
      jobKey: SYNC_JOB_KEY,
      displayName: "Sync Gmail",
      description: "Every 2 minutes: new Gmail messages (headers only), triage, labels and mail.received events for every connected account.",
      schedule: "*/2 * * * *",
    },
  ],
  apiRoutes: [
    {
      routeKey: "oauth-complete",
      method: "POST",
      path: "/oauth/complete",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      { type: "page", id: "mailbox-page", displayName: "Mailbox", exportName: "MailboxPage", routePath: "mailbox" },
      { type: "sidebar", id: "mailbox-sidebar", displayName: "Mailbox", exportName: "MailboxSidebar", order: 43 },
    ],
  },
};

export default manifest;
