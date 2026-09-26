import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { assertMayDraft, assertMayRead, assertMaySend, createEmailTemplate, defaultDelegation, MailboxError, type Delegation } from "./domain.js";
import { MAILBOX_TOOLS } from "./tools.js";
import { SKILLS } from "./skills.js";
import { createSkillSyncer } from "@partnersinbiz/pib-plugin-kit";

let skillSync: ReturnType<typeof createSkillSyncer> | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    skillSync = createSkillSyncer(ctx, SKILLS);
    for (const tool of MAILBOX_TOOLS) {
      ctx.tools.register(tool.name, tool, (params, run) => {
        void skillSync?.ensure(run.companyId);
        return runTool(ctx, tool.name, params, run);
      });
    }
    ctx.actions.register("mailbox.load", (_params, context) => {
      const companyId = requiredCompany(context);
      void skillSync?.ensure(companyId);
      return load(ctx, companyId);
    });
    ctx.actions.register("mailbox.sync-skills", async (_params, context) => ({ results: await skillSync?.force(requiredCompany(context)) }));
    ctx.actions.register("mailbox.create-account", (params, context) => createAccount(ctx, requiredCompany(context), context.actor.userId, params));
    ctx.actions.register("mailbox.create-delegation", (params, context) => createDelegation(ctx, requiredCompany(context), params));
    ctx.actions.register("mailbox.create-draft", (params, context) => createDraft(ctx, requiredCompany(context), context.actor.agentId, params, context.actor.type === "agent"));
    ctx.actions.register("mailbox.list-inbox", (params, context) => listInbox(ctx, requiredCompany(context), params));
    ctx.actions.register("mailbox.mark-read", (params, context) => markRead(ctx, requiredCompany(context), params));
    ctx.actions.register("mailbox.create-email-template", (params, context) => createEmailTemplateAction(ctx, requiredCompany(context), params));
    ctx.actions.register("mailbox.list-email-templates", (_params, context) => listEmailTemplates(ctx, requiredCompany(context)));
    ctx.actions.register("mailbox.list-threads", (params, context) => listThreads(ctx, requiredCompany(context), params));
    ctx.events.on("company.created", async (event) => {
      if (event.companyId) await skillSync?.ensure(event.companyId);
    });
  },
  async onHealth() {
    return { status: "ok", message: "Mailbox plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

async function runTool(ctx: PluginContext, name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    const body = objectParams(params);
    if (name === "create-draft") {
      return { content: "Draft created", data: await createDraft(ctx, run.companyId, run.agentId, body, true) };
    }
    if (name === "send-draft") {
      return { content: "Draft queued", data: await sendDraft(ctx, run.companyId, run.agentId, requiredString(body, "messageId")) };
    }
    if (name === "list-inbox") {
      assertMayRead(await delegationFor(ctx, requiredString(body, "accountId"), run.agentId));
      return { content: "Inbox listed", data: await listInbox(ctx, run.companyId, body) };
    }
    if (name === "mark-read") {
      const accountId = await messageAccount(ctx, run.companyId, requiredString(body, "messageId"));
      assertMayRead(accountId ? await delegationFor(ctx, accountId, run.agentId) : null);
      return { content: "Message marked read", data: await markRead(ctx, run.companyId, body) };
    }
    if (name === "create-email-template") return { content: "Email template created", data: await createEmailTemplateAction(ctx, run.companyId, body) };
    if (name === "list-email-templates") return { content: "Email templates listed", data: await listEmailTemplates(ctx, run.companyId) };
    if (name === "list-threads") {
      const accountId = optionalString(body, "accountId");
      if (accountId) {
        assertMayRead(await delegationFor(ctx, accountId, run.agentId));
        return { content: "Threads listed", data: await listThreads(ctx, run.companyId, body) };
      }
      const readable = await readableAccounts(ctx, run.companyId, run.agentId);
      const threads = [];
      for (const id of readable) threads.push(...(await listThreads(ctx, run.companyId, { ...body, accountId: id })));
      return { content: "Threads listed", data: threads };
    }
    return { error: "Unknown mailbox tool" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Mailbox tool failed" };
  }
}

async function load(ctx: PluginContext, companyId: string) {
  const accounts = await ctx.db.query(
    `SELECT id, provider, address, owner_user_id, secret_ref IS NOT NULL AS has_credential
       FROM ${table(ctx, "accounts")} WHERE company_id = $1 ORDER BY address`,
    [companyId],
  );
  const delegations = await ctx.db.query(
    `SELECT id, account_id, agent_id, can_read, can_draft, can_send
       FROM ${table(ctx, "delegations")} WHERE company_id = $1`,
    [companyId],
  );
  const messages = await ctx.db.query(
    `SELECT id, account_id, subject, status, direction, read_at IS NOT NULL AS is_read FROM ${table(ctx, "messages")}
      WHERE company_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [companyId],
  );
  const templates = await ctx.db.query(
    `SELECT id, name, subject, body FROM ${table(ctx, "email_templates")} WHERE company_id = $1 ORDER BY name`,
    [companyId],
  );
  const unread = await ctx.db.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM ${table(ctx, "messages")} WHERE company_id = $1 AND direction = 'inbound' AND read_at IS NULL`,
    [companyId],
  );
  return {
    accounts: accounts.map((row) => ({ ...row, secret_ref: undefined })),
    delegations,
    messages,
    templates,
    unreadCount: Number(unread[0]?.count ?? 0),
  };
}

async function createAccount(ctx: PluginContext, companyId: string, ownerUserId: string | null, params: Record<string, unknown>) {
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "accounts")} (id, company_id, provider, address, secret_ref, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, companyId, requiredString(params, "provider"), requiredString(params, "address"), optionalString(params, "secretRef") ?? null, ownerUserId],
  );
  return { id };
}

async function createDelegation(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const defaults = defaultDelegation();
  const canSend = params.canSend === true;
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "delegations")}
      (id, company_id, account_id, agent_id, can_read, can_draft, can_send)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, companyId, requiredString(params, "accountId"), requiredString(params, "agentId"), defaults.canRead, defaults.canDraft, canSend],
  );
  return { id, canSend };
}

async function createDraft(
  ctx: PluginContext,
  companyId: string,
  agentId: string | null,
  params: Record<string, unknown>,
  enforceDelegation: boolean,
) {
  const accountId = requiredString(params, "accountId");
  if (enforceDelegation) {
    if (!agentId) throw new MailboxError("This agent is not allowed to draft on that mailbox");
    assertMayDraft(await delegationFor(ctx, accountId, agentId));
  }
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "messages")} (id, company_id, account_id, subject, body, direction, status)
     VALUES ($1, $2, $3, $4, $5, 'outbound', 'draft')`,
    [id, companyId, accountId, requiredString(params, "subject"), optionalString(params, "body") ?? ""],
  );
  return { id, status: "draft" };
}

async function sendDraft(ctx: PluginContext, companyId: string, agentId: string, messageId: string) {
  const rows = await ctx.db.query<{ id: string; account_id: string; status: string }>(
    `SELECT id, account_id, status FROM ${table(ctx, "messages")} WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [messageId, companyId],
  );
  const message = rows[0];
  if (!message) throw new MailboxError("Draft was not found");
  if (message.status !== "draft") throw new MailboxError("Only a draft can be sent");
  assertMaySend(await delegationFor(ctx, message.account_id, agentId));
  await ctx.db.execute(
    `UPDATE ${table(ctx, "messages")} SET status = 'queued' WHERE id = $1`,
    [message.id],
  );
  return { id: message.id, status: "queued" };
}

async function listInbox(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const accountId = requiredString(params, "accountId");
  const limit = params.limit == null ? 50 : integer(params.limit, "limit");
  const rows = await ctx.db.query(
    `SELECT id, account_id, subject, body, status, read_at IS NOT NULL AS is_read, created_at
       FROM ${table(ctx, "messages")}
      WHERE company_id = $1 AND account_id = $2 AND direction = 'inbound'
      ORDER BY created_at DESC LIMIT $3`,
    [companyId, accountId, limit],
  );
  return rows;
}

async function markRead(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const messageId = requiredString(params, "messageId");
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "messages")} SET read_at = now() WHERE id = $1 AND company_id = $2 AND direction = 'inbound'`,
    [messageId, companyId],
  );
  return { messageId, read: true };
}

async function createEmailTemplateAction(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const template = createEmailTemplate({
    companyId,
    name: requiredString(params, "name"),
    subject: requiredString(params, "subject"),
    body: optionalString(params, "body"),
  });
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "email_templates")} (id, company_id, name, subject, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [template.id, template.companyId, template.name, template.subject, template.body],
  );
  return template;
}

async function listThreads(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const accountId = optionalString(params, "accountId");
  const limit = params.limit == null ? 50 : integer(params.limit, "limit");
  const rows = accountId
    ? await ctx.db.query(
        `SELECT id, account_id, subject, status, direction, read_at IS NOT NULL AS is_read, created_at
           FROM ${table(ctx, "messages")} WHERE company_id = $1 AND account_id = $2 ORDER BY created_at DESC LIMIT $3`,
        [companyId, accountId, limit],
      )
    : await ctx.db.query(
        `SELECT id, account_id, subject, status, direction, read_at IS NOT NULL AS is_read, created_at
           FROM ${table(ctx, "messages")} WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [companyId, limit],
      );
  const threads = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const subject = String(row.subject ?? "No subject").replace(/^(re|fw):\s*/i, "");
    const list = threads.get(subject) ?? [];
    list.push(row);
    threads.set(subject, list);
  }
  return [...threads.entries()].map(([subject, items]) => ({ subject, count: items.length, messages: items }));
}

async function listEmailTemplates(ctx: PluginContext, companyId: string) {
  return ctx.db.query(
    `SELECT id, name, subject, body FROM ${table(ctx, "email_templates")} WHERE company_id = $1 ORDER BY name`,
    [companyId],
  );
}

async function messageAccount(ctx: PluginContext, companyId: string, messageId: string): Promise<string | null> {
  const rows = await ctx.db.query<{ account_id: string }>(
    `SELECT account_id FROM ${table(ctx, "messages")} WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [messageId, companyId],
  );
  return rows[0]?.account_id ?? null;
}

async function readableAccounts(ctx: PluginContext, companyId: string, agentId: string): Promise<string[]> {
  const rows = await ctx.db.query<{ account_id: string }>(
    `SELECT account_id FROM ${table(ctx, "delegations")} WHERE company_id = $1 AND agent_id = $2 AND can_read = true`,
    [companyId, agentId],
  );
  return rows.map((row) => row.account_id);
}

async function delegationFor(ctx: PluginContext, accountId: string, agentId: string): Promise<Delegation | null> {
  const rows = await ctx.db.query<{ can_read: boolean; can_draft: boolean; can_send: boolean }>(
    `SELECT can_read, can_draft, can_send FROM ${table(ctx, "delegations")}
      WHERE account_id = $1 AND agent_id = $2 LIMIT 1`,
    [accountId, agentId],
  );
  const row = rows[0];
  if (!row) return null;
  return { canRead: row.can_read, canDraft: row.can_draft, canSend: row.can_send };
}

function table(ctx: PluginContext, name: string): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace) || !/^[a-z_]+$/.test(name)) throw new MailboxError("Unsafe identifier");
  return `${ctx.db.namespace}.${name}`;
}

function requiredCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new MailboxError("Company is required");
  return context.companyId;
}

function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MailboxError("Parameters must be an object");
  return value as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new MailboxError(`${key} is required`);
  return value.trim();
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new MailboxError(`${key} must be a string`);
  return value.trim();
}

function integer(value: unknown, key: string): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(amount) || amount < 1) throw new MailboxError(`${key} must be a positive integer`);
  return amount;
}

