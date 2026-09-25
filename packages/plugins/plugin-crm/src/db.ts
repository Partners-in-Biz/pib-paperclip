import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  AccountDraft,
  ContactDraft,
  DealDraft,
  EnrollmentDraft,
  FactDraft,
  Grant,
  Lifecycle,
  LinkDraft,
  NextActionKind,
  PrincipalType,
  ProductDraft,
  RecordType,
  SequenceStepDraft,
  StageKind,
} from "./domain.js";
import { DEFAULT_STAGES } from "./domain.js";

interface AccountRow {
  id: string;
  company_id: string;
  name: string;
  domain: string | null;
  lifecycle: string;
  currency: string;
  custom: unknown;
  human_owned_fields: unknown;
  owner_user_id: string | null;
  assignee_agent_id: string | null;
  tags: unknown;
}

interface ContactRow {
  id: string;
  company_id: string;
  name: string;
  emails: unknown;
  phones: unknown;
  lifecycle: string;
  custom: unknown;
  human_owned_fields: unknown;
  owner_user_id: string | null;
  assignee_agent_id: string | null;
  tags: unknown;
  next_action_kind: string | null;
  next_action_due_at: unknown;
}

interface LinkRow {
  id: string;
  company_id: string;
  contact_id: string;
  account_id: string;
  role_label: string;
}

interface DealRow {
  id: string;
  company_id: string;
  pipeline_id: string;
  stage_id: string;
  account_id: string | null;
  contact_id: string | null;
  title: string;
  amount_minor: number | string;
  currency: string;
  owner_user_id: string | null;
  assignee_agent_id: string | null;
  tags: unknown;
  next_action_kind: string | null;
  next_action_due_at: unknown;
  custom: unknown;
  human_owned_fields: unknown;
}

interface StageRow {
  id: string;
  company_id: string;
  pipeline_id: string;
  name: string;
  kind: string;
  position: number;
}

interface SequenceRow {
  id: string;
  company_id: string;
  name: string;
  completion_mode: string;
}

interface StepRow {
  id: string;
  company_id: string;
  sequence_id: string;
  position: number;
  delay_minutes: number;
  title: string;
  body: string;
}

interface EnrollmentRow {
  id: string;
  company_id: string;
  sequence_id: string;
  contact_id: string;
  status: string;
  step_position: number;
  next_due_at: unknown;
  open_issue_id: string | null;
}

export function table(ctx: PluginContext, name: string): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace)) throw new Error("Unsafe namespace");
  if (!/^[a-z_]+$/.test(name)) throw new Error("Unsafe table");
  return `${ctx.db.namespace}.${name}`;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

export function asStringList(value: unknown): string[] {
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

function mapAccount(row: AccountRow): AccountDraft {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    domain: row.domain,
    lifecycle: row.lifecycle as Lifecycle,
    currency: row.currency,
    custom: asRecord(row.custom),
    humanOwned: asStringList(row.human_owned_fields),
    ownerUserId: row.owner_user_id,
    assigneeAgentId: row.assignee_agent_id,
    tags: asStringList(row.tags),
  };
}

function mapContact(row: ContactRow): ContactDraft {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    emails: asStringList(row.emails),
    phones: asStringList(row.phones),
    lifecycle: row.lifecycle as Lifecycle,
    custom: asRecord(row.custom),
    humanOwned: asStringList(row.human_owned_fields),
    ownerUserId: row.owner_user_id,
    assigneeAgentId: row.assignee_agent_id,
    tags: asStringList(row.tags),
    nextActionKind: (row.next_action_kind as NextActionKind | null) ?? null,
    nextActionDueAt: asIso(row.next_action_due_at),
  };
}

function mapDeal(row: DealRow): DealDraft {
  const amount = typeof row.amount_minor === "number" ? row.amount_minor : Number(row.amount_minor);
  return {
    id: row.id,
    companyId: row.company_id,
    pipelineId: row.pipeline_id,
    stageId: row.stage_id,
    accountId: row.account_id,
    contactId: row.contact_id,
    title: row.title,
    amountMinor: Number.isFinite(amount) ? amount : 0,
    currency: row.currency,
    ownerUserId: row.owner_user_id,
    assigneeAgentId: row.assignee_agent_id,
    tags: asStringList(row.tags),
    nextActionKind: (row.next_action_kind as NextActionKind | null) ?? null,
    nextActionDueAt: asIso(row.next_action_due_at),
    custom: asRecord(row.custom),
    humanOwned: asStringList(row.human_owned_fields),
  };
}

function mapEnrollment(row: EnrollmentRow): EnrollmentDraft {
  return {
    id: row.id,
    companyId: row.company_id,
    sequenceId: row.sequence_id,
    contactId: row.contact_id,
    status: row.status as EnrollmentDraft["status"],
    stepPosition: row.step_position,
    nextDueAt: asIso(row.next_due_at),
    openIssueId: row.open_issue_id,
  };
}

export async function grantsFor(ctx: PluginContext, recordType: RecordType, companyId: string): Promise<Map<string, Grant[]>> {
  const rows = await ctx.db.query<{ record_id: string; principal_type: PrincipalType; principal_id: string }>(
    `SELECT record_id, principal_type, principal_id
       FROM ${table(ctx, "record_grants")}
      WHERE record_type = $1
        AND (company_id = $2 OR (principal_type = 'company' AND principal_id = $2))`,
    [recordType, companyId],
  );
  const grouped = new Map<string, Grant[]>();
  for (const row of rows) {
    const list = grouped.get(row.record_id) ?? [];
    list.push({ principalType: row.principal_type, principalId: row.principal_id });
    grouped.set(row.record_id, list);
  }
  return grouped;
}

export async function listAccounts(ctx: PluginContext, companyId: string): Promise<AccountDraft[]> {
  const rows = await ctx.db.query<AccountRow>(
    `SELECT id, company_id, name, domain, lifecycle, currency, custom, human_owned_fields,
            owner_user_id, assignee_agent_id, tags
       FROM ${table(ctx, "companies")}
      WHERE company_id = $1
         OR id IN (
              SELECT record_id FROM ${table(ctx, "record_grants")}
               WHERE record_type = 'company' AND principal_type = 'company' AND principal_id = $1
            )
      ORDER BY name`,
    [companyId],
  );
  return rows.map(mapAccount);
}

export async function getAccount(ctx: PluginContext, id: string): Promise<AccountDraft | null> {
  const rows = await ctx.db.query<AccountRow>(
    `SELECT id, company_id, name, domain, lifecycle, currency, custom, human_owned_fields,
            owner_user_id, assignee_agent_id, tags
       FROM ${table(ctx, "companies")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ? mapAccount(rows[0]) : null;
}

export async function insertAccount(ctx: PluginContext, account: AccountDraft): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "companies")}
      (id, company_id, name, domain, lifecycle, currency, custom, human_owned_fields, owner_user_id, assignee_agent_id, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb)`,
    [
      account.id,
      account.companyId,
      account.name,
      account.domain,
      account.lifecycle,
      account.currency,
      json(account.custom),
      json(account.humanOwned),
      account.ownerUserId,
      account.assigneeAgentId,
      json(account.tags),
    ],
  );
}

export async function saveAccount(ctx: PluginContext, account: AccountDraft): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "companies")}
        SET name = $2, domain = $3, lifecycle = $4, currency = $5, custom = $6::jsonb,
            human_owned_fields = $7::jsonb, tags = $8::jsonb, updated_at = now()
      WHERE id = $1`,
    [account.id, account.name, account.domain, account.lifecycle, account.currency, json(account.custom), json(account.humanOwned), json(account.tags)],
  );
}

export async function listContacts(ctx: PluginContext, companyId: string): Promise<ContactDraft[]> {
  const rows = await ctx.db.query<ContactRow>(
    `SELECT id, company_id, name, emails, phones, lifecycle, custom, human_owned_fields,
            owner_user_id, assignee_agent_id, tags, next_action_kind, next_action_due_at
       FROM ${table(ctx, "contacts")}
      WHERE company_id = $1
         OR id IN (
              SELECT record_id FROM ${table(ctx, "record_grants")}
               WHERE record_type = 'contact' AND principal_type = 'company' AND principal_id = $1
            )
      ORDER BY name`,
    [companyId],
  );
  return rows.map(mapContact);
}

export async function getContact(ctx: PluginContext, id: string): Promise<ContactDraft | null> {
  const rows = await ctx.db.query<ContactRow>(
    `SELECT id, company_id, name, emails, phones, lifecycle, custom, human_owned_fields,
            owner_user_id, assignee_agent_id, tags, next_action_kind, next_action_due_at
       FROM ${table(ctx, "contacts")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ? mapContact(rows[0]) : null;
}

export async function insertContact(ctx: PluginContext, contact: ContactDraft): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "contacts")}
      (id, company_id, name, emails, phones, lifecycle, custom, human_owned_fields, owner_user_id,
       assignee_agent_id, tags, next_action_kind, next_action_due_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb, $12, $13)`,
    [
      contact.id,
      contact.companyId,
      contact.name,
      json(contact.emails),
      json(contact.phones),
      contact.lifecycle,
      json(contact.custom),
      json(contact.humanOwned),
      contact.ownerUserId,
      contact.assigneeAgentId,
      json(contact.tags),
      contact.nextActionKind,
      contact.nextActionDueAt,
    ],
  );
}

export async function saveContact(ctx: PluginContext, contact: ContactDraft): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "contacts")}
        SET name = $2, emails = $3::jsonb, phones = $4::jsonb, lifecycle = $5, custom = $6::jsonb,
            human_owned_fields = $7::jsonb, tags = $8::jsonb, next_action_kind = $9, next_action_due_at = $10,
            updated_at = now()
      WHERE id = $1`,
    [
      contact.id,
      contact.name,
      json(contact.emails),
      json(contact.phones),
      contact.lifecycle,
      json(contact.custom),
      json(contact.humanOwned),
      json(contact.tags),
      contact.nextActionKind,
      contact.nextActionDueAt,
    ],
  );
}

export async function listLinks(ctx: PluginContext, companyId: string): Promise<LinkDraft[]> {
  const rows = await ctx.db.query<LinkRow>(
    `SELECT id, company_id, contact_id, account_id, role_label
       FROM ${table(ctx, "contact_companies")}
      WHERE company_id = $1
      ORDER BY created_at`,
    [companyId],
  );
  return rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    contactId: row.contact_id,
    accountId: row.account_id,
    roleLabel: row.role_label,
  }));
}

export async function insertLink(ctx: PluginContext, link: LinkDraft): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "contact_companies")}
      (id, company_id, contact_id, account_id, role_label)
     VALUES ($1, $2, $3, $4, $5)`,
    [link.id, link.companyId, link.contactId, link.accountId, link.roleLabel],
  );
}

export async function insertFacts(
  ctx: PluginContext,
  companyId: string,
  recordType: RecordType,
  recordId: string,
  facts: FactDraft[],
): Promise<void> {
  for (const fact of facts) {
    await ctx.db.execute(
      `INSERT INTO ${table(ctx, "facts")}
        (id, company_id, record_type, record_id, field_key, value, source, refused)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [randomUUID(), companyId, recordType, recordId, fact.fieldKey, json(fact.value), fact.source, fact.refused],
    );
  }
}

export async function insertActivity(
  ctx: PluginContext,
  input: { companyId: string; recordType: RecordType; recordId: string; kind: string; body: string; issueId?: string | null },
): Promise<string> {
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "activities")}
      (id, company_id, record_type, record_id, kind, body, issue_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.companyId, input.recordType, input.recordId, input.kind, input.body, input.issueId ?? null],
  );
  return id;
}

export async function insertGrant(
  ctx: PluginContext,
  input: { companyId: string; recordType: RecordType; recordId: string; principalType: PrincipalType; principalId: string },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "record_grants")}
      (id, company_id, record_type, record_id, principal_type, principal_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (record_type, record_id, principal_type, principal_id) DO NOTHING`,
    [randomUUID(), input.companyId, input.recordType, input.recordId, input.principalType, input.principalId],
  );
}

export async function listDeals(ctx: PluginContext, companyId: string): Promise<DealDraft[]> {
  const rows = await ctx.db.query<DealRow>(
    `SELECT id, company_id, pipeline_id, stage_id, account_id, contact_id, title, amount_minor, currency,
            owner_user_id, assignee_agent_id, tags, next_action_kind, next_action_due_at, custom, human_owned_fields
       FROM ${table(ctx, "deals")}
      WHERE company_id = $1
         OR id IN (
              SELECT record_id FROM ${table(ctx, "record_grants")}
               WHERE record_type = 'deal' AND principal_type = 'company' AND principal_id = $1
            )
      ORDER BY created_at DESC`,
    [companyId],
  );
  return rows.map(mapDeal);
}

export async function getDeal(ctx: PluginContext, id: string): Promise<DealDraft | null> {
  const rows = await ctx.db.query<DealRow>(
    `SELECT id, company_id, pipeline_id, stage_id, account_id, contact_id, title, amount_minor, currency,
            owner_user_id, assignee_agent_id, tags, next_action_kind, next_action_due_at, custom, human_owned_fields
       FROM ${table(ctx, "deals")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ? mapDeal(rows[0]) : null;
}

export async function ensurePipeline(ctx: PluginContext, companyId: string): Promise<{ pipelineId: string; openStageId: string }> {
  const existing = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${table(ctx, "pipelines")} WHERE company_id = $1 ORDER BY created_at LIMIT 1`,
    [companyId],
  );
  let pipelineId = existing[0]?.id;
  if (!pipelineId) {
    pipelineId = randomUUID();
    await ctx.db.execute(
      `INSERT INTO ${table(ctx, "pipelines")} (id, company_id, name) VALUES ($1, $2, 'Sales')`,
      [pipelineId, companyId],
    );
    for (const stage of DEFAULT_STAGES) {
      await ctx.db.execute(
        `INSERT INTO ${table(ctx, "pipeline_stages")}
          (id, company_id, pipeline_id, name, kind, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), companyId, pipelineId, stage.name, stage.kind, stage.position],
      );
    }
  }
  const stages = await listStages(ctx, pipelineId);
  const open = stages.find((stage) => stage.kind === "open") ?? stages[0];
  if (!open) throw new Error("Pipeline has no stages");
  return { pipelineId, openStageId: open.id };
}

export async function listStages(ctx: PluginContext, pipelineId: string): Promise<StageRow[]> {
  return ctx.db.query<StageRow>(
    `SELECT id, company_id, pipeline_id, name, kind, position
       FROM ${table(ctx, "pipeline_stages")}
      WHERE pipeline_id = $1
      ORDER BY position`,
    [pipelineId],
  );
}

export async function getStage(ctx: PluginContext, stageId: string): Promise<StageRow | null> {
  const rows = await ctx.db.query<StageRow>(
    `SELECT id, company_id, pipeline_id, name, kind, position
       FROM ${table(ctx, "pipeline_stages")} WHERE id = $1 LIMIT 1`,
    [stageId],
  );
  return rows[0] ?? null;
}

export async function insertDeal(ctx: PluginContext, deal: DealDraft): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "deals")}
      (id, company_id, pipeline_id, stage_id, account_id, contact_id, title, amount_minor, currency,
       owner_user_id, assignee_agent_id, tags, next_action_kind, next_action_due_at, custom, human_owned_fields)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15::jsonb, $16::jsonb)`,
    [
      deal.id,
      deal.companyId,
      deal.pipelineId,
      deal.stageId,
      deal.accountId,
      deal.contactId,
      deal.title,
      deal.amountMinor,
      deal.currency,
      deal.ownerUserId,
      deal.assigneeAgentId,
      json(deal.tags),
      deal.nextActionKind,
      deal.nextActionDueAt,
      json(deal.custom),
      json(deal.humanOwned),
    ],
  );
}

export async function saveDeal(ctx: PluginContext, deal: DealDraft): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "deals")}
        SET stage_id = $2, title = $3, amount_minor = $4, currency = $5, tags = $6::jsonb,
            next_action_kind = $7, next_action_due_at = $8, custom = $9::jsonb,
            human_owned_fields = $10::jsonb, updated_at = now()
      WHERE id = $1`,
    [
      deal.id,
      deal.stageId,
      deal.title,
      deal.amountMinor,
      deal.currency,
      json(deal.tags),
      deal.nextActionKind,
      deal.nextActionDueAt,
      json(deal.custom),
      json(deal.humanOwned),
    ],
  );
}

export async function stopEnrollmentsForContact(ctx: PluginContext, companyId: string, contactId: string): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "enrollments")}
        SET status = 'stopped', updated_at = now()
      WHERE company_id = $1 AND contact_id = $2 AND status = 'running'`,
    [companyId, contactId],
  );
}

export async function listSequences(ctx: PluginContext, companyId: string): Promise<SequenceRow[]> {
  return ctx.db.query<SequenceRow>(
    `SELECT id, company_id, name, completion_mode FROM ${table(ctx, "sequences")} WHERE company_id = $1 ORDER BY name`,
    [companyId],
  );
}

export async function getSequence(ctx: PluginContext, id: string): Promise<SequenceRow | null> {
  const rows = await ctx.db.query<SequenceRow>(
    `SELECT id, company_id, name, completion_mode FROM ${table(ctx, "sequences")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertSequence(
  ctx: PluginContext,
  input: { id: string; companyId: string; name: string; completionMode: string },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "sequences")} (id, company_id, name, completion_mode) VALUES ($1, $2, $3, $4)`,
    [input.id, input.companyId, input.name, input.completionMode],
  );
}

export async function listSteps(ctx: PluginContext, sequenceId: string): Promise<SequenceStepDraft[]> {
  const rows = await ctx.db.query<StepRow>(
    `SELECT id, company_id, sequence_id, position, delay_minutes, title, body
       FROM ${table(ctx, "sequence_steps")} WHERE sequence_id = $1 ORDER BY position`,
    [sequenceId],
  );
  return rows.map((row) => ({
    position: row.position,
    delayMinutes: row.delay_minutes,
    title: row.title,
    body: row.body,
  }));
}

export async function insertStep(
  ctx: PluginContext,
  input: { companyId: string; sequenceId: string; step: SequenceStepDraft },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "sequence_steps")}
      (id, company_id, sequence_id, position, delay_minutes, title, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), input.companyId, input.sequenceId, input.step.position, input.step.delayMinutes, input.step.title, input.step.body],
  );
}

export async function enrollmentsForContact(ctx: PluginContext, sequenceId: string, contactId: string): Promise<EnrollmentDraft[]> {
  const rows = await ctx.db.query<EnrollmentRow>(
    `SELECT id, company_id, sequence_id, contact_id, status, step_position, next_due_at, open_issue_id
       FROM ${table(ctx, "enrollments")}
      WHERE sequence_id = $1 AND contact_id = $2`,
    [sequenceId, contactId],
  );
  return rows.map(mapEnrollment);
}

export async function insertEnrollment(ctx: PluginContext, enrollment: EnrollmentDraft): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "enrollments")}
      (id, company_id, sequence_id, contact_id, status, step_position, next_due_at, open_issue_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      enrollment.id,
      enrollment.companyId,
      enrollment.sequenceId,
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
    `UPDATE ${table(ctx, "enrollments")}
        SET status = $2, step_position = $3, next_due_at = $4, open_issue_id = $5, updated_at = now()
      WHERE id = $1`,
    [enrollment.id, enrollment.status, enrollment.stepPosition, enrollment.nextDueAt, enrollment.openIssueId],
  );
}

export async function dueEnrollments(ctx: PluginContext): Promise<EnrollmentDraft[]> {
  const rows = await ctx.db.query<EnrollmentRow>(
    `SELECT id, company_id, sequence_id, contact_id, status, step_position, next_due_at, open_issue_id
       FROM ${table(ctx, "enrollments")}
      WHERE status = 'running' AND open_issue_id IS NULL AND next_due_at IS NOT NULL AND next_due_at <= now()`,
  );
  return rows.map(mapEnrollment);
}

export async function enrollmentByIssue(ctx: PluginContext, issueId: string): Promise<EnrollmentDraft | null> {
  const rows = await ctx.db.query<EnrollmentRow>(
    `SELECT id, company_id, sequence_id, contact_id, status, step_position, next_due_at, open_issue_id
       FROM ${table(ctx, "enrollments")}
      WHERE open_issue_id = $1 AND status = 'running'
      LIMIT 1`,
    [issueId],
  );
  return rows[0] ? mapEnrollment(rows[0]) : null;
}

export async function defineField(
  ctx: PluginContext,
  input: { companyId: string; recordType: RecordType; fieldKey: string; label: string; fieldType: string },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "field_defs")}
      (id, company_id, record_type, field_key, label, field_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (company_id, record_type, field_key) DO NOTHING`,
    [randomUUID(), input.companyId, input.recordType, input.fieldKey, input.label, input.fieldType],
  );
}

export function stageKind(value: string): StageKind {
  if (value === "won" || value === "lost" || value === "open") return value;
  return "open";
}

interface ProductRow {
  id: string;
  company_id: string;
  name: string;
  description: string;
  unit_amount_minor: number | string;
  currency: string;
  is_active: boolean;
}

interface ActivityRow {
  id: string;
  company_id: string;
  record_type: string;
  record_id: string;
  kind: string;
  body: string;
  issue_id: string | null;
  created_at: unknown;
}

function mapProduct(row: ProductRow): ProductDraft {
  const amount = typeof row.unit_amount_minor === "number" ? row.unit_amount_minor : Number(row.unit_amount_minor);
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    description: row.description,
    unitAmountMinor: Number.isFinite(amount) ? amount : 0,
    currency: row.currency,
    isActive: row.is_active,
  };
}

export async function listProducts(ctx: PluginContext, companyId: string): Promise<ProductDraft[]> {
  const rows = await ctx.db.query<ProductRow>(
    `SELECT id, company_id, name, description, unit_amount_minor, currency, is_active
       FROM ${table(ctx, "products")}
      WHERE company_id = $1
      ORDER BY name`,
    [companyId],
  );
  return rows.map(mapProduct);
}

export async function getProduct(ctx: PluginContext, id: string): Promise<ProductDraft | null> {
  const rows = await ctx.db.query<ProductRow>(
    `SELECT id, company_id, name, description, unit_amount_minor, currency, is_active
       FROM ${table(ctx, "products")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ? mapProduct(rows[0]) : null;
}

export async function insertProduct(ctx: PluginContext, product: ProductDraft): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "products")}
      (id, company_id, name, description, unit_amount_minor, currency, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [product.id, product.companyId, product.name, product.description, product.unitAmountMinor, product.currency, product.isActive],
  );
}

export async function saveProduct(ctx: PluginContext, product: ProductDraft): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "products")}
        SET name = $2, description = $3, unit_amount_minor = $4, currency = $5, is_active = $6, updated_at = now()
      WHERE id = $1`,
    [product.id, product.name, product.description, product.unitAmountMinor, product.currency, product.isActive],
  );
}

export async function listActivities(
  ctx: PluginContext,
  recordType: RecordType,
  recordId: string,
  limit = 50,
): Promise<Array<{ id: string; kind: string; body: string; issueId: string | null; createdAt: string }>> {
  const rows = await ctx.db.query<ActivityRow>(
    `SELECT id, company_id, record_type, record_id, kind, body, issue_id, created_at
       FROM ${table(ctx, "activities")}
      WHERE record_type = $1 AND record_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [recordType, recordId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    body: row.body,
    issueId: row.issue_id,
    createdAt: row.created_at == null ? "" : String(row.created_at),
  }));
}

export async function contactEngagement(
  ctx: PluginContext,
  contactId: string,
): Promise<{ activityCount: number; lastActivityAt: string | null }> {
  const rows = await ctx.db.query<{ count: string | number; last_at: unknown }>(
    `SELECT count(*) AS count, max(created_at) AS last_at
       FROM ${table(ctx, "activities")}
      WHERE record_type = 'contact' AND record_id = $1`,
    [contactId],
  );
  const row = rows[0];
  if (!row) return { activityCount: 0, lastActivityAt: null };
  return {
    activityCount: Number(row.count ?? 0),
    lastActivityAt: row.last_at == null ? null : String(row.last_at),
  };
}

export async function findDuplicateContacts(ctx: PluginContext, companyId: string): Promise<Array<{ id: string; name: string; emails: string[] }>> {
  const rows = await ctx.db.query<{ id: string; name: string; emails: unknown }>(
    `SELECT id, name, emails FROM ${table(ctx, "contacts")} WHERE company_id = $1`,
    [companyId],
  );
  return rows.map((row) => ({ id: row.id, name: row.name, emails: asStringList(row.emails) }));
}

export async function mergeContacts(
  ctx: PluginContext,
  input: { companyId: string; primaryId: string; duplicateId: string },
): Promise<void> {
  const { companyId, primaryId, duplicateId } = input;
  // Move links, deals, activities, facts, and enrollments to the primary.
  await ctx.db.execute(
    `UPDATE ${table(ctx, "contact_companies")} SET contact_id = $1 WHERE company_id = $2 AND contact_id = $3`,
    [primaryId, companyId, duplicateId],
  );
  await ctx.db.execute(
    `UPDATE ${table(ctx, "deals")} SET contact_id = $1 WHERE company_id = $2 AND contact_id = $3`,
    [primaryId, companyId, duplicateId],
  );
  await ctx.db.execute(
    `UPDATE ${table(ctx, "activities")} SET record_id = $1 WHERE company_id = $2 AND record_type = 'contact' AND record_id = $3`,
    [primaryId, companyId, duplicateId],
  );
  await ctx.db.execute(
    `UPDATE ${table(ctx, "facts")} SET record_id = $1 WHERE company_id = $2 AND record_type = 'contact' AND record_id = $3`,
    [primaryId, companyId, duplicateId],
  );
  await ctx.db.execute(
    `UPDATE ${table(ctx, "enrollments")} SET contact_id = $1 WHERE company_id = $2 AND contact_id = $3`,
    [primaryId, companyId, duplicateId],
  );
  await ctx.db.execute(
    `UPDATE ${table(ctx, "record_grants")} SET record_id = $1 WHERE company_id = $2 AND record_type = 'contact' AND record_id = $3`,
    [primaryId, companyId, duplicateId],
  );
  // Delete the duplicate.
  await ctx.db.execute(
    `DELETE FROM ${table(ctx, "contacts")} WHERE id = $1 AND company_id = $2`,
    [duplicateId, companyId],
  );
}

export interface SavedViewRow {
  id: string;
  company_id: string;
  name: string;
  record_type: string;
  filters: unknown;
  created_by_user_id: string | null;
}

export async function listSavedViews(ctx: PluginContext, companyId: string): Promise<SavedViewRow[]> {
  return ctx.db.query<SavedViewRow>(
    `SELECT id, company_id, name, record_type, filters, created_by_user_id
       FROM ${table(ctx, "saved_views")}
      WHERE company_id = $1
      ORDER BY name`,
    [companyId],
  );
}

export async function insertSavedView(ctx: PluginContext, view: SavedViewRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "saved_views")}
      (id, company_id, name, record_type, filters, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [view.id, view.company_id, view.name, view.record_type, JSON.stringify(view.filters ?? {}), view.created_by_user_id],
  );
}

export async function deleteSavedView(ctx: PluginContext, companyId: string, id: string): Promise<boolean> {
  const result = await ctx.db.execute(
    `DELETE FROM ${table(ctx, "saved_views")} WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  return result != null;
}

export async function listFacts(
  ctx: PluginContext,
  recordType: RecordType,
  recordId: string,
  limit = 100,
): Promise<Array<{ fieldKey: string; value: unknown; source: string; refused: boolean; createdAt: string }>> {
  const rows = await ctx.db.query<{ field_key: string; value: unknown; source: string; refused: boolean; created_at: unknown }>(
    `SELECT field_key, value, source, refused, created_at
       FROM ${table(ctx, "facts")}
      WHERE record_type = $1 AND record_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [recordType, recordId, limit],
  );
  return rows.map((row) => ({
    fieldKey: row.field_key,
    value: asRecord(row.value),
    source: row.source,
    refused: row.refused,
    createdAt: row.created_at == null ? "" : String(row.created_at),
  }));
}
