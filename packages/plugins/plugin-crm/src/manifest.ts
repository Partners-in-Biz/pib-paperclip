import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { COCKPIT_ROUTE, jevConfigSchema, SETUP_STATUS_ROUTE } from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_ID, PLUGIN_VERSION } from "./namespace.js";
import { SKILLS } from "./skills.js";
import { CRM_TOOLS } from "./tools.js";

const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "CRM settings",
  description:
    "Save these settings once for each Paperclip company that uses the CRM. Saving is what lets the scheduled jobs (sequence steps, client sync) act on the company.",
  properties: {
    timezone: { type: "string", title: "Timezone", default: "Africa/Johannesburg" },
    defaultCurrency: { type: "string", title: "Default currency", default: "ZAR", minLength: 3, maxLength: 3 },
    sequenceIssueAssignee: {
      type: "string",
      title: "Who gets CRM work (lead follow-ups, replies, sequence steps)",
      description:
        "contact (default): the contact's own agent or owner when it has one, else the Account Manager. team: always the Account Manager. Without an Account Manager the work goes to the Operator, then to the company owner, so nothing is left unassigned.",
      enum: ["contact", "team"],
      default: "contact",
    },
    mailFrom: {
      type: "string",
      title: "Send sequence email from",
      description: "A Mailbox (Gmail) address. Leave empty to use the Mailbox's default account.",
    },
    jev: jevConfigSchema() as unknown as JsonSchema,
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "CRM",
  description: "Companies, contacts, deals, sequences, client profiles, client websites (with the PiB Connector for WordPress) and client projects, with the Account Manager agent. The source of truth for clients.",
  author: "Partners in Biz",
  categories: ["workspace", "automation"],
  instanceConfigSchema,
  capabilities: [
    "companies.read",
    "access.members.read",
    "agents.read",
    "authorization.grants.read",
    "authorization.grants.write",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agent.tools.register",
    "skills.managed",
    "jobs.schedule",
    "events.subscribe",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "projects.read",
    "http.outbound",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.create",
    "api.routes.register",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "crm",
    migrationsDir: "migrations",
    coreReadTables: ["heartbeat_runs", "issues"],
  },
  tools: CRM_TOOLS,
  jobs: [
    {
      jobKey: "open-due-steps",
      displayName: "Open due sequence steps",
      description: "Opens a Paperclip issue for each sequence step that is due.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "redeliver-mail",
      displayName: "Resend sequence email requests",
      description: "Re-sends sequence email requests the Mailbox has not answered yet, and hands failed ones to a person.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "held-leads",
      displayName: "Add held leads",
      description: "Adds leads that came in while the CRM was off or its settings were unsaved, once it is ready.",
      schedule: "*/10 * * * *",
    },
    {
      jobKey: "emit-recent",
      displayName: "Share recent client changes",
      description: "Re-sends companies, contacts and websites changed in the last 30 minutes to the other PiB plugins.",
      schedule: "*/15 * * * *",
    },
    {
      jobKey: "emit-all",
      displayName: "Share all clients (nightly)",
      description: "Re-sends every company, contact and website to the other PiB plugins so their client lists stay complete.",
      schedule: "30 1 * * *",
    },
    {
      jobKey: "setup-status",
      displayName: "Report setup status",
      description: "Links a hired Account Manager, re-sends the last day's hand-offs, tells the Setup plugin what the CRM still needs, sends the Cockpit snapshot, and checks WordPress sites the Connector has not heard from in 6 hours.",
      schedule: "17 * * * *",
    },
    {
      jobKey: "sales-daily",
      displayName: "Sales: quiet deals and duplicate contacts",
      description: "Daily 07:30 SAST: opens a pipeline check for the Sales Lead when open deals have gone quiet for 14 days, and a duplicates issue for the CRM Data Steward when contacts share an email. Never a second one while the last is open.",
      schedule: "30 5 * * *",
    },
    {
      jobKey: "sales-weekly",
      displayName: "Sales: weekly pipeline summary and CRM hygiene",
      description: "Mondays 08:00 SAST: the weekly pipeline summary for the Sales Lead and the CRM hygiene report for the CRM Data Steward, for companies with CRM records.",
      schedule: "0 6 * * 1",
    },
  ],
  skills: SKILLS,
  apiRoutes: [
    {
      routeKey: "record-grant",
      method: "POST",
      path: "/grants",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    { ...SETUP_STATUS_ROUTE },
    { ...COCKPIT_ROUTE },
  ],
  ui: {
    slots: [
      {
        type: "page",
        id: "crm-page",
        displayName: "CRM",
        exportName: "CrmPage",
        routePath: "crm",
      },
      {
        type: "sidebar",
        id: "crm-sidebar",
        displayName: "CRM",
        exportName: "CrmSidebar",
        order: 40,
      },
    ],
  },
};

export default manifest;
