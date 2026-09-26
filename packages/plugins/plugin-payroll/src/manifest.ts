import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { instanceConfigSchema } from "./config.js";
import { PLUGIN_ID } from "./namespace.js";
import { SKILLS } from "./skills.js";
import { PAYROLL_TOOLS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Payroll",
  description:
    "South African payroll: employees with sealed ID, tax and bank details, PAYE/UIF/SDL/ETI pay runs with separate approval, payslips by email, leave, EMP201/IRP5/EMP501 packs and net-pay bank files. Posts every locked run to Accounting.",
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
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "http.outbound",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "payroll",
    migrationsDir: "migrations",
  },
  tools: PAYROLL_TOOLS,
  jobs: [
    {
      jobKey: "redeliver",
      displayName: "Redeliver payroll events",
      description: "Re-sends ledger postings and payslip emails that Accounting or the Mailbox has not answered yet.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: "follow-up",
      displayName: "Payroll follow-up",
      description: "Makes payslips that a locked run is still missing and links a pending Payroll Clerk hire.",
      schedule: "*/15 * * * *",
    },
  ],
  skills: SKILLS,
  ui: {
    slots: [
      {
        type: "page",
        id: "payroll-page",
        displayName: "Payroll",
        exportName: "PayrollPage",
        routePath: "payroll",
      },
      {
        type: "sidebar",
        id: "payroll-sidebar",
        displayName: "Payroll",
        exportName: "PayrollSidebar",
        order: 62,
      },
    ],
  },
};

export default manifest;
