import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { COCKPIT_ROUTE, jevConfigSchema, secretField, SETUP_STATUS_ROUTE } from "@partnersinbiz/pib-plugin-kit";
import { LEAD_ENDPOINT_KEY } from "./lead-form.js";
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
    publicBaseUrl: {
      type: "string",
      title: "Paperclip public address",
      description:
        "Optional. The address visitors and WordPress sites reach this Paperclip on, e.g. https://paperclip.partnersinbiz.online (the default). It is used to download the PiB Connector when an agent runs wp-connector update (it must be a host the Connector accepts for self-updates) and to build the lead form snippet and endpoint addresses clients put on their sites.",
    },
    jev: jevConfigSchema() as unknown as JsonSchema,
    leads: {
      type: "object",
      title: "Lead forms",
      description:
        "Optional spam protection and settings for the public lead forms on your clients' websites (CRM client page → Lead forms). Without Turnstile the form still has a honeypot field, rate limits, a throwaway-email block and a one-lead-per-email-per-day rule.",
      properties: {
        turnstileSiteKey: {
          type: "string",
          title: "Cloudflare Turnstile site key",
          description: "The public key of a Turnstile widget (free, dash.cloudflare.com → Turnstile). Add the hostname the Paperclip board is served from. It is copied into a form when the form is made or its key is rotated.",
        },
        turnstileSecret: secretField("Cloudflare Turnstile secret key", "The widget's secret key, as a Paperclip secret. The check is on only when both this and the site key are saved.") as unknown as JsonSchema,
        blockedEmailDomains: {
          type: "string",
          title: "Extra email domains to refuse",
          description: "Throwaway-mailbox domains to refuse on top of the built-in list, separated by commas or new lines (e.g. tempmail.example, burner.example).",
        },
      },
    } as unknown as JsonSchema,
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
    // The monthly client report is stored as a document on its issue (new in 0.13.0: a stop-first deploy, like webhooks.receive).
    "issue.documents.write",
    "api.routes.register",
    // The public lead form: POST /api/plugins/partnersinbiz.crm/webhooks/lead (new in 0.12.0: a stop-first deploy).
    "webhooks.receive",
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
    // cost_events (new in 0.13.0): the notional effort of a client's project, for the monthly report (internal only).
    coreReadTables: ["heartbeat_runs", "issues", "cost_events"],
  },
  tools: CRM_TOOLS,
  webhooks: [
    {
      endpointKey: LEAD_ENDPOINT_KEY,
      displayName: "Lead form",
      description: "Public. Takes an enquiry from a website form (a JSON body with the form key). The key says whose lead it is; the plugin checks everything.",
    },
  ],
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
      jobKey: "services-check",
      displayName: "Start the services customers bought",
      description: "Daily 08:00 SAST: saves older free-text services in the services list and, for each customer whose profile lists a service with no step yet, opens the step for the role that owns it (up to 8 per company a day).",
      schedule: "0 6 * * *",
    },
    {
      jobKey: "site-monitor",
      displayName: "Check client websites",
      description: "Every 5 minutes: one GET of the address of each client website that is due (twice a day its certificate, once a day its domain expiry). A site down for 5 minutes, a certificate under 14 days or a domain under 30 days opens an issue for the Delivery Lead.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "client-care",
      displayName: "Client care: targets, reminders and approvals",
      description: "Every 15 minutes: flags support targets that ran out, drafts reminders to clients who have not answered (for approval), re-opens approvals that lost their issue, settles emails the Mailbox never confirmed, and in the first days of a month finishes last month's report issues. Hourly it also asks again for erasures a module has not answered.",
      schedule: "*/15 * * * *",
    },
    {
      jobKey: "client-health",
      displayName: "Score customer health",
      description: "Daily 05:20 SAST: scores every customer from support, reply speed, invoices, SEO, uptime and how they answer us, and opens a churn-risk issue for the Account Manager when one is at risk.",
      schedule: "20 3 * * *",
    },
    {
      jobKey: "client-report-monthly",
      displayName: "Monthly client reports",
      description: "The 1st of the month, 06:00 SAST: for every customer with something to report, gathers last month's numbers and opens the report issue for the Account Manager. Sending the report still needs a person's approval.",
      schedule: "0 4 1 * *",
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
