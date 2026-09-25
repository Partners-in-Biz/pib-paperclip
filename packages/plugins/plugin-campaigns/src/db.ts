import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { CampaignDraft, CampaignStepDraft, EnrollmentDraft } from "./domain.js";
import { pluginNamespace } from "./namespace.js";

/** The CRM plugin's namespace, derived the same way the host derives it. */
const CRM_NAMESPACE = pluginNamespace("partnersinbiz.crm", "crm");

export function table(ctx: PluginContext, name: string): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace)) throw new Error("Unsafe namespace");
  if (!/^[a-z_]+$/.test(name)) throw new Error("Unsafe table");
  return `${ctx.db.namespace}.${name}`;
}

export interface CampaignRow {
  id: string;
  company_id: string;
  name: string;
  description: string;
  status: string;
  from_name: string;
  from_local: string;
  reply_to: string | null;
  audience_tags: unknown;
  start_at: unknown;
  end_at: unknown;
  approval_issue_id: string | null;
}

export interface StepRow {
  id: string;
  company_id: string;
  campaign_id: string;
  position: number;
  delay_days: number;
  subject: string;
  body: string;
}

export interface EnrollmentRow {
  id: string;
  company_id: string;
  campaign_id: string;
  contact_id: string;
  status: string;
  step_position: number;
  next_due_at: unknown;
  open_issue_id: string | null;
}

function asStringList(value: unknown): string[] {
  const source = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(source)) return [];
  return source.filter((item): item is string => typeof item === "string");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function asIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapCampaign(row: CampaignRow): CampaignDraft {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    description: row.description,
    status: row.status as CampaignDraft["status"],
    fromName: row.from_name,
    fromLocal: row.from_local,
    replyTo: row.reply_to,
    audienceTags: asStringList(row.audience_tags),
    startAt: asIso(row.start_at),
    endAt: asIso(row.end_at),
    approvalIssueId: row.approval_issue_id,
  };
}

function mapEnrollment(row: EnrollmentRow): EnrollmentDraft {
  return {
    id: row.id,
    companyId: row.company_id,
    campaignId: row.campaign_id,
    contactId: row.contact_id,
    status: row.status as EnrollmentDraft["status"],
    stepPosition: row.step_position,
    nextDueAt: asIso(row.next_due_at),
    openIssueId: row.open_issue_id,
  };
}

export async function listCampaigns(ctx: PluginContext, companyId: string): Promise<CampaignDraft[]> {
  const rows = await ctx.db.query<CampaignRow>(
    `SELECT id, company_id, name, description, status, from_name, from_local, reply_to, audience_tags, start_at, end_at, approval_issue_id
       FROM ${table(ctx, "campaigns")}
      WHERE company_id = $1
      ORDER BY created_at DESC`,
    [companyId],
  );
  return rows.map(mapCampaign);
}

export async function getCampaign(ctx: PluginContext, id: string): Promise<CampaignDraft | null> {
  const rows = await ctx.db.query<CampaignRow>(
    `SELECT id, company_id, name, description, status, from_name, from_local, reply_to, audience_tags, start_at, end_at, approval_issue_id
       FROM ${table(ctx, "campaigns")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ? mapCampaign(rows[0]) : null;
}

export async function insertCampaign(ctx: PluginContext, campaign: CampaignDraft): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "campaigns")}
      (id, company_id, name, description, status, from_name, from_local, reply_to, audience_tags, start_at, end_at, approval_issue_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
    [
      campaign.id,
      campaign.companyId,
      campaign.name,
      campaign.description,
      campaign.status,
      campaign.fromName,
      campaign.fromLocal,
      campaign.replyTo,
      JSON.stringify(campaign.audienceTags),
      campaign.startAt,
      campaign.endAt,
      campaign.approvalIssueId,
    ],
  );
}

export async function saveCampaign(ctx: PluginContext, campaign: CampaignDraft): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "campaigns")}
        SET name = $2, description = $3, status = $4, from_name = $5, from_local = $6, reply_to = $7,
            audience_tags = $8::jsonb, start_at = $9, end_at = $10, approval_issue_id = $11, updated_at = now()
      WHERE id = $1`,
    [
      campaign.id,
      campaign.name,
      campaign.description,
      campaign.status,
      campaign.fromName,
      campaign.fromLocal,
      campaign.replyTo,
      JSON.stringify(campaign.audienceTags),
      campaign.startAt,
      campaign.endAt,
      campaign.approvalIssueId,
    ],
  );
}

export async function listSteps(ctx: PluginContext, campaignId: string): Promise<CampaignStepDraft[]> {
  const rows = await ctx.db.query<StepRow>(
    `SELECT id, company_id, campaign_id, position, delay_days, subject, body
       FROM ${table(ctx, "campaign_steps")} WHERE campaign_id = $1 ORDER BY position`,
    [campaignId],
  );
  return rows.map((row) => ({
    position: row.position,
    delayDays: row.delay_days,
    subject: row.subject,
    body: row.body,
  }));
}

export async function insertStep(
  ctx: PluginContext,
  input: { companyId: string; campaignId: string; step: CampaignStepDraft },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "campaign_steps")}
      (id, company_id, campaign_id, position, delay_days, subject, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), input.companyId, input.campaignId, input.step.position, input.step.delayDays, input.step.subject, input.step.body],
  );
}

export async function enrollmentsForContact(ctx: PluginContext, campaignId: string, contactId: string): Promise<EnrollmentDraft[]> {
  const rows = await ctx.db.query<EnrollmentRow>(
    `SELECT id, company_id, campaign_id, contact_id, status, step_position, next_due_at, open_issue_id
       FROM ${table(ctx, "campaign_enrollments")}
      WHERE campaign_id = $1 AND contact_id = $2`,
    [campaignId, contactId],
  );
  return rows.map(mapEnrollment);
}

export async function insertEnrollment(ctx: PluginContext, enrollment: EnrollmentDraft): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "campaign_enrollments")}
      (id, company_id, campaign_id, contact_id, status, step_position, next_due_at, open_issue_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      enrollment.id,
      enrollment.companyId,
      enrollment.campaignId,
      enrollment.contactId,
      enrollment.status,
      enrollment.stepPosition,
      enrollment.nextDueAt,
      enrollment.openIssueId,
    ],
  );
}

export async function saveEnrollment(ctx: PluginContext, enrollment: EnrollmentDraft): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "campaign_enrollments")}
        SET status = $2, step_position = $3, next_due_at = $4, open_issue_id = $5, updated_at = now()
      WHERE id = $1`,
    [enrollment.id, enrollment.status, enrollment.stepPosition, enrollment.nextDueAt, enrollment.openIssueId],
  );
}

export async function dueEnrollments(ctx: PluginContext): Promise<EnrollmentDraft[]> {
  const rows = await ctx.db.query<EnrollmentRow>(
    `SELECT id, company_id, campaign_id, contact_id, status, step_position, next_due_at, open_issue_id
       FROM ${table(ctx, "campaign_enrollments")}
      WHERE status = 'running' AND open_issue_id IS NULL AND next_due_at IS NOT NULL AND next_due_at <= now()`,
  );
  return rows.map(mapEnrollment);
}

export async function enrollmentByIssue(ctx: PluginContext, issueId: string): Promise<EnrollmentDraft | null> {
  const rows = await ctx.db.query<EnrollmentRow>(
    `SELECT id, company_id, campaign_id, contact_id, status, step_position, next_due_at, open_issue_id
       FROM ${table(ctx, "campaign_enrollments")}
      WHERE open_issue_id = $1 AND status = 'running' LIMIT 1`,
    [issueId],
  );
  return rows[0] ? mapEnrollment(rows[0]) : null;
}

export async function enrollmentById(ctx: PluginContext, id: string): Promise<EnrollmentDraft | null> {
  const rows = await ctx.db.query<EnrollmentRow>(
    `SELECT id, company_id, campaign_id, contact_id, status, step_position, next_due_at, open_issue_id
       FROM ${table(ctx, "campaign_enrollments")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ? mapEnrollment(rows[0]) : null;
}

export async function stopEnrollmentsForContact(ctx: PluginContext, companyId: string, contactId: string): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "campaign_enrollments")}
        SET status = 'stopped', updated_at = now()
      WHERE company_id = $1 AND contact_id = $2 AND status = 'running'`,
    [companyId, contactId],
  );
}

export async function campaignStats(ctx: PluginContext, campaignId: string): Promise<{ enrolled: number; running: number; done: number }> {
  const rows = await ctx.db.query<{ status: string; count: string | number }>(
    `SELECT status, count(*) AS count
       FROM ${table(ctx, "campaign_enrollments")}
      WHERE campaign_id = $1
      GROUP BY status`,
    [campaignId],
  );
  const stats = { enrolled: 0, running: 0, done: 0 };
  for (const row of rows) {
    const count = Number(row.count ?? 0);
    stats.enrolled += count;
    if (row.status === "running") stats.running = count;
    if (row.status === "done") stats.done = count;
  }
  return stats;
}

export async function crmContactsByTags(
  ctx: PluginContext,
  companyId: string,
  tags: string[],
): Promise<Array<{ id: string; name: string; tags: string[] }>> {
  try {
    const rows = await ctx.db.query<{ id: string; name: string; tags: unknown }>(
      `SELECT id, name, tags FROM ${CRM_NAMESPACE}.contacts WHERE company_id = $1`,
      [companyId],
    );
    const wanted = new Set(tags.map((tag) => tag.toLowerCase()));
    return rows
      .map((row) => ({ id: row.id, name: row.name, tags: asStringList(row.tags) }))
      .filter((contact) => wanted.size === 0 || contact.tags.some((tag) => wanted.has(tag.toLowerCase())));
  } catch (error) {
    throw new Error(`Could not read CRM contacts: ${error instanceof Error ? error.message : String(error)}`);
  }
}
