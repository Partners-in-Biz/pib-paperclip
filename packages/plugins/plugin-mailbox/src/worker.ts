import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { assertMayDraft, assertMaySend, defaultDelegation, MailboxError, type Delegation } from "./domain.js";
import { MAILBOX_TOOLS } from "./tools.js";

const plugin = definePlugin({
  async setup(ctx) {
    for (const tool of MAILBOX_TOOLS) {
      ctx.tools.register(tool.name, tool, (params, run) => runTool(ctx, tool.name, params, run));
    }
    ctx.actions.register("mailbox.load", (_params, context) => load(ctx, requiredCompany(context)));
    ctx.actions.register("mailbox.create-account", (params, context) => createAccount(ctx, requiredCompany(context), context.actor.userId, params));
    ctx.actions.register("mailbox.create-delegation", (params, context) => createDelegation(ctx, requiredCompany(context), params));
    ctx.actions.register("mailbox.create-draft", (params, context) => createDraft(ctx, requiredCompany(context), context.actor.agentId, params, context.actor.type === "agent"));
    ctx.events.on("company.created", async (event) => {
      if (event.companyId) await safeReconcile(ctx, event.companyId);
    });
    await reconcileAll(ctx);
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
    `SELECT id, account_id, subject, status, direction FROM ${table(ctx, "messages")}
      WHERE company_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [companyId],
  );
  return {
    accounts: accounts.map((row) => ({ ...row, secret_ref: undefined })),
    delegations,
    messages,
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

async function reconcileAll(ctx: PluginContext) {
  try {
    const companies = await ctx.companies.list({ limit: 100 });
    for (const company of companies) await safeReconcile(ctx, company.id);
  } catch (error) {
    ctx.logger.info("Mailbox skill reconcile deferred", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function safeReconcile(ctx: PluginContext, companyId: string) {
  try {
    await ctx.skills.managed.reconcile("mailbox-draft", companyId);
  } catch (error) {
    ctx.logger.info("Mailbox skill reconcile skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
}
