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
  audienceContacts,
  campaignFunnel,
  campaignStats,
  clientCampaignCounts,
  crmContactsByIds,
  dueEnrollments,
  enrollmentById,
  enrollmentByIssue,
  enrollmentsForContact,
  getCampaign,
  getCampaignTemplate,
  insertCampaign,
  insertCampaignTemplate,
  insertEnrollment,
  insertStep,
  insertStepEvent,
  listCampaigns,
  listCampaignTemplates,
  listSteps,
  saveCampaign,
  saveEnrollment,
  setStepHtml,
  stepEventStats,
} from "./db.js";
import {
  advanceEnrollment,
  assertDelivery,
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
} from "./domain.js";
import { CAMPAIGN_TOOLS } from "./tools.js";
import { SKILLS } from "./skills.js";
import {
  clientScopeFromInput,
  COCKPIT_ROUTE,
  companyRoles,
  createSkillSyncer,
  createWorkIssue,
  getCrmContact as projectedContact,
  isModuleEnabled,
  registerModuleWatch,
  registerRoleWatch,
  rememberPluginUiBase,
  reviewerAgentId,
  reviewerBrief,
  SETUP_STATUS_ROUTE,
  trackJob,
  listCrmContactsAtCompany,
  parseClientParam,
  readConfig,
  registerCrmProjection,
  resolveCrmClient,
  MAIL_EVENTS,
  PIB_PLUGINS,
  pluginEvent,
  type ClientScope,
} from "@partnersinbiz/pib-plugin-kit";
import { abSuggestionFor, onMailReceived, onSendResult, redeliverMail, sendCampaignStep } from "./mail.js";
import { PLUGIN_ID } from "./namespace.js";
import { publishAllSetupStatus, rememberCompany, setupStatus } from "./setup-status.js";
import { cockpitSnapshot, publishAllCockpit } from "./cockpit.js";

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
      ctx.tools.register(tool.name, tool, (params, run) => {
        void skillSync?.ensure(run.companyId);
        return runTool(ctx, tool.name, params, run).then(normalizeToolResult);
      });
    }
    ctx.actions.register("campaigns.load", async (params, context) => {
      if (context.companyId) void skillSync?.ensure(context.companyId);
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
    ctx.actions.register("campaigns.ab-suggestion", (params, context) => suggestWinner(ctx, requiredCompany(context), params));
    ctx.actions.register("campaigns.declare-winner", (params, context) => declareWinner(ctx, requiredCompany(context), params));
    ctx.jobs.register("open-due-steps", () => trackJob(ctx, "open-due-steps", () => openDueSteps(ctx)));
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
      });
    });
    ctx.events.on(pluginEvent(PIB_PLUGINS.mailbox, MAIL_EVENTS.received), async (event) => {
      // Replies are ignored while the Campaigns module is switched off for the company.
      if (event.companyId && !(await isModuleEnabled(ctx, event.companyId, PLUGIN_ID))) return;
      await onMailReceived(ctx, event);
    });
    ctx.events.on(pluginEvent(PIB_PLUGINS.mailbox, MAIL_EVENTS.sendResult), (event) => onSendResult(ctx, event));
    ctx.events.on("issue.updated", (event) => onIssueUpdated(ctx, event.entityId, event.companyId));
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
  if (name === "pause-campaign") return setStatus(ctx, companyId, body, "paused");
  if (name === "resume-campaign") return setStatus(ctx, companyId, body, "active");
  if (name === "complete-campaign") return setStatus(ctx, companyId, body, "completed");
  if (name === "campaign-stats") return stats(ctx, companyId, body);
  if (name === "enroll-contact") return enroll(ctx, companyId, body);
  if (name === "complete-step") return completeStep(ctx, companyId, body);
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
  return {
    campaigns: result,
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
  let campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
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
  // Switching a draft to email after approval needs a fresh approval: the approver saw issue delivery.
  const approvalIssueId = edited.delivery === "email" && campaign.delivery !== "email" ? null : campaign.approvalIssueId;
  const next: CampaignDraft = { ...edited, approvalIssueId, winnerVariant: campaign.winnerVariant };
  await saveCampaign(ctx, next);
  return publicCampaign(next);
}

async function addStep(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  if (campaign.status !== "draft") throw new CampaignError("Steps can only be added to a draft campaign");
  const steps = await listSteps(ctx, campaign.id);
  const step: CampaignStepDraft = {
    position: steps.length + 1,
    delayDays: params.delayDays == null ? 0 : integer(params.delayDays, "delayDays"),
    subject: requiredString(params, "subject"),
    body: optionalString(params, "body") ?? "",
    htmlBody: null,
    variant: "a",
  };
  await insertStep(ctx, { companyId, campaignId: campaign.id, step });
  return { campaignId: campaign.id, step };
}

async function launch(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  assertCanLaunch(campaign.status);
  if (campaign.status === "draft") {
    if (!campaign.approvalIssueId) {
      throw new CampaignError("Request approval first (request-campaign-approval). A person approves by marking that issue done.");
    }
    const approval = await ctx.issues.get(campaign.approvalIssueId, companyId);
    if (approval?.status !== "done") throw new CampaignError("The campaign has not been approved yet");
    // Only a person approves. An approval closed while it still sits with an agent (e.g. the Reviewer) does not count.
    if (approval.assigneeAgentId) {
      throw new CampaignError("The approval issue was closed while assigned to an agent. A person must approve it: reopen it, assign it to the approver and have them mark it done.");
    }
  }
  const steps = await listSteps(ctx, campaign.id);
  if (steps.length === 0) throw new CampaignError("A campaign needs at least one step before launch");
  const explicitIds = stringList(params, "contactIds");
  const contacts = explicitIds.length > 0
    ? await crmContactsByIds(ctx, companyId, explicitIds)
    : await audienceContacts(ctx, companyId, campaign);
  if (explicitIds.length > 0 && contacts.length < explicitIds.length) {
    const known = new Set(contacts.map((contact) => contact.id));
    const missing = explicitIds.filter((id) => !known.has(id));
    throw new CampaignError(`Unknown CRM contact ids: ${missing.join(", ")}. Run the CRM "resync" action if they were just created.`);
  }
  if (explicitIds.length === 0 && campaign.audienceMode === "client_contact" && contacts.length === 0) {
    throw new CampaignError(`The client contact ${campaign.clientName ?? campaign.clientRef} is not in the Campaigns contact list. Run the CRM "resync" action, then launch again.`);
  }
  let enrolled = 0;
  for (const contact of contacts) {
    const existing = await enrollmentsForContact(ctx, campaign.id, contact.id);
    try {
      const enrollment = startEnrollment({
        companyId,
        campaignId: campaign.id,
        contactId: contact.id,
        existing,
        steps,
        now: new Date(),
        variant: pickVariant(campaign, steps, contact.id),
      });
      await insertEnrollment(ctx, enrollment);
      enrolled += 1;
    } catch {
      // already running — skip
    }
  }
  campaign.status = "active";
  await saveCampaign(ctx, campaign);
  return { campaignId: campaign.id, status: "active", enrolled };
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
  const existing = await enrollmentsForContact(ctx, campaign.id, contactId);
  const enrollment = startEnrollment({
    companyId,
    campaignId: campaign.id,
    contactId,
    existing,
    steps,
    now: new Date(),
    variant: pickVariant(campaign, steps, contactId),
  });
  await insertEnrollment(ctx, enrollment);
  return enrollment;
}

async function completeStep(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const enrollment = await enrollmentById(ctx, requiredString(params, "enrollmentId"));
  if (!enrollment || enrollment.companyId !== companyId) throw new CampaignError("Enrollment was not found");
  if (enrollment.status !== "running") throw new CampaignError("Enrollment is not running");
  const issue = enrollment.openIssueId ? await ctx.issues.get(enrollment.openIssueId, companyId) : null;
  if (issue?.status !== "done") throw new CampaignError("The campaign issue is not done yet");
  const steps = await listSteps(ctx, enrollment.campaignId);
  const next = advanceEnrollment(enrollment, steps, new Date());
  await saveEnrollment(ctx, next);
  return next;
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
        const copy = stepIssueCopy(contact?.name ?? enrollment.contactId, step, campaign?.clientRef ? campaign.clientName : null);
        const to = contact?.emails?.[0] ? `\n\nSend to: ${contact.name} <${contact.emails[0]}>` : "";
        // Explicit companyId: jobs have no invocation scope; the host allows the
        // call only for a company with saved Campaigns settings.
        const issue = await createWorkIssue(ctx, {
          companyId: enrollment.companyId,
          title: copy.title,
          description: `${note ? `${note}\n\n` : ""}${copy.description}${to}`,
          originKind: "plugin:partnersinbiz.campaigns",
          originId: enrollment.id,
        });
        enrollment.openIssueId = issue.id;
        await saveEnrollment(ctx, enrollment);
      };
      if (campaign?.delivery === "email") {
        await sendCampaignStep(ctx, { campaign, enrollment, step, issueFallback: (note) => openIssue(note) });
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

async function onIssueUpdated(ctx: PluginContext, issueId: string | undefined, companyId: string) {
  if (!issueId) return;
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue || issue.status !== "done") return;
  const enrollment = await enrollmentByIssue(ctx, issue.id);
  if (!enrollment) return;
  const steps = await listSteps(ctx, enrollment.campaignId);
  await saveEnrollment(ctx, advanceEnrollment(enrollment, steps, new Date()));
}

async function requestApproval(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  assertCanRequestApproval(campaign.status);
  if (campaign.approvalIssueId) throw new CampaignError("Approval was already requested for this campaign");
  const steps = await listSteps(ctx, campaign.id);
  const preview = steps
    .map((step) => `${step.position}${step.variant === "b" ? "B" : ""}. **${step.subject}** (after ${step.delayDays} days)\n${step.body || "(no body)"}`)
    .join("\n\n");
  const description = [
    `A person marks this issue done to approve launching campaign ${campaign.name}.`,
    campaign.delivery === "email"
      ? "Delivery: **email**. Once launched, the Mailbox sends each due step from Gmail. Tokens such as {{first_name}} are filled in per contact."
      : "Delivery: **issue**. Each due step opens an issue; a person sends the email.",
    "",
    preview || "(no steps yet)",
  ].join("\n");
  // A launch is outward-facing: the Reviewer checks it first when the company has one, then hands it to the person.
  const reviewer = await reviewerAgentId(ctx, companyId);
  const approver = reviewer ? await approverUserId(ctx, companyId, campaign) : null;
  const issue = await createWorkIssue(ctx, {
    companyId,
    title: `${clientPrefix(campaign.clientRef ? campaign.clientName : null)}Approve campaign ${campaign.name}`,
    description: reviewer ? `${description}\n${launchReviewBrief(campaign, approver)}` : description,
    originKind: "plugin:partnersinbiz.campaigns",
    originId: campaign.id,
    ...(reviewer ? { assigneeAgentId: reviewer, wakeReason: "Review a campaign launch before a person approves it" } : {}),
  });
  campaign.approvalIssueId = issue.id;
  await saveCampaign(ctx, campaign);
  return { campaignId: campaign.id, approvalIssueId: issue.id };
}

/** The person the Reviewer hands a launch approval to: the campaign's owner, else the company owner from the Cockpit roles. */
async function approverUserId(ctx: PluginContext, companyId: string, campaign: CampaignDraft): Promise<string | null> {
  if (campaign.ownerUserId && campaign.ownerUserId !== "local-board") return campaign.ownerUserId;
  return (await companyRoles(ctx, companyId))?.ownerUserId ?? null;
}

/** What the Reviewer checks on a campaign launch. */
export function launchReviewBrief(campaign: Pick<CampaignDraft, "name" | "delivery" | "audienceMode" | "audienceTags" | "clientName" | "clientRef">, approverUserId: string | null): string {
  const audience = campaign.audienceMode === "tags"
    ? `contacts tagged ${campaign.audienceTags.length ? campaign.audienceTags.map((tag) => `\`${tag}\``).join(", ") : "(no tags: every contact)"}`
    : campaign.audienceMode === "client_contact"
      ? `the client contact ${campaign.clientName ?? campaign.clientRef ?? ""}`.trim()
      : `the contacts at ${campaign.clientName ?? campaign.clientRef ?? "the client"}`;
  return reviewerBrief({
    what: `the launch of campaign ${campaign.name} (${campaign.delivery === "email" ? "sent by email from Gmail" : "each step opens an issue"})`,
    checks: [
      "Subject and body of every step and every A/B variant: clear, on brand, no typos, and {{first_name}} / {{name}} / {{company}} read well when filled in.",
      `Audience matches the intent: this campaign goes to ${audience}. Nobody who should not get it (existing clients mid-project, partners, staff).`,
      "Suppressions: unsubscribed and bounced addresses are skipped automatically; flag any contact in the audience who asked not to be emailed.",
      "Links: every link works and points to the right page, with no test or staging URLs.",
      "Compliance: says who we are, gives a way to opt out (reply STOP or unsubscribe), makes no claims we cannot back up (POPIA).",
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
  return { campaignId: campaign.id, step };
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
  const position = integer(params.position, "position");
  const variant = params.variant == null ? "a" : assertVariant(requiredString(params, "variant"));
  const html = requiredString(params, "html");
  const changed = await setStepHtml(ctx, { companyId, campaignId: campaign.id, position, variant, html });
  if (!changed) throw new CampaignError("No step found at that position and variant");
  return { campaignId: campaign.id, position, variant, htmlSet: true };
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
    startAt: campaign.startAt,
    endAt: campaign.endAt,
    approvalIssueId: campaign.approvalIssueId,
    delivery: campaign.delivery,
    winnerVariant: campaign.winnerVariant,
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
