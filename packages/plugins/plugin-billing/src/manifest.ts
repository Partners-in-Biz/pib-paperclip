import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { jevConfigSchema, secretField, TAX_CODES } from "@partnersinbiz/pib-plugin-kit";
import { DEFAULT_DUNNING_STAGES, DEFAULT_EXPENSE_CATEGORIES, RECEIPT_MODEL_DEFAULT } from "./config.js";
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
    defaultTaxCode: {
      type: "string",
      title: "Default VAT code for new lines",
      enum: Object.keys(TAX_CODES),
      default: "za_std_15",
      description: "za_std_15 = 15%. Use za_out_of_scope when the business is not VAT registered.",
    },
    pricesIncludeVat: { type: "boolean", title: "Prices include VAT", default: false, description: "Off: line prices exclude VAT and VAT is added. On: line prices already include VAT." },
    defaultDueDays: { type: "integer", title: "Days until an invoice is due", default: 14, minimum: 0, maximum: 365 },
    invoiceNotes: text("Footer notes", "Printed at the bottom of invoices (terms, thank-you note)."),
    reportingCurrency: { type: "string", title: "Book (reporting) currency", default: "ZAR", minLength: 3, maxLength: 3, description: "Reports and journals convert foreign invoices to this currency with daily FX rates." },
    reviewerUserId: text("Who checks payments (Paperclip user id)", "Proof-of-payment checks, bank matches and approvals are assigned to this person. Leave empty to leave them unassigned."),
    defaultHourlyRateMinor: { type: "integer", title: "Default hourly rate (cents)", default: 0, minimum: 0 },
    expenseCategories: {
      type: "array",
      title: "Expense categories",
      items: { type: "string" },
      default: DEFAULT_EXPENSE_CATEGORIES,
      description: "Used for expenses and bills; Accounting maps each to an account (expense:<category>).",
    },
    sender: {
      type: "object",
      title: "Your business (sender)",
      properties: {
        name: text("Business name"),
        address: text("Address", "Use new lines for each address line."),
        email: text("Billing email"),
        phone: text("Phone"),
        vatNumber: text("VAT number", "When set, documents are titled Tax invoice / Tax credit note."),
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
    numbering: {
      type: "object",
      title: "Numbering",
      properties: {
        mode: {
          type: "string",
          title: "Invoice numbers",
          enum: ["client", "sequential"],
          default: "client",
          description: "client: per-client prefix (LUM-001, Q-LUM-001, CN-LUM-001). sequential: INV-0001 / QTE-0001 / CN-0001. Existing numbers never change.",
        },
        digits: { type: "integer", title: "Digits after the prefix", default: 3, minimum: 1, maximum: 8 },
      },
    },
    email: {
      type: "object",
      title: "Email (through the Mailbox plugin)",
      description: "Approved invoices, quotes, credit notes, statements and reminders are sent from your connected Gmail by the Mailbox plugin.",
      properties: {
        enabled: { type: "boolean", title: "Email documents", default: true, description: "Off: an approved invoice is marked sent without an email (send it yourself)." },
        from: text("Send from (Mailbox account)", "Leave empty for the Mailbox's default account."),
        cc: text("Always copy (cc)", "Comma-separated addresses."),
        bcc: text("Always blind copy (bcc)"),
        signature: { type: "string", title: "Sign-off", maxLength: 2000, description: "Replaces 'Thank you, <business name>'." },
      },
    },
    r2: {
      type: "object",
      title: "Private document storage (Cloudflare R2)",
      description: "A PRIVATE bucket (no public URL) for invoice PDFs, statements, receipts and proofs of payment. Links are presigned and expire. Do not use the public social media bucket. The bucket's CORS must allow PUT from the Paperclip origin for uploads.",
      properties: {
        accountId: text("Account ID"),
        bucket: text("Bucket"),
        accessKeyId: text("Access key ID"),
        secretAccessKey: secretField("Secret access key") as JsonSchema,
        prefix: { type: "string", title: "Key prefix", default: "billing" },
      },
    },
    anthropic: {
      type: "object",
      title: "Receipt reading (Claude)",
      description: "Optional. Reads vendor, date, total and VAT from uploaded receipts. Without a key, people type them.",
      properties: {
        apiKey: secretField("Anthropic API key", "Stored as a Paperclip secret.") as JsonSchema,
        model: { type: "string", title: "Model", default: RECEIPT_MODEL_DEFAULT },
        extractReceipts: { type: "boolean", title: "Read receipts", default: true },
      },
    },
    jev: jevConfigSchema() as unknown as JsonSchema,
    ledger: {
      type: "object",
      title: "Books (Accounting plugin)",
      properties: {
        enabled: { type: "boolean", title: "Post to Accounting", default: true, description: "Every invoice, payment, credit note, bill and expense is sent to the Accounting plugin as a journal." },
      },
    },
    dunning: {
      type: "object",
      title: "Payment reminders",
      description: "Off until you switch it on. One reminder per stage per invoice, sent from the Mailbox. Clients can be opted out on the Billing page. Placeholders: {{invoiceNumber}} {{amount}} {{clientName}} {{dueDate}} {{daysOverdue}} {{businessName}}.",
      properties: {
        enabled: { type: "boolean", title: "Send reminders", default: false },
        attachInvoice: { type: "boolean", title: "Attach the invoice PDF", default: true },
        stages: {
          type: "array",
          title: "Stages",
          default: DEFAULT_DUNNING_STAGES,
          items: {
            type: "object",
            properties: {
              daysAfterDue: { type: "integer", title: "Days after the due date", minimum: 0 },
              subject: text("Subject"),
              body: { type: "string", title: "Message", maxLength: 4000 },
            },
          },
        },
      },
    },
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.3.0",
  displayName: "Billing",
  description: "Invoices, quotes, credit notes, EFT proof of payment, bills, expenses, time and retainers. Agents draft; a person approves sending and money.",
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
    "events.emit",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "http.outbound",
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
      displayName: "Run recurring invoices and retainers",
      description: "Creates the next invoice for each due recurring schedule and retainer subscription (drafts unless set to send).",
      schedule: "0 0 * * *",
    },
    {
      jobKey: "redeliver",
      displayName: "Re-send to Mailbox and Accounting",
      description: "Re-sends emails and journals that have not been answered yet.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "emit-open-items",
      displayName: "Share recent receivables and payables",
      description: "Re-sends invoices and bills changed in the last 30 minutes to Accounting for bank matching.",
      schedule: "*/15 * * * *",
    },
    {
      jobKey: "emit-open-items-all",
      displayName: "Share all open items (nightly)",
      description: "Re-sends every open invoice and bill to Accounting.",
      schedule: "40 1 * * *",
    },
    {
      jobKey: "dunning",
      displayName: "Send payment reminders",
      description: "Sends the due reminder stage for overdue invoices (only when reminders are on).",
      schedule: "0 7 * * *",
    },
    {
      jobKey: "fx-rates",
      displayName: "Fetch FX rates",
      description: "Stores today's exchange rates for reports and foreign-currency payments.",
      schedule: "15 6 * * *",
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
    {
      // Read by the CRM client workspace: GET /api/plugins/partnersinbiz.billing/api/client-summary?companyId=&kind=&id=
      routeKey: "client-summary",
      method: "GET",
      path: "/client-summary",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
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
