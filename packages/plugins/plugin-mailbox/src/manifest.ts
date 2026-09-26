import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { COCKPIT_ROUTE, SETUP_STATUS_ROUTE } from "@partnersinbiz/pib-plugin-kit";
import { instanceConfigSchema } from "./config.js";
import { SETUP_STATUS_JOB_KEY, SYNC_JOB_KEY } from "./constants.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "./namespace.js";
import { SKILLS } from "./skills.js";
import { MAILBOX_TOOLS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
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
      description: "Every 2 minutes: new Gmail messages (headers only), triage, labels, mail.received events and lead.captured for new leads, for every connected account.",
      schedule: "*/2 * * * *",
    },
    {
      jobKey: SETUP_STATUS_JOB_KEY,
      displayName: "Report setup status",
      description: "Tells the Setup plugin what the Mailbox still needs, and sends the Cockpit snapshot, for each company.",
      schedule: "29 * * * *",
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
    { ...SETUP_STATUS_ROUTE },
    { ...COCKPIT_ROUTE },
  ],
  ui: {
    slots: [
      { type: "page", id: "mailbox-page", displayName: "Mailbox", exportName: "MailboxPage", routePath: "mailbox" },
      { type: "sidebar", id: "mailbox-sidebar", displayName: "Mailbox", exportName: "MailboxSidebar", order: 43 },
    ],
  },
};

export default manifest;
