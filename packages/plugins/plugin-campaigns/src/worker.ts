import { createHash, randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginPerformActionContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  campaignStats,
  crmContactsByTags,
  dueEnrollments,
  enrollmentById,
  enrollmentByIssue,
  enrollmentsForContact,
  getCampaign,
  insertCampaign,
  insertEnrollment,
  insertStep,
  listCampaigns,
  listSteps,
  saveCampaign,
  saveEnrollment,
} from "./db.js";
import {
  advanceEnrollment,
  assertCanComplete,
  assertCanLaunch,
  assertCanPause,
  CampaignError,
  createCampaign,
  matchesAudience,
  startEnrollment,
  stepIssueCopy,
  type CampaignDraft,
  type CampaignStepDraft,
} from "./domain.js";
import { NAMESPACE } from "./namespace.js";
import { CAMPAIGN_TOOLS } from "./tools.js";

const plugin = definePlugin({
  async setup(ctx) {
    for (const tool of CAMPAIGN_TOOLS) {
      ctx.tools.register(tool.name, tool, (params, run) => runTool(ctx, tool.name, params, run));
    }
    ctx.actions.register("campaigns.load", (_params, context) => load(ctx, context));
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
      if (event.companyId) await safeReconcile(ctx, event.companyId);
    });
    await reconcileInstalledCompanies(ctx);
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
  throw new CampaignError(`Unknown campaign tool ${name}`);
}

async function load(ctx: PluginContext, context: PluginPerformActionContext) {
  const companyId = requiredCompany(context);
  const campaigns = await listCampaigns(ctx, companyId);
  const result = [];
  for (const campaign of campaigns) {
    const steps = await listSteps(ctx, campaign.id);
    const stats = await campaignStats(ctx, campaign.id);
    result.push({ ...publicCampaign(campaign), steps, stats });
  }
  return { campaigns: result };
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
  };
  await insertStep(ctx, { companyId, campaignId: campaign.id, step });
  return { campaignId: campaign.id, step };
}

async function launch(ctx: PluginContext, companyId: string, params: Record<string, unknown>) {
  const campaign = await requireCampaign(ctx, companyId, requiredString(params, "campaignId"));
  assertCanLaunch(campaign.status);
  const steps = await listSteps(ctx, campaign.id);
  if (steps.length === 0) throw new CampaignError("A campaign needs at least one step before launch");
  const explicitIds = stringList(params, "contactIds");
  const contacts = explicitIds.length > 0
    ? explicitIds.map((id) => ({ id, name: id, tags: [] as string[] }))
    : await crmContactsByTags(ctx, companyId, campaign.audienceTags);
  let enrolled = 0;
  for (const contact of contacts) {
    if (!matchesAudience(contact.tags, campaign.audienceTags)) continue;
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
      const step = steps.find((item) => item.position === enrollment.stepPosition);
      if (!step) continue;
      const contact = await getCrmContact(ctx, enrollment.companyId, enrollment.contactId);
      const copy = stepIssueCopy(contact?.name ?? enrollment.contactId, step);
      const issue = await ctx.issues.create({
        companyId: enrollment.companyId,
        title: copy.title,
        description: copy.description,
        status: "todo",
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

async function getCrmContact(ctx: PluginContext, companyId: string, contactId: string): Promise<{ name: string } | null> {
  try {
    const rows = await ctx.db.query<{ name: string }>(
      `SELECT name FROM ${crmNamespace()} WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [contactId, companyId],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

function crmNamespace(): string {
  // Derived identically to the CRM plugin's namespace.
  const hash = createHash("sha256").update("partnersinbiz.crm").digest("hex").slice(0, 10);
  return `plugin_crm_${hash}`;
}

async function requireCampaign(ctx: PluginContext, companyId: string, id: string): Promise<CampaignDraft> {
  const campaign = await getCampaign(ctx, id);
  if (!campaign || campaign.companyId !== companyId) throw new CampaignError("Campaign was not found");
  return campaign;
}

async function reconcileInstalledCompanies(ctx: PluginContext) {
  try {
    const companies = await ctx.companies.list({ limit: 100 });
    for (const company of companies) await safeReconcile(ctx, company.id);
  } catch (error) {
    ctx.logger.info("Campaign skill reconcile deferred", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function safeReconcile(ctx: PluginContext, companyId: string) {
  try {
    await ctx.skills.managed.reconcile("campaigns", companyId);
  } catch (error) {
    ctx.logger.info("Campaign skill reconcile skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
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
