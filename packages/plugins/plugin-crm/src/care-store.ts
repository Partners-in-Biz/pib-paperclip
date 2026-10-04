/**
 * Storage for the client care tables (migration 011): the signals the other
 * modules send about a client, monthly reports, the approvals that wait for a
 * person, client actions, support cases, feedback, health scores, site
 * monitoring, client sensitivity and the data-processing register.
 *
 * One statement per call, every query scoped by company, simple statements
 * only (the callers do their own counting and filtering).
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { asRecord, asStringList, table } from "./db.js";
import type { ClientKind } from "./refs.js";

export interface ClientKey {
  kind: ClientKind;
  id: string;
}

export function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const kindOf = (value: unknown): ClientKind => (value === "contact" ? "contact" : "company");

function member<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : fallback;
}


type FieldValue = string | number | boolean | null | { json: unknown } | { now: true };

/** `UPDATE <table> SET <only the fields given> WHERE <equalities>`: no expressions, so every statement stays a plain one. */
async function updateFields(ctx: PluginContext, name: string, where: Record<string, string>, fields: Record<string, FieldValue | undefined>): Promise<void> {
  const params: unknown[] = [];
  const whereSql = Object.entries(where).map(([column, value]) => {
    params.push(value);
    return `${column} = $${params.length}`;
  });
  const sets: string[] = [];
  for (const [column, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === "object" && "now" in value) {
      sets.push(`${column} = now()`);
    } else if (value !== null && typeof value === "object") {
      params.push(JSON.stringify(value.json));
      sets.push(`${column} = $${params.length}::jsonb`);
    } else {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = now()");
  await ctx.db.execute(`UPDATE ${table(ctx, name)} SET ${sets.join(", ")} WHERE ${whereSql.join(" AND ")}`, params);
}

// ---------------------------------------------------------------------------
// Signals (what the other modules say about a client)
// ---------------------------------------------------------------------------

export interface SignalRow {
  module: string;
  period: string;
  payload: Record<string, unknown>;
  source: "event" | "agent";
  recordedBy: string | null;
  signalAt: string | null;
  updatedAt: string | null;
}

interface SignalDbRow {
  module: string;
  period: string;
  payload: unknown;
  source: string;
  recorded_by: string | null;
  signal_at: unknown;
  updated_at: unknown;
}

const SIGNAL_COLUMNS = "module, period, payload, source, recorded_by, signal_at, updated_at";

function mapSignal(row: SignalDbRow): SignalRow {
  return { module: row.module, period: row.period ?? "", payload: asRecord(row.payload), source: row.source === "agent" ? "agent" : "event", recordedBy: row.recorded_by ?? null, signalAt: iso(row.signal_at), updatedAt: iso(row.updated_at) };
}

/** The newest statement wins: an older `signalAt` than the one stored is ignored. Returns whether the row changed. */
export async function upsertSignal(
  ctx: PluginContext,
  input: { companyId: string; client: ClientKey; module: string; period: string; payload: Record<string, unknown>; source: "event" | "agent"; recordedBy: string | null; signalAt: string },
): Promise<boolean> {
  const existing = await ctx.db.query<SignalDbRow>(
    `SELECT ${SIGNAL_COLUMNS} FROM ${table(ctx, "client_signals")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 AND module = $4 AND period = $5 LIMIT 1`,
    [input.companyId, input.client.kind, input.client.id, input.module, input.period],
  );
  const have = existing[0] ? Date.parse(iso(existing[0].signal_at) ?? "") : Number.NaN;
  if (Number.isFinite(have) && Date.parse(input.signalAt) < have) return false;
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "client_signals")} (id, company_id, client_kind, client_ref, module, period, payload, source, recorded_by, signal_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, now())
     ON CONFLICT (company_id, client_kind, client_ref, module, period) DO UPDATE SET
       payload = EXCLUDED.payload, source = EXCLUDED.source, recorded_by = EXCLUDED.recorded_by, signal_at = EXCLUDED.signal_at, updated_at = EXCLUDED.updated_at`,
    [randomUUID(), input.companyId, input.client.kind, input.client.id, input.module, input.period, JSON.stringify(input.payload), input.source, input.recordedBy, input.signalAt],
  );
  return true;
}

/** Every signal about a client: its current state (period empty) and each month. */
export async function listSignals(ctx: PluginContext, companyId: string, client: ClientKey): Promise<SignalRow[]> {
  const rows = await ctx.db.query<SignalDbRow>(
    `SELECT ${SIGNAL_COLUMNS} FROM ${table(ctx, "client_signals")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 ORDER BY updated_at DESC LIMIT 200`,
    [companyId, client.kind, client.id],
  );
  return rows.map(mapSignal);
}

// ---------------------------------------------------------------------------
// Monthly reports
// ---------------------------------------------------------------------------

export const REPORT_STATUSES = ["built", "awaiting_approval", "sent", "dry_run", "skipped"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface ReportNarrative {
  summary: string;
  highlights: string[];
  next: string[];
}

export interface ReportRecord {
  id: string;
  companyId: string;
  client: ClientKey;
  period: string;
  status: ReportStatus;
  narrative: ReportNarrative;
  data: Record<string, unknown>;
  markdown: string;
  html: string;
  issueId: string | null;
  approvalId: string | null;
  builtBy: string | null;
  builtAt: string | null;
  sentAt: string | null;
}

interface ReportRow {
  id: string;
  company_id: string;
  client_kind: string;
  client_ref: string;
  period: string;
  status: string;
  narrative: unknown;
  data: unknown;
  markdown: string | null;
  html: string | null;
  issue_id: string | null;
  approval_id: string | null;
  built_by: string | null;
  built_at: unknown;
  sent_at: unknown;
}

const REPORT_COLUMNS = "id, company_id, client_kind, client_ref, period, status, narrative, data, markdown, html, issue_id, approval_id, built_by, built_at, sent_at";

export function asNarrative(value: unknown): ReportNarrative {
  const v = asRecord(value);
  return {
    summary: typeof v.summary === "string" ? v.summary : "",
    highlights: asStringList(v.highlights),
    next: asStringList(v.next),
  };
}

function mapReport(row: ReportRow): ReportRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    client: { kind: kindOf(row.client_kind), id: row.client_ref },
    period: row.period,
    status: member(REPORT_STATUSES, row.status, "built"),
    narrative: asNarrative(row.narrative),
    data: asRecord(row.data),
    markdown: row.markdown ?? "",
    html: row.html ?? "",
    issueId: row.issue_id ?? null,
    approvalId: row.approval_id ?? null,
    builtBy: row.built_by ?? null,
    builtAt: iso(row.built_at),
    sentAt: iso(row.sent_at),
  };
}

export async function getReport(ctx: PluginContext, companyId: string, client: ClientKey, period: string): Promise<ReportRecord | null> {
  const rows = await ctx.db.query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM ${table(ctx, "client_reports")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 AND period = $4 LIMIT 1`,
    [companyId, client.kind, client.id, period],
  );
  return rows[0] ? mapReport(rows[0]) : null;
}

export async function getReportById(ctx: PluginContext, companyId: string, id: string): Promise<ReportRecord | null> {
  const rows = await ctx.db.query<ReportRow>(`SELECT ${REPORT_COLUMNS} FROM ${table(ctx, "client_reports")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return rows[0] ? mapReport(rows[0]) : null;
}

export async function listReports(ctx: PluginContext, companyId: string, client: ClientKey | null, limit = 24): Promise<ReportRecord[]> {
  const rows = client
    ? await ctx.db.query<ReportRow>(
      `SELECT ${REPORT_COLUMNS} FROM ${table(ctx, "client_reports")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 ORDER BY period DESC LIMIT ${Math.max(1, Math.min(limit, 60))}`,
      [companyId, client.kind, client.id],
    )
    : await ctx.db.query<ReportRow>(
      `SELECT ${REPORT_COLUMNS} FROM ${table(ctx, "client_reports")} WHERE company_id = $1 ORDER BY period DESC LIMIT ${Math.max(1, Math.min(limit, 200))}`,
      [companyId],
    );
  return rows.map(mapReport);
}

/** Reports of a month for every client (the job and the Cockpit count them). */
export async function reportsOfPeriod(ctx: PluginContext, companyId: string, period: string): Promise<ReportRecord[]> {
  const rows = await ctx.db.query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM ${table(ctx, "client_reports")} WHERE company_id = $1 AND period = $2 LIMIT 500`,
    [companyId, period],
  );
  return rows.map(mapReport);
}

export async function saveReport(
  ctx: PluginContext,
  input: { companyId: string; client: ClientKey; period: string; status: ReportStatus; narrative: ReportNarrative; data: Record<string, unknown>; markdown: string; html: string; issueId: string | null; approvalId: string | null; builtBy: string | null },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "client_reports")} (id, company_id, client_kind, client_ref, period, status, narrative, data, markdown, html, issue_id, approval_id, built_by, built_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, now(), now())
     ON CONFLICT (company_id, client_kind, client_ref, period) DO UPDATE SET
       status = EXCLUDED.status, narrative = EXCLUDED.narrative, data = EXCLUDED.data, markdown = EXCLUDED.markdown, html = EXCLUDED.html,
       issue_id = EXCLUDED.issue_id, approval_id = EXCLUDED.approval_id, built_by = EXCLUDED.built_by, built_at = EXCLUDED.built_at, updated_at = EXCLUDED.updated_at`,
    [randomUUID(), input.companyId, input.client.kind, input.client.id, input.period, input.status, JSON.stringify(input.narrative), JSON.stringify(input.data), input.markdown, input.html, input.issueId, input.approvalId, input.builtBy],
  );
}

export async function setReportStatus(ctx: PluginContext, companyId: string, id: string, patch: { status: ReportStatus; approvalId?: string | null; sentNow?: boolean }): Promise<void> {
  await updateFields(ctx, "client_reports", { company_id: companyId, id }, {
    status: patch.status,
    approval_id: patch.approvalId === undefined ? undefined : patch.approvalId,
    sent_at: patch.sentNow ? { now: true } : undefined,
  });
}

// ---------------------------------------------------------------------------
// Approvals (what waits for a person before it happens)
// ---------------------------------------------------------------------------

export const APPROVAL_KINDS = ["client_action", "client_reminder", "client_report", "feedback_request", "erasure", "esign_request", "esign_reminder", "esign_copy"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export const APPROVAL_STATUSES = ["open", "approved", "refused", "sent", "failed", "dry_run", "erased"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface ApprovalRecord {
  id: string;
  companyId: string;
  kind: ApprovalKind;
  client: ClientKey | null;
  subjectId: string;
  seq: number;
  issueId: string | null;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  sendKey: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string | null;
}

interface ApprovalRow {
  id: string;
  company_id: string;
  kind: string;
  client_kind: string | null;
  client_ref: string | null;
  subject_id: string;
  seq: number | string;
  issue_id: string | null;
  status: string;
  payload: unknown;
  send_key: string | null;
  decided_by: string | null;
  decided_at: unknown;
  result: unknown;
  error: string | null;
  created_at: unknown;
}

const APPROVAL_COLUMNS = "id, company_id, kind, client_kind, client_ref, subject_id, seq, issue_id, status, payload, send_key, decided_by, decided_at, result, error, created_at";

function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    kind: member(APPROVAL_KINDS, row.kind, "client_action"),
    client: row.client_kind && row.client_ref ? { kind: kindOf(row.client_kind), id: row.client_ref } : null,
    subjectId: row.subject_id,
    seq: Number(row.seq ?? 1),
    issueId: row.issue_id ?? null,
    status: member(APPROVAL_STATUSES, row.status, "open"),
    payload: asRecord(row.payload),
    sendKey: row.send_key ?? null,
    decidedBy: row.decided_by ?? null,
    decidedAt: iso(row.decided_at),
    result: row.result == null ? null : asRecord(row.result),
    error: row.error ?? null,
    createdAt: iso(row.created_at),
  };
}

/** Inserts the approval; false when the same subject and attempt already has one. */
export async function insertApproval(
  ctx: PluginContext,
  input: { id: string; companyId: string; kind: ApprovalKind; client: ClientKey | null; subjectId: string; seq: number; payload: Record<string, unknown> },
): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "care_approvals")} (id, company_id, kind, client_kind, client_ref, subject_id, seq, status, payload, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8::jsonb, now())
     ON CONFLICT (company_id, kind, subject_id, seq) DO NOTHING`,
    [input.id, input.companyId, input.kind, input.client?.kind ?? null, input.client?.id ?? null, input.subjectId, input.seq, JSON.stringify(input.payload)],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getApproval(ctx: PluginContext, companyId: string, id: string): Promise<ApprovalRecord | null> {
  const rows = await ctx.db.query<ApprovalRow>(`SELECT ${APPROVAL_COLUMNS} FROM ${table(ctx, "care_approvals")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return rows[0] ? mapApproval(rows[0]) : null;
}

export async function approvalByIssue(ctx: PluginContext, issueId: string): Promise<ApprovalRecord | null> {
  const rows = await ctx.db.query<ApprovalRow>(`SELECT ${APPROVAL_COLUMNS} FROM ${table(ctx, "care_approvals")} WHERE issue_id = $1 LIMIT 1`, [issueId]);
  return rows[0] ? mapApproval(rows[0]) : null;
}

export async function approvalBySendKey(ctx: PluginContext, sendKey: string): Promise<ApprovalRecord | null> {
  const rows = await ctx.db.query<ApprovalRow>(`SELECT ${APPROVAL_COLUMNS} FROM ${table(ctx, "care_approvals")} WHERE send_key = $1 LIMIT 1`, [sendKey]);
  return rows[0] ? mapApproval(rows[0]) : null;
}

export async function approvalForSubject(ctx: PluginContext, companyId: string, kind: ApprovalKind, subjectId: string, seq: number): Promise<ApprovalRecord | null> {
  const rows = await ctx.db.query<ApprovalRow>(
    `SELECT ${APPROVAL_COLUMNS} FROM ${table(ctx, "care_approvals")} WHERE company_id = $1 AND kind = $2 AND subject_id = $3 AND seq = $4 LIMIT 1`,
    [companyId, kind, subjectId, seq],
  );
  return rows[0] ? mapApproval(rows[0]) : null;
}

export async function approvalsOfSubject(ctx: PluginContext, companyId: string, kind: ApprovalKind, subjectId: string): Promise<ApprovalRecord[]> {
  const rows = await ctx.db.query<ApprovalRow>(
    `SELECT ${APPROVAL_COLUMNS} FROM ${table(ctx, "care_approvals")} WHERE company_id = $1 AND kind = $2 AND subject_id = $3 ORDER BY seq LIMIT 50`,
    [companyId, kind, subjectId],
  );
  return rows.map(mapApproval);
}

export async function approvalsByStatus(ctx: PluginContext, companyId: string, status: ApprovalStatus, limit = 200): Promise<ApprovalRecord[]> {
  const rows = await ctx.db.query<ApprovalRow>(
    `SELECT ${APPROVAL_COLUMNS} FROM ${table(ctx, "care_approvals")} WHERE company_id = $1 AND status = $2 ORDER BY created_at LIMIT ${Math.max(1, Math.min(limit, 500))}`,
    [companyId, status],
  );
  return rows.map(mapApproval);
}

export async function openApprovals(ctx: PluginContext, companyId: string, limit = 200): Promise<ApprovalRecord[]> {
  return approvalsByStatus(ctx, companyId, "open", limit);
}

export async function setApprovalIssue(ctx: PluginContext, companyId: string, id: string, issueId: string): Promise<void> {
  await updateFields(ctx, "care_approvals", { company_id: companyId, id }, { issue_id: issueId });
}

export async function updateApproval(
  ctx: PluginContext,
  companyId: string,
  id: string,
  patch: { status: ApprovalStatus; decidedBy?: string | null; sendKey?: string | null; result?: Record<string, unknown> | null; error?: string | null },
): Promise<void> {
  await updateFields(ctx, "care_approvals", { company_id: companyId, id }, {
    status: patch.status,
    decided_by: patch.decidedBy ?? undefined,
    decided_at: patch.decidedBy ? { now: true } : undefined,
    send_key: patch.sendKey ?? undefined,
    result: patch.result ? { json: patch.result } : undefined,
    error: patch.error === undefined ? null : patch.error,
  });
}

// ---------------------------------------------------------------------------
// Client actions
// ---------------------------------------------------------------------------

export const ACTION_KINDS = ["sign_off", "grant", "approval", "info"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const ACTION_STATUSES = ["draft", "waiting", "replied", "done", "cancelled"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export interface ClientAction {
  id: string;
  companyId: string;
  client: ClientKey;
  kind: ActionKind;
  title: string;
  instructions: string | null;
  linkUrl: string | null;
  linkLabel: string | null;
  contactId: string | null;
  toEmail: string | null;
  toName: string | null;
  status: ActionStatus;
  sourceRef: string | null;
  dueAt: string | null;
  remindAfterDays: number;
  reminders: number;
  requestedAt: string | null;
  nextReminderAt: string | null;
  lastReminderAt: string | null;
  replyAt: string | null;
  answeredAt: string | null;
  answer: string | null;
  escalatedAt: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

interface ActionRow {
  id: string;
  company_id: string;
  client_kind: string;
  client_ref: string;
  kind: string;
  title: string;
  instructions: string | null;
  link_url: string | null;
  link_label: string | null;
  contact_id: string | null;
  to_email: string | null;
  to_name: string | null;
  status: string;
  source_ref: string | null;
  due_at: unknown;
  remind_after_days: number | string;
  reminders: number | string;
  requested_at: unknown;
  next_reminder_at: unknown;
  last_reminder_at: unknown;
  reply_at: unknown;
  answered_at: unknown;
  answer: string | null;
  escalated_at: unknown;
  created_by: string | null;
  created_at: unknown;
}

const ACTION_COLUMNS = `id, company_id, client_kind, client_ref, kind, title, instructions, link_url, link_label, contact_id, to_email, to_name, status, source_ref, due_at,
  remind_after_days, reminders, requested_at, next_reminder_at, last_reminder_at, reply_at, answered_at, answer, escalated_at, created_by, created_at`;

function mapAction(row: ActionRow): ClientAction {
  return {
    id: row.id,
    companyId: row.company_id,
    client: { kind: kindOf(row.client_kind), id: row.client_ref },
    kind: member(ACTION_KINDS, row.kind, "info"),
    title: row.title,
    instructions: row.instructions ?? null,
    linkUrl: row.link_url ?? null,
    linkLabel: row.link_label ?? null,
    contactId: row.contact_id ?? null,
    toEmail: row.to_email ?? null,
    toName: row.to_name ?? null,
    status: member(ACTION_STATUSES, row.status, "draft"),
    sourceRef: row.source_ref ?? null,
    dueAt: iso(row.due_at),
    remindAfterDays: Number(row.remind_after_days ?? 3),
    reminders: Number(row.reminders ?? 0),
    requestedAt: iso(row.requested_at),
    nextReminderAt: iso(row.next_reminder_at),
    lastReminderAt: iso(row.last_reminder_at),
    replyAt: iso(row.reply_at),
    answeredAt: iso(row.answered_at),
    answer: row.answer ?? null,
    escalatedAt: iso(row.escalated_at),
    createdBy: row.created_by ?? null,
    createdAt: iso(row.created_at),
  };
}

export async function insertAction(ctx: PluginContext, action: Omit<ClientAction, "requestedAt" | "nextReminderAt" | "lastReminderAt" | "replyAt" | "answeredAt" | "answer" | "escalatedAt" | "createdAt" | "reminders">): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "client_actions")}
      (id, company_id, client_kind, client_ref, kind, title, instructions, link_url, link_label, contact_id, to_email, to_name, status, source_ref, due_at, remind_after_days, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())`,
    [action.id, action.companyId, action.client.kind, action.client.id, action.kind, action.title, action.instructions, action.linkUrl, action.linkLabel, action.contactId, action.toEmail, action.toName, action.status, action.sourceRef, action.dueAt, action.remindAfterDays, action.createdBy],
  );
}

export async function getAction(ctx: PluginContext, companyId: string, id: string): Promise<ClientAction | null> {
  const rows = await ctx.db.query<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM ${table(ctx, "client_actions")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return rows[0] ? mapAction(rows[0]) : null;
}

export async function listActions(ctx: PluginContext, companyId: string, client: ClientKey | null, limit = 100): Promise<ClientAction[]> {
  const max = Math.max(1, Math.min(limit, 500));
  const rows = client
    ? await ctx.db.query<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM ${table(ctx, "client_actions")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 ORDER BY created_at DESC LIMIT ${max}`, [companyId, client.kind, client.id])
    : await ctx.db.query<ActionRow>(`SELECT ${ACTION_COLUMNS} FROM ${table(ctx, "client_actions")} WHERE company_id = $1 ORDER BY created_at DESC LIMIT ${max}`, [companyId]);
  return rows.map(mapAction);
}

export async function listActionsByStatus(ctx: PluginContext, companyId: string, status: ActionStatus, limit = 200): Promise<ClientAction[]> {
  const rows = await ctx.db.query<ActionRow>(
    `SELECT ${ACTION_COLUMNS} FROM ${table(ctx, "client_actions")} WHERE company_id = $1 AND status = $2 ORDER BY created_at LIMIT ${Math.max(1, Math.min(limit, 500))}`,
    [companyId, status],
  );
  return rows.map(mapAction);
}

/** Writes the mutable fields of an action (read, change, save: the callers hold the whole record). */
export async function saveAction(ctx: PluginContext, action: ClientAction): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "client_actions")}
        SET title = $3, instructions = $4, link_url = $5, link_label = $6, contact_id = $7, to_email = $8, to_name = $9, status = $10, due_at = $11,
            remind_after_days = $12, reminders = $13, requested_at = $14, next_reminder_at = $15, last_reminder_at = $16, reply_at = $17,
            answered_at = $18, answer = $19, escalated_at = $20, updated_at = now()
      WHERE company_id = $1 AND id = $2`,
    [
      action.companyId, action.id, action.title, action.instructions, action.linkUrl, action.linkLabel, action.contactId, action.toEmail, action.toName, action.status, action.dueAt,
      action.remindAfterDays, action.reminders, action.requestedAt, action.nextReminderAt, action.lastReminderAt, action.replyAt, action.answeredAt, action.answer, action.escalatedAt,
    ],
  );
}

// ---------------------------------------------------------------------------
// Support cases
// ---------------------------------------------------------------------------

export const CASE_SOURCES = ["mail", "lead", "portal", "manual", "uptime"] as const;
export type CaseSource = (typeof CASE_SOURCES)[number];
export const CASE_SEVERITIES = ["low", "normal", "high", "urgent"] as const;
export type CaseSeverity = (typeof CASE_SEVERITIES)[number];
export const CASE_STATUSES = ["new", "open", "waiting_client", "resolved", "closed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export interface SupportCase {
  id: string;
  companyId: string;
  client: ClientKey;
  title: string;
  summary: string;
  source: CaseSource;
  severity: CaseSeverity;
  status: CaseStatus;
  contactId: string | null;
  threadId: string | null;
  sourceKey: string | null;
  replyIssueId: string | null;
  issueId: string | null;
  firstResponseDueAt: string;
  resolutionDueAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  firstBreachedAt: string | null;
  resolutionBreachedAt: string | null;
  escalatedAt: string | null;
  /** When the case went to waiting_client: the resolution clock is paused until it leaves that status. */
  pausedAt: string | null;
  resolution: string | null;
  openedBy: string | null;
  createdAt: string | null;
}

interface CaseRow {
  id: string;
  company_id: string;
  client_kind: string;
  client_ref: string;
  title: string;
  summary: string | null;
  source: string;
  severity: string;
  status: string;
  contact_id: string | null;
  thread_id: string | null;
  source_key: string | null;
  reply_issue_id: string | null;
  issue_id: string | null;
  first_response_due_at: unknown;
  resolution_due_at: unknown;
  first_response_at: unknown;
  resolved_at: unknown;
  first_breached_at: unknown;
  resolution_breached_at: unknown;
  escalated_at: unknown;
  paused_at: unknown;
  resolution: string | null;
  opened_by: string | null;
  created_at: unknown;
}

const CASE_COLUMNS = `id, company_id, client_kind, client_ref, title, summary, source, severity, status, contact_id, thread_id, source_key, reply_issue_id, issue_id,
  first_response_due_at, resolution_due_at, first_response_at, resolved_at, first_breached_at, resolution_breached_at, escalated_at, paused_at, resolution, opened_by, created_at`;

function mapCase(row: CaseRow): SupportCase {
  return {
    id: row.id,
    companyId: row.company_id,
    client: { kind: kindOf(row.client_kind), id: row.client_ref },
    title: row.title,
    summary: row.summary ?? "",
    source: member(CASE_SOURCES, row.source, "manual"),
    severity: member(CASE_SEVERITIES, row.severity, "normal"),
    status: member(CASE_STATUSES, row.status, "new"),
    contactId: row.contact_id ?? null,
    threadId: row.thread_id ?? null,
    sourceKey: row.source_key ?? null,
    replyIssueId: row.reply_issue_id ?? null,
    issueId: row.issue_id ?? null,
    firstResponseDueAt: iso(row.first_response_due_at) ?? new Date(0).toISOString(),
    resolutionDueAt: iso(row.resolution_due_at) ?? new Date(0).toISOString(),
    firstResponseAt: iso(row.first_response_at),
    resolvedAt: iso(row.resolved_at),
    firstBreachedAt: iso(row.first_breached_at),
    resolutionBreachedAt: iso(row.resolution_breached_at),
    escalatedAt: iso(row.escalated_at),
    pausedAt: iso(row.paused_at),
    resolution: row.resolution ?? null,
    openedBy: row.opened_by ?? null,
    createdAt: iso(row.created_at),
  };
}

/** Inserts a case; false when the source key already has one (the same mail never opens two). */
export async function insertCase(ctx: PluginContext, c: SupportCase): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "support_cases")}
      (id, company_id, client_kind, client_ref, title, summary, source, severity, status, contact_id, thread_id, source_key, reply_issue_id, issue_id,
       first_response_due_at, resolution_due_at, opened_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
     ON CONFLICT (company_id, source_key) WHERE source_key IS NOT NULL DO NOTHING`,
    [c.id, c.companyId, c.client.kind, c.client.id, c.title, c.summary, c.source, c.severity, c.status, c.contactId, c.threadId, c.sourceKey, c.replyIssueId, c.issueId, c.firstResponseDueAt, c.resolutionDueAt, c.openedBy],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getCase(ctx: PluginContext, companyId: string, id: string): Promise<SupportCase | null> {
  const rows = await ctx.db.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM ${table(ctx, "support_cases")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return rows[0] ? mapCase(rows[0]) : null;
}

export async function caseBySourceKey(ctx: PluginContext, companyId: string, sourceKey: string): Promise<SupportCase | null> {
  const rows = await ctx.db.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM ${table(ctx, "support_cases")} WHERE company_id = $1 AND source_key = $2 LIMIT 1`, [companyId, sourceKey]);
  return rows[0] ? mapCase(rows[0]) : null;
}

export async function casesByThread(ctx: PluginContext, companyId: string, threadId: string): Promise<SupportCase[]> {
  const rows = await ctx.db.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM ${table(ctx, "support_cases")} WHERE company_id = $1 AND thread_id = $2 ORDER BY created_at DESC LIMIT 20`, [companyId, threadId]);
  return rows.map(mapCase);
}

export async function listCases(ctx: PluginContext, companyId: string, client: ClientKey | null, limit = 100): Promise<SupportCase[]> {
  const max = Math.max(1, Math.min(limit, 500));
  const rows = client
    ? await ctx.db.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM ${table(ctx, "support_cases")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 ORDER BY created_at DESC LIMIT ${max}`, [companyId, client.kind, client.id])
    : await ctx.db.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM ${table(ctx, "support_cases")} WHERE company_id = $1 ORDER BY created_at DESC LIMIT ${max}`, [companyId]);
  return rows.map(mapCase);
}

export async function listCasesByStatus(ctx: PluginContext, companyId: string, status: CaseStatus, limit = 200): Promise<SupportCase[]> {
  const rows = await ctx.db.query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM ${table(ctx, "support_cases")} WHERE company_id = $1 AND status = $2 ORDER BY created_at LIMIT ${Math.max(1, Math.min(limit, 500))}`,
    [companyId, status],
  );
  return rows.map(mapCase);
}

export async function saveCase(ctx: PluginContext, c: SupportCase): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "support_cases")}
        SET title = $3, summary = $4, severity = $5, status = $6, contact_id = $7, reply_issue_id = $8, issue_id = $9, first_response_due_at = $10, resolution_due_at = $11,
            first_response_at = $12, resolved_at = $13, first_breached_at = $14, resolution_breached_at = $15, escalated_at = $16, paused_at = $17, resolution = $18, updated_at = now()
      WHERE company_id = $1 AND id = $2`,
    [c.companyId, c.id, c.title, c.summary, c.severity, c.status, c.contactId, c.replyIssueId, c.issueId, c.firstResponseDueAt, c.resolutionDueAt, c.firstResponseAt, c.resolvedAt, c.firstBreachedAt, c.resolutionBreachedAt, c.escalatedAt, c.pausedAt, c.resolution],
  );
}

// ---------------------------------------------------------------------------
// Feedback (NPS and CSAT)
// ---------------------------------------------------------------------------

export const FEEDBACK_KINDS = ["nps", "csat"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_STATUSES = ["draft", "requested", "answered", "declined"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export interface FeedbackRecord {
  id: string;
  companyId: string;
  client: ClientKey;
  kind: FeedbackKind;
  caseId: string | null;
  contactId: string | null;
  toEmail: string | null;
  status: FeedbackStatus;
  score: number | null;
  comment: string | null;
  requestedAt: string | null;
  answeredAt: string | null;
  createdAt: string | null;
}

interface FeedbackRow {
  id: string;
  company_id: string;
  client_kind: string;
  client_ref: string;
  kind: string;
  case_id: string | null;
  contact_id: string | null;
  to_email: string | null;
  status: string;
  score: number | string | null;
  comment: string | null;
  requested_at: unknown;
  answered_at: unknown;
  created_at: unknown;
}

const FEEDBACK_COLUMNS = "id, company_id, client_kind, client_ref, kind, case_id, contact_id, to_email, status, score, comment, requested_at, answered_at, created_at";

function mapFeedback(row: FeedbackRow): FeedbackRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    client: { kind: kindOf(row.client_kind), id: row.client_ref },
    kind: member(FEEDBACK_KINDS, row.kind, "nps"),
    caseId: row.case_id ?? null,
    contactId: row.contact_id ?? null,
    toEmail: row.to_email ?? null,
    status: member(FEEDBACK_STATUSES, row.status, "draft"),
    score: row.score == null ? null : Number(row.score),
    comment: row.comment ?? null,
    requestedAt: iso(row.requested_at),
    answeredAt: iso(row.answered_at),
    createdAt: iso(row.created_at),
  };
}

export async function insertFeedback(ctx: PluginContext, f: Pick<FeedbackRecord, "id" | "companyId" | "client" | "kind" | "caseId" | "contactId" | "toEmail" | "status">, createdBy: string | null): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "client_feedback")} (id, company_id, client_kind, client_ref, kind, case_id, contact_id, to_email, status, created_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
    [f.id, f.companyId, f.client.kind, f.client.id, f.kind, f.caseId, f.contactId, f.toEmail, f.status, createdBy],
  );
}

export async function getFeedback(ctx: PluginContext, companyId: string, id: string): Promise<FeedbackRecord | null> {
  const rows = await ctx.db.query<FeedbackRow>(`SELECT ${FEEDBACK_COLUMNS} FROM ${table(ctx, "client_feedback")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return rows[0] ? mapFeedback(rows[0]) : null;
}

export async function listFeedback(ctx: PluginContext, companyId: string, client: ClientKey | null, limit = 100): Promise<FeedbackRecord[]> {
  const max = Math.max(1, Math.min(limit, 500));
  const rows = client
    ? await ctx.db.query<FeedbackRow>(`SELECT ${FEEDBACK_COLUMNS} FROM ${table(ctx, "client_feedback")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 ORDER BY created_at DESC LIMIT ${max}`, [companyId, client.kind, client.id])
    : await ctx.db.query<FeedbackRow>(`SELECT ${FEEDBACK_COLUMNS} FROM ${table(ctx, "client_feedback")} WHERE company_id = $1 ORDER BY created_at DESC LIMIT ${max}`, [companyId]);
  return rows.map(mapFeedback);
}

export async function saveFeedback(ctx: PluginContext, f: FeedbackRecord): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "client_feedback")} SET status = $3, score = $4, comment = $5, requested_at = $6, answered_at = $7, contact_id = $8, to_email = $9, updated_at = now() WHERE company_id = $1 AND id = $2`,
    [f.companyId, f.id, f.status, f.score, f.comment, f.requestedAt, f.answeredAt, f.contactId, f.toEmail],
  );
}

// ---------------------------------------------------------------------------
// Health scores
// ---------------------------------------------------------------------------

export const HEALTH_BANDS = ["healthy", "watch", "at_risk"] as const;
export type HealthBand = (typeof HEALTH_BANDS)[number];

export interface HealthComponent {
  key: string;
  label: string;
  /** 0 to 100, 100 best. */
  score: number;
  weight: number;
  detail: string;
}

export interface HealthRecord {
  client: ClientKey;
  score: number;
  band: HealthBand;
  components: HealthComponent[];
  missing: string[];
  computedAt: string | null;
  previousScore: number | null;
  previousBand: HealthBand | null;
  atRiskSince: string | null;
  alertedAt: string | null;
}

interface HealthRow {
  client_kind: string;
  client_ref: string;
  score: number | string;
  band: string;
  components: unknown;
  missing: unknown;
  computed_at: unknown;
  previous_score: number | string | null;
  previous_band: string | null;
  at_risk_since: unknown;
  alerted_at: unknown;
}

const HEALTH_COLUMNS = "client_kind, client_ref, score, band, components, missing, computed_at, previous_score, previous_band, at_risk_since, alerted_at";

function mapHealth(row: HealthRow): HealthRecord {
  const raw = typeof row.components === "string" ? safeParse(row.components) : row.components;
  const components = Array.isArray(raw)
    ? raw.map(asRecord).map((c) => ({ key: String(c.key ?? ""), label: String(c.label ?? ""), score: Number(c.score ?? 0), weight: Number(c.weight ?? 0), detail: String(c.detail ?? "") }))
    : [];
  return {
    client: { kind: kindOf(row.client_kind), id: row.client_ref },
    score: Number(row.score),
    band: member(HEALTH_BANDS, row.band, "watch"),
    components,
    missing: asStringList(row.missing),
    computedAt: iso(row.computed_at),
    previousScore: row.previous_score == null ? null : Number(row.previous_score),
    previousBand: row.previous_band ? member(HEALTH_BANDS, row.previous_band, "watch") : null,
    atRiskSince: iso(row.at_risk_since),
    alertedAt: iso(row.alerted_at),
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function getHealth(ctx: PluginContext, companyId: string, client: ClientKey): Promise<HealthRecord | null> {
  const rows = await ctx.db.query<HealthRow>(
    `SELECT ${HEALTH_COLUMNS} FROM ${table(ctx, "client_health")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 LIMIT 1`,
    [companyId, client.kind, client.id],
  );
  return rows[0] ? mapHealth(rows[0]) : null;
}

export async function listHealth(ctx: PluginContext, companyId: string, limit = 500): Promise<HealthRecord[]> {
  const rows = await ctx.db.query<HealthRow>(`SELECT ${HEALTH_COLUMNS} FROM ${table(ctx, "client_health")} WHERE company_id = $1 ORDER BY score LIMIT ${Math.max(1, Math.min(limit, 1000))}`, [companyId]);
  return rows.map(mapHealth);
}

export async function saveHealth(ctx: PluginContext, companyId: string, h: HealthRecord): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "client_health")} (company_id, client_kind, client_ref, score, band, components, missing, computed_at, previous_score, previous_band, at_risk_since, alerted_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, now())
     ON CONFLICT (company_id, client_kind, client_ref) DO UPDATE SET
       score = EXCLUDED.score, band = EXCLUDED.band, components = EXCLUDED.components, missing = EXCLUDED.missing, computed_at = EXCLUDED.computed_at,
       previous_score = EXCLUDED.previous_score, previous_band = EXCLUDED.previous_band, at_risk_since = EXCLUDED.at_risk_since, alerted_at = EXCLUDED.alerted_at, updated_at = EXCLUDED.updated_at`,
    [companyId, h.client.kind, h.client.id, h.score, h.band, JSON.stringify(h.components), JSON.stringify(h.missing), h.computedAt ?? new Date().toISOString(), h.previousScore, h.previousBand, h.atRiskSince, h.alertedAt],
  );
}

// ---------------------------------------------------------------------------
// Client sensitivity
// ---------------------------------------------------------------------------

export const SENSITIVITY_LEVELS = ["standard", "sensitive"] as const;
export type SensitivityLevel = (typeof SENSITIVITY_LEVELS)[number];

export interface SensitivityRecord {
  client: ClientKey;
  level: SensitivityLevel;
  reason: string | null;
  setBy: string | null;
  updatedAt: string | null;
}

interface SensitivityRow {
  client_kind: string;
  client_ref: string;
  level: string;
  reason: string | null;
  set_by: string | null;
  updated_at: unknown;
}

function mapSensitivity(row: SensitivityRow): SensitivityRecord {
  return { client: { kind: kindOf(row.client_kind), id: row.client_ref }, level: member(SENSITIVITY_LEVELS, row.level, "standard"), reason: row.reason ?? null, setBy: row.set_by ?? null, updatedAt: iso(row.updated_at) };
}

export async function getSensitivity(ctx: PluginContext, companyId: string, client: ClientKey): Promise<SensitivityRecord | null> {
  const rows = await ctx.db.query<SensitivityRow>(
    `SELECT client_kind, client_ref, level, reason, set_by, updated_at FROM ${table(ctx, "client_sensitivity")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 LIMIT 1`,
    [companyId, client.kind, client.id],
  );
  return rows[0] ? mapSensitivity(rows[0]) : null;
}

export async function listSensitivity(ctx: PluginContext, companyId: string): Promise<SensitivityRecord[]> {
  const rows = await ctx.db.query<SensitivityRow>(`SELECT client_kind, client_ref, level, reason, set_by, updated_at FROM ${table(ctx, "client_sensitivity")} WHERE company_id = $1 LIMIT 2000`, [companyId]);
  return rows.map(mapSensitivity);
}

export async function saveSensitivity(ctx: PluginContext, companyId: string, record: { client: ClientKey; level: SensitivityLevel; reason: string | null; setBy: string | null }): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "client_sensitivity")} (company_id, client_kind, client_ref, level, reason, set_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (company_id, client_kind, client_ref) DO UPDATE SET level = EXCLUDED.level, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, updated_at = EXCLUDED.updated_at`,
    [companyId, record.client.kind, record.client.id, record.level, record.reason, record.setBy],
  );
}

// ---------------------------------------------------------------------------
// A client's care data goes with the client
// ---------------------------------------------------------------------------

const CLIENT_TABLES = ["client_signals", "client_reports", "client_actions", "support_cases", "client_feedback", "client_health", "client_sensitivity"] as const;

/**
 * Removes what the care features keep about one client: signals, reports, actions, cases, feedback, the health score and the
 * sensitivity flag, the approvals opened for it, and the monitoring rows of its websites. Returns how many rows went.
 */
export async function deleteCareDataOfClient(ctx: PluginContext, companyId: string, client: ClientKey): Promise<number> {
  let removed = 0;
  const sites = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "client_sites")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 LIMIT 200`, [companyId, client.kind, client.id]);
  for (const site of sites) {
    removed += (await ctx.db.execute(`DELETE FROM ${table(ctx, "site_monitor")} WHERE company_id = $1 AND site_id = $2`, [companyId, site.id]))?.rowCount ?? 0;
    removed += (await ctx.db.execute(`DELETE FROM ${table(ctx, "site_uptime_days")} WHERE company_id = $1 AND site_id = $2`, [companyId, site.id]))?.rowCount ?? 0;
  }
  for (const name of CLIENT_TABLES) {
    removed += (await ctx.db.execute(`DELETE FROM ${table(ctx, name)} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3`, [companyId, client.kind, client.id]))?.rowCount ?? 0;
  }
  removed += (await ctx.db.execute(`DELETE FROM ${table(ctx, "care_approvals")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3`, [companyId, client.kind, client.id]))?.rowCount ?? 0;
  return removed;
}
