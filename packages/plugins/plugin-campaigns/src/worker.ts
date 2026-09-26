import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  campaignFunnel,
  campaignStats,
  crmContactsByIds,
  crmContactsByTags,
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
  assertCanComplete,
  assertCanDeclareWinner,
  assertCanLaunch,
  assertCanPause,
  assertCanRequestApproval,
  assertEventType,
  assertVariant,
  CampaignError,
  createCampaign,
  createCampaignTemplate,
  matchesAudience,
  startEnrollment,
  stepIssueCopy,
  type CampaignDraft,
  type CampaignStepDraft,
} from "./domain.js";
import { CAMPAIGN_TOOLS } from "./tools.js";
import { SKILLS } from "./skills.js";
import { createSkillSyncer, createWorkIssue, getCrmContact as projectedContact, readConfig, registerCrmProjection } from "@partnersinbiz/pib-plugin-kit";

let skillSync: ReturnType<typeof createSkillSyncer> | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    skillSync = createSkillSyncer(ctx, SKILLS);
    registerCrmProjection(ctx, ctx.db.namespace, { companies: true, contacts: true });
    for (const tool of CAMPAIGN_TOOLS) {
      ctx.tools.register(tool.name, tool, (params, run) => {
        void skillSync?.ensure(run.companyId);
        return runTool(ctx, tool.name, params, run);
      });
    }
    ctx.actions.register("campaigns.load", (_params, context) => {
      if (context.companyId) void skillSync?.ensure(context.companyId);
      return load(ctx, context);
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
    ctx.jobs.register("open-due-steps", () => openDueSteps(ctx));
    ctx.events.on("issue.updated", (event) => onIssueUpdated(ctx, event.entityId, event.companyId));
    ctx.events.on("company.created", async (event) => {
      if (event.companyId) await skillSync?.ensure(event.companyId);
    });
    ctx.logger.info("Campaigns plugin ready");
  },
  async onHealth() {
    return { status: "ok", message: "Campaigns plugin ready" };
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
  if (name === "create-campaign") return createCampaignRecord(ctx, companyId, body);
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
  if (name === "create-campaign-from-template") return createFromTemplate(ctx, companyId, body);
  if (name === "declare-ab-winner") return declareWinner(ctx, companyId, body);
  throw new CampaignError(`Unknown campaign tool ${name}`);
}

async function load(ctx: PluginContext, context: PluginPerformActionContext) {
  const companyId = requiredCompany(context);
  const campaigns = await listCampaigns(ctx, companyId);
  const result = [];
  for (const campaign of campaigns) {
    const steps = await listSteps(ctx, campaign.id);
    const stats = await campaignStats(ctx, campaign.id);
    const approval = campaign.approvalIssueId ? await ctx.issues.get(campaign.approvalIssueId, companyId).catch(() => null) : null;
    result.push({ ...publicCampaign(campaign), steps, stats, approvalStatus: approval?.status ?? null });
  }
  const config = await readConfig(ctx, companyId).catch(() => ({}));
  return { campaigns: result, settingsSaved: Object.keys(config).length > 0 };
}

async function createCampaignAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  return createCampaignRecord(ctx, requiredCompany(context), params);
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

async function createCampaignRecord(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = createCampaign({
    companyId,
    name: requiredString(params, "name"),
    description: optionalString(params, "description"),
    fromName: optionalString(params, "fromName"),
    fromLocal: optionalString(params, "fromLocal"),
    replyTo: optionalString(params, "replyTo"),
    audienceTags: stringList(params, "audienceTags"),
    startAt: optionalString(params, "startAt"),
    endAt: optionalString(params, "endAt"),
  });
  await insertCampaign(ctx, campaign);
  return publicCampaign(campaign);
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
  }
  const steps = await listSteps(ctx, campaign.id);
  if (steps.length === 0) throw new CampaignError("A campaign needs at least one step before launch");
  const explicitIds = stringList(params, "contactIds");
  const contacts = explicitIds.length > 0
    ? await crmContactsByIds(ctx, companyId, explicitIds)
    : await crmContactsByTags(ctx, companyId, campaign.audienceTags);
  if (explicitIds.length > 0 && contacts.length < explicitIds.length) {
    const known = new Set(contacts.map((contact) => contact.id));
    const missing = explicitIds.filter((id) => !known.has(id));
    throw new CampaignError(`Unknown CRM contact ids: ${missing.join(", ")}. Run the CRM "resync" action if they were just created.`);
  }
  let enrolled = 0;
  for (const contact of contacts) {
    if (explicitIds.length === 0 && !matchesAudience(contact.tags, campaign.audienceTags)) continue;
    const existing = await enrollmentsForContact(ctx, campaign.id, contact.id);
    try {
      const enrollment = startEnrollment({
        companyId,
        campaignId: campaign.id,
        contactId: contact.id,
        existing,
        steps,
        now: new Date(),
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
  for (const enrollment of due) {
    try {
      const steps = await listSteps(ctx, enrollment.campaignId);
      const step = steps.find((item) => item.position === enrollment.stepPosition && item.variant === enrollment.variant);
      if (!step) continue;
      const contact = await projectedContact(ctx, ctx.db.namespace, enrollment.companyId, enrollment.contactId);
      const copy = stepIssueCopy(contact?.name ?? enrollment.contactId, step);
      const to = contact?.emails?.[0] ? `\n\nSend to: ${contact.name} <${contact.emails[0]}>` : "";
      // Explicit companyId: jobs have no invocation scope; the host allows the
      // call only for a company with saved Campaigns settings.
      const issue = await createWorkIssue(ctx, {
        companyId: enrollment.companyId,
        title: copy.title,
        description: `${copy.description}${to}`,
        originKind: "plugin:partnersinbiz.campaigns",
        originId: enrollment.id,
      });
      enrollment.openIssueId = issue.id;
      await saveEnrollment(ctx, enrollment);
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
  const issue = await createWorkIssue(ctx, {
    companyId,
    title: `Approve campaign ${campaign.name}`,
    description: `A person marks this issue done to approve launching campaign ${campaign.name}.`,
    originKind: "plugin:partnersinbiz.campaigns",
    originId: campaign.id,
  });
  campaign.approvalIssueId = issue.id;
  await saveCampaign(ctx, campaign);
  return { campaignId: campaign.id, approvalIssueId: issue.id };
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

async function createFromTemplate(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const template = await getCampaignTemplate(ctx, requiredString(params, "templateId"));
  if (!template || template.company_id !== companyId) throw new CampaignError("Template was not found");
  const steps = parseSteps(template.steps);
  const campaign = createCampaign({ companyId, name: requiredString(params, "name") });
  await insertCampaign(ctx, campaign);
  for (const step of steps) {
    await insertStep(ctx, { companyId, campaignId: campaign.id, step });
  }
  return { campaignId: campaign.id, stepCount: steps.length };
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
  campaign.winnerVariant = winner;
  await saveCampaign(ctx, campaign);
  return { campaignId: campaign.id, winner };
}

async function requireCampaign(ctx: PluginContext, companyId: string, id: string): Promise<CampaignDraft> {
  const campaign = await getCampaign(ctx, id);
  if (!campaign || campaign.companyId !== companyId) throw new CampaignError("Campaign was not found");
  return campaign;
}

function publicCampaign(campaign: CampaignDraft) {
  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    status: campaign.status,
    fromName: campaign.fromName,
    fromLocal: campaign.fromLocal,
    replyTo: campaign.replyTo,
    audienceTags: campaign.audienceTags,
    startAt: campaign.startAt,
    endAt: campaign.endAt,
    approvalIssueId: campaign.approvalIssueId,
  };
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
