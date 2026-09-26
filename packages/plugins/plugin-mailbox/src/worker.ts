import { normalizeToolResult } from "@partnersinbiz/pib-plugin-kit";
import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  COCKPIT_ROUTE,
  createSkillSyncer,
  decisionStats,
  registerModuleWatch,
  registerRoleWatch,
  trackJob,
  SETUP_STATUS_ROUTE,
  MAIL_CATEGORIES,
  MAIL_EVENTS,
  MAIL_SENDERS,
  pluginEvent,
  pluginUiBase,
  registerCrmProjection,
  rememberPluginUiBase,
  valueAtPath,
  type MailAddress,
  type MailSendRequested,
} from "@partnersinbiz/pib-plugin-kit";
import { gmailRedirectUri, loadMailboxConfig, validateMailboxConfig } from "./config.js";
import { SETUP_STATUS_JOB_KEY, SYNC_JOB_KEY } from "./constants.js";
import { publishAllSetupStatus, rememberCompany, setupStatus } from "./setup-status.js";
import { cockpitSnapshot, publishAllCockpit } from "./cockpit.js";
import { SqlStore } from "./db.js";
import { assertMayDraft, assertMayRead, assertMaySend, createEmailTemplate, defaultDelegation, MailboxError, type Delegation } from "./domain.js";
import { createEnv, errorMessage, type Env } from "./gmail/env.js";
import { toMailAddress } from "./gmail/headers.js";
import { connectStart, disconnect, oauthComplete } from "./gmail/oauth.js";
import { correctTriage, markReadInGmail, readMessageBody, searchMail, type TriageCorrection } from "./gmail/read.js";
import { handleSendRequested, performSend, retrySend } from "./gmail/send.js";
import { runSyncJob, syncOne, triageRunFor } from "./gmail/sync.js";
import type { AccountRow, MessageRow, SendRow } from "./gmail/types.js";
import { PLUGIN_ID } from "./namespace.js";
import { SKILLS } from "./skills.js";
import { MAILBOX_TOOLS } from "./tools.js";

let skillSync: ReturnType<typeof createSkillSyncer> | null = null;
let env: Env | null = null;
let store: SqlStore | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    store = new SqlStore(ctx.db);
    env = createEnv(ctx, store);
    skillSync = createSkillSyncer(ctx, SKILLS);
    registerCrmProjection(ctx, ctx.db.namespace);
    registerModuleWatch(ctx);
    registerRoleWatch(ctx);

    for (const tool of MAILBOX_TOOLS) {
      ctx.tools.register(tool.name, tool, (params, run) => {
        void skillSync?.ensure(run.companyId);
        return runTool(ctx, tool.name, params, run).then(normalizeToolResult);
      });
    }

    const user = (key: string, fn: (companyId: string, userId: string, params: Record<string, unknown>) => Promise<unknown>) =>
      ctx.actions.register(key, (params, context) => fn(requiredCompany(context), requiredUser(context), params));

    ctx.actions.register("mailbox.load", async (params, context) => {
      const companyId = requiredCompany(context);
      void skillSync?.ensure(companyId);
      await rememberCompany(ctx, companyId);
      return load(ctx, companyId, params);
    });
    ctx.actions.register("mailbox.sync-skills", async (_params, context) => ({ results: await skillSync?.force(requiredCompany(context)) }));
    ctx.actions.register("mailbox.create-account", (params, context) => createAccount(requiredCompany(context), context.actor.userId, params));
    ctx.actions.register("mailbox.create-delegation", (params, context) => createDelegation(requiredCompany(context), params));
    ctx.actions.register("mailbox.create-draft", (params, context) =>
      createDraft(requiredCompany(context), context.actor.agentId, params, context.actor.type === "agent"),
    );
    ctx.actions.register("mailbox.list-inbox", (params, context) => listInbox(requiredCompany(context), params));
    ctx.actions.register("mailbox.mark-read", (params, context) => markRead(requiredCompany(context), params));
    ctx.actions.register("mailbox.create-email-template", (params, context) => createEmailTemplateAction(requiredCompany(context), params));
    ctx.actions.register("mailbox.list-email-templates", (_params, context) => requireStore().listTemplates(requiredCompany(context)));
    ctx.actions.register("mailbox.list-threads", (params, context) => listThreads(requiredCompany(context), params));

    user("mailbox.connect-start", (companyId, userId, params) => connectStart(requireEnv(), companyId, userId, params));
    user("mailbox.disconnect", (companyId, _userId, params) => disconnect(requireEnv(), companyId, requiredString(params, "accountId")));
    user("mailbox.set-default", async (companyId, _userId, params) => {
      const account = await requireStore().getAccount(companyId, requiredString(params, "accountId"));
      if (!account || account.status !== "connected") throw new MailboxError("Only a connected Gmail account can be the default");
      await requireStore().setDefaultAccount(companyId, account.id);
      return { id: account.id, isDefault: true };
    });
    user("mailbox.sync-now", (companyId, _userId, params) => syncNow(companyId, optionalString(params, "accountId")));
    user("mailbox.inbox", (companyId, _userId, params) => inboxView(companyId, params));
    user("mailbox.sent", (companyId, _userId, params) => sentView(companyId, params));
    user("mailbox.retry-send", (companyId, _userId, params) => retrySend(requireEnv(), companyId, requiredString(params, "key")));
    user("mailbox.correct-triage", (companyId, userId, params) => correctTriageFor(companyId, requiredString(params, "messageId"), params, userId, null));
    user("mailbox.triage-stats", (companyId, _userId, params) => triageStats(ctx, companyId, params));
    user("mailbox.send-draft", (companyId, _userId, params) => sendDraft(companyId, null, requiredString(params, "messageId")));
    user("mailbox.get-message", (companyId, _userId, params) => getMessage(companyId, requiredString(params, "messageId"), params, null));

    ctx.jobs.register(SYNC_JOB_KEY, async () => {
      await trackJob(ctx, SYNC_JOB_KEY, async () => {
        const result = await runSyncJob(requireEnv());
        if (result.accounts > 0) ctx.logger.info("Gmail sync finished", result);
      });
    });
    ctx.jobs.register(SETUP_STATUS_JOB_KEY, async () => {
      await trackJob(ctx, SETUP_STATUS_JOB_KEY, async () => {
        await publishAllSetupStatus(ctx, requireStore());
        await publishAllCockpit(ctx);
      });
    });

    for (const sender of MAIL_SENDERS) {
      ctx.events.on(pluginEvent(sender, MAIL_EVENTS.sendRequested), async (event) => {
        await handleSendRequested(requireEnv(), event);
      });
    }
    ctx.events.on("company.created", async (event) => {
      if (event.companyId) await skillSync?.ensure(event.companyId);
    });
  },

  async onHealth() {
    return { status: "ok", message: "Mailbox plugin ready" };
  },

  async onValidateConfig(config) {
    return validateMailboxConfig(config);
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (!env) return { status: 503, body: { error: "Mailbox plugin is not ready" } };
    try {
      if (input.routeKey === "oauth-complete") return await oauthComplete(env, input);
      if (input.routeKey === SETUP_STATUS_ROUTE.routeKey) return { status: 200, body: await setupStatus(env.ctx, input.companyId, env.store) };
      if (input.routeKey === COCKPIT_ROUTE.routeKey) return { status: 200, body: await cockpitSnapshot(env.ctx, input.companyId) };
      return { status: 404, body: { error: "Unknown route" } };
    } catch (error) {
      return { status: error instanceof MailboxError ? 400 : 500, body: { error: errorMessage(error) } };
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

function requireEnv(): Env {
  if (!env) throw new MailboxError("Mailbox plugin is not ready");
  return env;
}

function requireStore(): SqlStore {
  if (!store) throw new MailboxError("Mailbox plugin is not ready");
  return store;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

async function runTool(ctx: PluginContext, name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    const body = objectParams(params);
    if (name === "create-draft") {
      return { content: "Draft created", data: await createDraft(run.companyId, run.agentId, body, true) };
    }
    if (name === "send-draft") {
      const result = await sendDraft(run.companyId, run.agentId, requiredString(body, "messageId"));
      return { content: result.status === "sent" ? "Draft sent through Gmail" : "Draft queued for a person to send", data: result };
    }
    if (name === "list-inbox") {
      assertMayRead(await delegationFor(requiredString(body, "accountId"), run.agentId));
      return { content: "Inbox listed", data: await listInbox(run.companyId, body) };
    }
    if (name === "mark-read") {
      const row = await findMessage(run.companyId, requiredString(body, "messageId"));
      assertMayRead(row ? await delegationFor(row.account_id, run.agentId) : null);
      return { content: "Message marked read", data: await markRead(run.companyId, { messageId: row!.id }) };
    }
    if (name === "create-email-template") return { content: "Email template created", data: await createEmailTemplateAction(run.companyId, body) };
    if (name === "list-email-templates") return { content: "Email templates listed", data: await requireStore().listTemplates(run.companyId) };
    if (name === "list-threads") {
      const accountId = optionalString(body, "accountId");
      if (accountId) {
        assertMayRead(await delegationFor(accountId, run.agentId));
        return { content: "Threads listed", data: await listThreads(run.companyId, body) };
      }
      const readable = await requireStore().readableAccounts(run.companyId, run.agentId);
      const threads = [];
      for (const id of readable) threads.push(...(await listThreads(run.companyId, { ...body, accountId: id })));
      return { content: "Threads listed", data: threads };
    }
    if (name === "search-mail") {
      const account = await readableGmailAccount(run.companyId, run.agentId, optionalString(body, "accountId"));
      const loaded = await loadMailboxConfig(ctx, run.companyId);
      const data = await searchMail(requireEnv(), loaded, account, requiredString(body, "query"), body.limit == null ? 10 : integer(body.limit, "limit"));
      return { content: `${data.count} message(s) found`, data };
    }
    if (name === "get-message") {
      const data = await getMessage(run.companyId, requiredString(body, "messageId"), body, run.agentId);
      return { content: data.truncated ? "Message read (truncated)" : "Message read", data };
    }
    if (name === "correct-triage") {
      const data = await correctTriageFor(run.companyId, requiredString(body, "messageId"), body, null, run.agentId);
      return { content: "Triage corrected", data };
    }
    if (name === "mail-status") {
      const row = await requireStore().getSend(run.companyId, requiredString(body, "key"));
      if (!row) return { content: "No send request with that key", data: { key: body.key, status: "unknown" } };
      return { content: `Send ${row.status}`, data: sendView(row) };
    }
    return { error: "Unknown mailbox tool" };
  } catch (error) {
    return { error: errorMessage(error) || "Mailbox tool failed" };
  }
}

// ---------------------------------------------------------------------------
// Page data
// ---------------------------------------------------------------------------

function configured(raw: Record<string, unknown>, path: string): boolean {
  const value = valueAtPath(raw, path);
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value && typeof value === "object");
}

function accountView(account: AccountRow) {
  return {
    id: account.id,
    provider: account.provider,
    address: account.address,
    owner_user_id: account.owner_user_id,
    status: account.status,
    connected: account.status === "connected",
    is_default: account.is_default,
    has_credential: Boolean(account.token_sealed),
    last_sync_at: account.last_sync_at,
    last_error: account.last_error,
    sync_stats: account.sync_stats,
    connected_at: account.connected_at,
  };
}

async function load(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const s = requireStore();
  const uiBase = (await rememberPluginUiBase(ctx, params.uiBase)) ?? (await pluginUiBase(ctx));
  const loaded = await loadMailboxConfig(ctx, companyId);
  const base = loaded.config.publicBaseUrl;
  let redirectUri: string | null = null;
  try {
    redirectUri = base && uiBase ? gmailRedirectUri(base, uiBase) : null;
  } catch {
    redirectUri = null;
  }
  const [accounts, delegations, messages, templates, unreadCount, sendCounts, categoryCounts] = await Promise.all([
    s.listAccounts(companyId),
    s.listDelegations(companyId),
    s.recentMessages(companyId, 50),
    s.listTemplates(companyId),
    s.unreadCount(companyId),
    s.sendCounts(companyId),
    s.categoryCounts(companyId),
  ]);
  const raw = loaded.raw;
  return {
    settings: {
      saved: loaded.config.saved,
      publicBaseUrl: base,
      redirectUri,
      encryptionKey: configured(raw, "encryptionKey"),
      googleClientId: Boolean(loaded.config.googleClientId),
      googleClientSecret: configured(raw, "google.clientSecret"),
      jev: configured(raw, "jev.apiKey") && (raw.jev as { enabled?: boolean } | undefined)?.enabled !== false,
      labelPrefix: loaded.config.labelPrefix,
      sendRatePerMinute: loaded.config.sendRatePerMinute,
      triageIssues: Boolean(loaded.config.triageAssignee),
    },
    accounts: accounts.map(accountView),
    delegations,
    messages,
    templates,
    unreadCount,
    sendCounts: Object.fromEntries(sendCounts.map((row) => [row.status, Number(row.n)])),
    categoryCounts: Object.fromEntries(categoryCounts.map((row) => [row.category ?? "untriaged", Number(row.n)])),
    categories: MAIL_CATEGORIES,
  };
}

function messageView(row: MessageRow) {
  return {
    id: row.id,
    account_id: row.account_id,
    subject: row.subject,
    body: row.body,
    status: row.status,
    is_read: Boolean(row.read_at),
    created_at: row.created_at,
    received_at: row.received_at,
    gmail_message_id: row.gmail_message_id,
    gmail_thread_id: row.gmail_thread_id,
    from: row.from_addr,
    to: row.to_addrs,
    snippet: row.snippet,
    attachments: (row.attachments ?? []).map((a) => ({ filename: a.filename, mime: a.mime, bytes: a.bytes })),
    category: row.category,
    urgency: row.urgency == null ? null : Number(row.urgency),
    needs_reply: row.needs_reply == null ? null : Number(row.needs_reply),
    phishing: row.phishing == null ? null : Number(row.phishing),
    client_kind: row.client_kind,
    client_ref: row.client_ref,
    client_name: row.triage?.clientName ?? null,
    triage_source: row.triage?.source ?? null,
    reply_to: row.reply_to,
  };
}

async function inboxView(companyId: string, params: Record<string, unknown>) {
  const s = requireStore();
  const category = optionalString(params, "category");
  const rows = await s.listInbox(companyId, {
    accountId: optionalString(params, "accountId") ?? null,
    category: category && (MAIL_CATEGORIES as readonly string[]).includes(category) ? category : null,
    needsReply: params.needsReply === true,
    limit: params.limit == null ? 100 : integer(params.limit, "limit"),
  });
  const clients = await s.crmClients(companyId, 500);
  return {
    messages: rows.map(messageView),
    clients: clients.map((c) => ({ ref: `${c.kind}:${c.id}`, name: c.name, kind: c.kind })),
  };
}

function sendView(row: SendRow) {
  return {
    key: row.key,
    status: row.status,
    permanent: row.permanent,
    attempts: row.attempts,
    error: row.error,
    sourcePlugin: row.source_plugin,
    context: row.context,
    from: row.from_address,
    to: (row.to_addrs ?? []).map((a) => a.email),
    subject: row.subject,
    gmailMessageId: row.gmail_message_id,
    threadId: row.gmail_thread_id,
    sentAt: row.sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function sentView(companyId: string, params: Record<string, unknown>) {
  const status = optionalString(params, "status");
  const rows = await requireStore().listSends(companyId, {
    status: status === "sent" || status === "failed" || status === "retrying" || status === "sending" ? status : null,
    limit: params.limit == null ? 100 : integer(params.limit, "limit"),
  });
  return { requests: rows.map(sendView) };
}

async function triageStats(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const days = params.days == null ? 30 : integer(params.days, "days");
  const rows = await decisionStats(ctx, companyId, days);
  return {
    days,
    questions: rows
      .filter((row) => row.purpose === "mail-triage")
      .map((row) => {
        const total = Number(row.total);
        const corrected = Number(row.corrected);
        return { question: row.question_key, total, corrected, accuracy: total > 0 ? Math.round(((total - corrected) / total) * 1000) / 1000 : null, avgConfidence: Number(row.avg_confidence) };
      }),
    categories: Object.fromEntries((await requireStore().categoryCounts(companyId)).map((row) => [row.category ?? "untriaged", Number(row.n)])),
  };
}

async function syncNow(companyId: string, accountId: string | undefined) {
  const e = requireEnv();
  const s = requireStore();
  const accounts = accountId
    ? [await s.getAccount(companyId, accountId)].filter((a): a is AccountRow => Boolean(a))
    : (await s.listAccounts(companyId)).filter((a) => a.status === "connected");
  if (accounts.length === 0) throw new MailboxError("No connected Gmail account to sync");
  const loaded = await loadMailboxConfig(e.ctx, companyId);
  // Kept small so the action returns quickly; the 2-minute job does the rest.
  const run = await triageRunFor(e, loaded, { maxNew: 50, triageLimit: 30 });
  const results = [];
  for (const account of accounts) {
    const ok = await syncOne(e, loaded, account, run);
    const fresh = await s.getAccount(companyId, account.id);
    results.push({ id: account.id, address: account.address, ok, status: fresh?.status, stats: fresh?.sync_stats, error: ok ? null : fresh?.last_error });
  }
  return { results };
}

// ---------------------------------------------------------------------------
// Accounts, delegations, drafts
// ---------------------------------------------------------------------------

async function createAccount(companyId: string, ownerUserId: string | null, params: Record<string, unknown>) {
  const id = randomUUID();
  await requireStore().insertLegacyAccount({
    id,
    companyId,
    provider: requiredString(params, "provider"),
    address: requiredString(params, "address"),
    secretRef: optionalString(params, "secretRef") ?? null,
    ownerUserId,
  });
  return { id };
}

async function createDelegation(companyId: string, params: Record<string, unknown>) {
  const defaults = defaultDelegation();
  const canSend = params.canSend === true;
  const id = randomUUID();
  await requireStore().insertDelegation({
    id,
    companyId,
    accountId: requiredString(params, "accountId"),
    agentId: requiredString(params, "agentId"),
    canRead: defaults.canRead,
    canDraft: defaults.canDraft,
    canSend,
  });
  return { id, canSend };
}

function addresses(params: Record<string, unknown>, key: string): MailAddress[] {
  const value = params[key];
  if (value == null || value === "") return [];
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;]\s*/) : [value];
  const out: MailAddress[] = [];
  for (const item of list) {
    if (typeof item === "string" && !item.trim()) continue;
    const address = toMailAddress(item);
    if (!address) throw new MailboxError(`Invalid ${key} address: ${String(item).slice(0, 120)}`);
    out.push(address);
  }
  return out;
}

async function createDraft(companyId: string, agentId: string | null, params: Record<string, unknown>, enforceDelegation: boolean) {
  const accountId = requiredString(params, "accountId");
  if (enforceDelegation) {
    if (!agentId) throw new MailboxError("This agent is not allowed to draft on that mailbox");
    assertMayDraft(await delegationFor(accountId, agentId));
  }
  const to = addresses(params, "to");
  const cc = addresses(params, "cc");
  const bcc = addresses(params, "bcc");
  const replyToMessageId = optionalString(params, "replyToMessageId") ?? null;
  let threadId: string | null = null;
  if (replyToMessageId) {
    const original = await findMessage(companyId, replyToMessageId);
    threadId = original?.gmail_thread_id ?? null;
  }
  const id = randomUUID();
  await requireStore().insertDraft({
    id,
    companyId,
    accountId,
    subject: requiredString(params, "subject"),
    body: optionalString(params, "body") ?? "",
    to,
    cc,
    bcc,
    draft: { html: optionalString(params, "html") ?? null, replyToMessageId, threadId },
  });
  return { id, status: "draft", to: to.map((a) => a.email) };
}

async function sendDraft(companyId: string, agentId: string | null, messageId: string) {
  const s = requireStore();
  const row = await s.getMessage(companyId, messageId);
  if (!row) throw new MailboxError("Draft was not found");
  if (row.status !== "draft") throw new MailboxError("Only a draft can be sent");
  if (agentId) assertMaySend(await delegationFor(row.account_id, agentId));
  const account = await s.getAccount(companyId, row.account_id);
  const gmailReady = Boolean(account?.token_sealed) && (account?.status === "connected" || account?.status === "needs_reconnect");
  if (!gmailReady) {
    await s.setDraftStatus(companyId, row.id, "queued", null);
    return { id: row.id, status: "queued" as const, note: "Gmail is not connected for this mailbox, so a person must send it." };
  }
  const to = row.to_addrs ?? [];
  const cc = row.cc_addrs ?? [];
  const bcc = row.bcc_addrs ?? [];
  if (to.length + cc.length + bcc.length === 0) throw new MailboxError("This draft has no recipients. Create it again with `to`.");
  const request: MailSendRequested = {
    key: `draft:${row.id}`,
    from: account!.address,
    to,
    cc,
    bcc,
    subject: row.subject,
    text: row.body || null,
    html: row.draft?.html ?? null,
    threadId: row.draft?.threadId ?? null,
    inReplyToMessageId: row.draft?.replyToMessageId ?? null,
    attachments: [],
    context: { plugin: PLUGIN_ID, kind: "draft", id: row.id },
  };
  if (!request.text && !request.html) throw new MailboxError("This draft has no body");
  await s.setDraftStatus(companyId, row.id, "queued", null);
  let result;
  try {
    result = await performSend(requireEnv(), companyId, request, { sourcePlugin: PLUGIN_ID, force: true, draftRowId: row.id });
  } catch (error) {
    await s.setDraftStatus(companyId, row.id, "draft", errorMessage(error));
    throw new MailboxError(`Not sent yet: ${errorMessage(error)}`);
  }
  if (result.status !== "sent") {
    await s.setDraftStatus(companyId, row.id, "draft", result.error ?? "Send failed");
    throw new MailboxError(`Not sent: ${result.error ?? "Send failed"}`);
  }
  return { id: row.id, status: "sent" as const, gmailMessageId: result.messageId, threadId: result.threadId, sentAt: result.sentAt };
}

async function findMessage(companyId: string, id: string): Promise<MessageRow | null> {
  const s = requireStore();
  return (await s.getMessage(companyId, id)) ?? (await s.getMessageByGmailId(companyId, id));
}

async function listInbox(companyId: string, params: Record<string, unknown>) {
  const accountId = requiredString(params, "accountId");
  const limit = params.limit == null ? 50 : integer(params.limit, "limit");
  const category = optionalString(params, "category");
  const rows = await requireStore().listInbox(companyId, {
    accountId,
    category: category ?? null,
    needsReply: params.needsReply === true,
    limit,
  });
  return rows.map(messageView);
}

async function markRead(companyId: string, params: Record<string, unknown>) {
  const messageId = requiredString(params, "messageId");
  const s = requireStore();
  await s.markRead(companyId, messageId);
  const row = await s.getMessage(companyId, messageId);
  let gmail = false;
  if (row?.gmail_message_id) gmail = await markReadInGmail(requireEnv(), await loadMailboxConfig(requireEnv().ctx, companyId), row);
  return { messageId, read: true, gmail };
}

async function createEmailTemplateAction(companyId: string, params: Record<string, unknown>) {
  const template = createEmailTemplate({
    companyId,
    name: requiredString(params, "name"),
    subject: requiredString(params, "subject"),
    body: optionalString(params, "body"),
  });
  await requireStore().insertTemplate(template);
  return template;
}

async function listThreads(companyId: string, params: Record<string, unknown>) {
  const accountId = optionalString(params, "accountId") ?? null;
  const limit = params.limit == null ? 50 : integer(params.limit, "limit");
  const rows = await requireStore().threadRows(companyId, accountId, limit);
  const threads = new Map<string, { threadId: string | null; subject: string; items: Array<Record<string, unknown>> }>();
  for (const row of rows) {
    const subject = String(row.subject ?? "No subject").replace(/^((re|fw|fwd):\s*)+/i, "");
    const threadId = typeof row.gmail_thread_id === "string" ? row.gmail_thread_id : null;
    const key = threadId ? `t:${threadId}` : `s:${subject}`;
    const entry = threads.get(key) ?? { threadId, subject, items: [] };
    entry.items.push(row);
    threads.set(key, entry);
  }
  return [...threads.values()].map((entry) => ({ subject: entry.subject, threadId: entry.threadId, count: entry.items.length, messages: entry.items }));
}

async function readableGmailAccount(companyId: string, agentId: string, accountId: string | undefined): Promise<AccountRow> {
  const s = requireStore();
  if (accountId) {
    assertMayRead(await delegationFor(accountId, agentId));
    const account = await s.getAccount(companyId, accountId);
    if (!account || account.status === "manual" || !account.token_sealed) throw new MailboxError("That mailbox has no connected Gmail account");
    return account;
  }
  for (const id of await s.readableAccounts(companyId, agentId)) {
    const account = await s.getAccount(companyId, id);
    if (account?.token_sealed && account.status === "connected") return account;
  }
  throw new MailboxError("This agent has no read delegation on a connected Gmail mailbox");
}

async function getMessage(companyId: string, messageId: string, params: Record<string, unknown>, agentId: string | null) {
  const row = await findMessage(companyId, messageId);
  if (!row) throw new MailboxError("Message not found");
  if (agentId) assertMayRead(await delegationFor(row.account_id, agentId));
  const account = await requireStore().getAccount(companyId, row.account_id);
  const base = { messageId: row.id, accountId: row.account_id, attachments: (row.attachments ?? []).map((a) => ({ filename: a.filename, mime: a.mime, bytes: a.bytes })) };
  if (!row.gmail_message_id || !account) {
    return { ...base, subject: row.subject, text: row.body, truncated: false, from: row.from_addr, to: row.to_addrs, date: row.received_at ?? row.created_at };
  }
  const e = requireEnv();
  const maxChars = params.maxChars == null ? 8000 : integer(params.maxChars, "maxChars");
  const body = await readMessageBody(e, await loadMailboxConfig(e.ctx, companyId), account, row.gmail_message_id, maxChars);
  return { ...base, ...body, triage: messageView(row) };
}

async function correctTriageFor(companyId: string, messageId: string, params: Record<string, unknown>, userId: string | null, agentId: string | null) {
  const row = await findMessage(companyId, messageId);
  if (!row) throw new MailboxError("Message not found");
  if (row.direction !== "inbound") throw new MailboxError("Only inbound mail has a triage");
  if (agentId) assertMayRead(await delegationFor(row.account_id, agentId));
  const correction: TriageCorrection = {
    category: optionalString(params, "category") ?? null,
    urgency: params.urgency == null || params.urgency === "" ? null : Number(params.urgency),
    needsReply: typeof params.needsReply === "boolean" ? params.needsReply : null,
    client: optionalString(params, "client") ?? null,
  };
  const e = requireEnv();
  return correctTriage(e, await loadMailboxConfig(e.ctx, companyId), row, correction, userId ?? (agentId ? `agent:${agentId}` : null));
}

async function delegationFor(accountId: string, agentId: string): Promise<Delegation | null> {
  const row = await requireStore().delegationFor(accountId, agentId);
  if (!row) return null;
  return { canRead: row.can_read, canDraft: row.can_draft, canSend: row.can_send };
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

function requiredCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new MailboxError("Company is required");
  return context.companyId;
}

function requiredUser(context: PluginPerformActionContext): string {
  if (context.actor.type !== "user" || !context.actor.userId) throw new MailboxError("This action is for board users");
  return context.actor.userId;
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
