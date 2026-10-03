import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { COCKPIT_ROUTE, SETUP_STATUS_ROUTE } from "@partnersinbiz/pib-plugin-kit";
import { instanceConfigSchema } from "./config.js";
import { DOMAIN_JOB_KEY, SETUP_STATUS_JOB_KEY, SYNC_JOB_KEY, UNSUBSCRIBE_ENDPOINT } from "./constants.js";
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
    // The mailbox.delegate ask effect checks that the agent it grants is an active agent of this company.
    "agents.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    // The done-check comments on a reply issue it reopens (what is still missing).
    "issue.comments.create",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agent.tools.register",
    "skills.managed",
    "jobs.schedule",
    "events.subscribe",
    "events.emit",
    "api.routes.register",
    // The public one-click unsubscribe address (RFC 8058).
    "webhooks.receive",
    // DNS over HTTPS for the sender domain checks.
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
      description: "Tells the Setup plugin what the Mailbox still needs, sends the Cockpit snapshot, keeps every company's managed skills up to date and announces the sender domain results again, for each company.",
      schedule: "29 * * * *",
    },
    {
      jobKey: DOMAIN_JOB_KEY,
      displayName: "Check sender domains",
      description: "Daily: reads SPF, DKIM, DMARC and MX of every domain the company's mailboxes send from (public DNS, nothing is changed), records the result and reports problems on the Cockpit.",
      schedule: "17 5 * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: UNSUBSCRIBE_ENDPOINT,
      displayName: "One-click unsubscribe",
      description: "POST /api/plugins/partnersinbiz.mailbox/webhooks/unsubscribe: a mail client's one-click unsubscribe (RFC 8058). The signed token must reach the plugin as the X-Pib-Unsubscribe-Token header or in the X-Original-Uri query (the reverse proxy passes it on; the Mailbox checks that every hour and makes its own https links only while the check passes); a bad token does nothing.",
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
