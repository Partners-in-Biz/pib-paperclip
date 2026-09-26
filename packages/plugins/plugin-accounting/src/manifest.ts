import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { jevConfigSchema, secretField, SETUP_STATUS_ROUTE } from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_ID } from "./namespace.js";
import { SKILLS } from "./skills.js";
import { ACCOUNTING_TOOLS } from "./tools.js";

const text = (title: string, description?: string): JsonSchema => (description ? { type: "string", title, description } : { type: "string", title });

const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Accounting settings",
  description:
    "Partners in Biz's own books. Save once for the company: saving sets up the South African chart of accounts and lets the scheduled jobs (depreciation, FX rates, month-end) run.",
  properties: {
    legalName: text("Legal name", "As registered with CIPC; printed on the VAT201 export and the accountant pack."),
    vatNumber: text("VAT number"),
    vatCategory: {
      type: "string",
      title: "VAT category",
      description: "SARS tax period: A = two months ending Jan/Mar/…, B = two months ending Feb/Apr/…, C = monthly, D = six months, E = annual, none = not VAT-registered.",
      enum: ["A", "B", "C", "D", "E", "none"],
      default: "B",
    },
    financialYearEndMonth: { type: "integer", title: "Financial year-end month", description: "1 = January … 12 = December. SA companies often use 2 (February).", minimum: 1, maximum: 12, default: 2 },
    agentsMayAcceptCategorisation: {
      type: "boolean",
      title: "Agents may accept bank categorisation",
      description: "Let the Bookkeeper accept bank suggestions (only exact invoice/bill matches). Off: a person accepts every suggestion.",
      default: false,
    },
    jev: jevConfigSchema() as unknown as JsonSchema,
    r2: {
      type: "object",
      title: "Private file storage (Cloudflare R2)",
      description:
        "A PRIVATE bucket (no public URL) for bank statements and accountant packs. Needed for statement files over 1 MB and large packs. Allow PUT from the Paperclip address in the bucket's CORS settings.",
      properties: {
        accountId: text("R2 account ID"),
        bucket: text("Bucket name"),
        accessKeyId: text("Access key ID"),
        secretAccessKey: secretField("Secret access key", "Stored as a Paperclip secret."),
        prefix: { type: "string", title: "Key prefix", default: "accounting" },
      },
    },
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.1",
  displayName: "Accounting",
  description: "Partners in Biz's books: chart of accounts, journals every plugin posts to, bank reconciliation, VAT201, reports, assets and the accountant pack.",
  author: "Partners in Biz",
  categories: ["workspace", "automation"],
  instanceConfigSchema,
  capabilities: [
    "companies.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agent.tools.register",
    "skills.managed",
    "agents.read",
    "authorization.grants.read",
    "authorization.grants.write",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.create",
    "secrets.read-ref",
    "http.outbound",
    "plugin.state.read",
    "plugin.state.write",
    "jobs.schedule",
    "events.subscribe",
    "events.emit",
    "ui.page.register",
    "ui.sidebar.register",
    "api.routes.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: { namespaceSlug: "accounting", migrationsDir: "migrations", coreReadTables: ["issues"] },
  tools: ACCOUNTING_TOOLS,
  apiRoutes: [SETUP_STATUS_ROUTE],
  jobs: [
    {
      jobKey: "redeliver",
      displayName: "Deliver bank matches and check approvals",
      description: "Re-sends bank matches Billing has not answered, checks approval issues and links a newly hired Bookkeeper.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "month-end",
      displayName: "Depreciation and month-end",
      description: "Posts depreciation up to last month, revalues open foreign-currency items at the last month end, and opens the Bookkeeper's month-end close issue.",
      schedule: "20 3 * * *",
    },
    {
      jobKey: "fx-rates",
      displayName: "Fetch FX rates",
      description: "Stores the day's reference rates to ZAR from frankfurter.app.",
      schedule: "30 16 * * *",
    },
  ],
  skills: SKILLS,
  ui: {
    slots: [
      { type: "page", id: "accounting-page", displayName: "Accounting", exportName: "AccountingPage", routePath: "accounting" },
      { type: "sidebar", id: "accounting-sidebar", displayName: "Accounting", exportName: "AccountingSidebar", order: 43 },
    ],
  },
};

export default manifest;
