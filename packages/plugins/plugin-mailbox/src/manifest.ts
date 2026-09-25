import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./namespace.js";
import { MAILBOX_DRAFT_SKILL } from "./skills.js";
import { MAILBOX_TOOLS } from "./tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Mailbox",
  description: "Member mailboxes and agent delegations. Sending stays off unless the delegation allows it.",
  author: "Partners in Biz",
  categories: ["connector"],
  capabilities: [
    "companies.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agent.tools.register",
    "skills.managed",
    "events.subscribe",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: { namespaceSlug: "mailbox", migrationsDir: "migrations" },
  tools: MAILBOX_TOOLS,
  skills: [
    {
      skillKey: "mailbox-draft",
      displayName: "Mailbox draft",
      slug: "mailbox-draft",
      description: "Draft on a delegated mailbox. Send only when that delegation allows it.",
      markdown: MAILBOX_DRAFT_SKILL,
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
