import { normalizeToolResult } from "@partnersinbiz/pib-plugin-kit";
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
  approvedDrafts,
  campaignByApprovalIssue,
  campaignFunnel,
  campaignStats,
  claimLaunch,
  clearApproval,
  clientCampaignCounts,
  closedStepIssues,
  crmContactsByIds,
  dueEnrollments,
  enrollmentById,
  enrollmentViews,
  isoTime,
  enrollmentByIssue,
  enrollmentsForContact,
  getCampaign,
  getCampaignTemplate,
  insertCampaign,
  insertCampaignTemplate,
  insertEnrollment,
  insertReplyLog,
  insertStep,
  insertStepEvent,
  isSuppressed,
  listCampaigns,
  listCampaignTemplates,
  listSteps,
  markEdited,
  REPLY_OUTCOMES,
  replyEvent,
  saveCampaign,
  saveEnrollment,
  setLaunchError,
  setStepHtml,
  stepEventStats,
  stopEnrollment,
  stopEnrollmentsForContact,
  suppressionCount,
} from "./db.js";
import {
  advanceEnrollment,
  ALL_CONTACTS_MARK,
  assertChannel,
  assertStepFitsDelivery,
  assertTemplateRef,
  audienceLine,
  campaignAddress,
  campaignSenderKey,
  enrollmentStart,
  isAutomatic,
  isEveryContact,
  pickVariant,
  stepChannel,
  stepFor,
  assertCanComplete,
  assertCanDeclareWinner,
  assertCanLaunch,
  assertCanPause,
  assertCanRequestApproval,
  assertEventType,
  assertVariant,
  CampaignError,
  campaignClientSummary,
  campaignScope,
  clientPrefix,
  createCampaign,
  createCampaignTemplate,
  startEnrollment,
  stepIssueCopy,
  withClient,
  type CampaignClient,
  type CampaignDraft,
  type ClientSummary,
  type CampaignStepDraft,
  type EnrollmentDraft,
} from "./domain.js";
import { CAMPAIGN_TOOLS } from "./tools.js";
import { SKILLS } from "./skills.js";
import { nextSend } from "./detail.js";
import { channelsUsed, firstChannel, launchAudience } from "./audience.js";
import { CHANNEL_LABELS, describeWindows, isMessagingChannel, smsLength } from "./channels.js";
import { pollMessaging } from "./inbound.js";
import { messagingSetup } from "./messaging.js";
import { objectParams, optionalString, requiredString, stringList, integer } from "./params.js";
import { DOMAIN_HEALTH_EVENT, gatherPreflight, preflightLines, rememberDomainHealth, rememberSenderHealth, SENDER_HEALTH_EVENT } from "./preflight.js";
import { eraseSubject, onConsentRecorded } from "./privacy.js";
import { CAMPAIGNS_PROJECT_KEY } from "./namespace.js";
import { projectForCampaign } from "./projects.js";
import { identityChanged, listSenderIdentities, preflightCampaign, recordChannelConsent, removeSenderIdentity, setSenderIdentity, suppressPhone } from "./sender-tools.js";
import { composeMessage, sendMessagingStep } from "./sms.js";
import { handleWebhook } from "./webhook.js";
import {
  clientScopeFromInput,
  COCKPIT_ROUTE,
  configSaved,
  createSkillSyncer,
  createWorkIssue,
  openApprovalIssue,
  registerClientProjectWatch,
  registerCompanyBootstrap,
  registerConsentReceiver,
  registerEraseReceiver,
  senderKeyOf,
  syncAllCompanies,
  getCrmContact as projectedContact,
  isModuleEnabled,
  checkDoneOnUpdate,
  registerModuleWatch,
  registerRoleWatch,
  rememberPluginUiBase,
  reopenApprovalForPerson,
  reviewerBrief,
  SETUP_STATUS_ROUTE,
  trackJob,
  listCrmContactsAtCompany,
  parseClientParam,
  readConfig,
  registerCrmProjection,
  resolveCrmClient,
  withClientParam,
  MAIL_EVENTS,
  PIB_PLUGINS,
  pluginEvent,
  type ClientScope,
} from "@partnersinbiz/pib-plugin-kit";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { onMailDelivery } from "./delivery.js";
import { abSuggestionFor, campaignAssignee, handSentEmail, onMailReceived, onSendResult, openIssueOnce, redeliverMail, sendCampaignStep } from "./mail.js";
import { PLUGIN_ID } from "./namespace.js";
import { eventCounts, eventDays } from "./db.js";
import { eventTotals, weeklySends } from "./series.js";
import { knownCompanies, publishAllSetupStatus, rememberCompany, setupStatus } from "./setup-status.js";
import { cockpitSnapshot, publishAllCockpit } from "./cockpit.js";
import { CAMPAIGN_DONE_CHECKS } from "./donechecks.js";
import { approverUserId, assigneeFields, workOwner } from "./owner.js";
import { approvalOrigin, reviseOrigin, stepOrigin } from "./origins.js";
import { announceSuppression, onContactSuppressed, reannounceSuppressions, suppressAddress, suppressionEvents, suppressionPayload } from "./suppress.js";

type Owner = { userId?: string | null; agentId?: string | null };

const ORIGIN = `plugin:${PLUGIN_ID}` as const;

let pluginCtx: PluginContext | null = null;
let skillSync: ReturnType<typeof createSkillSyncer> | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    skillSync = createSkillSyncer(ctx, SKILLS);
    registerCrmProjection(ctx, ctx.db.namespace, { companies: true, contacts: true });
    registerModuleWatch(ctx);
    registerRoleWatch(ctx);
    // A client's issues open in the client's own project (the CRM's link), else the managed Campaigns project.
    registerClientProjectWatch(ctx);
    // POPIA: erase one approved person, and keep consent records (opt-ins gate SMS and WhatsApp).
    registerEraseReceiver(ctx, { plugin: PLUGIN_ID, erase: (request, companyId) => eraseSubject(ctx, request, companyId) });
    registerConsentReceiver(ctx, { plugin: PLUGIN_ID, onConsent: (companyId, consent) => onConsentRecorded(ctx, companyId, consent) });
    // The Mailbox may report how a sender's domain is set up; the preflight uses it when present.
    ctx.events.on(pluginEvent(PIB_PLUGINS.mailbox, SENDER_HEALTH_EVENT), async (event) => {
      if (event.companyId) await rememberSenderHealth(ctx, event.companyId, event.payload).catch(() => false);
    });
    // What the Mailbox really announces (0.5.0+): the health of each sending domain, a Gmail mailbox's or an email provider account's (SPF, DKIM, DMARC, and for a
    // provider domain its bounce and complaint rates). The preflight reads it for the domain of the address a campaign sends from.
    ctx.events.on(pluginEvent(PIB_PLUGINS.mailbox, DOMAIN_HEALTH_EVENT), async (event) => {
      if (event.companyId) await rememberDomainHealth(ctx, event.companyId, event.payload).catch(() => false);
    });
    for (const tool of CAMPAIGN_TOOLS) {
      ctx.tools.register(tool.name, tool, async (params, run) => {
        await skillSync?.ensure(run.companyId).catch(() => undefined);
        return runTool(ctx, tool.name, params, run).then(normalizeToolResult);
      });
    }
    ctx.actions.register("campaigns.load", async (params, context) => {
      if (context.companyId) await skillSync?.ensure(context.companyId).catch(() => undefined);
      // The page reports /_plugins/<installation uuid>/ui/ so Setup can link the settings page.
      await rememberPluginUiBase(ctx, params.uiBase);
      if (context.companyId) await rememberCompany(ctx, context.companyId);
      return load(ctx, context, params);
    });
    ctx.actions.register("campaigns.request-approval", (params, context) => requestApproval(ctx, requiredCompany(context), params));
    ctx.actions.register("campaigns.sync-skills", async (_params, context) => ({ results: await skillSync?.force(requiredCompany(context)) }));
    ctx.actions.register("campaigns.create-campaign", (params, context) => createCampaignAction(ctx, context, params));
    ctx.actions.register("campaigns.add-step", (params, context) => addStepAction(ctx, context, params));
    ctx.actions.register("campaigns.launch", (params, context) => launchAction(ctx, context, params));
    ctx.actions.register("campaigns.pause", (params, context) => pauseAction(ctx, context, params));
    ctx.actions.register("campaigns.resume", (params, context) => resumeAction(ctx, context, params));
    ctx.actions.register("campaigns.complete", (params, context) => completeAction(ctx, context, params));
    ctx.actions.register("campaigns.stats", (params, context) => statsAction(ctx, context, params));
    ctx.actions.register("campaigns.enroll", (params, context) => enrollAction(ctx, context, params));
    ctx.actions.register("campaigns.detail", (params, context) => campaignDetail(ctx, requiredCompany(context), params));
    ctx.actions.register("campaigns.ab-suggestion", (params, context) => suggestWinner(ctx, requiredCompany(context), params));
    ctx.actions.register("campaigns.declare-winner", (params, context) => declareWinner(ctx, requiredCompany(context), params));
    ctx.jobs.register("open-due-steps", () => trackJob(ctx, "open-due-steps", async () => {
      // Catch up on approvals and step issues whose events were missed (delivery is at-most-once).
      await catchUpApprovals(ctx);
      await catchUpStepIssues(ctx);
      await openDueSteps(ctx);
    }));
    ctx.jobs.register("redeliver-mail", async () => {
      await trackJob(ctx, "redeliver-mail", async () => {
        const result = await redeliverMail(ctx);
        if (result.emitted || result.failed || result.handedOver) ctx.logger.info("Campaign mail redelivery", result);
      });
    });
    ctx.jobs.register("poll-messaging", async () => {
      await trackJob(ctx, "poll-messaging", async () => {
        const results = await pollMessaging(ctx);
        const read = results.reduce((sum, r) => sum + r.inbound, 0);
        const stops = results.reduce((sum, r) => sum + r.stops, 0);
        if (read || stops) ctx.logger.info("Messaging poll", { companies: results.length, read, stops });
      });
    });
    ctx.jobs.register("setup-status", async () => {
      await trackJob(ctx, "setup-status", async () => {
        await publishAllSetupStatus(ctx);
        await publishAllCockpit(ctx);
        await reannounceSuppressions(ctx);
        // Every company's managed skills, not only the one a call arrives from (a failure is reported, not fatal).
        if (skillSync) {
          await syncAllCompanies(ctx, skillSync, { companyIds: await knownCompanies(ctx), isEnabled: (companyId) => isModuleEnabled(ctx, companyId, PLUGIN_ID), plugin: PLUGIN_ID }).catch((error) => {
            ctx.logger.info("Skill sweep failed", { error: error instanceof Error ? error.message : String(error) });
          });
        }
      });
    });
    ctx.events.on(pluginEvent(PIB_PLUGINS.mailbox, MAIL_EVENTS.received), async (event) => {
      // Replies are ignored while the Campaigns module is switched off for the company.
      if (event.companyId && !(await isModuleEnabled(ctx, event.companyId, PLUGIN_ID))) return;
      await onMailReceived(ctx, event);
    });
    ctx.events.on(pluginEvent(PIB_PLUGINS.mailbox, MAIL_EVENTS.sendResult), (event) => onSendResult(ctx, event));
    // What the email provider says became of a campaign email (delivered, bounced, marked as spam, opened, clicked): step events for the report, and a
    // hard bounce or a complaint stops the address. Only mail the provider took is reported, so with the provider off nothing arrives.
    ctx.events.on(pluginEvent(PIB_PLUGINS.mailbox, MAIL_EVENTS.delivery), async (event) => {
      if (event.companyId && !(await isModuleEnabled(ctx, event.companyId, PLUGIN_ID))) return;
      await onMailDelivery(ctx, event);
    });
    // Unsubscribes and hard bounces from the CRM and the Mailbox join Campaigns' own list.
    for (const eventType of suppressionEvents()) {
      ctx.events.on(eventType as `plugin.${string}`, (event) => onContactSuppressed(ctx, event));
    }
    // One subscription (a second would run both twice). A closed step issue moves its contact on before its done check looks.
    ctx.events.on("issue.updated", async (event) => {
      try {
        await onIssueUpdated(ctx, event);
      } catch (error) {
        ctx.logger.error("Campaign issue update failed", { issueId: event.entityId, error: error instanceof Error ? error.message : String(error) });
      }
      await checkDoneOnUpdate(ctx, CAMPAIGN_DONE_CHECKS, event);
    });
    // The one company.created wiring (kit): remembers the company, syncs the skills, creates the Campaigns project.
    registerCompanyBootstrap(ctx, {
      ...(skillSync ? { syncer: skillSync } : {}),
      ensureResources: (companyId) => ctx.projects.managed.reconcile(CAMPAIGNS_PROJECT_KEY, companyId),
    });
    ctx.logger.info("Campaigns plugin ready");
  },
  async onHealth() {
    return { status: "ok", message: "Campaigns plugin ready" };
  },
  async onWebhook(input) {
    if (!pluginCtx) throw new Error("Campaigns plugin is not ready");
    await handleWebhook(pluginCtx, input);
  },
  async onApiRequest(input) {
    if (!pluginCtx) return { status: 503, body: { error: "Campaigns plugin is not ready" } };
    if (input.routeKey === SETUP_STATUS_ROUTE.routeKey) {
      return { status: 200, body: await setupStatus(pluginCtx, input.companyId) };
    }
    if (input.routeKey === COCKPIT_ROUTE.routeKey) {
      return { status: 200, body: await cockpitSnapshot(pluginCtx, input.companyId) };
    }
    return handleApiRoute(pluginCtx, input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

async function runTool(ctx: PluginContext, name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    const body = objectParams(params);
    const data = await dispatch(ctx, name, body, run);
    return { content: name, data };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Campaign tool failed" };
  }
}

/** Who recorded something, for the audit trail: `agent:<id>` or `user:<id>`. */
function actorLabel(run: Pick<ToolRunContext, "agentId"> & { userId?: string | null }): string | null {
  return run.agentId ? `agent:${run.agentId}` : run.userId ? `user:${run.userId}` : null;
}

/** A sender's identity changed: the approver saw the old one, so a draft of that sender that waits for approval needs a new request. */
async function setSenderAndResetApprovals(ctx: PluginContext, companyId: string, body: Record<string, unknown>, actor: string | null) {
  const scope = readClientScope(body) ?? null;
  const result = await setSenderIdentity(ctx, companyId, body, actor, async (before, after) => {
    if (!identityChanged(before, after)) return;
    // A running or paused campaign was approved as it was: its sender cannot change under it (a new reply-to would redirect real replies unapproved).
    const live = (await listCampaigns(ctx, companyId, scope)).filter((campaign) => campaign.status === "active" || campaign.status === "paused" || campaign.status === "scheduled");
    if (live.length > 0) {
      throw new CampaignError(`This sender has ${live.length === 1 ? "a campaign" : `${live.length} campaigns`} running or paused (${live.slice(0, 3).map((campaign) => campaign.name).join(", ")}), approved as it goes out now. Complete ${live.length === 1 ? "it" : "them"} (complete-campaign) first, then change the sender and ask for approval of a new campaign.`);
    }
  });
  let reset = 0;
  for (const campaign of await listCampaigns(ctx, companyId, scope)) {
    if (campaign.status === "draft" && campaign.approvalIssueId && (await invalidateApproval(ctx, companyId, campaign, "the sender it goes out as changed"))) reset += 1;
  }
  return { ...result, approvalsReset: reset };
}

async function dispatch(ctx: PluginContext, name: string, body: Record<string, unknown>, run: ToolRunContext): Promise<unknown> {
  const companyId = run.companyId;
  if (name === "create-campaign") return createCampaignRecord(ctx, companyId, body, { agentId: run.agentId });
  if (name === "update-campaign") return updateCampaignRecord(ctx, companyId, body);
  if (name === "list-campaigns") return listCampaignsRecord(ctx, companyId, body);
  if (name === "add-campaign-step") return addStep(ctx, companyId, body);
  if (name === "launch-campaign") return launch(ctx, companyId, body);
  if (name === "stop-enrollment") return stopEnrollmentTool(ctx, companyId, body);
  if (name === "suppress-address") return suppressAddressTool(ctx, companyId, body);
  if (name === "suppress-phone") return suppressPhone(ctx, companyId, body);
  if (name === "record-channel-consent") return recordChannelConsent(ctx, companyId, body, actorLabel(run));
  if (name === "set-sender-identity") return setSenderAndResetApprovals(ctx, companyId, body, actorLabel(run));
  if (name === "remove-sender-identity") return removeSenderIdentity(ctx, companyId, body);
  if (name === "list-sender-identities") return listSenderIdentities(ctx, companyId);
  if (name === "preflight-campaign") return preflightCampaign(ctx, companyId, body);
  if (name === "log-reply") return logReplyTool(ctx, companyId, body, run.agentId ?? null);
  if (name === "pause-campaign") return setStatus(ctx, companyId, body, "paused");
  if (name === "resume-campaign") return setStatus(ctx, companyId, body, "active");
  if (name === "complete-campaign") return setStatus(ctx, companyId, body, "completed");
  if (name === "campaign-stats") return stats(ctx, companyId, body);
  if (name === "enroll-contact") return enroll(ctx, companyId, body);
  if (name === "request-campaign-approval") return requestApproval(ctx, companyId, body);
  if (name === "create-ab-variant") return createAbVariant(ctx, companyId, body);
  if (name === "campaign-funnel") return funnel(ctx, companyId, body);
  if (name === "record-step-event") return recordStepEvent(ctx, companyId, body);
  if (name === "campaign-step-analytics") return stepAnalytics(ctx, companyId, body);
  if (name === "set-step-html") return setStepHtmlAction(ctx, companyId, body);
  if (name === "create-campaign-template") return createTemplateAction(ctx, companyId, body);
  if (name === "list-campaign-templates") return listTemplatesAction(ctx, companyId);
  if (name === "create-campaign-from-template") return createFromTemplate(ctx, companyId, body, { agentId: run.agentId });
  if (name === "declare-ab-winner") return declareWinner(ctx, companyId, body);
  if (name === "suggest-ab-winner") return suggestWinner(ctx, companyId, body);
  throw new CampaignError(`Unknown campaign tool ${name}`);
}

/**
 * The Campaigns page. No `client` is PiB's own campaigns; a client returns
 * only that client's campaigns plus the client's CRM details for the
 * workspace header.
 */
async function load(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown> = {}) {
  const companyId = requiredCompany(context);
  const scope = readClientScope(params) ?? null;
  const campaigns = await listCampaigns(ctx, companyId, scope);
  const result = [];
  for (const campaign of campaigns) {
    const steps = await listSteps(ctx, campaign.id);
    const stats = await campaignStats(ctx, campaign.id);
    const approval = campaign.approvalIssueId ? await ctx.issues.get(campaign.approvalIssueId, companyId).catch(() => null) : null;
    result.push({ ...publicCampaign(campaign), steps, stats, approvalStatus: approval?.status ?? null });
  }
  const config = await readConfig(ctx, companyId).catch(() => ({}));
  const now = new Date();
  const ids = new Set(campaigns.map((campaign) => campaign.id));
  const [counts, days, suppressed] = await Promise.all([
    eventCounts(ctx, companyId).catch(() => []),
    eventDays(ctx, companyId, new Date(now.getTime() - 84 * 86_400_000).toISOString()).catch(() => []),
    suppressionCount(ctx, companyId).catch(() => 0),
  ]);
  const setup = await messagingSetup(ctx, companyId).catch(() => null);
  return {
    campaigns: result,
    suppressed,
    series: { weeks: weeklySends(days, now, 12, ids), byCampaign: eventTotals(counts, ids) },
    settingsSaved: Object.keys(config).length > 0,
    client: scope ? await clientDetails(ctx, companyId, scope, campaigns) : null,
    messaging: setup ? { sms: setup.sms, whatsapp: setup.whatsapp, windows: describeWindows(setup.config.windows) } : null,
  };
}

/** The workspace header's client. `found: false` when the CRM projection does not know it (yet). */
async function clientDetails(ctx: PluginContext, companyId: string, scope: NonNullable<ClientScope>, campaigns: CampaignDraft[]) {
  const client = await resolveCrmClient(ctx, ctx.db.namespace, companyId, scope).catch(() => null);
  const contactCount = scope.kind === "company"
    ? (await listCrmContactsAtCompany(ctx, ctx.db.namespace, companyId, scope.id).catch(() => [])).length
    : null;
  return {
    kind: scope.kind,
    id: scope.id,
    name: client?.name ?? campaigns.find((campaign) => campaign.clientName)?.clientName ?? null,
    detail: client?.domain ?? client?.email ?? null,
    found: Boolean(client),
    contactCount,
  };
}

/**
 * One campaign for the page's detail view: what a person reads before
 * approving. Every step in order, who gets it (the audience that matches now,
 * with unsubscribed and bounced addresses left out), who is enrolled, when the
 * next email goes out, and where the approval stands.
 */
async function campaignDetail(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  const [steps, stats, enrollments, approval] = await Promise.all([
    listSteps(ctx, campaign.id),
    campaignStats(ctx, campaign.id),
    enrollmentViews(ctx, campaign.id),
    campaign.approvalIssueId ? ctx.issues.get(campaign.approvalIssueId, companyId).catch(() => null) : Promise.resolve(null),
  ]);
  const audience = await launchAudience(ctx, companyId, campaign, steps).catch(() => null);
  // Who it goes out as and what is wrong, without asking the web: the page shows this before anyone approves.
  const preflight = await gatherPreflight(ctx, companyId, campaign, steps, { network: false, audience: false }).catch(() => null);
  const running = enrollments.filter((row) => row.status === "running");
  return {
    campaign: { ...publicCampaign(campaign), steps, stats, approvalStatus: approval?.status ?? null },
    sender: preflight ? { sentAs: preflight.sentAs, channels: preflight.channels } : null,
    preflight: preflight ? { errors: preflight.errors, warnings: preflight.warnings } : null,
    approval: approval
      ? { issueId: approval.id, identifier: approval.identifier ?? null, status: approval.status, withPerson: Boolean(approval.assigneeUserId), withAgent: Boolean(approval.assigneeAgentId) }
      : null,
    audience: audience
      ? { matching: audience.contacts.length, willGet: audience.eligible.length, leftOut: audience.suppressedCount, notReachable: audience.notReachable, reach: audience.reach, sample: audience.eligible.slice(0, 5).map((contact) => contact.name) }
      : null,
    enrolled: {
      total: stats.enrolled,
      running: stats.running,
      done: stats.done,
      stopped: Math.max(0, stats.enrolled - stats.running - stats.done),
      sample: enrollments.slice(0, 5).map((row) => ({ name: row.name, status: row.status, stepPosition: row.stepPosition, nextDueAt: row.nextDueAt, waiting: row.waiting })),
    },
    next: nextSend(running),
  };
}

async function listCampaignsRecord(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const scope = readClientScope(params) ?? null;
  const campaigns = await listCampaigns(ctx, companyId, scope);
  const result = [];
  for (const campaign of campaigns) {
    result.push({ ...publicCampaign(campaign), stats: await campaignStats(ctx, campaign.id) });
  }
  return { client: scope, campaigns: result };
}

async function createCampaignAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return createCampaignRecord(ctx, requiredCompany(context), params, { userId: context.actor.userId, agentId: context.actor.agentId });
}

async function addStepAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return addStep(ctx, requiredCompany(context), params);
}

async function launchAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return launch(ctx, requiredCompany(context), params);
}

async function pauseAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return setStatus(ctx, requiredCompany(context), params, "paused");
}

async function resumeAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return setStatus(ctx, requiredCompany(context), params, "active");
}

async function completeAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return setStatus(ctx, requiredCompany(context), params, "completed");
}

async function statsAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return stats(ctx, requiredCompany(context), params);
}

async function enrollAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return enroll(ctx, requiredCompany(context), params);
}

async function createCampaignRecord(ctx: PluginContext, companyId: string, params: Record<string, unknown>, owner: Owner = {}) {
  const client = await requireClient(ctx, companyId, readClientScope(params) ?? null);
  const campaign = createCampaign({
    companyId,
    name: requiredString(params, "name"),
    description: optionalString(params, "description"),
    fromName: optionalString(params, "fromName"),
    fromLocal: optionalString(params, "fromLocal"),
    replyTo: optionalString(params, "replyTo"),
    audienceTags: stringList(params, "audienceTags"),
    audienceMode: optionalString(params, "audienceMode"),
    client,
    startAt: optionalString(params, "startAt"),
    endAt: optionalString(params, "endAt"),
    delivery: optionalString(params, "delivery"),
    ownerUserId: owner.userId ?? null,
    ownerAgentId: owner.agentId ?? null,
  });
  await insertCampaign(ctx, campaign);
  return publicCampaign(campaign);
}

/** Edits a draft. `client` moves it to a client (or `null` to own work); omitted fields stay. */
async function updateCampaignRecord(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const original = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  let campaign = original;
  if (campaign.status !== "draft") throw new CampaignError("Only a draft campaign can be edited");
  const scope = readClientScope(params);
  const audienceMode = optionalString(params, "audienceMode");
  if (scope !== undefined) {
    campaign = withClient(campaign, await requireClient(ctx, companyId, scope), audienceMode);
  } else if (audienceMode) {
    const current = campaignScope(campaign);
    campaign = withClient(campaign, current ? { kind: current.kind, id: current.id, name: campaign.clientName ?? current.id } : null, audienceMode);
  }
  const edited = createCampaign({
    companyId,
    id: campaign.id,
    name: optionalString(params, "name") ?? campaign.name,
    description: optionalString(params, "description") ?? campaign.description,
    fromName: optionalString(params, "fromName") ?? campaign.fromName,
    fromLocal: optionalString(params, "fromLocal") ?? campaign.fromLocal,
    replyTo: params.replyTo === undefined ? campaign.replyTo : optionalString(params, "replyTo") ?? null,
    audienceTags: params.audienceTags === undefined ? campaign.audienceTags : stringList(params, "audienceTags"),
    audienceMode: campaign.audienceMode,
    client: campaign.clientRef ? { kind: campaign.clientKind ?? "company", id: campaign.clientRef, name: campaign.clientName ?? campaign.clientRef } : null,
    startAt: params.startAt === undefined ? campaign.startAt : optionalString(params, "startAt") ?? null,
    endAt: params.endAt === undefined ? campaign.endAt : optionalString(params, "endAt") ?? null,
    delivery: params.delivery === undefined ? campaign.delivery : optionalString(params, "delivery"),
    ownerUserId: campaign.ownerUserId,
    ownerAgentId: campaign.ownerAgentId,
  });
  if (edited.delivery !== "auto") {
    // SMS and WhatsApp are sent by the plugin itself, so a campaign that has such a step cannot go back to a delivery that cannot send them.
    const texted = (await listSteps(ctx, campaign.id)).find((row) => stepChannel(row) !== "email");
    if (texted) throw new CampaignError(`This campaign has a ${stepChannel(texted) === "sms" ? "SMS" : "WhatsApp"} step, so its delivery must be auto.`);
  }
  const next: CampaignDraft = { ...edited, approvalIssueId: campaign.approvalIssueId, winnerVariant: campaign.winnerVariant };
  // What goes out, to whom and when changed after approval was asked for: that approval no longer counts.
  const approvalReset = approvalFields(next) !== approvalFields(original)
    ? await invalidateApproval(ctx, companyId, next, "the campaign's audience, sender, delivery or dates changed")
    : false;
  await saveCampaign(ctx, next);
  if (approvalFields(next) !== approvalFields(original) || next.description !== original.description) await markEdited(ctx, next.id);
  return { ...publicCampaign(next), approvalReset };
}

/** The parts of a campaign the approver saw. */
function approvalFields(campaign: CampaignDraft): string {
  return JSON.stringify([
    campaign.name, campaign.fromName, campaign.fromLocal, campaign.replyTo, campaign.audienceTags, campaign.audienceMode,
    campaign.clientKind, campaign.clientRef, campaign.startAt, campaign.endAt, campaign.delivery,
  ]);
}

async function addStep(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  if (campaign.status !== "draft") throw new CampaignError("Steps can only be added to a draft campaign");
  const steps = await listSteps(ctx, campaign.id);
  const channel = assertChannel(params.channel);
  assertStepFitsDelivery(campaign.delivery, channel);
  const body = optionalString(params, "body") ?? "";
  if (channel !== "email" && !body) throw new CampaignError("An SMS or WhatsApp step needs body text.");
  const templateRef = channel === "whatsapp" ? assertTemplateRef(params.templateRef) : null;
  if (channel !== "whatsapp" && (params.templateRef || params.templateVars)) throw new CampaignError("templateRef and templateVars are for WhatsApp steps only.");
  const step: CampaignStepDraft = {
    // After the last step (a B version shares its step's position, so counting rows would skip one).
    position: steps.reduce((last, row) => Math.max(last, row.position), 0) + 1,
    delayDays: params.delayDays == null ? 0 : integer(params.delayDays, "delayDays"),
    subject: channel === "email" ? requiredString(params, "subject") : optionalString(params, "subject") ?? "",
    body,
    htmlBody: null,
    variant: "a",
    channel,
    templateRef,
    templateVars: templateRef ? stringList(params, "templateVars") : [],
  };
  await insertStep(ctx, { companyId, campaignId: campaign.id, step });
  await markEdited(ctx, campaign.id);
  const approvalReset = await invalidateApproval(ctx, companyId, campaign, `step ${step.position} was added`);
  return { campaignId: campaign.id, step, approvalReset };
}

/**
 * `launch-campaign` (tool and page): a paused campaign enrolls its audience
 * again and runs; a draft launches only when a person approved it (normally
 * that already happened by itself when the approval was marked done).
 */
async function launch(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  assertCanLaunch(campaign.status);
  if (campaign.status === "draft") {
    if (!campaign.approvalIssueId) {
      throw new CampaignError("Request approval first (request-campaign-approval). It launches by itself once a person marks that issue done.");
    }
    const approval = await ctx.issues.get(campaign.approvalIssueId, companyId);
    if (approval?.status !== "done") throw new CampaignError("The campaign has not been approved yet. It launches by itself once a person marks the approval issue done.");
    // Only a person approves. An approval closed while it still sits with an agent (e.g. the Reviewer) does not count.
    if (approval.assigneeAgentId) {
      throw new CampaignError("The approval issue was closed while assigned to an agent. A person must approve it: reopen it, assign it to the approver and have them mark it done.");
    }
  }
  return launchCampaign(ctx, companyId, campaign, { contactIds: stringList(params, "contactIds"), approvedByUserId: null });
}

export interface LaunchResult {
  campaignId: string;
  status: string;
  enrolled: number;
  /** Left out because the address is on the do-not-email (or do-not-message) list. */
  skippedSuppressed: number;
  /** Left out of a text campaign: no mobile number, or no opt-in on record for this sender. */
  skippedNotReachable?: number;
  /** Already running in this campaign. */
  skippedRunning: number;
  audience: string;
  /** True when another launch got there first. */
  alreadyLaunched?: boolean;
  firstStepAt: string;
}

/**
 * The one launch path (approval, sweep, tool). Checks: at least one step, a
 * known audience, and an audience of every CRM contact only when the
 * approval said "All contacts (N)". Suppressed addresses are never enrolled.
 * Throws `CampaignError` with what to fix; changes nothing then.
 */
async function launchCampaign(
  ctx: PluginContext,
  companyId: string,
  campaign: CampaignDraft,
  options: { contactIds?: string[]; approvedByUserId: string | null },
): Promise<LaunchResult> {
  assertCanLaunch(campaign.status);
  const steps = await listSteps(ctx, campaign.id);
  if (steps.length === 0) throw new CampaignError("A campaign needs at least one step before launch. Add one with add-campaign-step.");
  // Things change between approval and launch (a sender removed, a provider switched off): check again, without the web.
  const checked = await gatherPreflight(ctx, companyId, campaign, steps, { network: false, audience: false });
  if (!checked.ok) throw new CampaignError(`It cannot launch yet: ${checked.errors.map((finding) => finding.message).join(" ")}`);
  const explicitIds = options.contactIds ?? [];
  const setup = await messagingSetup(ctx, companyId);
  const { contacts, eligible, suppressedCount, notReachable } = await launchAudience(ctx, companyId, campaign, steps, explicitIds, setup.config.defaultCountry);
  if (explicitIds.length > 0 && contacts.length < explicitIds.length) {
    const known = new Set(contacts.map((contact) => contact.id));
    const missing = explicitIds.filter((id) => !known.has(id));
    throw new CampaignError(`Unknown CRM contact ids: ${missing.join(", ")}. The CRM shares new contacts within 15 minutes; launch again after that.`);
  }
  if (explicitIds.length === 0 && campaign.audienceMode === "client_contact" && contacts.length === 0) {
    throw new CampaignError(`The client contact ${campaign.clientName ?? campaign.clientRef} is not in the Campaigns contact list yet. The CRM shares it within 15 minutes; approve again after that.`);
  }
  if (isEveryContact(campaign, explicitIds)) {
    // Empty tags means every CRM contact: only when the approval said so and a person approved it.
    const approval = campaign.approvalIssueId ? await ctx.issues.get(campaign.approvalIssueId, companyId).catch(() => null) : null;
    if (!approval?.description?.includes(ALL_CONTACTS_MARK)) {
      throw new CampaignError(`This campaign would email every CRM contact (${contacts.length}), but its approval did not say "${ALL_CONTACTS_MARK}${contacts.length})". Add audience tags, or request approval again so the approver sees who gets it.`);
    }
  }
  const audience = audienceLine(campaign, eligible.length);
  const start = enrollmentStart(new Date(), campaign.startAt);
  if (!(await claimLaunch(ctx, campaign, campaign.status, options.approvedByUserId))) {
    const current = await getCampaign(ctx, campaign.id);
    return { campaignId: campaign.id, status: current?.status ?? campaign.status, enrolled: 0, skippedSuppressed: 0, skippedNotReachable: 0, skippedRunning: 0, audience, alreadyLaunched: true, firstStepAt: start.toISOString() };
  }
  let enrolled = 0;
  let skippedRunning = 0;
  for (const contact of eligible) {
    const existing = await enrollmentsForContact(ctx, campaign.id, contact.id);
    try {
      const enrollment = startEnrollment({
        companyId,
        campaignId: campaign.id,
        contactId: contact.id,
        existing,
        steps,
        now: start,
        variant: pickVariant(campaign, steps, contact.id),
      });
      await insertEnrollment(ctx, enrollment);
      enrolled += 1;
    } catch {
      // already running in this campaign
      skippedRunning += 1;
    }
  }
  return { campaignId: campaign.id, status: "active", enrolled, skippedSuppressed: suppressedCount, skippedNotReachable: notReachable, skippedRunning, audience, firstStepAt: start.toISOString() };
}

function launchSummary(result: LaunchResult): string {
  const skipped = [
    result.skippedSuppressed ? `${result.skippedSuppressed} left out (unsubscribed or bounced)` : "",
    result.skippedNotReachable ? `${result.skippedNotReachable} left out (no mobile number or no opt-in on record)` : "",
    result.skippedRunning ? `${result.skippedRunning} already in it` : "",
  ].filter(Boolean).join(", ");
  const first = Date.parse(result.firstStepAt) > Date.now() + 60_000 ? ` The first step is due ${result.firstStepAt.slice(0, 16).replace("T", " ")} UTC.` : "";
  return `Launched: ${result.enrolled} contact${result.enrolled === 1 ? "" : "s"} enrolled${skipped ? ` (${skipped})` : ""}.${first}`;
}

/** A person marked the approval done: launch now, or hand the approval back with the reason. */
async function launchOnApproval(ctx: PluginContext, companyId: string, campaign: CampaignDraft, issueId: string, approvedByUserId: string | null): Promise<LaunchResult | null> {
  try {
    const result = await launchCampaign(ctx, companyId, campaign, { approvedByUserId });
    if (!result.alreadyLaunched) await commentOn(ctx, companyId, issueId, launchSummary(result));
    return result;
  } catch (error) {
    // Only a known problem hands the approval back; a host or database error waits for the next sweep.
    if (!(error instanceof CampaignError)) throw error;
    await setLaunchError(ctx, campaign.id, error.message);
    const userId = approvedByUserId ?? (await approverUserId(ctx, companyId, campaign));
    try {
      await ctx.issues.update(issueId, { status: "todo", assigneeAgentId: null, assigneeUserId: userId }, companyId);
      await commentOn(ctx, companyId, issueId, `Approved, but the campaign could not launch: ${error.message}\n\nFix that, then mark this issue **done** again to launch it. Cancel the issue to drop the launch.`);
    } catch (updateError) {
      ctx.logger.info("Could not hand the approval back after a failed launch", { issueId, error: updateError instanceof Error ? updateError.message : String(updateError) });
    }
    return null;
  }
}

/** A person refused the launch: the draft can be fixed and sent for approval again; its agent gets a task to do that. */
async function onApprovalRefused(ctx: PluginContext, companyId: string, campaign: CampaignDraft, issueId: string): Promise<void> {
  await clearApproval(ctx, campaign.id);
  const owner = await workOwner(ctx, companyId, campaign);
  await openIssueOnce(ctx, {
    companyId,
    originId: reviseOrigin(campaign.id, issueId),
    title: `${clientPrefix(campaign.clientRef ? campaign.clientName : null)}Revise campaign ${campaign.name}: not approved`,
    description: [
      `A person cancelled the launch approval of campaign **${campaign.name}** (\`${campaign.id}\`), so it did not launch.`,
      "",
      `1. Read their comments on the approval issue ${issueId}.`,
      "2. Fix the draft: update-campaign, add-campaign-step, create-ab-variant or set-step-html.",
      "3. Call request-campaign-approval again, then mark this issue done.",
      "",
      "When you close it, Campaigns checks the draft changed after the refusal and a new approval is open; if it reopens, finish what it lists.",
      "If the comments say to drop the campaign, mark this issue cancelled and leave the draft.",
    ].join("\n"),
    assignee: assigneeFields(owner),
    wakeReason: "A campaign launch was not approved",
    projectId: await projectForCampaign(ctx, companyId, campaign),
  });
}

async function commentOn(ctx: PluginContext, companyId: string, issueId: string, body: string): Promise<void> {
  try {
    await ctx.issues.createComment(issueId, body, companyId);
  } catch (error) {
    ctx.logger.info("Campaign comment not added", { issueId, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * A draft's content or audience changed after approval was asked for: the
 * approver would not see what goes out, so that approval is cancelled and a
 * new one is needed. True when there was one.
 */
async function invalidateApproval(ctx: PluginContext, companyId: string, campaign: CampaignDraft, what: string): Promise<boolean> {
  const issueId = campaign.approvalIssueId;
  if (!issueId || campaign.status !== "draft") return false;
  const issue = await ctx.issues.get(issueId, companyId).catch(() => null);
  if (issue && issue.status !== "done" && issue.status !== "cancelled") {
    try {
      await ctx.issues.update(issueId, { status: "cancelled" }, companyId);
      await commentOn(ctx, companyId, issueId, `Cancelled: ${what} after this approval was asked for, so this is no longer what would go out. The campaign needs a new approval issue (request-campaign-approval).`);
    } catch (error) {
      ctx.logger.info("Could not cancel the out-of-date approval", { issueId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  await clearApproval(ctx, campaign.id);
  campaign.approvalIssueId = null;
  return true;
}

/** Stop one contact's enrollment, or every campaign of that contact. */
async function stopEnrollmentTool(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const enrollment = await enrollmentById(ctx, requiredString(params, "enrollmentId"));
  if (!enrollment || enrollment.companyId !== companyId) throw new CampaignError("Enrollment was not found");
  const everyCampaign = params.everyCampaign === true;
  if (everyCampaign) await stopEnrollmentsForContact(ctx, companyId, enrollment.contactId);
  else if (enrollment.status === "running") await stopEnrollment(ctx, enrollment.id);
  return { enrollmentId: enrollment.id, contactId: enrollment.contactId, stopped: everyCampaign ? "every campaign" : "this campaign" };
}

/**
 * An agent records an opt-out: the sender's campaigns stop for the address and the
 * CRM and Mailbox are told. `client` names the sender (a client's list, or `own`);
 * without it the opt-out is for every sender.
 */
async function suppressAddressTool(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const email = requiredString(params, "email").toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new CampaignError("email must be one email address");
  const raw = optionalString(params, "reason") ?? "unsubscribe";
  if (raw !== "unsubscribe" && raw !== "complaint" && raw !== "manual") throw new CampaignError("reason must be unsubscribe, complaint or manual");
  const scope = readClientScope(params);
  const senderKey = scope === undefined ? "" : senderKeyOf(scope ? { clientKind: scope.kind, clientRef: scope.id } : null);
  const outcome = await suppressAddress(ctx, { companyId, email, reason: raw, scope: "marketing", source: PLUGIN_ID, senderKey });
  const announced = await announceSuppression(ctx, companyId, suppressionPayload({ email, reason: raw, scope: "marketing", senderKey, ...(scope ? { clientKind: scope.kind, clientRef: scope.id } : {}) }));
  return { email, reason: raw, scope: "marketing", sender: senderKey || "every sender", added: outcome.created, stoppedContacts: outcome.stoppedContacts, cancelledStepIssues: outcome.cancelledIssues, announced };
}

/** An agent records what it did about a reply (answered, or nothing to answer); the reply issue's done check counts it. */
async function logReplyTool(ctx: PluginContext, companyId: string, params: Record<string, unknown>, agentId: string | null) {
  const messageId = requiredString(params, "messageId");
  const outcome = requiredString(params, "outcome");
  if (!(REPLY_OUTCOMES as string[]).includes(outcome)) throw new CampaignError("outcome must be answered or no-reply-needed");
  const note = requiredString(params, "note").slice(0, 1000);
  const mailDraftId = optionalString(params, "mailDraftId")?.slice(0, 200) ?? null;
  const reply = await replyEvent(ctx, companyId, messageId);
  if (!reply) throw new CampaignError(`No campaign reply has Mailbox message id ${messageId}. Use the messageId from the reply issue.`);
  const id = await insertReplyLog(ctx, { companyId, messageId, campaignId: reply.campaignId, enrollmentId: reply.enrollmentId, outcome: outcome as (typeof REPLY_OUTCOMES)[number], note, mailDraftId, createdBy: agentId ? `agent:${agentId}` : null });
  return { logged: true, id, messageId, outcome, campaignId: reply.campaignId, enrollmentId: reply.enrollmentId, next: "Mark the reply issue done." };
}

async function setStatus(ctx: PluginContext, companyId: string, params: Record<string, unknown>, to: "paused" | "active" | "completed") {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  if (to === "paused") assertCanPause(campaign.status);
  if (to === "active") {
    if (campaign.status !== "paused") throw new CampaignError("Only a paused campaign can be resumed");
  }
  if (to === "completed") assertCanComplete(campaign.status);
  campaign.status = to;
  await saveCampaign(ctx, campaign);
  return { campaignId: campaign.id, status: to };
}

async function stats(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  const counts = await campaignStats(ctx, campaign.id);
  return { campaignId: campaign.id, ...counts };
}

async function enroll(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  if (campaign.status !== "active" && campaign.status !== "draft") {
    throw new CampaignError("Enroll only in an active or draft campaign");
  }
  const steps = await listSteps(ctx, campaign.id);
  const contactId = requiredString(params, "contactId");
  const [contact] = await crmContactsByIds(ctx, companyId, [contactId]);
  if (!contact) throw new CampaignError(`CRM contact ${contactId} was not found. The CRM shares new contacts within 15 minutes; try again after that.`);
  const address = campaignAddress(contact.emails);
  if (address && (await isSuppressed(ctx, companyId, address, campaignSenderKey(campaign)))) {
    throw new CampaignError(`${address} unsubscribed or bounced, so it may not get campaigns.`);
  }
  if (isMessagingChannel(firstChannel(steps))) {
    // A text campaign enrolls only people with a mobile number, an opt-in on record for this sender and no block.
    const reach = await launchAudience(ctx, companyId, campaign, steps, [contactId]);
    if (reach.eligible.length === 0) throw new CampaignError(`${contact.name} cannot be enrolled in a ${firstChannel(steps) === "sms" ? "SMS" : "WhatsApp"} campaign: they need a mobile number on the contact, a recorded opt-in for this sender (record-channel-consent) and not be on the do-not-message list.`);
  }
  const existing = await enrollmentsForContact(ctx, campaign.id, contactId);
  const enrollment = startEnrollment({
    companyId,
    campaignId: campaign.id,
    contactId,
    existing,
    steps,
    now: enrollmentStart(new Date(), campaign.startAt),
    variant: pickVariant(campaign, steps, contactId),
  });
  await insertEnrollment(ctx, enrollment);
  return enrollment;
}

async function openDueSteps(ctx: PluginContext) {
  const due = await dueEnrollments(ctx);
  const campaigns = new Map<string, Promise<CampaignDraft | null>>();
  const enabled = new Map<string, Promise<boolean>>();
  for (const enrollment of due) {
    try {
      if (!enabled.has(enrollment.companyId)) enabled.set(enrollment.companyId, isModuleEnabled(ctx, enrollment.companyId, PLUGIN_ID));
      if (!(await enabled.get(enrollment.companyId))) continue;
      const steps = await listSteps(ctx, enrollment.campaignId);
      // The contact's A/B arm; a position without a B version sends A.
      const step = stepFor(steps, enrollment.stepPosition, enrollment.variant);
      if (!step) continue;
      if (!campaigns.has(enrollment.campaignId)) campaigns.set(enrollment.campaignId, getCampaign(ctx, enrollment.campaignId));
      const campaign = await campaigns.get(enrollment.campaignId)!;
      const openIssue = async (note?: string) => {
        const contact = await projectedContact(ctx, ctx.db.namespace, enrollment.companyId, enrollment.contactId);
        // The subject and body with this contact's name and company filled in, and the footer that says who we
        // are and how to opt out (with this contact's own unsubscribe link): an email sent by hand carries it too.
        const email = await handSentEmail(ctx, { companyId: enrollment.companyId, campaign, step, contact });
        const copy = stepIssueCopy(contact?.name ?? enrollment.contactId, { ...step, subject: email.subject, body: email.text }, campaign?.clientRef ? campaign.clientName : null);
        const to = contact?.emails?.[0] ? `\n\nSend to: ${contact.name} <${contact.emails[0]}>` : "";
        const how = [
          "",
          "---",
          `Campaign step ${step.position}${step.variant === "b" ? " (variant B)" : ""} for \`contact:${enrollment.contactId}\`. Send this email as written (subject: the issue title before the colon), including the last lines that say who we are and how to unsubscribe: never cut them. Then mark this issue **done**: that moves them to the next step. Cancel the issue to stop the campaign for this contact.`,
        ].join("\n");
        // Explicit companyId: jobs have no invocation scope; the host allows the
        // call only for a company with saved Campaigns settings.
        const projectId = await projectForCampaign(ctx, enrollment.companyId, campaign);
        const issue = await createWorkIssue(ctx, {
          companyId: enrollment.companyId,
          title: copy.title,
          description: `${note ? `${note}\n\n` : ""}${copy.description}${to}${how}`,
          originKind: "plugin:partnersinbiz.campaigns",
          originId: stepOrigin(enrollment.id, step.position),
          ...(projectId ? { projectId } : {}),
          ...(await campaignAssignee(ctx, enrollment.companyId, campaign)),
          wakeReason: "A campaign step is due",
        });
        enrollment.openIssueId = issue.id;
        await saveEnrollment(ctx, enrollment);
      };
      if (campaign && isAutomatic(campaign.delivery)) {
        // Each step goes out on its own channel: email through the Mailbox, SMS and WhatsApp through the provider.
        if (stepChannel(step) === "email") await sendCampaignStep(ctx, { campaign, enrollment, step, issueFallback: (note) => openIssue(note) });
        else await sendMessagingStep(ctx, { campaign, enrollment, step, steps });
        continue;
      }
      // Issue delivery: never ask anyone to email an address that unsubscribed or bounced.
      const contact = await projectedContact(ctx, ctx.db.namespace, enrollment.companyId, enrollment.contactId);
      const address = campaignAddress(contact?.emails);
      if (address && campaign && (await isSuppressed(ctx, enrollment.companyId, address, campaignSenderKey(campaign)))) {
        await saveEnrollment(ctx, { ...enrollment, status: "stopped", nextDueAt: null });
        continue;
      }
      await openIssue();
    } catch (error) {
      ctx.logger.error("Campaign due step failed", {
        enrollmentId: enrollment.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** A step issue closed: done moves the contact to the next step; cancelled stops the campaign for them. */
async function closeStep(ctx: PluginContext, enrollment: EnrollmentDraft, status: string): Promise<void> {
  if (status === "cancelled") {
    await saveEnrollment(ctx, { ...enrollment, status: "stopped", nextDueAt: null, openIssueId: null });
    return;
  }
  const steps = await listSteps(ctx, enrollment.campaignId);
  await saveEnrollment(ctx, advanceEnrollment(enrollment, steps, new Date()));
}

/** Job: step issues closed while we did not hear about it. */
async function catchUpStepIssues(ctx: PluginContext): Promise<number> {
  let closed = 0;
  for (const row of await closedStepIssues(ctx)) {
    try {
      const { issueStatus, ...enrollment } = row;
      await closeStep(ctx, enrollment, issueStatus);
      closed += 1;
    } catch (error) {
      ctx.logger.info("Campaign step catch-up failed", { enrollmentId: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return closed;
}

/**
 * Job: drafts whose approval is done but did not launch (the event was
 * missed). A person's approval launches; one closed while an agent held it
 * goes back to a person.
 */
async function catchUpApprovals(ctx: PluginContext): Promise<number> {
  let handled = 0;
  for (const { campaign, issueAgentId, issueUserId } of await approvedDrafts(ctx)) {
    const companyId = campaign.companyId;
    try {
      if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) continue;
      if (!(await configSaved(ctx, companyId))) continue;
      if (!campaign.approvalIssueId) continue;
      if (issueAgentId) {
        await reopenApprovalForPerson(ctx, { issueId: campaign.approvalIssueId, companyId, userId: await approverUserId(ctx, companyId, campaign), what: `launch of campaign ${campaign.name}` });
      } else {
        await launchOnApproval(ctx, companyId, campaign, campaign.approvalIssueId, issueUserId);
      }
      handled += 1;
    } catch (error) {
      ctx.logger.info("Campaign approval catch-up failed", { campaignId: campaign.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return handled;
}

/**
 * `issue.updated`:
 * - a step issue done moves the contact on; cancelled stops it (any actor);
 * - a launch approval marked done by a person launches the campaign at once;
 *   cancelled by a person refuses it; closed by an agent goes back to a person.
 * Our own updates (actor `plugin`) are ignored for approvals.
 */
async function onIssueUpdated(ctx: PluginContext, event: PluginEvent) {
  const issueId = event.entityId;
  const companyId = event.companyId;
  if (!issueId || !companyId) return;
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue || (issue.status !== "done" && issue.status !== "cancelled")) return;
  const enrollment = await enrollmentByIssue(ctx, issue.id);
  if (enrollment) {
    await closeStep(ctx, enrollment, issue.status);
    return;
  }
  if (event.actorType === "plugin") return;
  const campaign = await campaignByApprovalIssue(ctx, issue.id);
  if (!campaign || campaign.companyId !== companyId || campaign.status !== "draft") return;
  const byPerson = event.actorType === "user" || (!event.actorType && !issue.assigneeAgentId);
  if (!byPerson) {
    await reopenApprovalForPerson(ctx, { issueId: issue.id, companyId, userId: await approverUserId(ctx, companyId, campaign), what: `launch of campaign ${campaign.name}` });
    return;
  }
  if (issue.status === "cancelled") {
    await onApprovalRefused(ctx, companyId, campaign, issue.id);
    return;
  }
  const personId = event.actorType === "user" && event.actorId ? event.actorId : issue.assigneeUserId ?? null;
  await launchOnApproval(ctx, companyId, campaign, issue.id, personId);
}

async function requestApproval(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  assertCanRequestApproval(campaign.status);
  if (campaign.approvalIssueId) {
    const current = await ctx.issues.get(campaign.approvalIssueId, companyId).catch(() => null);
    if (current && current.status !== "cancelled") throw new CampaignError(`Approval was already requested for this campaign (issue ${campaign.approvalIssueId}). It launches by itself once a person marks that issue done.`);
  }
  const steps = await listSteps(ctx, campaign.id);
  if (steps.length === 0) throw new CampaignError("Add at least one step (add-campaign-step) before asking for approval.");
  // The checks first: a client's campaign without its own sender, a channel that is not set up or a broken link never reaches an approver.
  const preflight = await gatherPreflight(ctx, companyId, campaign, steps, { network: true });
  if (!preflight.ok) {
    throw new CampaignError(`Fix these before asking for approval (preflight-campaign shows them again):\n${preflight.errors.map((finding) => `- ${finding.message}${finding.fix ? ` (${finding.fix})` : ""}`).join("\n")}`);
  }
  const setup = await messagingSetup(ctx, companyId);
  const { contacts, eligible, suppressedCount, notReachable, reach, agentRecorded } = await launchAudience(ctx, companyId, campaign, steps, [], setup.config.defaultCountry);
  const audience = audienceLine(campaign, contacts.length);
  const start = campaign.startAt && Date.parse(campaign.startAt) > Date.now() ? `on ${campaign.startAt.slice(0, 10)}` : "as soon as it is approved";
  const preview = steps
    .map((step) => {
      const channel = stepChannel(step);
      const after = `after ${step.delayDays} day${step.delayDays === 1 ? "" : "s"}`;
      if (channel === "email") return `${step.position}${step.variant === "b" ? "B" : ""}. **${step.subject}** (${after})\n${step.body || "(no body)"}`;
      const text = composeMessage(step, { name: "{{first_name}}" }).text;
      const parts = channel === "sms" ? `, ${smsLength(text).segments} SMS part${smsLength(text).segments === 1 ? "" : "s"}` : step.templateRef ? ", approved template" : ", free-form (only reaches people who wrote in the last 24 hours)";
      return `${step.position}${step.variant === "b" ? "B" : ""}. **${CHANNEL_LABELS[channel]}** (${after}${parts})\n${text}`;
    })
    .join("\n\n");
  const used = channelsUsed(steps);
  const channelLines = used.filter(isMessagingChannel).map((channel) => {
    const info = preflight.channels.find((entry) => entry.channel === channel);
    return `- **${CHANNEL_LABELS[channel]}:** from ${info?.sentFrom ?? "the sender number"}. Only sent ${describeWindows(setup.config.windows)} (${setup.config.timezone}). ${reach[channel]} of ${contacts.length} contacts have a mobile number and a recorded opt-in for this sender; the rest skip these steps.${agentRecorded[channel] ? ` **${agentRecorded[channel]} of those opt-ins were recorded by an agent** (typed-in evidence, not a form or an import): ask to see the evidence before approving.` : ""} Every message says how to opt out (reply STOP).`;
  });
  const automatic = isAutomatic(campaign.delivery);
  const deliveryLine = campaign.delivery === "auto"
    ? "- **Delivery:** automatic. Each due step goes out on its own channel: email through the Mailbox as marketing mail, SMS and WhatsApp through the messaging provider. {{first_name}} and the other tokens are filled in per contact."
    : campaign.delivery === "email"
      ? "- **Delivery:** email. The Mailbox sends each due step as marketing mail (with an unsubscribe header). {{first_name}} and the other tokens are filled in per contact."
      : "- **Delivery:** issue. Each due step opens an issue and the campaign's agent sends the email.";
  const description = [
    `Mark this issue **done** to approve campaign **${campaign.name}**: it then launches by itself. Cancel the issue to refuse it (its agent gets a task to revise it).`,
    "",
    `See every email, who gets it and when on the Campaigns page: [${campaign.name}](${await campaignPageLink(ctx, companyId, campaign)}).`,
    "",
    `- **Audience:** ${audience}${suppressedCount ? `. ${suppressedCount} unsubscribed or bounced address${suppressedCount === 1 ? " is" : "es are"} left out, so ${eligible.length} get it` : ""}${notReachable ? `. ${notReachable} ha${notReachable === 1 ? "s" : "ve"} no mobile number or no opt-in on record and ${notReachable === 1 ? "is" : "are"} left out` : ""}.`,
    deliveryLine,
    ...(automatic && preflight.sentAs ? [`- **Sent as:** ${preflight.sentAs}.`] : []),
    ...(automatic && used.includes("email") ? ["- **Added to every email:** who sent it and how to stop (an unsubscribe link and \"reply STOP\"), after the text below."] : []),
    ...(!automatic && used.includes("email") ? ["- **Added to every step issue:** the same footer (who sent it, the person's own unsubscribe link, \"reply STOP\"), after the text below, for the agent to send whole."] : []),
    ...(automatic ? channelLines : []),
    `- **Starts:** ${start}.`,
    "- **Rules:** every email says who we are, why they get it, and how to opt out (reply STOP, or the unsubscribe link). Opt-outs are honoured automatically (POPIA).",
    ...(preflight.warnings.length ? ["", "**Check before approving:**", ...preflightLines({ ...preflight, errors: [] })] : []),
    "",
    preview,
  ].join("\n");
  // A launch is outward-facing: the Reviewer checks it first when the company has one, then a person decides; it never opens unassigned.
  const approval = await openApprovalIssue(ctx, {
    companyId,
    title: `${clientPrefix(campaign.clientRef ? campaign.clientName : null)}Approve campaign ${campaign.name}`,
    description,
    originKind: ORIGIN,
    originId: approvalOrigin(campaign.id),
    projectId: await projectForCampaign(ctx, companyId, campaign),
    outward: true,
    actorUserId: campaign.ownerUserId,
    reviewerBrief: (route) => launchReviewBrief(campaign, route.approverUserId),
    wakeReason: "Review a campaign launch before a person approves it",
  });
  campaign.approvalIssueId = approval.id;
  await saveCampaign(ctx, campaign);
  await setLaunchError(ctx, campaign.id, null);
  return {
    campaignId: campaign.id,
    approvalIssueId: approval.id,
    audience,
    willGet: eligible.length,
    leftOut: suppressedCount,
    routedTo: approval.assignedTo === "reviewer" ? "reviewer" : approval.assignedTo === "person" ? "approver" : approval.assignedTo === "operator" ? "operator" : "unassigned",
    warnings: preflight.warnings.map((finding) => finding.message),
    next: "Wait. A person approves on the issue and the campaign then launches by itself. Editing the draft now cancels this approval.",
  };
}

/** The campaign's detail view on the Campaigns page (`/<prefix>/campaigns?campaign=<id>`, with the client when it has one). */
async function campaignPageLink(ctx: PluginContext, companyId: string, campaign: CampaignDraft): Promise<string> {
  const prefix = await ctx.companies.get(companyId).then((company) => company?.issuePrefix ?? null).catch(() => null);
  const path = withClientParam(`/campaigns?campaign=${encodeURIComponent(campaign.id)}`, campaignScope(campaign));
  return prefix ? `/${prefix}${path}` : path;
}

/** What the Reviewer checks on a campaign launch. */
export function launchReviewBrief(campaign: Pick<CampaignDraft, "name" | "delivery" | "audienceMode" | "audienceTags" | "clientName" | "clientRef">, approverUserId: string | null): string {
  const audience = campaign.audienceMode === "tags"
    ? `contacts tagged ${campaign.audienceTags.length ? campaign.audienceTags.map((tag) => `\`${tag}\``).join(", ") : "(no tags: all contacts)"}`
    : campaign.audienceMode === "client_contact"
      ? `the client contact ${campaign.clientName ?? campaign.clientRef ?? ""}`.trim()
      : `the contacts at ${campaign.clientName ?? campaign.clientRef ?? "the client"}`;
  return reviewerBrief({
    what: `the launch of campaign ${campaign.name} (${campaign.delivery === "email" ? "sent by email through the Mailbox" : "each step opens an issue"})`,
    checks: [
      "Subject and body of every step and every A/B variant: clear, on brand, no typos, and every {{token}} reads well when filled in (use {{first_name|there}} where a name may be missing).",
      `Audience matches the intent: this campaign goes to ${audience}. Nobody who should not get it (existing clients mid-project, partners, staff).`,
      "Suppressions: unsubscribed and bounced addresses are left out automatically; flag any contact in the audience who asked not to be emailed.",
      "Links: every link works and points to the right page, with no test or staging URLs.",
      "Sender: the 'Sent as' line is who the recipient sees (a client's campaign goes out as the client, never from PiB's own Gmail or number), and the reply-to is right.",
      "Texts: an SMS or WhatsApp step only reaches people with a recorded opt-in; check the wording makes sense in a few characters and says who we are.",
      "Compliance (POPIA): says who we are, why they get it, and how to opt out (reply STOP or unsubscribe); makes no claims we cannot back up.",
    ],
    handTo: approverUserId ? { userId: approverUserId, label: `the approver (user \`${approverUserId}\`)` } : { label: "a board member (unassign the agent so the board sees it)" },
  });
}

async function createAbVariant(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  if (campaign.status !== "draft") throw new CampaignError("A/B variants can only be added to a draft campaign");
  const position = integer(params.position, "position");
  const existing = await listSteps(ctx, campaign.id);
  const original = existing.find((step) => step.position === position && step.variant === "a");
  if (!original) {
    throw new CampaignError("There is no A variant at that position");
  }
  if (existing.some((step) => step.position === position && step.variant === "b")) {
    throw new CampaignError("A B variant already exists at that position");
  }
  // A B version goes out on the same channel as its A version.
  const channel = stepChannel(original);
  const body = optionalString(params, "body") ?? "";
  if (channel !== "email" && !body) throw new CampaignError("An SMS or WhatsApp step needs body text.");
  const step: CampaignStepDraft = {
    position,
    delayDays: 0,
    subject: channel === "email" ? requiredString(params, "subject") : optionalString(params, "subject") ?? "",
    body,
    htmlBody: null,
    variant: "b",
    channel,
    templateRef: original.templateRef ?? null,
    templateVars: original.templateVars ?? [],
  };
  await insertStep(ctx, { companyId, campaignId: campaign.id, step });
  await markEdited(ctx, campaign.id);
  const approvalReset = await invalidateApproval(ctx, companyId, campaign, `a B version of step ${position} was added`);
  return { campaignId: campaign.id, step, approvalReset };
}

async function funnel(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  const funnel = await campaignFunnel(ctx, campaign.id);
  return { campaignId: campaign.id, ...funnel };
}

async function recordStepEvent(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const enrollment = await enrollmentById(ctx, requiredString(params, "enrollmentId"));
  if (!enrollment || enrollment.companyId !== companyId) throw new CampaignError("Enrollment was not found");
  const eventType = assertEventType(requiredString(params, "eventType"));
  const stepPosition = params.stepPosition == null ? enrollment.stepPosition : integer(params.stepPosition, "stepPosition");
  await insertStepEvent(ctx, {
    companyId,
    campaignId: enrollment.campaignId,
    enrollmentId: enrollment.id,
    stepPosition,
    eventType,
  });
  return { enrollmentId: enrollment.id, stepPosition, eventType };
}

async function stepAnalytics(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  const byStep = await stepEventStats(ctx, campaign.id);
  return { campaignId: campaign.id, byStep };
}

async function setStepHtmlAction(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  // The approver saw the copy: what goes out may only change on a draft.
  if (campaign.status !== "draft") throw new CampaignError("Only a draft campaign's steps can change. Pause it and create a new draft instead.");
  const position = integer(params.position, "position");
  const variant = params.variant == null ? "a" : assertVariant(requiredString(params, "variant"));
  const html = requiredString(params, "html");
  const steps = await listSteps(ctx, campaign.id);
  const target = steps.find((step) => step.position === position && step.variant === variant);
  if (!target) throw new CampaignError("No step found at that position and variant");
  if (stepChannel(target) !== "email") throw new CampaignError("Only an email step has an HTML body.");
  await setStepHtml(ctx, { companyId, campaignId: campaign.id, position, variant, html });
  await markEdited(ctx, campaign.id);
  const approvalReset = await invalidateApproval(ctx, companyId, campaign, `the HTML of step ${position}${variant === "b" ? "B" : ""} changed`);
  return { campaignId: campaign.id, position, variant, htmlSet: true, approvalReset };
}

async function createTemplateAction(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const template = createCampaignTemplate({
    companyId,
    name: requiredString(params, "name"),
    description: optionalString(params, "description"),
    steps: templateSteps(params),
  });
  await insertCampaignTemplate(ctx, {
    id: template.id,
    company_id: template.companyId,
    name: template.name,
    description: template.description,
    steps: template.steps,
  });
  return template;
}

async function listTemplatesAction(ctx: PluginContext, companyId: string) {
  const rows = await listCampaignTemplates(ctx, companyId);
  return rows.map((row) => ({ id: row.id, name: row.name, description: row.description }));
}

async function createFromTemplate(ctx: PluginContext, companyId: string, params: Record<string, unknown>, owner: Owner = {}) {
  const template = await getCampaignTemplate(ctx, requiredString(params, "templateId"));
  if (!template || template.company_id !== companyId) throw new CampaignError("Template was not found");
  const steps = parseSteps(template.steps);
  const client = await requireClient(ctx, companyId, readClientScope(params) ?? null);
  const campaign = createCampaign({
    companyId,
    name: requiredString(params, "name"),
    client,
    audienceMode: optionalString(params, "audienceMode"),
    delivery: optionalString(params, "delivery"),
    ownerUserId: owner.userId ?? null,
    ownerAgentId: owner.agentId ?? null,
  });
  for (const step of steps) assertStepFitsDelivery(campaign.delivery, stepChannel(step));
  await insertCampaign(ctx, campaign);
  for (const step of steps) {
    await insertStep(ctx, { companyId, campaignId: campaign.id, step });
  }
  return { campaignId: campaign.id, stepCount: steps.length, client: publicCampaign(campaign).client };
}

function parseSteps(value: unknown): CampaignStepDraft[] {
  if (!Array.isArray(value)) return [];
  const result: CampaignStepDraft[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const step = item as Record<string, unknown>;
    const channel = step.channel === "sms" || step.channel === "whatsapp" ? step.channel : "email";
    result.push({
      position: result.length + 1,
      delayDays: typeof step.delayDays === "number" ? step.delayDays : 0,
      subject: String(step.subject ?? ""),
      body: typeof step.body === "string" ? step.body : "",
      htmlBody: null,
      variant: "a",
      channel,
      templateRef: channel === "whatsapp" && typeof step.templateRef === "string" ? step.templateRef : null,
      templateVars: [],
    });
  }
  return result;
}

function templateSteps(params: Record<string, unknown>): Array<{ subject: string; body: string; delayDays: number; channel?: ReturnType<typeof assertChannel>; templateRef?: string | null }> {
  if (!Array.isArray(params.steps)) return [];
  const result: Array<{ subject: string; body: string; delayDays: number; channel?: ReturnType<typeof assertChannel>; templateRef?: string | null }> = [];
  for (const item of params.steps) {
    if (!item || typeof item !== "object") continue;
    const step = item as Record<string, unknown>;
    const channel = assertChannel(step.channel);
    if (channel === "email" && typeof step.subject !== "string") continue;
    result.push({
      subject: typeof step.subject === "string" ? step.subject.trim() : "",
      body: typeof step.body === "string" ? step.body.trim() : "",
      delayDays: typeof step.delayDays === "number" ? step.delayDays : 0,
      channel,
      templateRef: channel === "whatsapp" ? assertTemplateRef(step.templateRef) : null,
    });
  }
  return result;
}

async function declareWinner(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  assertCanDeclareWinner(campaign.status);
  const winner = assertVariant(requiredString(params, "winner"));
  const suggestion = await abSuggestionFor(ctx, campaign.id);
  campaign.winnerVariant = winner;
  await saveCampaign(ctx, campaign);
  return { campaignId: campaign.id, winner, suggestion };
}

/** Reply-rate verdict per variant (kit `experimentVerdict`); a person still declares with declare-ab-winner. */
async function suggestWinner(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  const suggestion = await abSuggestionFor(ctx, campaign.id);
  return { campaignId: campaign.id, winnerVariant: campaign.winnerVariant, ...suggestion };
}

async function requireCampaign(ctx: PluginContext, companyId: string, id: string): Promise<CampaignDraft> {
  const campaign = await getCampaign(ctx, id);
  if (!campaign || campaign.companyId !== companyId) throw new CampaignError("Campaign was not found");
  return campaign;
}

function publicCampaign(campaign: CampaignDraft) {
  const scope = campaignScope(campaign);
  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    status: campaign.status,
    fromName: campaign.fromName,
    fromLocal: campaign.fromLocal,
    replyTo: campaign.replyTo,
    audienceTags: campaign.audienceTags,
    audienceMode: campaign.audienceMode,
    client: scope ? { kind: scope.kind, id: scope.id, name: campaign.clientName } : null,
    startAt: isoTime(campaign.startAt),
    endAt: isoTime(campaign.endAt),
    approvalIssueId: campaign.approvalIssueId,
    delivery: campaign.delivery,
    winnerVariant: campaign.winnerVariant,
    ownerAgentId: campaign.ownerAgentId,
    approvedByUserId: campaign.approvedByUserId ?? null,
    launchedAt: isoTime(campaign.launchedAt),
    launchError: campaign.launchError ?? null,
  };
}

/**
 * The client named by `client` / `clientKind`+`clientRef`. `undefined` when the
 * input does not mention a client; a malformed value is an error rather than
 * silently becoming own work.
 */
function readClientScope(params: Record<string, unknown>): ClientScope | undefined {
  const scope = clientScopeFromInput(params);
  if (scope !== undefined) return scope;
  const raw = "client" in params ? params.client : "clientRef" in params ? params.clientRef : undefined;
  if (raw === undefined) return undefined;
  throw new CampaignError("client must be company:<crm company id> or contact:<crm contact id>. Omit it for PiB's own work.");
}

/** The CRM record behind a client scope. Client work must name a client the CRM knows. */
async function requireClient(ctx: PluginContext, companyId: string, scope: ClientScope): Promise<CampaignClient | null> {
  if (!scope) return null;
  const client = await resolveCrmClient(ctx, ctx.db.namespace, companyId, scope);
  if (!client) {
    throw new CampaignError(`CRM ${scope.kind} ${scope.id} was not found. Run the CRM "resync" action if it was just created.`);
  }
  return { kind: client.kind, id: client.id, name: client.name };
}

// ── Cross-plugin summary for the CRM client workspace ───────────────────────

async function handleApiRoute(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  if (input.routeKey !== "client-summary") return { status: 404, body: { error: "Not found" } };
  try {
    const kind = firstQuery(input.query.kind);
    const id = firstQuery(input.query.id);
    const scope = parseClientParam(`${kind}:${id}`);
    if (!scope) return { status: 400, body: { error: "kind (company or contact) and a valid id are required" } };
    return { status: 200, body: await clientSummary(ctx, input.companyId, scope) };
  } catch (error) {
    ctx.logger.info("Campaigns client summary failed", { error: error instanceof Error ? error.message : String(error) });
    return { status: 500, body: { error: error instanceof Error ? error.message : "Summary failed" } };
  }
}

async function clientSummary(ctx: PluginContext, companyId: string, scope: NonNullable<ClientScope>): Promise<ClientSummary> {
  return campaignClientSummary(await clientCampaignCounts(ctx, companyId, scope));
}

function firstQuery(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim() : "";
}

function requiredCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new CampaignError("Company is required");
  return context.companyId;
}
