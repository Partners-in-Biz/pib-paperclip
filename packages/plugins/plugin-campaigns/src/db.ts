import { createHash, randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { assertDelivery, audienceSource, campaignSenderKey, matchesAudience, type AudienceMode, type CampaignDraft, type CampaignStepDraft, type CampaignSuppressionReason, type EnrollmentDraft } from "./domain.js";
import { clientWhere, listCrmContacts, listCrmContactsAtCompany, suppressionBlocks, textArrayParam, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import type { Channel, MessagingChannel } from "./channels.js";

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
  winner_variant: string | null;
  client_kind: string | null;
  client_ref: string | null;
  client_name: string | null;
  audience_mode: string | null;
  delivery?: string | null;
  owner_user_id?: string | null;
  owner_agent_id?: string | null;
  approved_by_user_id?: string | null;
  launched_at?: unknown;
  launch_error?: string | null;
}

const CAMPAIGN_COLUMNS =
  "id, company_id, name, description, status, from_name, from_local, reply_to, audience_tags, start_at, end_at, approval_issue_id, winner_variant, client_kind, client_ref, client_name, audience_mode, delivery, owner_user_id, owner_agent_id, approved_by_user_id, launched_at, launch_error";

export interface StepRow {
  id: string;
  company_id: string;
  campaign_id: string;
  position: number;
  delay_days: number;
  subject: string;
  body: string;
  html_body: string | null;
  variant: string;
  channel?: string | null;
  template_ref?: string | null;
  template_vars?: unknown;
}

export interface EnrollmentRow {
  id: string;
  company_id: string;
  campaign_id: string;
  contact_id: string;
  status: string;
  step_position: number;
  variant: string;
  next_due_at: unknown;
  open_issue_id: string | null;
  sending_key?: string | null;
  mail_thread_id?: string | null;
  mail_last_message_id?: string | null;
}

const ENROLLMENT_COLUMNS =
  "id, company_id, campaign_id, contact_id, status, step_position, variant, next_due_at, open_issue_id, sending_key, mail_thread_id, mail_last_message_id";

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

/** A driver time (Date, ISO or Postgres text) as ISO; null when missing or unreadable. */
export function isoTime(value: unknown): string | null {
  if (value == null || value === "") return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
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
    winnerVariant: row.winner_variant as "a" | "b" | null,
    clientKind: row.client_ref ? (row.client_kind === "contact" ? "contact" : "company") : null,
    clientRef: row.client_ref ?? null,
    clientName: row.client_name ?? null,
    audienceMode: (row.audience_mode ?? "tags") as AudienceMode,
    delivery: row.delivery === "email" ? "email" : row.delivery === "auto" ? "auto" : "issue",
    ownerUserId: row.owner_user_id ?? null,
    ownerAgentId: row.owner_agent_id ?? null,
    approvedByUserId: row.approved_by_user_id ?? null,
    launchedAt: asIso(row.launched_at),
    launchError: row.launch_error ?? null,
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
    variant: row.variant as "a" | "b",
    nextDueAt: asIso(row.next_due_at),
    openIssueId: row.open_issue_id,
    sendingKey: row.sending_key ?? null,
    mailThreadId: row.mail_thread_id ?? null,
    mailLastMessageId: row.mail_last_message_id ?? null,
  };
}

/** Campaigns in one scope: `null` is PiB's own work, a client is that client's work only. */
export async function listCampaigns(ctx: PluginContext, companyId: string, scope: ClientScope = null): Promise<CampaignDraft[]> {
  const where = clientWhere(scope, 2);
  const rows = await ctx.db.query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLUMNS}
       FROM ${table(ctx, "campaigns")}
      WHERE company_id = $1 AND ${where.sql}
      ORDER BY created_at DESC`,
    [companyId, ...where.params],
  );
  return rows.map(mapCampaign);
}

export async function getCampaign(ctx: PluginContext, id: string): Promise<CampaignDraft | null> {
  const rows = await ctx.db.query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLUMNS}
       FROM ${table(ctx, "campaigns")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ? mapCampaign(rows[0]) : null;
}

export async function insertCampaign(ctx: PluginContext, campaign: CampaignDraft): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "campaigns")}
      (id, company_id, name, description, status, from_name, from_local, reply_to, audience_tags, start_at, end_at, approval_issue_id, winner_variant,
       client_kind, client_ref, client_name, audience_mode, delivery, owner_user_id, owner_agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
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
      campaign.winnerVariant,
      campaign.clientRef ? campaign.clientKind : null,
      campaign.clientRef,
      campaign.clientRef ? campaign.clientName : null,
      campaign.audienceMode,
      assertDelivery(campaign.delivery),
      campaign.ownerUserId ?? null,
      campaign.ownerAgentId ?? null,
    ],
  );
}

export async function saveCampaign(ctx: PluginContext, campaign: CampaignDraft): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "campaigns")}
        SET name = $2, description = $3, status = $4, from_name = $5, from_local = $6, reply_to = $7,
            audience_tags = $8::jsonb, start_at = $9, end_at = $10, approval_issue_id = $11, winner_variant = $12,
            client_kind = $13, client_ref = $14, client_name = $15, audience_mode = $16, delivery = $17, updated_at = now()
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
      campaign.winnerVariant,
      campaign.clientRef ? campaign.clientKind : null,
      campaign.clientRef,
      campaign.clientRef ? campaign.clientName : null,
      campaign.audienceMode,
      assertDelivery(campaign.delivery),
    ],
  );
}

/** The draft (or launched) campaign an approval issue belongs to. */
export async function campaignByApprovalIssue(ctx: PluginContext, issueId: string): Promise<CampaignDraft | null> {
  const rows = await ctx.db.query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLUMNS}
       FROM ${table(ctx, "campaigns")} WHERE approval_issue_id = $1 LIMIT 1`,
    [issueId],
  );
  return rows[0] ? mapCampaign(rows[0]) : null;
}

/**
 * Moves the campaign from `fromStatus` to active. False when another launch
 * got there first (the status changed meanwhile), so enrollment runs once.
 */
export async function claimLaunch(ctx: PluginContext, campaign: Pick<CampaignDraft, "id" | "approvedByUserId">, fromStatus: string, approvedByUserId: string | null): Promise<boolean> {
  const res = await ctx.db.execute(
    `UPDATE ${table(ctx, "campaigns")}
        SET status = 'active', launched_at = now(), launch_error = NULL, approved_by_user_id = $3, updated_at = now()
      WHERE id = $1 AND status = $2`,
    [campaign.id, fromStatus, approvedByUserId ?? campaign.approvedByUserId ?? null],
  );
  return (res?.rowCount ?? 0) > 0;
}

/** Why the last launch on approval failed; null clears it. */
export async function setLaunchError(ctx: PluginContext, campaignId: string, error: string | null): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "campaigns")} SET launch_error = $2, updated_at = now() WHERE id = $1`,
    [campaignId, error ? error.slice(0, 500) : null],
  );
}

/** Forgets the approval issue so the draft can be sent for approval again. */
export async function clearApproval(ctx: PluginContext, campaignId: string): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "campaigns")} SET approval_issue_id = NULL, launch_error = NULL, updated_at = now() WHERE id = $1`,
    [campaignId],
  );
}

export interface ApprovalIssueRow extends CampaignRow {
  issue_status: string;
  issue_agent_id: string | null;
  issue_user_id: string | null;
}

/** Drafts whose approval issue is done: the launch event may have been missed (events are at-most-once). */
export async function approvedDrafts(ctx: PluginContext, limit = 50): Promise<Array<{ campaign: CampaignDraft; issueAgentId: string | null; issueUserId: string | null }>> {
  const rows = await ctx.db.query<ApprovalIssueRow>(
    `SELECT c.${CAMPAIGN_COLUMNS.split(", ").join(", c.")}, i.status AS issue_status, i.assignee_agent_id AS issue_agent_id, i.assignee_user_id AS issue_user_id
       FROM ${table(ctx, "campaigns")} c JOIN public.issues i ON i.id::text = c.approval_issue_id
      WHERE c.status = 'draft' AND i.status = 'done'
      ORDER BY c.updated_at
      LIMIT ${Math.max(1, Math.min(limit, 200))}`,
  );
  return rows.map((row) => ({ campaign: mapCampaign(row), issueAgentId: row.issue_agent_id ?? null, issueUserId: row.issue_user_id ?? null }));
}

/** Running enrollments whose step issue was closed without us hearing about it. */
export async function closedStepIssues(ctx: PluginContext, limit = 200): Promise<Array<EnrollmentDraft & { issueStatus: string }>> {
  const rows = await ctx.db.query<EnrollmentRow & { issue_status: string }>(
    `SELECT e.id, e.company_id, e.campaign_id, e.contact_id, e.status, e.step_position, e.variant, e.next_due_at, e.open_issue_id,
            e.sending_key, e.mail_thread_id, e.mail_last_message_id, i.status AS issue_status
       FROM ${table(ctx, "campaign_enrollments")} e JOIN public.issues i ON i.id::text = e.open_issue_id
      WHERE e.status = 'running' AND i.status IN ('done', 'cancelled')
      LIMIT ${Math.max(1, Math.min(limit, 500))}`,
  );
  return rows.map((row) => ({ ...mapEnrollment(row), issueStatus: row.issue_status }));
}

export async function listSteps(ctx: PluginContext, campaignId: string): Promise<CampaignStepDraft[]> {
  const rows = await ctx.db.query<StepRow>(
    `SELECT id, company_id, campaign_id, position, delay_days, subject, body, html_body, variant, channel, template_ref, template_vars
       FROM ${table(ctx, "campaign_steps")} WHERE campaign_id = $1 ORDER BY position, variant`,
    [campaignId],
  );
  return rows.map((row) => ({
    position: row.position,
    delayDays: row.delay_days,
    subject: row.subject,
    body: row.body,
    htmlBody: row.html_body,
    variant: row.variant as "a" | "b",
    channel: row.channel === "sms" || row.channel === "whatsapp" ? row.channel : "email",
    templateRef: row.template_ref ?? null,
    templateVars: asStringList(row.template_vars),
  }));
}

export async function insertStep(
  ctx: PluginContext,
  input: { companyId: string; campaignId: string; step: CampaignStepDraft },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "campaign_steps")}
      (id, company_id, campaign_id, position, delay_days, subject, body, html_body, variant, channel, template_ref, template_vars)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    [
      randomUUID(), input.companyId, input.campaignId, input.step.position, input.step.delayDays, input.step.subject, input.step.body, input.step.htmlBody, input.step.variant,
      input.step.channel ?? "email", input.step.templateRef ?? null, JSON.stringify(input.step.templateVars ?? []),
    ],
  );
}

export async function enrollmentsForContact(ctx: PluginContext, campaignId: string, contactId: string): Promise<EnrollmentDraft[]> {
  const rows = await ctx.db.query<EnrollmentRow>(
    `SELECT ${ENROLLMENT_COLUMNS}
       FROM ${table(ctx, "campaign_enrollments")}
      WHERE campaign_id = $1 AND contact_id = $2`,
    [campaignId, contactId],
  );
  return rows.map(mapEnrollment);
}

export async function insertEnrollment(ctx: PluginContext, enrollment: EnrollmentDraft): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "campaign_enrollments")}
      (id, company_id, campaign_id, contact_id, status, step_position, variant, next_due_at, open_issue_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      enrollment.id,
      enrollment.companyId,
      enrollment.campaignId,
      enrollment.contactId,
      enrollment.status,
      enrollment.stepPosition,
      enrollment.variant,
      enrollment.nextDueAt,
      enrollment.openIssueId,
    ],
  );
}

export async function saveEnrollment(ctx: PluginContext, enrollment: EnrollmentDraft): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "campaign_enrollments")}
        SET status = $2, step_position = $3, variant = $4, next_due_at = $5, open_issue_id = $6, sending_key = $7,
            mail_thread_id = $8, mail_last_message_id = $9, updated_at = now()
      WHERE id = $1`,
    [
      enrollment.id,
      enrollment.status,
      enrollment.stepPosition,
      enrollment.variant,
      enrollment.nextDueAt,
      enrollment.openIssueId,
      enrollment.sendingKey ?? null,
      enrollment.mailThreadId ?? null,
      enrollment.mailLastMessageId ?? null,
    ],
  );
}

export async function dueEnrollments(ctx: PluginContext): Promise<EnrollmentDraft[]> {
  const rows = await ctx.db.query<EnrollmentRow>(
    `SELECT ${ENROLLMENT_COLUMNS}
       FROM ${table(ctx, "campaign_enrollments")}
      WHERE status = 'running' AND open_issue_id IS NULL AND sending_key IS NULL AND next_due_at IS NOT NULL AND next_due_at <= now()
        AND campaign_id IN (SELECT id FROM ${table(ctx, "campaigns")} WHERE status = 'active')`,
  );
  return rows.map(mapEnrollment);
}

export async function enrollmentByIssue(ctx: PluginContext, issueId: string): Promise<EnrollmentDraft | null> {
  const rows = await ctx.db.query<EnrollmentRow>(
    `SELECT ${ENROLLMENT_COLUMNS}
       FROM ${table(ctx, "campaign_enrollments")}
      WHERE open_issue_id = $1 AND status = 'running' LIMIT 1`,
    [issueId],
  );
  return rows[0] ? mapEnrollment(rows[0]) : null;
}

export async function enrollmentById(ctx: PluginContext, id: string): Promise<EnrollmentDraft | null> {
  const rows = await ctx.db.query<EnrollmentRow>(
    `SELECT ${ENROLLMENT_COLUMNS}
       FROM ${table(ctx, "campaign_enrollments")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ? mapEnrollment(rows[0]) : null;
}

/** Moves only the next due time of a running enrollment (never touches a send in flight). */
export async function pushEnrollmentDue(ctx: PluginContext, id: string, nextDueAt: string): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "campaign_enrollments")} SET next_due_at = $2, updated_at = now() WHERE id = $1 AND status = 'running'`,
    [id, nextDueAt],
  );
}

/** Stops one running enrollment. */
export async function stopEnrollment(ctx: PluginContext, id: string): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "campaign_enrollments")} SET status = 'stopped', next_due_at = NULL, updated_at = now() WHERE id = $1 AND status = 'running'`,
    [id],
  );
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

export interface EnrollmentView {
  contactId: string;
  /** From the CRM projection; null when the contact is no longer there. */
  name: string | null;
  status: string;
  stepPosition: number;
  variant: string;
  nextDueAt: string | null;
  /** A step task is open and waits for the agent. */
  waiting: boolean;
  /** The Mailbox is sending the step email now. */
  sending: boolean;
}

/** A campaign's enrollments for the detail view: running ones first, soonest due first. */
export async function enrollmentViews(ctx: PluginContext, campaignId: string, limit = 500): Promise<EnrollmentView[]> {
  const rows = await ctx.db.query<{
    contact_id: string; status: string; step_position: number; variant: string | null; next_due_at: unknown;
    open_issue_id: string | null; sending_key: string | null; name: string | null;
  }>(
    `SELECT e.contact_id, e.status, e.step_position, e.variant, e.next_due_at, e.open_issue_id, e.sending_key, c.name
       FROM ${table(ctx, "campaign_enrollments")} e
       LEFT JOIN ${table(ctx, "crm_contacts")} c ON c.id = e.contact_id
      WHERE e.campaign_id = $1
      ORDER BY (e.status = 'running') DESC, e.next_due_at ASC NULLS LAST, e.created_at
      LIMIT ${Math.max(1, Math.min(limit, 1000))}`,
    [campaignId],
  );
  return rows.map((row) => ({
    contactId: row.contact_id,
    name: row.name ?? null,
    status: row.status,
    stepPosition: Number(row.step_position),
    variant: row.variant ?? "a",
    nextDueAt: isoTime(row.next_due_at),
    waiting: Boolean(row.open_issue_id),
    sending: Boolean(row.sending_key),
  }));
}

/**
 * Contacts from the local CRM projection (fed by CRM events). A plugin may not
 * read the CRM schema directly. Tag matching is case-insensitive; an empty tag
 * list means every contact.
 */
export async function crmContactsByTags(
  ctx: PluginContext,
  companyId: string,
  tags: string[],
): Promise<AudienceContact[]> {
  const rows = await listCrmContacts(ctx, ctx.db.namespace, companyId);
  const wanted = new Set(tags.map((tag) => tag.toLowerCase()));
  return rows
    .map((row) => ({ id: row.id, name: row.name, tags: row.tags ?? [], emails: row.emails ?? [], phones: row.phones ?? [] }))
    .filter((contact) => wanted.size === 0 || contact.tags.some((tag) => wanted.has(tag.toLowerCase())));
}

export async function crmContactsByIds(
  ctx: PluginContext,
  companyId: string,
  ids: string[],
): Promise<AudienceContact[]> {
  const rows = await listCrmContacts(ctx, ctx.db.namespace, companyId, { ids });
  return rows.map((row) => ({ id: row.id, name: row.name, tags: row.tags ?? [], emails: row.emails ?? [], phones: row.phones ?? [] }));
}

export interface AudienceContact {
  id: string;
  name: string;
  tags: string[];
  emails: string[];
  phones: string[];
}

/**
 * The contacts a launch enrolls, from the campaign's audience mode: tagged CRM
 * contacts, the contacts at the client company (narrowed by tags when set),
 * or the client contact alone.
 */
export async function audienceContacts(ctx: PluginContext, companyId: string, campaign: CampaignDraft): Promise<AudienceContact[]> {
  const source = audienceSource(campaign);
  if (source.kind === "contact") return crmContactsByIds(ctx, companyId, [source.contactId]);
  if (source.kind === "company-contacts") {
    const rows = await listCrmContactsAtCompany(ctx, ctx.db.namespace, companyId, source.crmCompanyId);
    return rows
      .map((row) => ({ id: row.id, name: row.name, tags: row.tags ?? [], emails: row.emails ?? [], phones: row.phones ?? [] }))
      .filter((contact) => matchesAudience(contact.tags, source.tags));
  }
  return crmContactsByTags(ctx, companyId, source.tags);
}

export interface ClientCampaignCounts {
  total: number;
  active: number;
  enrolledContacts: number;
  dueSteps: number;
}

/** Counts for the CRM client workspace: campaigns, distinct enrolled contacts, and steps due now. */
export async function clientCampaignCounts(ctx: PluginContext, companyId: string, scope: ClientScope): Promise<ClientCampaignCounts> {
  const campaignWhere = clientWhere(scope, 2);
  const campaigns = await ctx.db.query<{ total: string | number; active: string | number }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE status = 'active') AS active
       FROM ${table(ctx, "campaigns")}
      WHERE company_id = $1 AND ${campaignWhere.sql}`,
    [companyId, ...campaignWhere.params],
  );
  const enrollmentWhere = clientWhere(scope, 2, "c");
  const enrollments = await ctx.db.query<{ enrolled: string | number; due: string | number }>(
    `SELECT count(DISTINCT e.contact_id) AS enrolled,
            count(*) FILTER (WHERE e.status = 'running' AND e.next_due_at IS NOT NULL AND e.next_due_at <= now()) AS due
       FROM ${table(ctx, "campaign_enrollments")} e
       JOIN ${table(ctx, "campaigns")} c ON c.id = e.campaign_id
      WHERE c.company_id = $1 AND ${enrollmentWhere.sql}`,
    [companyId, ...enrollmentWhere.params],
  );
  return {
    total: Number(campaigns[0]?.total ?? 0),
    active: Number(campaigns[0]?.active ?? 0),
    enrolledContacts: Number(enrollments[0]?.enrolled ?? 0),
    dueSteps: Number(enrollments[0]?.due ?? 0),
  };
}

export async function campaignFunnel(ctx: PluginContext, campaignId: string): Promise<{ byStep: Array<{ stepPosition: number; variant: string; count: number }>; completed: number; stopped: number }> {
  const rows = await ctx.db.query<{ step_position: number; variant: string; count: string | number }>(
    `SELECT step_position, variant, count(*) AS count
       FROM ${table(ctx, "campaign_enrollments")}
      WHERE campaign_id = $1 AND status = 'running'
      GROUP BY step_position, variant
      ORDER BY step_position, variant`,
    [campaignId],
  );
  const done = await ctx.db.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM ${table(ctx, "campaign_enrollments")} WHERE campaign_id = $1 AND status = 'done'`,
    [campaignId],
  );
  const stopped = await ctx.db.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM ${table(ctx, "campaign_enrollments")} WHERE campaign_id = $1 AND status = 'stopped'`,
    [campaignId],
  );
  return {
    byStep: rows.map((row) => ({ stepPosition: row.step_position, variant: row.variant, count: Number(row.count ?? 0) })),
    completed: Number(done[0]?.count ?? 0),
    stopped: Number(stopped[0]?.count ?? 0),
  };
}

export async function insertStepEvent(
  ctx: PluginContext,
  input: { companyId: string; campaignId: string; enrollmentId: string; stepPosition: number; eventType: string },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "campaign_step_events")}
      (id, company_id, campaign_id, enrollment_id, step_position, event_type)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), input.companyId, input.campaignId, input.enrollmentId, input.stepPosition, input.eventType],
  );
}

export async function stepEventStats(
  ctx: PluginContext,
  campaignId: string,
): Promise<Array<{ stepPosition: number; opens: number; clicks: number; sent: number; replies: number; bounces: number; unsubscribes: number }>> {
  const rows = await ctx.db.query<{ step_position: number; event_type: string; count: string | number }>(
    `SELECT step_position, event_type, count(*) AS count
       FROM ${table(ctx, "campaign_step_events")}
      WHERE campaign_id = $1
      GROUP BY step_position, event_type
      ORDER BY step_position`,
    [campaignId],
  );
  const byStep = new Map<number, { stepPosition: number; opens: number; clicks: number; sent: number; replies: number; bounces: number; unsubscribes: number }>();
  for (const row of rows) {
    const step = byStep.get(row.step_position) ?? { stepPosition: row.step_position, opens: 0, clicks: 0, sent: 0, replies: 0, bounces: 0, unsubscribes: 0 };
    const count = Number(row.count ?? 0);
    if (row.event_type === "open") step.opens = count;
    if (row.event_type === "click") step.clicks = count;
    if (row.event_type === "sent") step.sent = count;
    if (row.event_type === "reply") step.replies = count;
    if (row.event_type === "bounce") step.bounces = count;
    if (row.event_type === "unsubscribe") step.unsubscribes = count;
    byStep.set(row.step_position, step);
  }
  return [...byStep.values()];
}

export async function setStepHtml(
  ctx: PluginContext,
  input: { companyId: string; campaignId: string; position: number; variant: string; html: string },
): Promise<boolean> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx, "campaign_steps")}
        SET html_body = $5
      WHERE company_id = $1 AND campaign_id = $2 AND position = $3 AND variant = $4`,
    [input.companyId, input.campaignId, input.position, input.variant, input.html],
  );
  return result != null;
}

export interface CampaignTemplateRow {
  id: string;
  company_id: string;
  name: string;
  description: string;
  steps: unknown;
}

export async function insertCampaignTemplate(ctx: PluginContext, row: CampaignTemplateRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "campaign_templates")} (id, company_id, name, description, steps)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [row.id, row.company_id, row.name, row.description, JSON.stringify(row.steps ?? [])],
  );
}

export async function listCampaignTemplates(ctx: PluginContext, companyId: string): Promise<CampaignTemplateRow[]> {
  return ctx.db.query<CampaignTemplateRow>(
    `SELECT id, company_id, name, description, steps
       FROM ${table(ctx, "campaign_templates")} WHERE company_id = $1 ORDER BY name`,
    [companyId],
  );
}

export async function getCampaignTemplate(ctx: PluginContext, id: string): Promise<CampaignTemplateRow | null> {
  const rows = await ctx.db.query<CampaignTemplateRow>(
    `SELECT id, company_id, name, description, steps
       FROM ${table(ctx, "campaign_templates")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Mailbox sends and replies
// ---------------------------------------------------------------------------

/** A step event recorded once per source (a Mailbox result or message may arrive twice). */
export async function insertStepEventOnce(
  ctx: PluginContext,
  input: {
    companyId: string;
    campaignId: string;
    enrollmentId: string;
    stepPosition: number;
    eventType: "sent" | "reply" | "bounce" | "unsubscribe" | "skipped" | "delivered" | "failed";
    variant: string;
    sourceKey: string;
    meta?: Record<string, unknown> | null;
  },
): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "campaign_step_events")}
      (id, company_id, campaign_id, enrollment_id, step_position, event_type, variant, source_key, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING`,
    [
      randomUUID(),
      input.companyId,
      input.campaignId,
      input.enrollmentId,
      input.stepPosition,
      input.eventType,
      input.variant,
      input.sourceKey,
      input.meta ? JSON.stringify(input.meta) : null,
    ],
  );
  return (res?.rowCount ?? 0) > 0;
}

export interface SentEvent {
  enrollmentId: string;
  stepPosition: number;
  variant: string;
  occurredAt: string;
  meta: Record<string, unknown>;
}

/** The latest step each of these enrollments was emailed, newest first. */
export async function latestSends(ctx: PluginContext, companyId: string, enrollmentIds: string[]): Promise<SentEvent[]> {
  if (enrollmentIds.length === 0) return [];
  const rows = await ctx.db.query<{ enrollment_id: string; step_position: number; variant: string | null; occurred_at: unknown; meta: unknown }>(
    `SELECT enrollment_id, step_position, variant, occurred_at, meta
       FROM ${table(ctx, "campaign_step_events")}
      WHERE company_id = $1 AND event_type = 'sent' AND enrollment_id = ANY(${textArrayParam(2)})
      ORDER BY occurred_at DESC
      LIMIT 50`,
    [companyId, JSON.stringify(enrollmentIds)],
  );
  return rows.map((row) => ({
    enrollmentId: row.enrollment_id,
    stepPosition: Number(row.step_position),
    variant: row.variant ?? "a",
    occurredAt: asIso(row.occurred_at) ?? "",
    meta: row.meta && typeof row.meta === "object" ? (row.meta as Record<string, unknown>) : typeof row.meta === "string" ? ((parseJson(row.meta) as Record<string, unknown>) ?? {}) : {},
  }));
}

/** Projected CRM contacts with this address (case-insensitive). */
export async function crmContactsByEmail(ctx: PluginContext, companyId: string, email: string): Promise<Array<{ id: string; name: string; emails: string[] }>> {
  return ctx.db.query<{ id: string; name: string; emails: string[] }>(
    `SELECT id, name, emails
       FROM ${table(ctx, "crm_contacts")}
      WHERE company_id = $1 AND deleted = false
        AND EXISTS (SELECT 1 FROM unnest(emails) AS e(value) WHERE lower(trim(e.value)) = $2)
      ORDER BY updated_at, id
      LIMIT 10`,
    [companyId, email.trim().toLowerCase()],
  );
}

/** Every enrollment (any status) of these contacts. */
export async function enrollmentsForContacts(ctx: PluginContext, companyId: string, contactIds: string[]): Promise<EnrollmentDraft[]> {
  if (contactIds.length === 0) return [];
  const rows = await ctx.db.query<EnrollmentRow>(
    `SELECT ${ENROLLMENT_COLUMNS}
       FROM ${table(ctx, "campaign_enrollments")}
      WHERE company_id = $1 AND contact_id = ANY(${textArrayParam(2)})
      ORDER BY updated_at DESC
      LIMIT 50`,
    [companyId, JSON.stringify(contactIds)],
  );
  return rows.map(mapEnrollment);
}

/** A stable stand-in for an address after an erasure: the plain address is gone, the opt-out still holds. */
export function addressHash(address: string): string {
  return `sha256:${createHash("sha256").update(address.trim().toLowerCase()).digest("hex")}`;
}

/**
 * Which of these addresses may not get a campaign from this sender. A hard bounce
 * (`all`) stops every sender; an unsubscribe or complaint stops the sender it was
 * on, and every sender when the row has no sender (a row from before 0.6). An
 * address erased on request is found by its hash.
 */
export async function suppressedEmails(ctx: PluginContext, companyId: string, emails: string[], senderKey: string): Promise<Set<string>> {
  const wanted = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
  if (wanted.length === 0) return new Set();
  const origin = new Map<string, string>();
  for (const email of wanted) {
    origin.set(email, email);
    origin.set(addressHash(email), email);
  }
  const rows = await ctx.db.query<{ email: string; scope: string; sender_key: string | null }>(
    `SELECT email, scope, sender_key FROM ${table(ctx, "suppressions")} WHERE company_id = $1 AND email = ANY(${textArrayParam(2)})`,
    [companyId, JSON.stringify([...origin.keys()])],
  );
  const blocked = new Set<string>();
  for (const row of rows) {
    if (!suppressionBlocks({ scope: row.scope === "all" ? "all" : "marketing", senderKey: row.sender_key || null }, { marketing: true, senderKey })) continue;
    const email = origin.get(row.email);
    if (email) blocked.add(email);
  }
  return blocked;
}

export async function isSuppressed(ctx: PluginContext, companyId: string, email: string, senderKey: string): Promise<boolean> {
  return (await suppressedEmails(ctx, companyId, [email], senderKey)).has(email.trim().toLowerCase());
}

export interface SuppressionInput {
  companyId: string;
  email: string;
  reason: CampaignSuppressionReason;
  /** marketing: campaigns and sequences only; all: a hard bounce stops every email. */
  scope: "marketing" | "all";
  /** The plugin that saw it. */
  source: string;
  contactId: string | null;
  campaignId: string | null;
  /** Whose list: `own`, `company:<id>`, `contact:<id>`; empty is every sender (the old company-wide row). */
  senderKey: string;
}

/**
 * Stores a suppression once per address and sender. A later hard bounce widens a
 * marketing-only row to all mail. True when the address was new for that sender.
 */
export async function addSuppression(ctx: PluginContext, input: SuppressionInput): Promise<boolean> {
  const email = input.email.trim().toLowerCase();
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "suppressions")} (company_id, email, reason, scope, source, contact_id, campaign_id, sender_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (company_id, email, sender_key) DO NOTHING`,
    [input.companyId, email, input.reason, input.scope, input.source, input.contactId, input.campaignId, input.senderKey],
  );
  const created = (res?.rowCount ?? 0) > 0;
  if (input.scope === "all") {
    await ctx.db.execute(
      `UPDATE ${table(ctx, "suppressions")} SET scope = 'all', updated_at = now() WHERE company_id = $1 AND email = $2 AND scope = 'marketing'`,
      [input.companyId, email],
    );
  }
  return created;
}

export interface SuppressionRow {
  company_id: string;
  email: string;
  reason: CampaignSuppressionReason;
  scope: "marketing" | "all";
  source: string;
  contact_id: string | null;
  sender_key?: string | null;
  created_at: unknown;
}

/** Suppressions this plugin found since `sinceIso`, re-announced hourly because events are at-most-once. */
export async function ownSuppressionsSince(ctx: PluginContext, source: string, sinceIso: string, limit = 200): Promise<SuppressionRow[]> {
  return ctx.db.query<SuppressionRow>(
    `SELECT company_id, email, reason, scope, source, contact_id, sender_key, created_at
       FROM ${table(ctx, "suppressions")}
      WHERE source = $1 AND created_at >= $2::timestamptz
      ORDER BY created_at
      LIMIT ${Math.max(1, Math.min(limit, 1000))}`,
    [source, sinceIso],
  );
}

/** How many addresses may not get campaigns, for the page. */
export async function suppressionCount(ctx: PluginContext, companyId: string): Promise<number> {
  const rows = await ctx.db.query<{ n: string | number }>(
    `SELECT count(*)::text AS n FROM ${table(ctx, "suppressions")} WHERE company_id = $1`,
    [companyId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Running enrollments of a contact that still wait on a step issue. */
export async function openStepIssuesForContact(ctx: PluginContext, companyId: string, contactId: string): Promise<Array<{ id: string; open_issue_id: string }>> {
  return ctx.db.query<{ id: string; open_issue_id: string }>(
    `SELECT id, open_issue_id FROM ${table(ctx, "campaign_enrollments")}
      WHERE company_id = $1 AND contact_id = $2 AND status = 'running' AND open_issue_id IS NOT NULL`,
    [companyId, contactId],
  );
}

/** Sends and replies per variant, in send order, for the A/B suggestion. */
export async function abEvents(
  ctx: PluginContext,
  campaignId: string,
): Promise<Array<{ enrollment_id: string; step_position: number; event_type: string; variant: string | null; occurred_at: unknown }>> {
  return ctx.db.query(
    `SELECT enrollment_id, step_position, event_type, variant, occurred_at
       FROM ${table(ctx, "campaign_step_events")}
      WHERE campaign_id = $1 AND event_type = ANY(${textArrayParam(2)})
      ORDER BY occurred_at
      LIMIT 20000`,
    [campaignId, JSON.stringify(["sent", "reply"])],
  );
}

/** Running enrollments whose step email the outbox gave up on. */
export async function enrollmentsWithFailedSend(ctx: PluginContext): Promise<Array<EnrollmentDraft & { lastError: string | null }>> {
  const rows = await ctx.db.query<EnrollmentRow & { last_error: string | null }>(
    `SELECT e.id, e.company_id, e.campaign_id, e.contact_id, e.status, e.step_position, e.variant, e.next_due_at, e.open_issue_id,
            e.sending_key, e.mail_thread_id, e.mail_last_message_id, o.last_error
       FROM ${table(ctx, "campaign_enrollments")} e
       JOIN ${table(ctx, "outbox")} o ON o.key = e.sending_key
      WHERE e.status = 'running' AND o.status = 'failed'
      LIMIT 200`,
  );
  return rows.map((row) => ({ ...mapEnrollment(row), lastError: row.last_error ?? null }));
}

export async function markDecisionActed(ctx: PluginContext, decisionId: string): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "decisions")} SET acted = true WHERE id = $1`, [decisionId]);
}

export async function noteOutboxError(ctx: PluginContext, key: string, error: string): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "outbox")} SET last_error = $2 WHERE key = $1 AND status = 'pending'`, [key, error.slice(0, 500)]);
}

// ---------------------------------------------------------------------------
// Overview charts (read only)
// ---------------------------------------------------------------------------

/** Step events per campaign, type and variant, all time. */
export async function eventCounts(
  ctx: PluginContext,
  companyId: string,
): Promise<Array<{ campaign_id: string; event_type: string; variant: string | null; count: string | number }>> {
  return ctx.db.query(
    `SELECT campaign_id, event_type, variant, count(*) AS count
       FROM ${table(ctx, "campaign_step_events")}
      WHERE company_id = $1
      GROUP BY campaign_id, event_type, variant`,
    [companyId],
  );
}

/** Sends, replies and bounces per campaign and UTC day since `sinceIso`. */
export async function eventDays(
  ctx: PluginContext,
  companyId: string,
  sinceIso: string,
): Promise<Array<{ campaign_id: string; event_type: string; day: string; count: string | number }>> {
  return ctx.db.query(
    `SELECT campaign_id, event_type, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*) AS count
       FROM ${table(ctx, "campaign_step_events")}
      WHERE company_id = $1 AND event_type IN ('sent', 'reply', 'bounce') AND occurred_at >= $2::timestamptz
      GROUP BY campaign_id, event_type, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
    [companyId, sinceIso],
  );
}

// ---------------------------------------------------------------------------
// Done checks: edits, replies handled
// ---------------------------------------------------------------------------

/** A draft's content changed (steps, HTML, audience, sender, dates, description): a refused campaign must change before it is asked again. */
export async function markEdited(ctx: PluginContext, campaignId: string): Promise<void> {
  await ctx.db.execute(`UPDATE ${table(ctx, "campaigns")} SET edited_at = now() WHERE id = $1`, [campaignId]);
}

/** When the draft's content last changed (null when never since 0.5). */
export async function campaignEditedAt(ctx: PluginContext, campaignId: string): Promise<string | null> {
  const rows = await ctx.db.query<{ edited_at: unknown }>(`SELECT edited_at FROM ${table(ctx, "campaigns")} WHERE id = $1 LIMIT 1`, [campaignId]);
  return isoTime(rows[0]?.edited_at);
}

/** One enrollment's state with when it last changed (for the reply check). */
export async function enrollmentState(ctx: PluginContext, id: string): Promise<{ id: string; companyId: string; campaignId: string; contactId: string; status: string; updatedAt: string | null } | null> {
  const rows = await ctx.db.query<{ id: string; company_id: string; campaign_id: string; contact_id: string; status: string; updated_at: unknown }>(
    `SELECT id, company_id, campaign_id, contact_id, status, updated_at FROM ${table(ctx, "campaign_enrollments")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = rows[0];
  return row ? { id: row.id, companyId: row.company_id, campaignId: row.campaign_id, contactId: row.contact_id, status: row.status, updatedAt: isoTime(row.updated_at) } : null;
}

/** The reply event a Mailbox message recorded (its enrollment and campaign), or null. */
export async function replyEvent(ctx: PluginContext, companyId: string, messageId: string): Promise<{ enrollmentId: string; campaignId: string } | null> {
  const rows = await ctx.db.query<{ enrollment_id: string; campaign_id: string }>(
    `SELECT enrollment_id, campaign_id FROM ${table(ctx, "campaign_step_events")} WHERE company_id = $1 AND source_key = $2 LIMIT 1`,
    [companyId, `reply:${messageId}`],
  );
  return rows[0] ? { enrollmentId: rows[0].enrollment_id, campaignId: rows[0].campaign_id } : null;
}

export type ReplyOutcome = "answered" | "no-reply-needed";
export const REPLY_OUTCOMES: ReplyOutcome[] = ["answered", "no-reply-needed"];

export async function insertReplyLog(
  ctx: PluginContext,
  input: { companyId: string; messageId: string; campaignId: string | null; enrollmentId: string | null; outcome: ReplyOutcome; note: string; mailDraftId: string | null; createdBy: string | null },
): Promise<string> {
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "reply_log")} (id, company_id, message_id, campaign_id, enrollment_id, outcome, note, mail_draft_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, input.companyId, input.messageId, input.campaignId, input.enrollmentId, input.outcome, input.note, input.mailDraftId, input.createdBy],
  );
  return id;
}

/** True when an agent or person logged what was done about this reply. */
export async function replyLogged(ctx: PluginContext, companyId: string, messageId: string): Promise<boolean> {
  const rows = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "reply_log")} WHERE company_id = $1 AND message_id = $2 LIMIT 1`, [companyId, messageId]);
  return rows.length > 0;
}

/** True when this contact (or one of these addresses) is on the do-not-email list. */
export async function contactSuppressed(ctx: PluginContext, companyId: string, contactId: string, emails: string[]): Promise<boolean> {
  const byContact = await ctx.db.query<{ email: string }>(`SELECT email FROM ${table(ctx, "suppressions")} WHERE company_id = $1 AND contact_id = $2 LIMIT 1`, [companyId, contactId]);
  if (byContact.length > 0) return true;
  const wanted = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
  if (wanted.length === 0) return false;
  // On any sender's list counts: the person asked not to be emailed, which is what a reply issue wants to know.
  const rows = await ctx.db.query<{ email: string }>(
    `SELECT email FROM ${table(ctx, "suppressions")} WHERE company_id = $1 AND email = ANY(${textArrayParam(2)})`,
    [companyId, JSON.stringify(wanted)],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Running enrollments of a contact, by sender
// ---------------------------------------------------------------------------

/** The campaigns' senders by campaign id (own work is `own`). */
async function sendersOfCampaigns(ctx: PluginContext, campaignIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set(campaignIds)) {
    const campaign = await getCampaign(ctx, id);
    if (campaign) out.set(id, campaignSenderKey(campaign));
  }
  return out;
}

/**
 * Stops the contact's running enrollments in campaigns of this sender (every
 * campaign when `senderKey` is empty) and returns what it stopped with the step
 * issue each was waiting on, so the caller can cancel those.
 */
export async function stopEnrollmentsForSender(
  ctx: PluginContext,
  companyId: string,
  contactId: string,
  senderKey: string,
): Promise<Array<{ id: string; campaign_id: string; open_issue_id: string | null }>> {
  const rows = await ctx.db.query<{ id: string; campaign_id: string; open_issue_id: string | null }>(
    `SELECT id, campaign_id, open_issue_id FROM ${table(ctx, "campaign_enrollments")}
      WHERE company_id = $1 AND contact_id = $2 AND status = 'running'`,
    [companyId, contactId],
  );
  if (rows.length === 0) return [];
  const senders = senderKey ? await sendersOfCampaigns(ctx, rows.map((row) => row.campaign_id)) : new Map<string, string>();
  const stopped: typeof rows = [];
  for (const row of rows) {
    if (senderKey && senders.get(row.campaign_id) !== senderKey) continue;
    await stopEnrollment(ctx, row.id);
    stopped.push(row);
  }
  return stopped;
}

// ---------------------------------------------------------------------------
// Sender identities
// ---------------------------------------------------------------------------

export interface SenderIdentityRow {
  company_id: string;
  sender_key: string;
  from_address: string | null;
  from_name: string | null;
  reply_to: string | null;
  sms_from: string | null;
  whatsapp_from: string | null;
  updated_by?: string | null;
  updated_at?: unknown;
}

export async function listSenderIdentityRows(ctx: PluginContext, companyId: string): Promise<SenderIdentityRow[]> {
  return ctx.db.query<SenderIdentityRow>(
    `SELECT company_id, sender_key, from_address, from_name, reply_to, sms_from, whatsapp_from, updated_by, updated_at
       FROM ${table(ctx, "sender_identities")} WHERE company_id = $1 ORDER BY sender_key`,
    [companyId],
  );
}

export async function upsertSenderIdentity(ctx: PluginContext, row: SenderIdentityRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "sender_identities")} (company_id, sender_key, from_address, from_name, reply_to, sms_from, whatsapp_from, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (company_id, sender_key) DO UPDATE SET from_address = EXCLUDED.from_address, from_name = EXCLUDED.from_name,
       reply_to = EXCLUDED.reply_to, sms_from = EXCLUDED.sms_from, whatsapp_from = EXCLUDED.whatsapp_from, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [row.company_id, row.sender_key, row.from_address, row.from_name, row.reply_to, row.sms_from, row.whatsapp_from, row.updated_by ?? null],
  );
}

export async function deleteSenderIdentity(ctx: PluginContext, companyId: string, senderKey: string): Promise<boolean> {
  const res = await ctx.db.execute(`DELETE FROM ${table(ctx, "sender_identities")} WHERE company_id = $1 AND sender_key = $2`, [companyId, senderKey]);
  return (res?.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// SMS and WhatsApp: do-not-contact list, consent, messages
// ---------------------------------------------------------------------------

export type ChannelSuppressionReason = "stop_keyword" | "provider_opt_out" | "manual" | "consent_withdrawn" | "invalid_number";

export interface ChannelSuppressionInput {
  companyId: string;
  channel: MessagingChannel;
  /** E.164. */
  address: string;
  senderKey: string;
  reason: ChannelSuppressionReason;
  scope: "marketing" | "all";
  source: string;
  contactId?: string | null;
  campaignId?: string | null;
}

/** Stores an SMS or WhatsApp opt-out once per number and sender. True when it was new. */
export async function addChannelSuppression(ctx: PluginContext, input: ChannelSuppressionInput): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "channel_suppressions")} (company_id, channel, address, sender_key, reason, scope, source, contact_id, campaign_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (company_id, channel, address, sender_key) DO NOTHING`,
    [input.companyId, input.channel, input.address, input.senderKey, input.reason, input.scope, input.source, input.contactId ?? null, input.campaignId ?? null],
  );
  return (res?.rowCount ?? 0) > 0;
}

/**
 * Which of these numbers may not be messaged by this sender on this channel. A
 * `marketing` row blocks its own sender (and every sender when it has none); an
 * `all` row (a number that cannot be reached at all) blocks every sender.
 */
export async function blockedAddresses(ctx: PluginContext, companyId: string, channel: MessagingChannel, addresses: string[], senderKey: string): Promise<Set<string>> {
  const wanted = [...new Set(addresses.filter(Boolean))];
  if (wanted.length === 0) return new Set();
  const origin = new Map<string, string>();
  for (const address of wanted) {
    origin.set(address, address);
    origin.set(addressHash(address), address);
  }
  const rows = await ctx.db.query<{ address: string; scope: string; sender_key: string | null }>(
    `SELECT address, scope, sender_key FROM ${table(ctx, "channel_suppressions")}
      WHERE company_id = $1 AND channel = $2 AND address = ANY(${textArrayParam(3)})`,
    [companyId, channel, JSON.stringify([...origin.keys()])],
  );
  const blocked = new Set<string>();
  for (const row of rows) {
    if (!suppressionBlocks({ scope: row.scope === "all" ? "all" : "marketing", senderKey: row.sender_key || null }, { marketing: true, senderKey })) continue;
    const address = origin.get(row.address);
    if (address) blocked.add(address);
  }
  return blocked;
}

/** START or UNSTOP: the person asked to hear from this sender again. Only their own opt-out words are lifted, never one a person added. */
export async function liftChannelSuppression(ctx: PluginContext, companyId: string, channel: MessagingChannel, address: string, senderKey: string): Promise<number> {
  const res = await ctx.db.execute(
    `DELETE FROM ${table(ctx, "channel_suppressions")}
      WHERE company_id = $1 AND channel = $2 AND address = $3 AND sender_key = $4 AND reason = ANY(${textArrayParam(5)})`,
    [companyId, channel, address, senderKey, JSON.stringify(["stop_keyword", "provider_opt_out"])],
  );
  return res?.rowCount ?? 0;
}

export interface ConsentInput {
  companyId: string;
  channel: Channel;
  address: string;
  senderKey: string;
  granted: boolean;
  basis: string;
  source: string;
  evidence?: string | null;
  contactId?: string | null;
  recordedAt: string;
  recordedBy?: string | null;
}

export interface ConsentRow {
  company_id: string;
  channel: string;
  address: string;
  sender_key: string;
  granted: boolean;
  basis: string;
  source: string;
  evidence: string | null;
  contact_id: string | null;
  recorded_at: unknown;
  recorded_by: string | null;
}

/** Stores a consent record; a record older than the one held is ignored. True when it was stored. */
export async function upsertConsent(ctx: PluginContext, input: ConsentInput): Promise<boolean> {
  const held = await ctx.db.query<{ recorded_at: unknown }>(
    `SELECT recorded_at FROM ${table(ctx, "channel_consents")} WHERE company_id = $1 AND channel = $2 AND address = $3 AND sender_key = $4`,
    [input.companyId, input.channel, input.address, input.senderKey],
  );
  const have = held[0] ? Date.parse(String(held[0].recorded_at instanceof Date ? held[0].recorded_at.toISOString() : held[0].recorded_at)) : Number.NaN;
  const next = Date.parse(input.recordedAt);
  if (Number.isFinite(have) && Number.isFinite(next) && next < have) return false;
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "channel_consents")} (company_id, channel, address, sender_key, granted, basis, source, evidence, contact_id, recorded_at, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (company_id, channel, address, sender_key) DO UPDATE SET granted = EXCLUDED.granted, basis = EXCLUDED.basis,
       source = EXCLUDED.source, evidence = EXCLUDED.evidence, contact_id = EXCLUDED.contact_id, recorded_at = EXCLUDED.recorded_at, recorded_by = EXCLUDED.recorded_by`,
    [input.companyId, input.channel, input.address, input.senderKey, input.granted, input.basis, input.source, input.evidence?.slice(0, 500) ?? null, input.contactId ?? null, input.recordedAt, input.recordedBy ?? null],
  );
  return true;
}

/** Which of these numbers have a granted opt-in on file for this sender and channel. */
export async function consentedAddresses(ctx: PluginContext, companyId: string, channel: Channel, addresses: string[], senderKey: string): Promise<Set<string>> {
  const wanted = [...new Set(addresses.filter(Boolean))];
  if (wanted.length === 0) return new Set();
  const rows = await ctx.db.query<{ address: string }>(
    `SELECT address FROM ${table(ctx, "channel_consents")}
      WHERE company_id = $1 AND channel = $2 AND sender_key = $3 AND granted = true AND address = ANY(${textArrayParam(4)})`,
    [companyId, channel, senderKey, JSON.stringify(wanted)],
  );
  return new Set(rows.map((row) => row.address));
}

/** How many of these numbers have their granted opt-in recorded by an agent (`recorded_by` is `agent:<id>`), not from a form, import or the person. */
export async function agentRecordedConsents(ctx: PluginContext, companyId: string, channel: Channel, addresses: string[], senderKey: string): Promise<number> {
  const wanted = [...new Set(addresses.filter(Boolean))];
  if (wanted.length === 0) return 0;
  const rows = await ctx.db.query<{ address: string; recorded_by: string | null }>(
    `SELECT address, recorded_by FROM ${table(ctx, "channel_consents")}
      WHERE company_id = $1 AND channel = $2 AND sender_key = $3 AND granted = true AND address = ANY(${textArrayParam(4)})`,
    [companyId, channel, senderKey, JSON.stringify(wanted)],
  );
  return rows.filter((row) => typeof row.recorded_by === "string" && row.recorded_by.startsWith("agent:")).length;
}

export type MessageStatusValue = "sending" | "pending" | "sent" | "delivered" | "failed" | "unknown";

export interface ChannelMessageRow {
  key: string;
  company_id: string;
  campaign_id: string;
  enrollment_id: string;
  step_position: number;
  channel: MessagingChannel;
  to_address: string;
  contact_id: string | null;
  sender_key: string;
  body: string;
  segments: number | null;
  status: MessageStatusValue;
  provider_id: string | null;
  provider_status: string | null;
  error_code: string | null;
  error: string | null;
  attempts: number;
  updated_at?: unknown;
}

const MESSAGE_COLUMNS =
  "key, company_id, campaign_id, enrollment_id, step_position, channel, to_address, contact_id, sender_key, body, segments, status, provider_id, provider_status, error_code, error, attempts, updated_at";

/** Writes the message row before the provider is called. False when the step was already attempted. */
export async function claimMessage(
  ctx: PluginContext,
  input: Pick<ChannelMessageRow, "key" | "company_id" | "campaign_id" | "enrollment_id" | "step_position" | "channel" | "to_address" | "contact_id" | "sender_key" | "body" | "segments">,
): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "channel_messages")} (key, company_id, campaign_id, enrollment_id, step_position, channel, to_address, contact_id, sender_key, body, segments, status, attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'sending', 1)
     ON CONFLICT (key) DO NOTHING`,
    [input.key, input.company_id, input.campaign_id, input.enrollment_id, input.step_position, input.channel, input.to_address, input.contact_id, input.sender_key, input.body, input.segments],
  );
  return (res?.rowCount ?? 0) > 0;
}

export async function getMessage(ctx: PluginContext, key: string): Promise<ChannelMessageRow | null> {
  const rows = await ctx.db.query<ChannelMessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM ${table(ctx, "channel_messages")} WHERE key = $1`, [key]);
  return rows[0] ?? null;
}

/** Changes the fields named in `patch`; the rest stay. */
export async function updateMessage(
  ctx: PluginContext,
  key: string,
  patch: Partial<Pick<ChannelMessageRow, "status" | "provider_id" | "provider_status" | "error_code" | "error" | "segments" | "attempts">>,
): Promise<void> {
  const row = await getMessage(ctx, key);
  if (!row) return;
  const next = { ...row, ...patch };
  await ctx.db.execute(
    `UPDATE ${table(ctx, "channel_messages")}
        SET status = $2, provider_id = $3, provider_status = $4, error_code = $5, error = $6, segments = $7, attempts = $8, updated_at = now()
      WHERE key = $1`,
    [key, next.status, next.provider_id ?? null, next.provider_status ?? null, next.error_code ?? null, next.error ? next.error.slice(0, 500) : null, next.segments ?? null, next.attempts ?? 1],
  );
}

/**
 * Sent messages whose delivery status the provider has not confirmed yet, newest first.
 * Newest first so messages a carrier never confirms (they stay `sent` until they age out of
 * the lookback) cannot crowd newer ones out of the batch and delay their delivery results
 * and the provider's STOP block (21610).
 */
export async function messagesAwaitingStatus(ctx: PluginContext, companyId: string, sinceIso: string, limit = 50): Promise<ChannelMessageRow[]> {
  return ctx.db.query<ChannelMessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM ${table(ctx, "channel_messages")}
      WHERE company_id = $1 AND status = 'sent' AND provider_id IS NOT NULL AND created_at >= $2::timestamptz
      ORDER BY created_at DESC
      LIMIT ${Math.max(1, Math.min(limit, 200))}`,
    [companyId, sinceIso],
  );
}

/** Contacts whose projected phone numbers match an E.164 number (compared on the last nine digits, then exactly). */
export async function crmContactsByPhone(ctx: PluginContext, companyId: string, tail: string): Promise<Array<{ id: string; name: string; emails: string[]; phones: string[] }>> {
  return ctx.db.query<{ id: string; name: string; emails: string[]; phones: string[] }>(
    `SELECT id, name, emails, phones
       FROM ${table(ctx, "crm_contacts")}
      WHERE company_id = $1 AND deleted = false
        AND EXISTS (SELECT 1 FROM unnest(phones) AS p(value) WHERE right(regexp_replace(p.value, '[^0-9]', '', 'g'), 9) = $2)
      ORDER BY updated_at, id
      LIMIT 10`,
    [companyId, tail],
  );
}

/**
 * The newest SMS or WhatsApp message we sent to this number. With a `senderKey` only
 * messages sent for that sender count: a person who got a client's text and answers PiB's
 * own number (or the reverse) is not answering the other sender's campaign.
 */
export async function latestMessageFor(ctx: PluginContext, companyId: string, toAddress: string, channel: MessagingChannel, senderKey?: string | null): Promise<ChannelMessageRow | null> {
  const rows = await ctx.db.query<ChannelMessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM ${table(ctx, "channel_messages")}
      WHERE company_id = $1 AND channel = $2 AND to_address = $3${senderKey ? " AND sender_key = $4" : ""}
      ORDER BY created_at DESC
      LIMIT 1`,
    senderKey ? [companyId, channel, toAddress, senderKey] : [companyId, channel, toAddress],
  );
  return rows[0] ?? null;
}
