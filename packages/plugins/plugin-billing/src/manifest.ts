import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./namespace.js";
import { INVOICE_DRAFT_SKILL } from "./skills.js";
import { BILLING_TOOLS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Billing",
  description: "Commercial invoices. Agents draft. A person approves sending and payment.",
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
    "issues.read",
    "issues.create",
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
  skills: [
    {
      skillKey: "invoice-draft",
      displayName: "Invoice draft",
      slug: "invoice-draft",
      description: "Draft commercial invoices. Do not send them.",
      markdown: INVOICE_DRAFT_SKILL,
    },
  ],
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
