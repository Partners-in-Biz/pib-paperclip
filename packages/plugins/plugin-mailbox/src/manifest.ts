import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID } from "./namespace.js";
import { SKILLS } from "./skills.js";
import { MAILBOX_TOOLS } from "./tools.js";

const instanceConfigSchema: JsonSchema = {
  type: "object",
  title: "Mailbox settings",
  description: "Save once for each Paperclip company that uses delegated mailboxes.",
  properties: {
    defaultDelegation: {
      type: "string",
      title: "Default delegation for new agents",
      enum: ["read-draft", "draft-only"],
      default: "read-draft",
    },
  },
};

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Mailbox",
  description: "Member mailboxes and agent delegations. Sending stays off unless the delegation allows it.",
  author: "Partners in Biz",
  categories: ["connector"],
  instanceConfigSchema,
  capabilities: [
    "companies.read",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "agent.tools.register",
    "skills.managed",
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  database: { namespaceSlug: "mailbox", migrationsDir: "migrations" },
  tools: MAILBOX_TOOLS,
  skills: SKILLS,
  ui: {
    slots: [
      { type: "page", id: "mailbox-page", displayName: "Mailbox", exportName: "MailboxPage", routePath: "mailbox" },
      { type: "sidebar", id: "mailbox-sidebar", displayName: "Mailbox", exportName: "MailboxSidebar", order: 43 },
    ],
  },
};

export default manifest;
