import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./namespace.js";
import { SKILLS } from "./skills.js";
import { BILLING_TOOLS } from "./tools.js";

const text = (title: string, description?: string): JsonSchema =>
  description ? { type: "string", title, description } : { type: "string", title };

const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Billing settings",
  description: "Save once for each Paperclip company that invoices. These details print on every invoice and quote.",
  properties: {
    defaultCurrency: { type: "string", title: "Default currency", default: "ZAR", minLength: 3, maxLength: 3 },
    defaultTaxRate: { type: "number", title: "Default VAT rate (%)", default: 15, minimum: 0, maximum: 100 },
    defaultDueDays: { type: "integer", title: "Days until an invoice is due", default: 14, minimum: 0, maximum: 365 },
    invoiceNotes: text("Footer notes", "Printed at the bottom of invoices (terms, thank-you note)."),
    sender: {
      type: "object",
      title: "Your business (sender)",
      properties: {
        name: text("Business name"),
        address: text("Address", "Use new lines for each address line."),
        email: text("Billing email"),
        phone: text("Phone"),
        vatNumber: text("VAT number"),
        registrationNumber: text("Company registration number"),
      },
    },
    payment: {
      type: "object",
      title: "EFT payment details",
      properties: {
        bankName: text("Bank"),
        accountName: text("Account name"),
        accountNumber: text("Account number"),
        branchCode: text("Branch code"),
        accountType: text("Account type"),
        swift: text("SWIFT code"),
      },
    },
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Billing",
  description: "Commercial invoices. Agents draft. A person approves sending and payment.",
  author: "Partners in Biz",
  categories: ["automation"],
  instanceConfigSchema,
  capabilities: [
    "companies.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agent.tools.register",
    "skills.managed",
    "jobs.schedule",
    "events.subscribe",
    "issues.read",
    "issues.create",
    "issues.wakeup",
    "plugin.state.read",
    "plugin.state.write",
    "api.routes.register",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: { namespaceSlug: "billing", migrationsDir: "migrations", coreReadTables: ["issues"] },
  tools: BILLING_TOOLS,
  jobs: [
      {
        jobKey: "mark-overdue",
        displayName: "Mark overdue invoices",
        description: "Moves sent or viewed invoices past their due time to overdue.",
        schedule: "0 * * * *",
      },
      {
        jobKey: "run-recurring",
        displayName: "Run recurring invoices",
        description: "Creates a new draft invoice from each due recurring schedule.",
        schedule: "0 0 * * *",
      },
    ],
  skills: SKILLS,
  apiRoutes: [
    {
      routeKey: "invoice-grant",
      method: "POST",
      path: "/grants",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      { type: "page", id: "billing-page", displayName: "Billing", exportName: "BillingPage", routePath: "billing" },
      { type: "sidebar", id: "billing-sidebar", displayName: "Billing", exportName: "BillingSidebar", order: 42 },
    ],
  },
};

export default manifest;
