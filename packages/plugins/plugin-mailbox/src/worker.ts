import { normalizeToolResult } from "@partnersinbiz/pib-plugin-kit";
import { DAILY_DAYS, shapeDaily } from "./daily.js";
import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
  type PluginPerformActionContext,
  type PluginWebhookInput,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  COCKPIT_EVENTS,
  COCKPIT_ROUTE,
  configSaved,
  createSkillSyncer,
  decisionStats,
  HANDOFF_EVENTS,
  installAskEffects,
  isModuleEnabled,
  registerAskEffect,
  registerCompanyBootstrap,
  registerConsentReceiver,
  registerDoneChecks,
  registerEraseReceiver,
  registerModuleWatch,
  registerRoleWatch,
  settleOutbox,
  syncAllCompanies,
  trackJob,
  SETUP_STATUS_ROUTE,
  MAIL_CATEGORIES,
  MAIL_EVENTS,
  MAIL_SENDERS,
  PIB_PLUGINS,
  pluginEvent,
  pluginUiBase,
  registerCrmProjection,
  rememberPluginUiBase,
  valueAtPath,
  type MailAddress,
  type MailSendRequested,
  type RolesPayload,
} from "@partnersinbiz/pib-plugin-kit";
import { espReadiness, espWebhookUrl, gmailRedirectUri, loadMailboxConfig, parseSelectors, r2Configured, validateMailboxConfig, type LoadedConfig } from "./config.js";
import { getAttachment, listMailboxes } from "./agent-mail.js";
import { addClientMap, clientMapOverview, removeClientMap } from "./client-maps.js";
import { DELEGATE_EFFECT_KEY, ensureDefaultDelegations, mailboxDelegateEffect, removeDelegation } from "./delegations.js";
import { sendingDomain } from "./dns.js";
import {
  checkAndStore,
  checkDomain,
  DEFAULT_DKIM_SELECTORS,
  defaultResolver,
  onboardingGuide,
  reannounceDomainChecks,
  runDomainChecks,
  senderDomainHealth,
  sendingDomains,
  type DomainRunEnv,
  type SendingDomain,
} from "./domain-health.js";
import { addSendingDomain, refreshPendingDomains, refreshSendingDomain, sendingDomainView, dnsInstructions, type SendingDomainView } from "./esp/domains.js";
import { readEspState } from "./esp/runtime.js";
import { liftReputationHold } from "./esp/hold.js";
import { isEspProvider, type EspDomainRow } from "./esp/types.js";
import { ESP_ENDPOINT, handleEspWebhook } from "./esp/webhook.js";
import { eraseSubject, onConsentRecorded } from "./erasure.js";
import { isFreeMailDomain } from "./free-mail.js";
import { handleUnsubscribeWebhook, probeCompanies, probeUnsubscribeProxy, probeUrl } from "./unsubscribe.js";
import { onContactSuppressed, reannounceSuppressions, suppressionEvents } from "./suppression.js";
import { DOMAIN_JOB_KEY, SETUP_STATUS_JOB_KEY, SYNC_JOB_KEY } from "./constants.js";
import { knownCompanies, publishAllSetupStatus, rememberCompany, settingsHref, setupStatus } from "./setup-status.js";
import { cockpitSnapshot, publishAllCockpit } from "./cockpit.js";
import { SqlStore, type RecentMessageRow } from "./db.js";
import { mailboxDoneChecks } from "./done-checks.js";
import { assertMayDraft, assertMayRead, assertMaySend, createEmailTemplate, defaultDelegation, MailboxError, type Delegation } from "./domain.js";
import { createEnv, errorMessage, type Env } from "./gmail/env.js";
import { toMailAddress } from "./gmail/headers.js";
import { connectStart, disconnect, oauthComplete } from "./gmail/oauth.js";
import { correctTriage, markReadInGmail, readMessageBody, searchMail, type TriageCorrection } from "./gmail/read.js";
import { handleDraftRequested } from "./gmail/draft.js";
import { handleSendRequested, performSend, retrySend } from "./gmail/send.js";
import { runSyncJob, syncOne, triageRunFor } from "./gmail/sync.js";
import type { AccountRow, ClientMapType, DomainCheckRow, DraftExtras, MessageRow, SendRow } from "./gmail/types.js";
import type { DomainReport } from "./domain-health.js";
import { PLUGIN_ID } from "./namespace.js";
import { isPrivateMail, PRIVATE_BODY_NOTE, PRIVATE_STALE_DAYS } from "./private-mail.js";
import { cleanDisplayName, draftSendContext, parseReplyTo } from "./sender.js";
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
    // An agent's close of a "Reply needed" issue is checked: reopened while the thread still has no reply.
    registerDoneChecks(ctx, mailboxDoneChecks(store));
    // New companies get their skills here (the kit's one company.created wiring, plus a catch-up on a rare core event).
    registerCompanyBootstrap(ctx, { syncer: skillSync });
    // An answered "may I read and draft on this mailbox?" creates the delegation, checks it, and says so (RC5).
    registerAskEffect(DELEGATE_EFFECT_KEY, mailboxDelegateEffect(() => requireEnv()));
    installAskEffects(ctx);
    // Data-subject erasure (the CRM starts it, after a person approved) and withdrawn consent.
    registerEraseReceiver(ctx, { plugin: PLUGIN_ID, erase: (request, companyId) => eraseSubject(requireEnv(), companyId, request) });
    registerConsentReceiver(ctx, { plugin: PLUGIN_ID, onConsent: (companyId, consent) => onConsentRecorded(requireEnv(), companyId, consent) });

    for (const tool of MAILBOX_TOOLS) {
      ctx.tools.register(tool.name, tool, async (params, run) => {
        await skillSync?.ensure(run.companyId).catch(() => undefined);
        return runTool(ctx, tool.name, params, run).then(normalizeToolResult);
      });
    }

    const user = (key: string, fn: (companyId: string, userId: string, params: Record<string, unknown>) => Promise<unknown>) =>
      ctx.actions.register(key, (params, context) => fn(requiredCompany(context), requiredUser(context), params));

    ctx.actions.register("mailbox.load", async (params, context) => {
      const companyId = requiredCompany(context);
      await skillSync?.ensure(companyId).catch(() => undefined);
      await rememberCompany(ctx, companyId);
      return load(ctx, companyId, params);
    });
    ctx.actions.register("mailbox.sync-skills", async (_params, context) => ({ results: await skillSync?.force(requiredCompany(context)) }));
    ctx.actions.register("mailbox.create-draft", (params, context) =>
      createDraft(requiredCompany(context), context.actor.agentId, params, context.actor.type === "agent", drafter(context)),
    );
    ctx.actions.register("mailbox.create-email-template", (params, context) => createEmailTemplateAction(requiredCompany(context), params));
    ctx.actions.register("mailbox.list-email-templates", (_params, context) => requireStore().listTemplates(requiredCompany(context)));

    // The host lets any agent with company access call an action, and an action has no delegation check. So what hands out
    // access or reads mail is for a signed-in person only; an agent uses the tools of the same names, which check its delegation.
    user("mailbox.create-account", (companyId, userId, params) => createAccount(companyId, userId, params));
    user("mailbox.create-delegation", (companyId, userId, params) => createDelegation(companyId, params, userId));
    user("mailbox.list-inbox", (companyId, _userId, params) => listInbox(companyId, params));
    user("mailbox.mark-read", (companyId, _userId, params) => markRead(companyId, params));
    user("mailbox.list-threads", (companyId, _userId, params) => listThreads(companyId, params));

    user("mailbox.connect-start", (companyId, userId, params) => connectStart(requireEnv(), companyId, userId, params));
    user("mailbox.disconnect", (companyId, _userId, params) => disconnect(requireEnv(), companyId, requiredString(params, "accountId")));
    user("mailbox.set-default", async (companyId, _userId, params) => {
      const account = await requireStore().getAccount(companyId, requiredString(params, "accountId"));
      if (!account || account.status !== "connected") throw new MailboxError("Only a connected Gmail account can be the default");
      // A send-only provider address is chosen by name or by the owner's "prefer the provider for invoices" setting; it is never the default mailbox.
      if (isEspProvider(account.provider)) throw new MailboxError("A send-only provider address is never the default mailbox: the default is a Gmail account. To send invoices from the provider, set \"Mail the provider takes when no sender is named\" to transactional in the Mailbox settings.");
      if (account.client_ref) throw new MailboxError("A mailbox that belongs to a client is never the default sender: it sends only that client's mail");
      await requireStore().setDefaultAccount(companyId, account.id);
      return { id: account.id, isDefault: true };
    });
    // A person takes an agent's access away. The defaults never give it back; only a new grant does.
    user("mailbox.remove-delegation", async (companyId, userId, params) => {
      const accountId = requiredString(params, "accountId");
      const agentId = requiredString(params, "agentId");
      if (!(await requireStore().getAccount(companyId, accountId))) throw new MailboxError("Mailbox not found");
      return removeDelegation(requireStore(), companyId, accountId, agentId, userId);
    });
    // A mailbox belongs to a client (or back to the company): it then sends only that client's mail, with its own opt-out list.
    user("mailbox.set-account-client", (companyId, _userId, params) => setAccountClient(companyId, params));
    user("mailbox.check-domain", (companyId, _userId, params) => checkSenderDomain(companyId, params));
    // The email provider's sending domains: registered by a person here, or by an agent with add-sending-domain (both only hand out DNS records; nobody here edits DNS).
    user("mailbox.add-sending-domain", async (companyId, userId, params) => {
      const loaded = await loadMailboxConfig(ctx, companyId);
      const kind = optionalString(params, "clientKind");
      const { created, view } = await addSendingDomain(requireEnv(), companyId, {
        domain: requiredString(params, "domain"),
        fromAddress: optionalString(params, "fromAddress") ?? null,
        fromName: optionalString(params, "fromName") ?? null,
        replyTo: optionalString(params, "replyTo") ?? null,
        clientKind: kind === "contact" ? "contact" : kind === "company" ? "company" : null,
        clientRef: optionalString(params, "clientRef") ?? null,
        region: optionalString(params, "region") ?? null,
        createdBy: userId,
        ownerLinks: { settings: (await settingsHref(ctx).catch(() => ({ href: "/company/settings/instance/plugins" }))).href, webhookUrl: espWebhookUrl(loaded.config.publicBaseUrl, loaded.config.esp.provider) },
      });
      return { created, ...view };
    });
    user("mailbox.sending-domains", (companyId, _userId, params) => sendingDomainsOverview(ctx, companyId, optionalString(params, "domain"), false));
    user("mailbox.refresh-sending-domain", async (companyId, _userId, params) => {
      const domain = requiredString(params, "domain");
      const loaded = await loadMailboxConfig(ctx, companyId);
      await refreshSendingDomain(requireEnv(), loaded, companyId, domain, { verify: true, force: true });
      return sendingDomainsOverview(ctx, companyId, domain, false);
    });
    // Only a person decides that a domain is already established (no warm-up) or gives it a cap of its own: an agent must not lift its own limit.
    user("mailbox.set-sending-domain", async (companyId, userId, params) => {
      const domain = sendingDomain(requiredString(params, "domain")) ?? "";
      const row = await requireStore().getEspDomain(companyId, domain);
      if (!row) throw new MailboxError(`${domain} is not a sending domain of the email provider`);
      const patch: Parameters<SqlStore["patchEspDomain"]>[2] = {};
      if (typeof params.warmupExempt === "boolean") patch.warmup_exempt = params.warmupExempt;
      if ("dailyCap" in params) {
        const cap = params.dailyCap === null || params.dailyCap === "" ? null : Number(params.dailyCap);
        if (cap !== null && (!Number.isInteger(cap) || cap < 0 || cap > 1_000_000)) throw new MailboxError("dailyCap must be a whole number from 1 to 1000000, or empty to use the schedule");
        patch.daily_cap_override = cap === 0 ? null : cap;
      }
      await requireStore().patchEspDomain(companyId, domain, patch);
      // Whoever lifted a limit is on record, like whoever lifted a hold.
      await requireStore().insertEspAudit({ id: randomUUID(), companyId, domain, action: "set_limits", actor: `user:${userId}`, detail: { warmupExempt: patch.warmup_exempt ?? null, dailyCap: "daily_cap_override" in patch ? patch.daily_cap_override : null, was: { warmupExempt: row.warmup_exempt, dailyCap: row.daily_cap_override } } }).catch((error) => ctx.logger.info("Limit change not audited", { domain, error: errorMessage(error) }));
      return sendingDomainsOverview(ctx, companyId, domain, false);
    });
    // A reputation hold (a domain's bounce or complaint rate over the limit holds its marketing back) is lifted by a person only, with a reason, and
    // it is audited. The host lets any agent with company access call an action, so `user` refuses an agent here; the person is the host's actor,
    // never a value in the request (a `userId` or `by` in the parameters is ignored).
    user("mailbox.clear-reputation-hold", async (companyId, userId, params) => {
      const result = await liftReputationHold(requireEnv(), companyId, { domain: requiredString(params, "domain"), reason: requiredString(params, "reason"), userId });
      return { ...result, overview: await sendingDomainsOverview(ctx, companyId, result.domain, false) };
    });
    // "Check now" for the one-click unsubscribe link: the Mailbox posts to its own address and records whether the proxy passed the token on.
    user("mailbox.check-unsubscribe-proxy", (companyId) => checkUnsubscribeProxy(companyId));
    user("mailbox.client-maps", (companyId) => clientMapOverview(requireStore(), companyId));
    user("mailbox.crm-clients", async (companyId) => ({ clients: (await requireStore().crmClients(companyId, 500)).map((c) => ({ ref: `${c.kind}:${c.id}`, name: c.name, kind: c.kind })) }));
    user("mailbox.add-client-map", async (companyId, userId, params) => {
      const { map, filed, rehanded } = await addClientMap(requireEnv(), companyId, clientMapInput(params), userId);
      return { id: map.id, filed, rehanded };
    });
    user("mailbox.remove-client-map", (companyId, _userId, params) => removeClientMap(requireStore(), companyId, requiredString(params, "mapId")));
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
        // First, so the Setup status below shows today's answer: can the Mailbox's own one-click link work?
        await probeCompanies(requireEnv(), await knownCompanies(ctx));
        await publishAllSetupStatus(ctx, requireStore());
        await publishAllCockpit(ctx);
        await reannounceSuppressions(requireEnv());
        await hourlyHousekeeping(ctx);
      });
    });
    // Daily: SPF, DKIM, DMARC and MX of every sending domain, recorded and announced; problems reach the Cockpit.
    ctx.jobs.register(DOMAIN_JOB_KEY, async () => {
      await trackJob(ctx, DOMAIN_JOB_KEY, async () => {
        await runAllDomainChecks(ctx);
      });
    });

    for (const sender of MAIL_SENDERS) {
      ctx.events.on(pluginEvent(sender, MAIL_EVENTS.sendRequested), async (event) => {
        await handleSendRequested(requireEnv(), event);
      });
      // A Gmail draft instead of a send: the message waits in Drafts for a person (nothing is sent).
      ctx.events.on(pluginEvent(sender, MAIL_EVENTS.draftRequested), async (event) => {
        await handleDraftRequested(requireEnv(), event);
      });
    }
    // Unsubscribes and hard bounces the CRM and Campaigns found join the do-not-email list.
    for (const eventType of suppressionEvents()) {
      ctx.events.on(eventType as `plugin.${string}`, (event) => onContactSuppressed(requireEnv(), event));
    }
    // The CRM answered a lead: stop re-sending it.
    ctx.events.on(pluginEvent(PIB_PLUGINS.crm, HANDOFF_EVENTS.leadCapturedResult), async (event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (typeof payload.key !== "string" || !payload.key.startsWith("mail:")) return;
      if (payload.status !== "stored" && payload.status !== "held" && payload.status !== "ignored") return;
      try {
        await settleOutbox(ctx, payload.key, payload, "done");
      } catch (error) {
        ctx.logger.info("Lead result not recorded", { key: payload.key, error: errorMessage(error) });
      }
    });
    // The Cockpit's roles broadcast: an Operator that is staffed after Gmail was connected gets its default access now.
    ctx.events.on(pluginEvent(PIB_PLUGINS.cockpit, COCKPIT_EVENTS.rolesUpdated), async (event) => {
      const payload = event.payload as RolesPayload | undefined;
      const companyId = payload?.companyId ?? event.companyId;
      if (!companyId || !payload) return;
      await ensureDefaultDelegations(requireEnv(), companyId, { roles: payload });
    });
  },

  async onHealth() {
    return { status: "ok", message: "Mailbox plugin ready" };
  },

  async onValidateConfig(config) {
    return validateMailboxConfig(config);
  },

  /** The public one-click unsubscribe address (RFC 8058). A bad or missing token changes nothing and says nothing. */
  async onWebhook(input: PluginWebhookInput): Promise<void> {
    if (!env) return;
    // The email provider's delivery events: signed (Svix); a delivery that does not verify throws, so the host answers with an error and the provider retries.
    if (input.endpointKey === ESP_ENDPOINT) {
      const result = await handleEspWebhook(env, input);
      env.ctx.logger.info("Provider webhook handled", { outcome: result.outcome });
      return;
    }
    const outcome = await handleUnsubscribeWebhook(env, input);
    env.ctx.logger.info("Unsubscribe webhook handled", { outcome });
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
      return { content: "Draft created", data: await createDraft(run.companyId, run.agentId, body, true, run.agentId ? { kind: "agent", id: run.agentId } : null) };
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
    if (name === "check-sender-domain") {
      const data = await checkSenderDomain(run.companyId, body);
      return { content: `${data.domain}: ${data.status}${data.sendReady ? ", ready to send" : ""}`, data };
    }
    if (name === "sender-domain-health") {
      const data = await senderDomainHealthTool(run.companyId, optionalString(body, "domain"));
      return { content: `${data.domains.length} sending domain(s)`, data };
    }
    if (name === "map-client-mail") {
      const { map, filed, rehanded } = await addClientMap(requireEnv(), run.companyId, clientMapInput(body), `agent:${run.agentId}`);
      return { content: `Mapped ${map.match_type.replace("_", " ")} ${map.pattern} to ${map.client_name ?? map.client_ref}${filed ? `; filed ${filed} message(s)` : ""}`, data: { mapId: map.id, filed, rehanded } };
    }
    if (name === "list-client-mail-maps") {
      const data = await clientMapOverview(requireStore(), run.companyId);
      return { content: `${data.maps.length} mapping(s); ${data.unmapped.length} sender domain(s) of unmapped client-looking mail`, data };
    }
    if (name === "remove-client-mail-map") {
      const data = await removeClientMap(requireStore(), run.companyId, requiredString(body, "mapId"));
      return { content: data.removed ? "Mapping removed" : "No mapping with that id", data };
    }
    if (name === "add-sending-domain") {
      const e = requireEnv();
      const loaded = await loadMailboxConfig(ctx, run.companyId);
      const { created, view } = await addSendingDomain(e, run.companyId, {
        domain: requiredString(body, "domain"),
        fromAddress: optionalString(body, "fromAddress") ?? null,
        fromName: optionalString(body, "fromName") ?? null,
        replyTo: optionalString(body, "replyTo") ?? null,
        clientKind: optionalString(body, "clientKind") === "contact" ? "contact" : optionalString(body, "clientKind") === "company" ? "company" : null,
        clientRef: optionalString(body, "clientRef") ?? null,
        region: optionalString(body, "region") ?? null,
        createdBy: `agent:${run.agentId}`,
        ownerLinks: { settings: (await settingsHref(ctx).catch(() => ({ href: "/company/settings/instance/plugins" }))).href, webhookUrl: espWebhookUrl(loaded.config.publicBaseUrl, loaded.config.esp.provider) },
      });
      return { content: `${view.domain}: ${view.ready ? "ready to send" : view.status === "verified" ? "verified" : "waiting for DNS records"}${created ? " (registered now)" : ""}`, data: { created, ...view } };
    }
    if (name === "list-sending-domains") {
      const data = await sendingDomainsOverview(ctx, run.companyId, optionalString(body, "domain"), body.refresh === true);
      return { content: `${data.domains.length} sending domain(s)`, data };
    }
    if (name === "mail-status") {
      const row = await requireStore().getSend(run.companyId, requiredString(body, "key"));
      if (!row) return { content: "No send request with that key", data: { key: body.key, status: "unknown" } };
      return { content: `Send ${row.status}`, data: sendView(row) };
    }
    if (name === "list-mailboxes") {
      const data = await listMailboxes(requireEnv(), run.companyId, run.agentId);
      return { content: `${data.accounts.length} mailbox(es); default ${data.defaultAddress ?? "none"}`, data };
    }
    if (name === "get-attachment") {
      const data = await getAttachment(requireEnv(), run.companyId, run.agentId, requiredString(body, "messageId"), requiredString(body, "attachmentId"), optionalString(body, "account"));
      return { content: `${data.filename} (${data.mime}, ${data.bytes} bytes)${data.url ? ", url valid 15 minutes" : ""}${data.text != null ? ", text included" : ""}`, data };
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
    client_kind: account.client_kind,
    client_ref: account.client_ref,
    from_name: account.from_name,
    reply_to: account.reply_to,
    /** `gmail`, or `email-provider` for a send-only account (no inbox, no sync, no sign-in). */
    kind: isEspProvider(account.provider) ? "email-provider" : "gmail",
  };
}

/** A stored domain check as the page shows it. */
function domainView(row: DomainCheckRow) {
  const report = (row.result ?? {}) as Partial<DomainReport>;
  return {
    domain: row.domain,
    status: row.status,
    sendReady: Boolean(report.sendReady),
    checkedAt: row.checked_at,
    statusSince: row.status_since,
    source: row.source,
    clientKind: row.client_kind,
    clientRef: row.client_ref,
    mx: report.mx?.state ?? null,
    spf: report.spf?.state ?? null,
    dkim: report.dkim?.state ?? null,
    dmarc: report.dmarc?.state === "unreadable" ? "unreadable" : report.dmarc?.policy ?? report.dmarc?.state ?? null,
    problems: (report.problems ?? []).slice(0, 6).map((problem) => ({ severity: problem.severity, message: problem.message, fix: problem.fix })),
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
  const [accounts, delegations, messages, templates, unreadCount, sendCounts, categoryCounts, dailyRows, domains, clientMaps] = await Promise.all([
    s.listAccounts(companyId),
    s.listDelegations(companyId),
    s.recentMessages(companyId, 50),
    s.listTemplates(companyId),
    s.unreadCount(companyId),
    s.sendCounts(companyId),
    s.categoryCounts(companyId),
    // Chart series; a failed read leaves the charts empty, the page still loads.
    s.dailyCounts(companyId, DAILY_DAYS).catch(() => []),
    s.listDomainChecks(companyId).catch(() => []),
    clientMapOverview(s, companyId).catch(() => null),
  ]);
  const raw = loaded.raw;
  const settingsLink = await settingsHref(ctx).catch(() => ({ href: "/company/settings/instance/plugins" }));
  return {
    settings: {
      href: settingsLink.href,
      saved: loaded.config.saved,
      publicBaseUrl: base,
      redirectUri,
      encryptionKey: configured(raw, "encryptionKey"),
      googleClientId: Boolean(loaded.config.googleClientId),
      googleClientSecret: configured(raw, "google.clientSecret"),
      jev: configured(raw, "jev.apiKey") && (raw.jev as { enabled?: boolean } | undefined)?.enabled !== false,
      labelPrefix: loaded.config.labelPrefix,
      sendRatePerMinute: loaded.config.sendRatePerMinute,
      triageIssues: loaded.config.replyIssues,
      r2: r2Configured(raw),
      autoDelegate: loaded.config.autoDelegate,
      domainChecks: loaded.config.domainChecks,
      unsubscribeSecret: configured(raw, "unsubscribe.secret"),
    },
    suppressions: (await s.listSuppressions(companyId, 200).catch(() => [])).map((row) => ({ email: row.email, scope: row.scope, reason: row.reason, source: row.source, at: row.updated_at })),
    accounts: accounts.map(accountView),
    delegations,
    messages: messages.map(draftView),
    templates,
    unreadCount,
    sendCounts: Object.fromEntries(sendCounts.map((row) => [row.status, Number(row.n)])),
    categoryCounts: Object.fromEntries(categoryCounts.map((row) => [row.category ?? "untriaged", Number(row.n)])),
    categories: MAIL_CATEGORIES,
    daily: shapeDaily(dailyRows, DAILY_DAYS),
    domains: domains.map(domainView),
    clientMaps,
    esp: await sendingDomainsOverview(ctx, companyId, undefined, false).catch(() => null),
  };
}

/** A driver time (Date, ISO or Postgres text) as ISO; null when missing or unreadable. */
export function isoTime(value: unknown): string | null {
  if (value == null || value === "") return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** A draft (or other unsent mail) as the page lists and previews it. */
export function draftView(row: RecentMessageRow) {
  const draft: DraftExtras = row.draft && typeof row.draft === "object" ? row.draft : {};
  return {
    id: row.id,
    account_id: row.account_id,
    subject: row.subject,
    body: row.body ?? "",
    status: row.status,
    direction: row.direction,
    send_error: row.send_error,
    to_addrs: row.to_addrs ?? [],
    cc_addrs: row.cc_addrs ?? [],
    bcc_addrs: row.bcc_addrs ?? [],
    created_at: isoTime(row.created_at),
    drafted_by: draft.by && typeof draft.by.id === "string" ? draft.by : null,
    is_reply: Boolean(draft.replyToMessageId),
    has_html: Boolean(draft.html),
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
    attachments: (row.attachments ?? []).map((a) => ({ attachmentId: a.attachmentId, filename: a.filename, mime: a.mime, bytes: a.bytes })),
    category: row.category,
    urgency: row.urgency == null ? null : Number(row.urgency),
    needs_reply: row.needs_reply == null ? null : Number(row.needs_reply),
    phishing: row.phishing == null ? null : Number(row.phishing),
    client_kind: row.client_kind,
    client_ref: row.client_ref,
    client_name: row.triage?.clientName ?? null,
    triage_source: row.triage?.source ?? null,
    reply_to: row.reply_to,
    map_state: row.map_state,
    visitor: row.reply_to_addr,
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
    marketing: row.request?.marketing === true,
    // A client message keeps no text once its send ended (private-mail.ts).
    ...(isPrivateMail(row.context) ? { private: true, textKept: Boolean(row.request?.text || row.request?.html) } : {}),
    skipped: row.skipped ?? [],
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
    ...(row.provider ? { provider: row.provider, providerMessageId: row.provider_message_id, deliveryStatus: row.delivery_status, delivery: row.delivery ?? {} } : {}),
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
    : (await s.listAccounts(companyId)).filter((a) => a.status === "connected" && a.token_sealed);
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
  // A send-only account is made by registering its domain (it needs a verified domain behind it), never by hand.
  if (isEspProvider(optionalString(params, "provider")?.toLowerCase())) throw new MailboxError("An email provider account is created by adding its sending domain (add-sending-domain, or Add a sending domain on the Mailboxes tab).");
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

/**
 * Board action (the Mailboxes tab and the Setup items): read, draft unless canDraft is false, send only when canSend.
 * A person's grant is explicit: it also ends an earlier removal, so the default access can come back for that agent.
 */
async function createDelegation(companyId: string, params: Record<string, unknown>, userId: string) {
  const defaults = defaultDelegation();
  const canSend = params.canSend === true;
  const canDraft = params.canDraft === false ? false : defaults.canDraft;
  const id = randomUUID();
  const accountId = requiredString(params, "accountId");
  if (!(await requireStore().getAccount(companyId, accountId))) throw new MailboxError("Mailbox not found");
  await requireStore().insertDelegation({
    id,
    companyId,
    accountId,
    agentId: requiredString(params, "agentId"),
    canRead: defaults.canRead,
    canDraft,
    canSend,
    grantedBy: userId,
  });
  return { id, canRead: defaults.canRead, canDraft, canSend };
}

/** Board action: runs the check of the proxy rule now. `probeUrl` is for a person who has to run it by hand (`curl -X POST`) when the Mailbox cannot reach its own address. */
async function checkUnsubscribeProxy(companyId: string) {
  const e = requireEnv();
  const proof = await probeUnsubscribeProxy(e, companyId);
  if (!proof) return { configured: false, ok: false, detail: "Set the unsubscribe secret and the public base URL in the Mailbox settings first." };
  return { configured: true, ok: proof.ok, at: proof.at, detail: proof.detail, probeUrl: proof.ok ? null : await probeUrl(await loadMailboxConfig(e.ctx, companyId), companyId) };
}

/** Board action: a mailbox belongs to a client (their mail only, their own opt-out list) or goes back to the company. */
async function setAccountClient(companyId: string, params: Record<string, unknown>) {
  const s = requireStore();
  const account = await s.getAccount(companyId, requiredString(params, "accountId"));
  if (!account) throw new MailboxError("Mailbox not found");
  const clientRef = optionalString(params, "clientRef") ?? null;
  const fromName = optionalString(params, "fromName") ?? null;
  if (!clientRef) {
    await s.setAccountClient(companyId, account.id, { clientKind: null, clientRef: null, fromName });
    if (isEspProvider(account.provider)) await s.patchEspDomain(companyId, sendingDomain(account.address) ?? "", { client_kind: null, client_ref: null });
    return { id: account.id, client: null };
  }
  const clientKind = params.clientKind === "contact" ? "contact" : "company";
  const found = clientKind === "company" ? await s.crmCompany(companyId, clientRef) : await s.crmContact(companyId, clientRef);
  if (!found) throw new MailboxError(`The CRM has no ${clientKind} ${clientRef} in this company`);
  const otherOwn = (await s.listAccounts(companyId)).filter((a) => a.id !== account.id && !a.client_ref && a.token_sealed && (a.status === "connected" || a.status === "needs_reconnect"));
  // The company keeps at least one Gmail mailbox of its own; a send-only account of the email provider is not one.
  if (!isEspProvider(account.provider) && !account.client_ref && otherOwn.length === 0) {
    throw new MailboxError("This is the company's only mailbox with Gmail. Connect another one for the company before giving this one to a client, or nothing would send for the company.");
  }
  await s.setAccountClient(companyId, account.id, { clientKind, clientRef, fromName: fromName ?? found.name });
  // The provider domain sends for the same client as its account: the daily cap, the reputation and the opt-outs are that client's.
  if (isEspProvider(account.provider)) await s.patchEspDomain(companyId, sendingDomain(account.address) ?? "", { client_kind: clientKind, client_ref: clientRef });
  // No agent gets a client's mailbox automatically: what the defaults gave while it was still the company's goes. A person's own grant stays.
  const droppedDefaults = await s.deleteDefaultDelegations(companyId, account.id);
  return { id: account.id, droppedDefaultAccess: droppedDefaults, client: { kind: clientKind, ref: clientRef, name: found.name } };
}

function clientMapInput(params: Record<string, unknown>) {
  const matchType = requiredString(params, "matchType");
  const clientKind = requiredString(params, "clientKind");
  if (clientKind !== "company" && clientKind !== "contact") throw new MailboxError("clientKind must be company or contact");
  return { matchType: matchType as ClientMapType, pattern: requiredString(params, "pattern"), clientKind: clientKind as "company" | "contact", clientRef: requiredString(params, "clientRef"), note: optionalString(params, "note") ?? null };
}

// ---------------------------------------------------------------------------
// Sender domains
// ---------------------------------------------------------------------------

function domainEnv(): DomainRunEnv {
  const e = requireEnv();
  return { ctx: e.ctx, store: requireStore(), dns: e.dns ?? defaultResolver(e.ctx), now: e.now };
}

/** The usual DKIM selectors plus the company's and the caller's extra ones. */
function selectorsFor(loadedSelectors: string[], extra: string | undefined): string[] {
  return [...new Set([...DEFAULT_DKIM_SELECTORS, ...loadedSelectors, ...parseSelectors(extra)])];
}

/** At most this many domains can be watched on purpose (a domain with a mailbox is always watched). */
const MAX_WATCHED_DOMAINS = 25;

/** Checks one domain now (a tool or the page's Check button), records it and returns the report with the onboarding steps. */
async function checkSenderDomain(companyId: string, params: Record<string, unknown>) {
  const s = requireStore();
  const input = optionalString(params, "domain") ?? optionalString(params, "address");
  const domain = sendingDomain(input);
  if (!domain) throw new MailboxError("domain is required, e.g. client.co.za");
  if (isFreeMailDomain(domain)) {
    return { domain, status: "unknown" as const, applicable: false, note: `${domain} is a free mail service: Google, Microsoft or Yahoo authenticate its mail themselves. Mail authentication applies to a company's own domain.` };
  }
  const loaded = await loadMailboxConfig(requireEnv().ctx, companyId);
  // A domain at the email provider: the provider's own status first (it is asked to look at the DNS again, at most every 6 hours).
  let provider: { status: string; error?: string } | null = null;
  const espBefore = await s.getEspDomain(companyId, domain);
  if (espBefore) {
    try {
      provider = { status: (await refreshSendingDomain(requireEnv(), loaded, companyId, domain, { verify: true })).status };
    } catch (error) {
      provider = { status: espBefore.status, error: errorMessage(error) };
    }
  }
  const known = (await sendingDomains(s, companyId)).find((entry) => entry.domain === domain);
  const accounts = (await s.listAccounts(companyId)).filter((account) => sendingDomain(account.address) === domain && account.status !== "disconnected");
  const clientKind = params.clientKind === "contact" ? "contact" : params.clientKind === "company" ? "company" : null;
  const clientRef = optionalString(params, "clientRef") ?? null;
  const watch = params.watch !== false;
  const target: SendingDomain = known ?? { domain, mailboxes: [], gmail: false, sendingSince: null, source: "manual", clientKind: clientRef ? clientKind ?? "company" : null, clientRef };
  if (clientRef && !target.clientRef) Object.assign(target, { clientKind: clientKind ?? "company", clientRef });
  const selectors = selectorsFor(loaded.config.dkimSelectors, optionalString(params, "selectors"));
  const env2 = domainEnv();
  let report;
  const stored = await s.getDomainCheck(companyId, domain);
  if (!known && !stored && !watch) {
    // Look only: nothing is kept.
    report = await checkDomain(env2.dns, domain, { selectors, now: env2.now(), hasMailbox: false, gmail: false });
  } else {
    if (!known && !stored && (await s.listDomainChecks(companyId)).filter((row) => row.source === "manual").length >= MAX_WATCHED_DOMAINS) {
      throw new MailboxError(`${MAX_WATCHED_DOMAINS} domains are already watched. Check this one with watch false, or ask the owner to clean up.`);
    }
    report = await checkAndStore(env2, companyId, target, { selectors });
  }
  const espRow = await s.getEspDomain(companyId, domain);
  const guide = espRow ? espOnboarding(espRow, report, accounts[0]?.address ?? null) : onboardingGuide(domain, report, { gmail: target.gmail || target.mailboxes.length === 0, reportsMailbox: accounts[0]?.address ?? null });
  return {
    /** The email provider's own status of the domain (only for a domain registered there). */
    provider,
    domain,
    applicable: true,
    status: report.status,
    healthy: report.status === "healthy",
    sendReady: report.sendReady,
    checkedAt: report.checkedAt,
    watched: Boolean(known || stored || watch),
    problems: report.problems,
    mx: report.mx,
    spf: report.spf,
    dkim: { state: report.dkim.state, found: report.dkim.found },
    dmarc: report.dmarc,
    unreadable: report.unreadable,
    manual: report.manual,
    onboarding: guide,
  };
}

/** The onboarding of a domain at the email provider: the records the provider has not verified yet, and what is already right. */
function espOnboarding(row: EspDomainRow, report: DomainReport, reportsMailbox: string | null) {
  const pending = row.status === "verified" ? [] : row.records.filter((record) => record.status !== "verified");
  const instructions = dnsInstructions({ ...row, records: pending }, { report, reportsMailbox });
  const alreadyDone = row.records.filter((record) => record.status === "verified" && record.record.toUpperCase() !== "TRACKING").map((record) => `${record.record} ${record.type} at ${record.fqdn}`);
  const nothing = pending.length === 0 && !instructions.dmarc;
  return {
    steps: nothing ? ["Nothing to add: the provider has verified every record."] : instructions.steps,
    dig: report.manual,
    alreadyDone,
    records: instructions.records,
    dmarc: instructions.dmarc,
    whoAddsIt: instructions.whoAddsIt,
    afterwards: instructions.afterwards,
  };
}

/** The company's sending domains at the email provider, for `list-sending-domains` and the Mailboxes tab. `refresh` asks the provider to verify first. */
async function sendingDomainsOverview(ctx: PluginContext, companyId: string, domain: string | undefined, refresh: boolean) {
  const e = requireEnv();
  const s = requireStore();
  const loaded: LoadedConfig = await loadMailboxConfig(ctx, companyId);
  const config = loaded.config.esp;
  const readiness = espReadiness(config);
  const wanted = domain ? sendingDomain(domain) ?? domain.toLowerCase() : null;
  const errors: Record<string, string> = {};
  if (refresh && readiness.domains) {
    for (const row of (await s.listEspDomains(companyId)).filter((entry) => !wanted || entry.domain === wanted)) {
      try {
        await refreshSendingDomain(e, loaded, companyId, row.domain, { verify: true });
      } catch (error) {
        errors[row.domain] = errorMessage(error);
      }
    }
  }
  const rows = (await s.listEspDomains(companyId)).filter((entry) => !wanted || entry.domain === wanted);
  const accounts = await s.listAccounts(companyId);
  const checks = await s.listDomainChecks(companyId).catch(() => []);
  const views: SendingDomainView[] = [];
  for (const row of rows) {
    const report = (checks.find((check) => check.domain === row.domain)?.result ?? null) as Pick<DomainReport, "dmarc"> | null;
    views.push(await sendingDomainView(e, config, row, accounts.find((account) => account.id === row.account_id) ?? null, report?.dmarc ? report : null));
  }
  const state = await readEspState(ctx, companyId);
  return {
    enabled: config.enabled,
    ready: { domains: readiness.domains, sending: readiness.sending },
    blockers: readiness.blockers,
    webhookUrl: espWebhookUrl(loaded.config.publicBaseUrl, loaded.config.esp.provider),
    /** What the provider last answered about the Mailbox's key: set when it was refused or the quota is used up. */
    providerState: state && !state.ok ? { code: state.code, detail: state.detail, at: state.at } : null,
    domains: views,
    ...(Object.keys(errors).length ? { refreshErrors: errors } : {}),
    note: "Mail goes out as a domain only once the provider has verified it. A domain's daily cap ramps up for its first 13 days; a bounce or complaint rate over 2% or 0.1% (7 days) holds its marketing back.",
  };
}

async function senderDomainHealthTool(companyId: string, domainOrAddress: string | undefined) {
  const s = requireStore();
  const now = requireEnv().now();
  const rows = await s.listDomainChecks(companyId);
  const wanted = domainOrAddress ? sendingDomain(domainOrAddress) ?? domainOrAddress.toLowerCase() : null;
  const domains = [];
  for (const row of wanted ? rows.filter((entry) => entry.domain === wanted) : rows) domains.push(await senderDomainHealth(s, companyId, row.domain, now));
  if (wanted && domains.length === 0) domains.push(await senderDomainHealth(s, companyId, wanted, now));
  return { domains, note: "Healthy means SPF, DKIM and DMARC are right. This blocks nothing: the Mailbox still sends. Launch a campaign from a domain only when it is healthy; check-sender-domain re-reads DNS now." };
}

/** Daily job body: every company that has the Mailbox on, settings saved and the checks not switched off. */
async function runAllDomainChecks(ctx: PluginContext): Promise<void> {
  for (const companyId of await knownCompanies(ctx)) {
    try {
      if (!(await configSaved(ctx, companyId)) || !(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) continue;
      await purgeProviderHistory(ctx, companyId);
      const loaded = await loadMailboxConfig(ctx, companyId);
      if (!loaded.config.domainChecks) continue;
      const summary = await runDomainChecks(domainEnv(), companyId, { selectors: selectorsFor(loaded.config.dkimSelectors, undefined) });
      if (summary.checked > 0) ctx.logger.info("Sender domains checked", { companyId, ...summary });
    } catch (error) {
      ctx.logger.info("Sender domain checks skipped", { companyId, error: errorMessage(error) });
    }
  }
}

/** Provider history is kept 90 days (events) and 60 days (daily counts): the reputation window is 7. Per company, like every other job step. Never throws. */
async function purgeProviderHistory(ctx: PluginContext, companyId: string): Promise<void> {
  try {
    const now = requireEnv().now();
    const purged = await requireStore().purgeEspHistory(companyId, new Date(now - 90 * 86_400_000).toISOString(), new Date(now - 60 * 86_400_000).toISOString().slice(0, 10));
    if (purged.events > 0 || purged.days > 0) ctx.logger.info("Provider history purged", { companyId, ...purged });
  } catch (error) {
    ctx.logger.info("Provider history not purged", { companyId, error: errorMessage(error) });
  }
}

/**
 * Hourly backstop for client messages (private-mail.ts): the store drops a settled send's text when it settles, so this finds what slipped
 * (a send an older version stored, a sent copy the sync stored before the send was known) and what never settled (the sender's outbox gave
 * up and cannot tell the Mailbox). Never throws.
 */
async function scrubPrivateMail(ctx: PluginContext, companyId: string): Promise<void> {
  try {
    const s = requireStore();
    const bodies = await s.scrubPrivateBodies(companyId, new Date(requireEnv().now() - PRIVATE_STALE_DAYS * 86_400_000).toISOString());
    const snippets = await s.scrubPrivateSnippets(companyId);
    if (bodies > 0 || snippets > 0) ctx.logger.info("Client message text removed", { companyId, bodies, snippets });
  } catch (error) {
    ctx.logger.info("Client message text not removed this hour", { companyId, error: errorMessage(error) });
  }
}

/** Hourly: managed skills for every company (not only the one a call comes from), and the domain results announced again. */
async function hourlyHousekeeping(ctx: PluginContext): Promise<void> {
  try {
    if (skillSync) await syncAllCompanies(ctx, skillSync, { companyIds: await knownCompanies(ctx), isEnabled: (companyId) => isModuleEnabled(ctx, companyId, PLUGIN_ID), plugin: PLUGIN_ID });
  } catch (error) {
    ctx.logger.info("Mailbox skill sweep failed", { error: errorMessage(error) });
  }
  for (const companyId of await knownCompanies(ctx)) {
    try {
      if (!(await configSaved(ctx, companyId))) continue;
      await scrubPrivateMail(ctx, companyId);
      await reannounceDomainChecks(domainEnv(), companyId);
      // A sending domain waiting for its DNS records is looked at again at the provider (it asks for a fresh verification at most every 6 hours).
      if (await isModuleEnabled(ctx, companyId, PLUGIN_ID)) await refreshPendingDomains(requireEnv(), companyId);
    } catch {
      // the next hour tries again
    }
  }
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

/** Who is saving a draft through a page action: the agent, or the signed-in person. */
function drafter(context: PluginPerformActionContext): DraftExtras["by"] {
  if (context.actor.type === "agent" && context.actor.agentId) return { kind: "agent", id: context.actor.agentId };
  if (context.actor.type === "user" && context.actor.userId) return { kind: "user", id: context.actor.userId };
  return null;
}

async function createDraft(companyId: string, agentId: string | null, params: Record<string, unknown>, enforceDelegation: boolean, by: DraftExtras["by"] = null) {
  const accountId = requiredString(params, "accountId");
  if (enforceDelegation) {
    if (!agentId) throw new MailboxError("This agent is not allowed to draft on that mailbox");
    assertMayDraft(await delegationFor(accountId, agentId));
  }
  const to = addresses(params, "to");
  const cc = addresses(params, "cc");
  const bcc = addresses(params, "bcc");
  const replyToMessageId = optionalString(params, "replyToMessageId") ?? null;
  const replyTo = parseReplyTo(params.replyTo);
  if (replyTo.invalid) throw new MailboxError("Invalid replyTo address");
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
    draft: { html: optionalString(params, "html") ?? null, replyToMessageId, threadId, by, replyTo: replyTo.address, fromName: cleanDisplayName(params.fromName) },
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
  // A send-only account of the email provider sends through the provider, under the same delegation and the same rules.
  const providerReady = Boolean(account && isEspProvider(account.provider) && account.status === "connected");
  if (!gmailReady && !providerReady) {
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
    // A draft on a client's mailbox is that client's mail: its context says so, or the mailbox would refuse it.
    context: draftSendContext(account!, row.id, PLUGIN_ID),
    ...(row.draft?.fromName ? { fromName: row.draft.fromName } : {}),
    ...(row.draft?.replyTo ? { replyTo: row.draft.replyTo } : {}),
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
  const base = { messageId: row.id, accountId: row.account_id, attachments: (row.attachments ?? []).map((a) => ({ attachmentId: a.attachmentId, filename: a.filename, mime: a.mime, bytes: a.bytes })) };
  // A client message may carry a private link (a signing link): nobody gets its text through the Mailbox, whatever mailbox they may read.
  if (await isPrivateMessage(companyId, row)) {
    return { ...base, subject: row.subject, text: "", truncated: false, withheld: true, note: PRIVATE_BODY_NOTE, from: row.from_addr, to: row.to_addrs, date: row.received_at ?? row.created_at };
  }
  if (!row.gmail_message_id || !account) {
    return { ...base, subject: row.subject, text: row.body, truncated: false, from: row.from_addr, to: row.to_addrs, date: row.received_at ?? row.created_at };
  }
  const e = requireEnv();
  const maxChars = params.maxChars == null ? 8000 : integer(params.maxChars, "maxChars");
  const body = await readMessageBody(e, await loadMailboxConfig(e.ctx, companyId), account, row.gmail_message_id, maxChars);
  return { ...base, ...body, triage: messageView(row) };
}

/** True when the stored message is the sent copy of a client message (the send record, not the copy, is what says so when the sync stored it first). */
async function isPrivateMessage(companyId: string, row: MessageRow): Promise<boolean> {
  if (isPrivateMail(row.sent_context)) return true;
  return requireStore().isPrivateSend(companyId, { key: row.send_key, gmailMessageId: row.gmail_message_id, rfcMessageId: row.rfc_message_id });
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
