import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { assertDelivery, audienceSource, matchesAudience, type AudienceMode, type CampaignDraft, type CampaignStepDraft, type EnrollmentDraft } from "./domain.js";
import { clientWhere, listCrmContacts, listCrmContactsAtCompany, textArrayParam, type ClientScope } from "@partnersinbiz/pib-plugin-kit";

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
}

const CAMPAIGN_COLUMNS =
  "id, company_id, name, description, status, from_name, from_local, reply_to, audience_tags, start_at, end_at, approval_issue_id, winner_variant, client_kind, client_ref, client_name, audience_mode, delivery, owner_user_id, owner_agent_id";

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
    delivery: row.delivery === "email" ? "email" : "issue",
    ownerUserId: row.owner_user_id ?? null,
    ownerAgentId: row.owner_agent_id ?? null,
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

export async function listSteps(ctx: PluginContext, campaignId: string): Promise<CampaignStepDraft[]> {
  const rows = await ctx.db.query<StepRow>(
    `SELECT id, company_id, campaign_id, position, delay_days, subject, body, html_body, variant
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
  }));
}

export async function insertStep(
  ctx: PluginContext,
  input: { companyId: string; campaignId: string; step: CampaignStepDraft },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "campaign_steps")}
      (id, company_id, campaign_id, position, delay_days, subject, body, html_body, variant)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), input.companyId, input.campaignId, input.step.position, input.step.delayDays, input.step.subject, input.step.body, input.step.htmlBody, input.step.variant],
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

/**
 * Contacts from the local CRM projection (fed by CRM events). A plugin may not
 * read the CRM schema directly. Tag matching is case-insensitive; an empty tag
 * list means every contact.
 */
export async function crmContactsByTags(
  ctx: PluginContext,
  companyId: string,
  tags: string[],
): Promise<Array<{ id: string; name: string; tags: string[]; emails: string[] }>> {
  const rows = await listCrmContacts(ctx, ctx.db.namespace, companyId);
  const wanted = new Set(tags.map((tag) => tag.toLowerCase()));
  return rows
    .map((row) => ({ id: row.id, name: row.name, tags: row.tags ?? [], emails: row.emails ?? [] }))
    .filter((contact) => wanted.size === 0 || contact.tags.some((tag) => wanted.has(tag.toLowerCase())));
}

export async function crmContactsByIds(
  ctx: PluginContext,
  companyId: string,
  ids: string[],
): Promise<Array<{ id: string; name: string; tags: string[]; emails: string[] }>> {
  const rows = await listCrmContacts(ctx, ctx.db.namespace, companyId, { ids });
  return rows.map((row) => ({ id: row.id, name: row.name, tags: row.tags ?? [], emails: row.emails ?? [] }));
}

export interface AudienceContact {
  id: string;
  name: string;
  tags: string[];
  emails: string[];
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
      .map((row) => ({ id: row.id, name: row.name, tags: row.tags ?? [], emails: row.emails ?? [] }))
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
    eventType: "sent" | "reply" | "bounce" | "unsubscribe";
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

export async function isSuppressed(ctx: PluginContext, companyId: string, email: string): Promise<boolean> {
  const rows = await ctx.db.query<{ reason: string }>(
    `SELECT reason FROM ${table(ctx, "suppressions")} WHERE company_id = $1 AND email = $2 LIMIT 1`,
    [companyId, email.trim().toLowerCase()],
  );
  return rows.length > 0;
}

export async function addSuppression(
  ctx: PluginContext,
  input: { companyId: string; email: string; reason: "unsubscribe" | "bounce"; contactId: string | null; campaignId: string | null },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "suppressions")} (company_id, email, reason, contact_id, campaign_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (company_id, email) DO NOTHING`,
    [input.companyId, input.email.trim().toLowerCase(), input.reason, input.contactId, input.campaignId],
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
