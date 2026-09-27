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
  approvedDrafts,
  audienceContacts,
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
  insertStep,
  insertStepEvent,
  isSuppressed,
  listCampaigns,
  listCampaignTemplates,
  listSteps,
  saveCampaign,
  saveEnrollment,
  setLaunchError,
  setStepHtml,
  stepEventStats,
  stopEnrollment,
  stopEnrollmentsForContact,
  suppressedEmails,
  suppressionCount,
  type AudienceContact,
} from "./db.js";
import {
  advanceEnrollment,
  ALL_CONTACTS_MARK,
  audienceLine,
  campaignAddress,
  enrollmentStart,
  isEveryContact,
  pickVariant,
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
import {
  clientScopeFromInput,
  COCKPIT_ROUTE,
  configSaved,
  createSkillSyncer,
  createWorkIssue,
  getCrmContact as projectedContact,
  isModuleEnabled,
  registerModuleWatch,
  registerRoleWatch,
  rememberPluginUiBase,
  reopenApprovalForPerson,
  reviewerAgentId,
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
import { abSuggestionFor, campaignAssignee, onMailReceived, onSendResult, openIssueOnce, personalStep, personalVars, redeliverMail, sendCampaignStep } from "./mail.js";
import { PLUGIN_ID } from "./namespace.js";
import { eventCounts, eventDays } from "./db.js";
import { eventTotals, weeklySends } from "./series.js";
import { publishAllSetupStatus, rememberCompany, setupStatus } from "./setup-status.js";
import { cockpitSnapshot, publishAllCockpit } from "./cockpit.js";
import { approverUserId, assigneeFields, workOwner } from "./owner.js";
import { announceSuppression, onContactSuppressed, reannounceSuppressions, suppressAddress, suppressionEvents, suppressionPayload } from "./suppress.js";

type Owner = { userId?: string | null; agentId?: string | null };

let pluginCtx: PluginContext | null = null;
let skillSync: ReturnType<typeof createSkillSyncer> | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    skillSync = createSkillSyncer(ctx, SKILLS);
    registerCrmProjection(ctx, ctx.db.namespace, { companies: true, contacts: true });
    registerModuleWatch(ctx);
    registerRoleWatch(ctx);
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
    ctx.jobs.register("setup-status", async () => {
      await trackJob(ctx, "setup-status", async () => {
        await publishAllSetupStatus(ctx);
        await publishAllCockpit(ctx);
        await reannounceSuppressions(ctx);
      });
    });
    ctx.events.on(pluginEvent(PIB_PLUGINS.mailbox, MAIL_EVENTS.received), async (event) => {
      // Replies are ignored while the Campaigns module is switched off for the company.
      if (event.companyId && !(await isModuleEnabled(ctx, event.companyId, PLUGIN_ID))) return;
      await onMailReceived(ctx, event);
    });
    ctx.events.on(pluginEvent(PIB_PLUGINS.mailbox, MAIL_EVENTS.sendResult), (event) => onSendResult(ctx, event));
    // Unsubscribes and hard bounces from the CRM and the Mailbox join Campaigns' own list.
    for (const eventType of suppressionEvents()) {
      ctx.events.on(eventType as `plugin.${string}`, (event) => onContactSuppressed(ctx, event));
    }
    ctx.events.on("issue.updated", async (event) => {
      try {
        await onIssueUpdated(ctx, event);
      } catch (error) {
        ctx.logger.error("Campaign issue update failed", { issueId: event.entityId, error: error instanceof Error ? error.message : String(error) });
      }
    });
    ctx.events.on("company.created", async (event) => {
      if (event.companyId) await skillSync?.ensure(event.companyId);
    });
    ctx.logger.info("Campaigns plugin ready");
  },
  async onHealth() {
    return { status: "ok", message: "Campaigns plugin ready" };
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

async function dispatch(ctx: PluginContext, name: string, body: Record<string, unknown>, run: ToolRunContext): Promise<unknown> {
  const companyId = run.companyId;
  if (name === "create-campaign") return createCampaignRecord(ctx, companyId, body, { agentId: run.agentId });
  if (name === "update-campaign") return updateCampaignRecord(ctx, companyId, body);
  if (name === "list-campaigns") return listCampaignsRecord(ctx, companyId, body);
  if (name === "add-campaign-step") return addStep(ctx, companyId, body);
  if (name === "launch-campaign") return launch(ctx, companyId, body);
  if (name === "stop-enrollment") return stopEnrollmentTool(ctx, companyId, body);
  if (name === "suppress-address") return suppressAddressTool(ctx, companyId, body);
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
  return {
    campaigns: result,
    suppressed,
    series: { weeks: weeklySends(days, now, 12, ids), byCampaign: eventTotals(counts, ids) },
    settingsSaved: Object.keys(config).length > 0,
    client: scope ? await clientDetails(ctx, companyId, scope, campaigns) : null,
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
  const [steps, stats, enrollments, audience, approval] = await Promise.all([
    listSteps(ctx, campaign.id),
    campaignStats(ctx, campaign.id),
    enrollmentViews(ctx, campaign.id),
    launchAudience(ctx, companyId, campaign).catch(() => null),
    campaign.approvalIssueId ? ctx.issues.get(campaign.approvalIssueId, companyId).catch(() => null) : Promise.resolve(null),
  ]);
  const running = enrollments.filter((row) => row.status === "running");
  return {
    campaign: { ...publicCampaign(campaign), steps, stats, approvalStatus: approval?.status ?? null },
    approval: approval
      ? { issueId: approval.id, identifier: approval.identifier ?? null, status: approval.status, withPerson: Boolean(approval.assigneeUserId), withAgent: Boolean(approval.assigneeAgentId) }
      : null,
    audience: audience
      ? { matching: audience.contacts.length, willGet: audience.eligible.length, leftOut: audience.suppressedCount, sample: audience.eligible.slice(0, 5).map((contact) => contact.name) }
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
  const next: CampaignDraft = { ...edited, approvalIssueId: campaign.approvalIssueId, winnerVariant: campaign.winnerVariant };
  // What goes out, to whom and when changed after approval was asked for: that approval no longer counts.
  const approvalReset = approvalFields(next) !== approvalFields(original)
    ? await invalidateApproval(ctx, companyId, next, "the campaign's audience, sender, delivery or dates changed")
    : false;
  await saveCampaign(ctx, next);
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
  const step: CampaignStepDraft = {
    // After the last step (a B version shares its step's position, so counting rows would skip one).
    position: steps.reduce((last, row) => Math.max(last, row.position), 0) + 1,
    delayDays: params.delayDays == null ? 0 : integer(params.delayDays, "delayDays"),
    subject: requiredString(params, "subject"),
    body: optionalString(params, "body") ?? "",
    htmlBody: null,
    variant: "a",
  };
  await insertStep(ctx, { companyId, campaignId: campaign.id, step });
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
  /** Left out because the address is on the do-not-email list. */
  skippedSuppressed: number;
  /** Already running in this campaign. */
  skippedRunning: number;
  audience: string;
  /** True when another launch got there first. */
  alreadyLaunched?: boolean;
  firstStepAt: string;
}

/** Who a launch enrolls, with suppressed addresses left out. */
async function launchAudience(ctx: PluginContext, companyId: string, campaign: CampaignDraft, contactIds: string[] = []) {
  const contacts: AudienceContact[] = contactIds.length > 0
    ? await crmContactsByIds(ctx, companyId, contactIds)
    : await audienceContacts(ctx, companyId, campaign);
  const suppressed = await suppressedEmails(ctx, companyId, contacts.map((contact) => campaignAddress(contact.emails) ?? "").filter(Boolean));
  const eligible = contacts.filter((contact) => {
    const address = campaignAddress(contact.emails);
    return !address || !suppressed.has(address);
  });
  return { contacts, eligible, suppressedCount: contacts.length - eligible.length };
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
  const explicitIds = options.contactIds ?? [];
  const { contacts, eligible, suppressedCount } = await launchAudience(ctx, companyId, campaign, explicitIds);
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
    return { campaignId: campaign.id, status: current?.status ?? campaign.status, enrolled: 0, skippedSuppressed: 0, skippedRunning: 0, audience, alreadyLaunched: true, firstStepAt: start.toISOString() };
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
  return { campaignId: campaign.id, status: "active", enrolled, skippedSuppressed: suppressedCount, skippedRunning, audience, firstStepAt: start.toISOString() };
}

function launchSummary(result: LaunchResult): string {
  const skipped = [
    result.skippedSuppressed ? `${result.skippedSuppressed} left out (unsubscribed or bounced)` : "",
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
    originId: `revise:${issueId}`,
    title: `${clientPrefix(campaign.clientRef ? campaign.clientName : null)}Revise campaign ${campaign.name}: not approved`,
    description: [
      `A person cancelled the launch approval of campaign **${campaign.name}** (\`${campaign.id}\`), so it did not launch.`,
      "",
      `1. Read their comments on the approval issue ${issueId}.`,
      "2. Fix the draft: update-campaign, add-campaign-step, create-ab-variant or set-step-html.",
      "3. Call request-campaign-approval again, then mark this issue done.",
      "",
      "If the comments say to drop the campaign, mark this issue cancelled and leave the draft.",
    ].join("\n"),
    assignee: assigneeFields(owner),
    wakeReason: "A campaign launch was not approved",
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

/** An agent records an opt-out: every campaign stops and the CRM and Mailbox are told. */
async function suppressAddressTool(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const email = requiredString(params, "email").toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new CampaignError("email must be one email address");
  const raw = optionalString(params, "reason") ?? "unsubscribe";
  if (raw !== "unsubscribe" && raw !== "complaint" && raw !== "manual") throw new CampaignError("reason must be unsubscribe, complaint or manual");
  const outcome = await suppressAddress(ctx, { companyId, email, reason: raw, scope: "marketing", source: PLUGIN_ID });
  const announced = await announceSuppression(ctx, companyId, suppressionPayload({ email, reason: raw, scope: "marketing" }));
  return { email, reason: raw, scope: "marketing", added: outcome.created, stoppedContacts: outcome.stoppedContacts, cancelledStepIssues: outcome.cancelledIssues, announced };
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
  if (address && (await isSuppressed(ctx, companyId, address))) {
    throw new CampaignError(`${address} unsubscribed or bounced, so it may not get campaigns.`);
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
        // The subject and body with this contact's name and company filled in.
        const personal = personalStep(step, await personalVars(ctx, enrollment.companyId, campaign, contact));
        const copy = stepIssueCopy(contact?.name ?? enrollment.contactId, personal, campaign?.clientRef ? campaign.clientName : null);
        const to = contact?.emails?.[0] ? `\n\nSend to: ${contact.name} <${contact.emails[0]}>` : "";
        const how = [
          "",
          "---",
          `Campaign step ${step.position}${step.variant === "b" ? " (variant B)" : ""} for \`contact:${enrollment.contactId}\`. Send this email as written (subject: the issue title before the colon), then mark this issue **done**: that moves them to the next step. Cancel the issue to stop the campaign for this contact.`,
        ].join("\n");
        // Explicit companyId: jobs have no invocation scope; the host allows the
        // call only for a company with saved Campaigns settings.
        const issue = await createWorkIssue(ctx, {
          companyId: enrollment.companyId,
          title: copy.title,
          description: `${note ? `${note}\n\n` : ""}${copy.description}${to}${how}`,
          originKind: "plugin:partnersinbiz.campaigns",
          originId: enrollment.id,
          ...(await campaignAssignee(ctx, enrollment.companyId, campaign)),
          wakeReason: "A campaign step is due",
        });
        enrollment.openIssueId = issue.id;
        await saveEnrollment(ctx, enrollment);
      };
      if (campaign?.delivery === "email") {
        await sendCampaignStep(ctx, { campaign, enrollment, step, issueFallback: (note) => openIssue(note) });
        continue;
      }
      // Issue delivery: never ask anyone to email an address that unsubscribed or bounced.
      const contact = await projectedContact(ctx, ctx.db.namespace, enrollment.companyId, enrollment.contactId);
      const address = campaignAddress(contact?.emails);
      if (address && (await isSuppressed(ctx, enrollment.companyId, address))) {
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
  const { contacts, eligible, suppressedCount } = await launchAudience(ctx, companyId, campaign);
  const audience = audienceLine(campaign, contacts.length);
  const start = campaign.startAt && Date.parse(campaign.startAt) > Date.now() ? `on ${campaign.startAt.slice(0, 10)}` : "as soon as it is approved";
  const preview = steps
    .map((step) => `${step.position}${step.variant === "b" ? "B" : ""}. **${step.subject}** (after ${step.delayDays} day${step.delayDays === 1 ? "" : "s"})\n${step.body || "(no body)"}`)
    .join("\n\n");
  const description = [
    `Mark this issue **done** to approve campaign **${campaign.name}**: it then launches by itself. Cancel the issue to refuse it (its agent gets a task to revise it).`,
    "",
    `See every email, who gets it and when on the Campaigns page: [${campaign.name}](${await campaignPageLink(ctx, companyId, campaign)}).`,
    "",
    `- **Audience:** ${audience}${suppressedCount ? `. ${suppressedCount} unsubscribed or bounced address${suppressedCount === 1 ? " is" : "es are"} left out, so ${eligible.length} get it` : ""}.`,
    campaign.delivery === "email"
      ? "- **Delivery:** email. The Mailbox sends each due step from Gmail as marketing mail (with an unsubscribe header). {{first_name}} and the other tokens are filled in per contact."
      : "- **Delivery:** issue. Each due step opens an issue and the campaign's agent sends the email.",
    `- **Starts:** ${start}.`,
    "- **Rules:** every email says who we are, why they get it, and how to opt out (reply STOP, or the unsubscribe link). Opt-outs are honoured automatically (POPIA).",
    "",
    preview,
  ].join("\n");
  // A launch is outward-facing: the Reviewer checks it first when the company has one, then hands it to the person.
  const reviewer = await reviewerAgentId(ctx, companyId);
  const approver = await approverUserId(ctx, companyId, campaign);
  const issue = await createWorkIssue(ctx, {
    companyId,
    title: `${clientPrefix(campaign.clientRef ? campaign.clientName : null)}Approve campaign ${campaign.name}`,
    description: reviewer ? `${description}\n${launchReviewBrief(campaign, approver)}` : description,
    originKind: "plugin:partnersinbiz.campaigns",
    originId: campaign.id,
    ...(reviewer
      ? { assigneeAgentId: reviewer, wakeReason: "Review a campaign launch before a person approves it" }
      : approver ? { assigneeUserId: approver } : {}),
  });
  campaign.approvalIssueId = issue.id;
  await saveCampaign(ctx, campaign);
  await setLaunchError(ctx, campaign.id, null);
  return {
    campaignId: campaign.id,
    approvalIssueId: issue.id,
    audience,
    willGet: eligible.length,
    leftOut: suppressedCount,
    routedTo: reviewer ? "reviewer" : approver ? "approver" : "unassigned",
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
    what: `the launch of campaign ${campaign.name} (${campaign.delivery === "email" ? "sent by email from Gmail" : "each step opens an issue"})`,
    checks: [
      "Subject and body of every step and every A/B variant: clear, on brand, no typos, and every {{token}} reads well when filled in (use {{first_name|there}} where a name may be missing).",
      `Audience matches the intent: this campaign goes to ${audience}. Nobody who should not get it (existing clients mid-project, partners, staff).`,
      "Suppressions: unsubscribed and bounced addresses are left out automatically; flag any contact in the audience who asked not to be emailed.",
      "Links: every link works and points to the right page, with no test or staging URLs.",
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
  if (!existing.some((step) => step.position === position && step.variant === "a")) {
    throw new CampaignError("There is no A variant at that position");
  }
  if (existing.some((step) => step.position === position && step.variant === "b")) {
    throw new CampaignError("A B variant already exists at that position");
  }
  const step: CampaignStepDraft = {
    position,
    delayDays: 0,
    subject: requiredString(params, "subject"),
    body: optionalString(params, "body") ?? "",
    htmlBody: null,
    variant: "b",
  };
  await insertStep(ctx, { companyId, campaignId: campaign.id, step });
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
  if (!steps.some((step) => step.position === position && step.variant === variant)) throw new CampaignError("No step found at that position and variant");
  await setStepHtml(ctx, { companyId, campaignId: campaign.id, position, variant, html });
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
    result.push({
      position: result.length + 1,
      delayDays: typeof step.delayDays === "number" ? step.delayDays : 0,
      subject: String(step.subject ?? ""),
      body: typeof step.body === "string" ? step.body : "",
      htmlBody: null,
      variant: "a",
    });
  }
  return result;
}

function templateSteps(params: Record<string, unknown>): Array<{ subject: string; body: string; delayDays: number }> {
  if (!Array.isArray(params.steps)) return [];
  const result: Array<{ subject: string; body: string; delayDays: number }> = [];
  for (const item of params.steps) {
    if (!item || typeof item !== "object") continue;
    const step = item as Record<string, unknown>;
    if (typeof step.subject !== "string") continue;
    result.push({
      subject: step.subject.trim(),
      body: typeof step.body === "string" ? step.body.trim() : "",
      delayDays: typeof step.delayDays === "number" ? step.delayDays : 0,
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

function objectParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CampaignError("Parameters must be an object");
  return value as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new CampaignError(`${key} is required`);
  return value.trim();
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new CampaignError(`${key} must be a string`);
  return value.trim();
}

function stringList(params: Record<string, unknown>, key: string): string[] {
  if (params[key] == null) return [];
  const value = params[key];
  if (!Array.isArray(value)) throw new CampaignError(`${key} must be a list`);
  return value.filter((item): item is string => typeof item === "string");
}

function integer(value: unknown, key: string): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(amount)) throw new CampaignError(`${key} must be an integer`);
  return amount;
}
