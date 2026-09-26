/**
 * Data access for the SEO namespace.
 *
 * Host SQL guard rules this file follows:
 * - every table is `${NAMESPACE}.table`; one statement per call;
 * - `query` is SELECT/WITH only and never contains insert/update/delete/alter/
 *   create/drop/truncate words; `execute` is INSERT/UPDATE/DELETE only;
 * - no grant/revoke/copy/call words anywhere;
 * - params are JSON over RPC: lists and objects travel as JSON strings cast
 *   with `$n::jsonb` (never JS arrays); dates are selected as text.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clientWhere, isClientKind, type ClientKind, type ClientScope } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { NAMESPACE } from "./namespace.js";
import type { AutopilotMode, SprintStatus, TaskSource, TaskStatus } from "./engine/sprint.js";
import type { TaskOwner } from "./templates/outrank-90.js";
import { CHANGE_POLICIES, SITE_ACCESS, type ChangePolicy, type SiteAccess } from "./engine/site-change.js";
import type { NeedsYouItem } from "./engine/needs-you.js";

export type SeoDb = PluginContext["db"];

export function t(name: string): string {
  if (!/^[a-z_]+$/.test(name)) throw new Error(`Unsafe table name ${name}`);
  return `${NAMESPACE}.${name}`;
}

type Row = Record<string, unknown>;

function s(value: unknown): string | null {
  return value == null || value === "" ? null : String(value);
}

function n(value: unknown): number | null {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function iso(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function strList(value: unknown): string[] {
  const list = json<unknown[]>(value, []);
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

function numList(value: unknown): number[] {
  const list = json<unknown[]>(value, []);
  return Array.isArray(list) ? list.map(Number).filter((x) => Number.isFinite(x)) : [];
}

export function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** `ARRAY(...)`/`IN (...)` helper for a JSON list parameter. */
function jsonTextList(index: number): string {
  return `(SELECT jsonb_array_elements_text($${index}::jsonb))`;
}

// ---------------------------------------------------------------------------
// Generic patch builder (whitelisted columns only)
// ---------------------------------------------------------------------------

type ColumnKind = "text" | "int" | "real" | "bool" | "date" | "ts" | "jsonb";

function buildSet(patch: Record<string, unknown>, columns: Record<string, ColumnKind>, params: unknown[]): string[] {
  const sets: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const kind = columns[key];
    if (!kind) throw new Error(`Unknown column ${key}`);
    if (value === null) {
      sets.push(`${key} = NULL`);
      continue;
    }
    switch (kind) {
      case "jsonb":
        params.push(jsonParam(value));
        sets.push(`${key} = $${params.length}::jsonb`);
        break;
      case "date":
        params.push(String(value));
        sets.push(`${key} = $${params.length}::date`);
        break;
      case "ts":
        params.push(value instanceof Date ? value.toISOString() : String(value));
        sets.push(`${key} = $${params.length}::timestamptz`);
        break;
      case "int":
        params.push(Math.round(Number(value)));
        sets.push(`${key} = $${params.length}::int`);
        break;
      case "real":
        params.push(Number(value));
        sets.push(`${key} = $${params.length}::real`);
        break;
      case "bool":
        params.push(Boolean(value));
        sets.push(`${key} = $${params.length}::boolean`);
        break;
      default:
        params.push(String(value));
        sets.push(`${key} = $${params.length}`);
    }
  }
  return sets;
}

async function patchRow(
  db: SeoDb,
  table: string,
  columns: Record<string, ColumnKind>,
  where: { companyId: string; id: string; idColumn?: string },
  patch: Record<string, unknown>,
  touch = true,
): Promise<number> {
  const params: unknown[] = [];
  const sets = buildSet(patch, columns, params);
  if (sets.length === 0) return 0;
  if (touch && "updated_at" in columns && !("updated_at" in patch)) sets.push("updated_at = now()");
  params.push(where.id, where.companyId);
  const result = await db.execute(
    `UPDATE ${t(table)} SET ${sets.join(", ")} WHERE ${where.idColumn ?? "id"} = $${params.length - 1} AND company_id = $${params.length}`,
    params,
  );
  return result.rowCount;
}

// ---------------------------------------------------------------------------
// Sprints
// ---------------------------------------------------------------------------

export interface Sprint {
  id: string;
  companyId: string;
  name: string;
  siteUrl: string;
  siteName: string;
  /** Set for client sprints; null for Partners in Biz's own sites. */
  clientKind: ClientKind | null;
  clientRef: string | null;
  /** The CRM client's name (client sprints only). */
  clientName: string | null;
  /** A free-text client name from before sprints had to reference the CRM (own sprints only). */
  legacyClientName: string | null;
  status: SprintStatus;
  startDate: string;
  templateId: string;
  templateVersion: number;
  autopilotMode: AutopilotMode;
  ownerUserId: string | null;
  projectId: string | null;
  rootIssueId: string | null;
  rootIssueIdentifier: string | null;
  agentId: string | null;
  notes: string | null;
  pausedReason: string | null;
  health: Record<string, unknown>;
  scoreboard: Record<string, unknown>;
  today: Record<string, unknown>;
  currentDay: number | null;
  currentWeek: number | null;
  currentPhase: number | null;
  lastDailyOn: string | null;
  lastWeeklyOn: string | null;
  auditDaysDone: number[];
  seededAt: string | null;
  /** The Paperclip project whose workspace holds the site repo (code tasks go there). */
  siteProjectId: string | null;
  siteAccess: SiteAccess;
  repoUrl: string | null;
  defaultBranch: string;
  framework: string | null;
  hosting: string | null;
  changePolicy: ChangePolicy;
  /** Google / Bing / IndexNow verification and indexing follow-up state. */
  verification: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}

const SPRINT_SELECT = `id, company_id, name, site_url, site_name, client_kind, client_ref, client_name, status, start_date::text AS start_date,
  template_id, template_version, autopilot_mode, owner_user_id, project_id, root_issue_id, root_issue_identifier, agent_id, notes,
  paused_reason, health, scoreboard, today, current_day, current_week, current_phase, last_daily_on::text AS last_daily_on,
  last_weekly_on::text AS last_weekly_on, audit_days_done, seeded_at, site_project_id, site_access, repo_url, default_branch, framework,
  hosting, change_policy, verification, created_at, updated_at`;

function sprintFrom(row: Row): Sprint {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    name: String(row.name ?? ""),
    siteUrl: String(row.site_url ?? ""),
    siteName: String(row.site_name ?? row.name ?? ""),
    ...sprintClientFrom(row),
    status: String(row.status) as SprintStatus,
    startDate: String(row.start_date ?? "").slice(0, 10),
    templateId: String(row.template_id ?? "outrank-90"),
    templateVersion: Number(row.template_version ?? 0),
    autopilotMode: (String(row.autopilot_mode ?? "safe") as AutopilotMode),
    ownerUserId: s(row.owner_user_id),
    projectId: s(row.project_id),
    rootIssueId: s(row.root_issue_id),
    rootIssueIdentifier: s(row.root_issue_identifier),
    agentId: s(row.agent_id),
    notes: s(row.notes),
    pausedReason: s(row.paused_reason),
    health: json<Record<string, unknown>>(row.health, {}),
    scoreboard: json<Record<string, unknown>>(row.scoreboard, {}),
    today: json<Record<string, unknown>>(row.today, {}),
    currentDay: n(row.current_day),
    currentWeek: n(row.current_week),
    currentPhase: n(row.current_phase),
    lastDailyOn: s(row.last_daily_on)?.slice(0, 10) ?? null,
    lastWeeklyOn: s(row.last_weekly_on)?.slice(0, 10) ?? null,
    auditDaysDone: numList(row.audit_days_done),
    seededAt: iso(row.seeded_at),
    siteProjectId: s(row.site_project_id),
    siteAccess: (SITE_ACCESS as readonly string[]).includes(String(row.site_access)) ? (String(row.site_access) as SiteAccess) : "unlinked",
    repoUrl: s(row.repo_url),
    defaultBranch: s(row.default_branch) ?? "main",
    framework: s(row.framework),
    hosting: s(row.hosting),
    changePolicy: (CHANGE_POLICIES as readonly string[]).includes(String(row.change_policy)) ? (String(row.change_policy) as ChangePolicy) : "merge_seo_scope",
    verification: json<Record<string, unknown>>(row.verification, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function sprintClientFrom(row: Row): Pick<Sprint, "clientKind" | "clientRef" | "clientName" | "legacyClientName"> {
  const ref = s(row.client_ref);
  const name = s(row.client_name);
  if (!ref) return { clientKind: null, clientRef: null, clientName: null, legacyClientName: name };
  return { clientKind: isClientKind(row.client_kind) ? row.client_kind : "company", clientRef: ref, clientName: name, legacyClientName: null };
}

const SPRINT_COLUMNS: Record<string, ColumnKind> = {
  name: "text",
  site_url: "text",
  site_name: "text",
  client_kind: "text",
  client_ref: "text",
  client_name: "text",
  status: "text",
  start_date: "date",
  template_id: "text",
  template_version: "int",
  autopilot_mode: "text",
  owner_user_id: "text",
  project_id: "text",
  root_issue_id: "text",
  root_issue_identifier: "text",
  agent_id: "text",
  notes: "text",
  paused_reason: "text",
  health: "jsonb",
  scoreboard: "jsonb",
  today: "jsonb",
  current_day: "int",
  current_week: "int",
  current_phase: "int",
  last_daily_on: "date",
  last_weekly_on: "date",
  audit_days_done: "jsonb",
  seeded_at: "ts",
  site_project_id: "text",
  site_access: "text",
  repo_url: "text",
  default_branch: "text",
  framework: "text",
  hosting: "text",
  change_policy: "text",
  verification: "jsonb",
  updated_at: "ts",
};

/**
 * `scope` undefined lists every sprint; `null` only Partners in Biz's own
 * sites (no client); a client ref only that CRM company's or contact's.
 */
export async function listSprints(db: SeoDb, companyId: string, filter: { status?: string; scope?: ClientScope } = {}): Promise<Sprint[]> {
  const where = ["company_id = $1"];
  const params: unknown[] = [companyId];
  if (filter.status) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }
  if (filter.scope !== undefined) {
    const clause = clientWhere(filter.scope, params.length + 1);
    params.push(...clause.params);
    where.push(clause.sql);
  }
  const rows = await db.query(`SELECT ${SPRINT_SELECT} FROM ${t("sprints")} WHERE ${where.join(" AND ")} ORDER BY created_at DESC`, params);
  return rows.map(sprintFrom);
}

export async function getSprint(db: SeoDb, companyId: string, id: string): Promise<Sprint | null> {
  const rows = await db.query(`SELECT ${SPRINT_SELECT} FROM ${t("sprints")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [id, companyId]);
  return rows[0] ? sprintFrom(rows[0]) : null;
}

/** Sprints the jobs work on, across companies (company ids come from our rows). */
export async function listRunnableSprints(db: SeoDb): Promise<Sprint[]> {
  const rows = await db.query(
    `SELECT ${SPRINT_SELECT} FROM ${t("sprints")}
      WHERE status IN ('pre_launch', 'active', 'compounding') AND seeded_at IS NOT NULL
      ORDER BY company_id, created_at`,
  );
  return rows.map(sprintFrom);
}

export async function listSprintCompanies(db: SeoDb): Promise<string[]> {
  const rows = await db.query<{ company_id: string }>(`SELECT DISTINCT company_id FROM ${t("sprints")} ORDER BY company_id LIMIT 50`);
  return rows.map((r) => String(r.company_id));
}

export async function insertSprint(db: SeoDb, sprint: {
  id: string;
  companyId: string;
  name: string;
  siteUrl: string;
  siteName: string;
  clientKind: ClientKind | null;
  clientRef: string | null;
  clientName: string | null;
  status: SprintStatus;
  startDate: string;
  templateId: string;
  templateVersion: number;
  autopilotMode: AutopilotMode;
  ownerUserId: string | null;
  notes: string | null;
}): Promise<void> {
  await db.execute(
    `INSERT INTO ${t("sprints")} (id, company_id, name, site_url, site_name, client_kind, client_ref, client_name, status, start_date,
       template_id, template_version, autopilot_mode, owner_user_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12::int, $13, $14, $15)`,
    [
      sprint.id,
      sprint.companyId,
      sprint.name,
      sprint.siteUrl,
      sprint.siteName,
      sprint.clientRef ? sprint.clientKind ?? "company" : null,
      sprint.clientRef,
      sprint.clientName,
      sprint.status,
      sprint.startDate,
      sprint.templateId,
      sprint.templateVersion,
      sprint.autopilotMode,
      sprint.ownerUserId,
      sprint.notes,
    ],
  );
}

export async function updateSprint(db: SeoDb, companyId: string, id: string, patch: Record<string, unknown>): Promise<number> {
  return patchRow(db, "sprints", SPRINT_COLUMNS, { companyId, id }, patch);
}

export async function setAgentForCompany(db: SeoDb, companyId: string, agentId: string): Promise<void> {
  await db.execute(`UPDATE ${t("sprints")} SET agent_id = $1, updated_at = now() WHERE company_id = $2`, [agentId, companyId]);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface SprintTask {
  id: string;
  companyId: string;
  sprintId: string;
  templateKey: string | null;
  week: number;
  phase: number;
  dueDay: number | null;
  focus: string;
  title: string;
  description: string | null;
  taskType: string;
  owner: TaskOwner;
  autopilotEligible: boolean;
  playbookKey: string | null;
  status: TaskStatus;
  source: TaskSource;
  parentOptimizationId: string | null;
  context: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueStatus: string | null;
  /** Project the issue was created in (the site project for code tasks). */
  issueProjectId?: string | null;
  assigneeKind: string | null;
  blockerReason: string | null;
  humanAsk: string | null;
  evidence: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const TASK_SELECT = `id, company_id, sprint_id, template_key, week, phase, due_day, focus, title, description, task_type, owner,
  autopilot_eligible, playbook_key, status, source, parent_optimization_id, context, issue_id, issue_identifier, issue_status,
  assignee_kind, blocker_reason, human_ask, evidence, started_at, completed_at, completed_by, created_at, updated_at, issue_project_id`;

function taskFrom(row: Row): SprintTask {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    sprintId: String(row.sprint_id),
    templateKey: s(row.template_key),
    week: Number(row.week ?? 0),
    phase: Number(row.phase ?? 0),
    dueDay: n(row.due_day),
    focus: String(row.focus ?? ""),
    title: String(row.title ?? ""),
    description: s(row.description),
    taskType: String(row.task_type ?? "custom"),
    owner: (row.owner === "human" ? "human" : "agent") as TaskOwner,
    autopilotEligible: Boolean(row.autopilot_eligible),
    playbookKey: s(row.playbook_key),
    status: String(row.status) as TaskStatus,
    source: String(row.source) as TaskSource,
    parentOptimizationId: s(row.parent_optimization_id),
    context: s(row.context),
    issueId: s(row.issue_id),
    issueIdentifier: s(row.issue_identifier),
    issueStatus: s(row.issue_status),
    issueProjectId: s(row.issue_project_id),
    assigneeKind: s(row.assignee_kind),
    blockerReason: s(row.blocker_reason),
    humanAsk: s(row.human_ask),
    evidence: json<Record<string, unknown> | null>(row.evidence, null),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    completedBy: s(row.completed_by),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const TASK_COLUMNS: Record<string, ColumnKind> = {
  week: "int",
  phase: "int",
  due_day: "int",
  focus: "text",
  title: "text",
  description: "text",
  task_type: "text",
  owner: "text",
  autopilot_eligible: "bool",
  playbook_key: "text",
  status: "text",
  context: "text",
  issue_id: "text",
  issue_identifier: "text",
  issue_status: "text",
  issue_project_id: "text",
  assignee_kind: "text",
  blocker_reason: "text",
  human_ask: "text",
  evidence: "jsonb",
  started_at: "ts",
  completed_at: "ts",
  completed_by: "text",
  updated_at: "ts",
};

export interface NewTask {
  id: string;
  companyId: string;
  sprintId: string;
  templateKey: string | null;
  week: number;
  phase: number;
  dueDay: number | null;
  focus: string;
  title: string;
  description: string | null;
  taskType: string;
  owner: TaskOwner;
  autopilotEligible: boolean;
  playbookKey: string | null;
  source: TaskSource;
  parentOptimizationId: string | null;
  context: string | null;
}

/** Multi-row insert; template tasks are idempotent on (sprint_id, template_key). */
export async function insertTasks(db: SeoDb, tasks: NewTask[]): Promise<number> {
  if (tasks.length === 0) return 0;
  const params: unknown[] = [];
  const values: string[] = [];
  for (const task of tasks) {
    const base = params.length;
    params.push(
      task.id,
      task.companyId,
      task.sprintId,
      task.templateKey,
      task.week,
      task.phase,
      task.dueDay,
      task.focus,
      task.title,
      task.description,
      task.taskType,
      task.owner,
      task.autopilotEligible,
      task.playbookKey,
      task.source,
      task.parentOptimizationId,
      task.context,
    );
    const p = (i: number) => `$${base + i}`;
    values.push(
      `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}::int, ${p(6)}::int, ${p(7)}::int, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}, ${p(12)}, ${p(13)}::boolean, ${p(14)}, ${p(15)}, ${p(16)}, ${p(17)})`,
    );
  }
  const result = await db.execute(
    `INSERT INTO ${t("sprint_tasks")} (id, company_id, sprint_id, template_key, week, phase, due_day, focus, title, description,
       task_type, owner, autopilot_eligible, playbook_key, source, parent_optimization_id, context)
     VALUES ${values.join(", ")}
     ON CONFLICT (sprint_id, template_key) WHERE template_key IS NOT NULL DO NOTHING`,
    params,
  );
  return result.rowCount;
}

export async function listTasks(
  db: SeoDb,
  companyId: string,
  sprintId: string,
  filter: { status?: string[]; week?: number; owner?: string; source?: string; limit?: number } = {},
): Promise<SprintTask[]> {
  const where = ["company_id = $1", "sprint_id = $2"];
  const params: unknown[] = [companyId, sprintId];
  if (filter.status && filter.status.length > 0) {
    params.push(jsonParam(filter.status));
    where.push(`status IN ${jsonTextList(params.length)}`);
  }
  if (filter.week != null) {
    params.push(filter.week);
    where.push(`week = $${params.length}::int`);
  }
  if (filter.owner) {
    params.push(filter.owner);
    where.push(`owner = $${params.length}`);
  }
  if (filter.source) {
    params.push(filter.source);
    where.push(`source = $${params.length}`);
  }
  params.push(Math.min(Math.max(filter.limit ?? 500, 1), 1000));
  const rows = await db.query(
    `SELECT ${TASK_SELECT} FROM ${t("sprint_tasks")} WHERE ${where.join(" AND ")}
      ORDER BY week, created_at, title LIMIT $${params.length}::int`,
    params,
  );
  return rows.map(taskFrom);
}

export async function getTask(db: SeoDb, companyId: string, id: string): Promise<SprintTask | null> {
  const rows = await db.query(`SELECT ${TASK_SELECT} FROM ${t("sprint_tasks")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [id, companyId]);
  return rows[0] ? taskFrom(rows[0]) : null;
}

export async function getTaskByIssue(db: SeoDb, companyId: string, issueId: string): Promise<SprintTask | null> {
  const rows = await db.query(`SELECT ${TASK_SELECT} FROM ${t("sprint_tasks")} WHERE issue_id = $1 AND company_id = $2 LIMIT 1`, [issueId, companyId]);
  return rows[0] ? taskFrom(rows[0]) : null;
}

export async function updateTask(db: SeoDb, companyId: string, id: string, patch: Record<string, unknown>): Promise<number> {
  return patchRow(db, "sprint_tasks", TASK_COLUMNS, { companyId, id }, patch);
}

/**
 * Claim a task before creating its issue so two runs (job + tool) never open
 * two issues for it. A stale claim (10 min) can be taken over.
 */
export async function claimTaskForIssue(db: SeoDb, companyId: string, id: string): Promise<boolean> {
  const result = await db.execute(
    `UPDATE ${t("sprint_tasks")} SET issue_status = 'creating', updated_at = now()
      WHERE id = $1 AND company_id = $2 AND issue_id IS NULL
        AND (issue_status IS NULL OR issue_status <> 'creating' OR updated_at < now() - interval '10 minutes')`,
    [id, companyId],
  );
  return result.rowCount > 0;
}

export async function releaseTaskClaim(db: SeoDb, companyId: string, id: string): Promise<void> {
  await db.execute(
    `UPDATE ${t("sprint_tasks")} SET issue_status = NULL, updated_at = now() WHERE id = $1 AND company_id = $2 AND issue_id IS NULL`,
    [id, companyId],
  );
}

export async function taskStats(db: SeoDb, sprintId: string): Promise<Record<string, number>> {
  const rows = await db.query<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM ${t("sprint_tasks")} WHERE sprint_id = $1 GROUP BY status`,
    [sprintId],
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[String(row.status)] = Number(row.count);
  return out;
}

// ---------------------------------------------------------------------------
// Keywords and positions
// ---------------------------------------------------------------------------

export interface Keyword {
  id: string;
  companyId: string;
  sprintId: string;
  phrase: string;
  volume: number | null;
  intent: string | null;
  targetUrl: string | null;
  rankingUrl: string | null;
  difficultyDr: number | null;
  isPriority: boolean;
  notes: string | null;
  source: string;
  currentPosition: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  status: string;
  retiredAt: string | null;
  retiredReason: string | null;
  lastPulledAt: string | null;
  createdAt: string | null;
}

const KEYWORD_SELECT = `id, company_id, sprint_id, phrase, volume, intent, target_url, ranking_url, difficulty_dr, is_priority, notes,
  source, current_position, impressions, clicks, ctr, status, retired_at, retired_reason, last_pulled_at, created_at`;

function keywordFrom(row: Row): Keyword {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    sprintId: String(row.sprint_id),
    phrase: String(row.phrase ?? ""),
    volume: n(row.volume),
    intent: s(row.intent),
    targetUrl: s(row.target_url),
    rankingUrl: s(row.ranking_url),
    difficultyDr: n(row.difficulty_dr),
    isPriority: Boolean(row.is_priority),
    notes: s(row.notes),
    source: String(row.source ?? "manual"),
    currentPosition: n(row.current_position),
    impressions: n(row.impressions),
    clicks: n(row.clicks),
    ctr: n(row.ctr),
    status: String(row.status ?? "not_yet"),
    retiredAt: iso(row.retired_at),
    retiredReason: s(row.retired_reason),
    lastPulledAt: iso(row.last_pulled_at),
    createdAt: iso(row.created_at),
  };
}

const KEYWORD_COLUMNS: Record<string, ColumnKind> = {
  phrase: "text",
  volume: "int",
  intent: "text",
  target_url: "text",
  ranking_url: "text",
  difficulty_dr: "int",
  is_priority: "bool",
  notes: "text",
  current_position: "real",
  impressions: "int",
  clicks: "int",
  ctr: "real",
  status: "text",
  retired_at: "ts",
  retired_reason: "text",
  last_pulled_at: "ts",
  rank: "int",
  updated_at: "ts",
};

export async function listKeywords(db: SeoDb, companyId: string, sprintId: string, opts: { includeRetired?: boolean } = {}): Promise<Keyword[]> {
  const rows = await db.query(
    `SELECT ${KEYWORD_SELECT} FROM ${t("keywords")} WHERE company_id = $1 AND sprint_id = $2
      ${opts.includeRetired ? "" : "AND retired_at IS NULL"} ORDER BY is_priority DESC, lower(phrase)`,
    [companyId, sprintId],
  );
  return rows.map(keywordFrom);
}

export async function getKeyword(db: SeoDb, companyId: string, id: string): Promise<Keyword | null> {
  const rows = await db.query(`SELECT ${KEYWORD_SELECT} FROM ${t("keywords")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [id, companyId]);
  return rows[0] ? keywordFrom(rows[0]) : null;
}

export async function findKeyword(db: SeoDb, companyId: string, sprintId: string, phrase: string): Promise<Keyword | null> {
  const rows = await db.query(
    `SELECT ${KEYWORD_SELECT} FROM ${t("keywords")}
      WHERE company_id = $1 AND sprint_id = $2 AND lower(phrase) = lower($3) AND retired_at IS NULL LIMIT 1`,
    [companyId, sprintId, phrase],
  );
  return rows[0] ? keywordFrom(rows[0]) : null;
}

export async function insertKeyword(db: SeoDb, k: {
  id: string;
  companyId: string;
  sprintId: string;
  phrase: string;
  volume: number | null;
  intent: string | null;
  targetUrl: string | null;
  difficultyDr: number | null;
  isPriority: boolean;
  notes: string | null;
  source: string;
}): Promise<boolean> {
  const result = await db.execute(
    `INSERT INTO ${t("keywords")} (id, company_id, sprint_id, phrase, volume, intent, target_url, difficulty_dr, is_priority, notes, source)
     VALUES ($1, $2, $3, $4, $5::int, $6, $7, $8::int, $9::boolean, $10, $11)
     ON CONFLICT (sprint_id, lower(phrase)) WHERE retired_at IS NULL DO NOTHING`,
    [k.id, k.companyId, k.sprintId, k.phrase, k.volume, k.intent, k.targetUrl, k.difficultyDr, k.isPriority, k.notes, k.source],
  );
  return result.rowCount > 0;
}

export async function updateKeyword(db: SeoDb, companyId: string, id: string, patch: Record<string, unknown>): Promise<number> {
  return patchRow(db, "keywords", KEYWORD_COLUMNS, { companyId, id }, patch);
}

export interface PositionRow {
  keywordId: string;
  position: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  source: string;
  recordedOn: string | null;
  recordedAt: string | null;
}

function positionFrom(row: Row): PositionRow {
  return {
    keywordId: String(row.keyword_id),
    position: n(row.position) ?? n(row.rank),
    impressions: n(row.impressions),
    clicks: n(row.clicks),
    ctr: n(row.ctr),
    source: String(row.source ?? "manual"),
    recordedOn: s(row.recorded_on)?.slice(0, 10) ?? null,
    recordedAt: iso(row.recorded_at),
  };
}

export async function keywordHistory(db: SeoDb, companyId: string, keywordId: string, limit = 180): Promise<PositionRow[]> {
  const rows = await db.query(
    `SELECT keyword_id, rank, position, impressions, clicks, ctr, source, recorded_on::text AS recorded_on, recorded_at
       FROM ${t("rank_history")} WHERE keyword_id = $1 AND company_id = $2 ORDER BY recorded_at DESC LIMIT $3::int`,
    [keywordId, companyId, limit],
  );
  return rows.map(positionFrom).reverse();
}

export async function sprintHistory(db: SeoDb, sprintId: string, since: string): Promise<PositionRow[]> {
  const rows = await db.query(
    `SELECT h.keyword_id, h.rank, h.position, h.impressions, h.clicks, h.ctr, h.source, h.recorded_on::text AS recorded_on, h.recorded_at
       FROM ${t("rank_history")} h JOIN ${t("keywords")} k ON k.id = h.keyword_id
      WHERE k.sprint_id = $1 AND h.recorded_on >= $2::date
      ORDER BY h.recorded_at`,
    [sprintId, since],
  );
  return rows.map(positionFrom);
}

export async function recordPosition(db: SeoDb, row: {
  id: string;
  companyId: string;
  sprintId: string;
  keywordId: string;
  position: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  source: "gsc" | "manual";
  recordedOn: string;
}): Promise<void> {
  const rank = row.position == null ? null : Math.max(1, Math.round(row.position));
  const params = [row.id, row.companyId, row.keywordId, rank, row.sprintId, row.position, row.impressions, row.clicks, row.ctr, row.source, row.recordedOn];
  if (row.source === "gsc") {
    await db.execute(
      `INSERT INTO ${t("rank_history")} (id, company_id, keyword_id, rank, sprint_id, position, impressions, clicks, ctr, source, recorded_on)
       VALUES ($1, $2, $3, $4::int, $5, $6::real, $7::int, $8::int, $9::real, $10, $11::date)
       ON CONFLICT (keyword_id, source, recorded_on) WHERE source = 'gsc'
       DO UPDATE SET rank = EXCLUDED.rank, position = EXCLUDED.position, impressions = EXCLUDED.impressions,
         clicks = EXCLUDED.clicks, ctr = EXCLUDED.ctr, recorded_at = now()`,
      params,
    );
    return;
  }
  await db.execute(
    `INSERT INTO ${t("rank_history")} (id, company_id, keyword_id, rank, sprint_id, position, impressions, clicks, ctr, source, recorded_on)
     VALUES ($1, $2, $3, $4::int, $5, $6::real, $7::int, $8::int, $9::real, $10, $11::date)`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------

export interface Backlink {
  id: string;
  companyId: string;
  sprintId: string;
  source: string;
  domain: string;
  url: string | null;
  submitUrl: string | null;
  type: string;
  dr: number | null;
  status: string;
  submittedAt: string | null;
  liveAt: string | null;
  notes: string | null;
  evidence: Record<string, unknown> | null;
  discoveredVia: string;
  createdAt: string | null;
  updatedAt: string | null;
}

const BACKLINK_SELECT = `id, company_id, sprint_id, source, domain, url, submit_url, type, dr, status, submitted_at, live_at, notes, evidence,
  discovered_via, created_at, updated_at`;

function backlinkFrom(row: Row): Backlink {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    sprintId: String(row.sprint_id),
    source: String(row.source ?? ""),
    domain: String(row.domain ?? ""),
    url: s(row.url),
    submitUrl: s(row.submit_url),
    type: String(row.type ?? "other"),
    dr: n(row.dr),
    status: String(row.status ?? "not_started"),
    submittedAt: iso(row.submitted_at),
    liveAt: iso(row.live_at),
    notes: s(row.notes),
    evidence: json<Record<string, unknown> | null>(row.evidence, null),
    discoveredVia: String(row.discovered_via ?? "manual"),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const BACKLINK_COLUMNS: Record<string, ColumnKind> = {
  source: "text",
  domain: "text",
  url: "text",
  submit_url: "text",
  type: "text",
  dr: "int",
  status: "text",
  submitted_at: "ts",
  live_at: "ts",
  notes: "text",
  evidence: "jsonb",
  updated_at: "ts",
};

export interface NewBacklink {
  id: string;
  companyId: string;
  sprintId: string;
  source: string;
  domain: string;
  url: string | null;
  submitUrl: string | null;
  type: string;
  dr: number | null;
  status: string;
  notes: string | null;
  discoveredVia: string;
}

export async function insertBacklinks(db: SeoDb, links: NewBacklink[]): Promise<number> {
  if (links.length === 0) return 0;
  const params: unknown[] = [];
  const values: string[] = [];
  for (const link of links) {
    const base = params.length;
    params.push(link.id, link.companyId, link.sprintId, link.source, link.domain, link.url, link.submitUrl, link.type, link.dr, link.status, link.notes, link.discoveredVia);
    const p = (i: number) => `$${base + i}`;
    values.push(`(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}::int, ${p(10)}, ${p(11)}, ${p(12)},
      CASE WHEN ${p(10)} IN ('submitted', 'live') THEN now() ELSE NULL END, CASE WHEN ${p(10)} = 'live' THEN now() ELSE NULL END)`);
  }
  const result = await db.execute(
    `INSERT INTO ${t("backlinks")} (id, company_id, sprint_id, source, domain, url, submit_url, type, dr, status, notes, discovered_via,
       submitted_at, live_at)
     VALUES ${values.join(", ")}
     ON CONFLICT (sprint_id, domain) WHERE discovered_via = 'template' DO NOTHING`,
    params,
  );
  return result.rowCount;
}

export async function listBacklinks(db: SeoDb, companyId: string, sprintId: string, filter: { status?: string; type?: string } = {}): Promise<Backlink[]> {
  const where = ["company_id = $1", "sprint_id = $2"];
  const params: unknown[] = [companyId, sprintId];
  if (filter.status) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }
  if (filter.type) {
    params.push(filter.type);
    where.push(`type = $${params.length}`);
  }
  const rows = await db.query(`SELECT ${BACKLINK_SELECT} FROM ${t("backlinks")} WHERE ${where.join(" AND ")} ORDER BY dr DESC NULLS LAST, domain`, params);
  return rows.map(backlinkFrom);
}

export async function getBacklink(db: SeoDb, companyId: string, id: string): Promise<Backlink | null> {
  const rows = await db.query(`SELECT ${BACKLINK_SELECT} FROM ${t("backlinks")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [id, companyId]);
  return rows[0] ? backlinkFrom(rows[0]) : null;
}

export async function updateBacklink(db: SeoDb, companyId: string, id: string, patch: Record<string, unknown>): Promise<number> {
  return patchRow(db, "backlinks", BACKLINK_COLUMNS, { companyId, id }, patch);
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export interface ContentItem {
  id: string;
  companyId: string;
  sprintId: string;
  title: string;
  type: string;
  status: string;
  targetKeywordId: string | null;
  targetUrl: string | null;
  publishOn: string | null;
  publishedOn: string | null;
  socialPostIds: string[];
  internalLinksAdded: boolean;
  linksToPillarIds: string[];
  impressions: number | null;
  clicks: number | null;
  position: number | null;
  perfPulledAt: string | null;
  taskId: string | null;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const CONTENT_SELECT = `id, company_id, sprint_id, title, type, status, target_keyword_id, target_url, publish_on::text AS publish_on,
  published_on::text AS published_on, social_post_ids, internal_links_added, links_to_pillar_ids, impressions, clicks, position,
  perf_pulled_at, task_id, notes, created_at, updated_at`;

function contentFrom(row: Row): ContentItem {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    sprintId: String(row.sprint_id),
    title: String(row.title ?? ""),
    type: String(row.type ?? "post"),
    status: String(row.status ?? "idea"),
    targetKeywordId: s(row.target_keyword_id),
    targetUrl: s(row.target_url),
    publishOn: s(row.publish_on)?.slice(0, 10) ?? null,
    publishedOn: s(row.published_on)?.slice(0, 10) ?? null,
    socialPostIds: strList(row.social_post_ids),
    internalLinksAdded: Boolean(row.internal_links_added),
    linksToPillarIds: strList(row.links_to_pillar_ids),
    impressions: n(row.impressions),
    clicks: n(row.clicks),
    position: n(row.position),
    perfPulledAt: iso(row.perf_pulled_at),
    taskId: s(row.task_id),
    notes: s(row.notes),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const CONTENT_COLUMNS: Record<string, ColumnKind> = {
  title: "text",
  type: "text",
  status: "text",
  target_keyword_id: "text",
  target_url: "text",
  publish_on: "date",
  published_on: "date",
  social_post_ids: "jsonb",
  internal_links_added: "bool",
  links_to_pillar_ids: "jsonb",
  impressions: "int",
  clicks: "int",
  position: "real",
  perf_pulled_at: "ts",
  task_id: "text",
  notes: "text",
  updated_at: "ts",
};

export async function insertContent(db: SeoDb, c: {
  id: string;
  companyId: string;
  sprintId: string;
  title: string;
  type: string;
  status: string;
  targetKeywordId: string | null;
  targetUrl: string | null;
  publishOn: string | null;
  publishedOn: string | null;
  taskId: string | null;
  notes: string | null;
}): Promise<void> {
  await db.execute(
    `INSERT INTO ${t("content")} (id, company_id, sprint_id, title, type, status, target_keyword_id, target_url, publish_on, published_on, task_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11, $12)`,
    [c.id, c.companyId, c.sprintId, c.title, c.type, c.status, c.targetKeywordId, c.targetUrl, c.publishOn, c.publishedOn, c.taskId, c.notes],
  );
}

export async function listContent(db: SeoDb, companyId: string, sprintId: string, filter: { status?: string; type?: string } = {}): Promise<ContentItem[]> {
  const where = ["company_id = $1", "sprint_id = $2"];
  const params: unknown[] = [companyId, sprintId];
  if (filter.status) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }
  if (filter.type) {
    params.push(filter.type);
    where.push(`type = $${params.length}`);
  }
  const rows = await db.query(`SELECT ${CONTENT_SELECT} FROM ${t("content")} WHERE ${where.join(" AND ")} ORDER BY created_at`, params);
  return rows.map(contentFrom);
}

export async function getContent(db: SeoDb, companyId: string, id: string): Promise<ContentItem | null> {
  const rows = await db.query(`SELECT ${CONTENT_SELECT} FROM ${t("content")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [id, companyId]);
  return rows[0] ? contentFrom(rows[0]) : null;
}

export async function updateContent(db: SeoDb, companyId: string, id: string, patch: Record<string, unknown>): Promise<number> {
  return patchRow(db, "content", CONTENT_COLUMNS, { companyId, id }, patch);
}

// ---------------------------------------------------------------------------
// Legacy pages (still used for PageSpeed rotation)
// ---------------------------------------------------------------------------

export async function insertPage(db: SeoDb, p: { id: string; companyId: string; sprintId: string; url: string; title: string }): Promise<void> {
  await db.execute(`INSERT INTO ${t("pages")} (id, company_id, sprint_id, url, title) VALUES ($1, $2, $3, $4, $5)`, [p.id, p.companyId, p.sprintId, p.url, p.title]);
}

export async function listPages(db: SeoDb, companyId: string, sprintId: string): Promise<Array<{ id: string; url: string; title: string }>> {
  const rows = await db.query(`SELECT id, url, title FROM ${t("pages")} WHERE company_id = $1 AND sprint_id = $2 ORDER BY created_at`, [companyId, sprintId]);
  return rows.map((r) => ({ id: String(r.id), url: String(r.url), title: String(r.title ?? "") }));
}

// ---------------------------------------------------------------------------
// Page health
// ---------------------------------------------------------------------------

export interface PageHealth {
  url: string;
  strategy: string;
  performance: number | null;
  seo: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  source: string;
  fieldScope: string | null;
  opportunities: Array<{ id: string; title: string; savingsMs: number | null }>;
  pulledOn: string | null;
  pulledAt: string | null;
}

function healthFrom(row: Row): PageHealth {
  return {
    url: String(row.url),
    strategy: String(row.strategy ?? "mobile"),
    performance: n(row.performance),
    seo: n(row.seo),
    accessibility: n(row.accessibility),
    bestPractices: n(row.best_practices),
    lcpMs: n(row.lcp_ms),
    cls: n(row.cls),
    inpMs: n(row.inp_ms),
    source: String(row.source ?? "lab"),
    fieldScope: s(row.field_scope),
    opportunities: json(row.opportunities, []),
    pulledOn: s(row.pulled_on)?.slice(0, 10) ?? null,
    pulledAt: iso(row.pulled_at),
  };
}

export async function upsertPageHealth(db: SeoDb, row: {
  id: string;
  companyId: string;
  sprintId: string;
  url: string;
  strategy: string;
  performance: number | null;
  seo: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  labLcpMs: number | null;
  labCls: number | null;
  labInpMs: number | null;
  fieldLcpMs: number | null;
  fieldCls: number | null;
  fieldInpMs: number | null;
  fieldScope: string | null;
  source: string;
  opportunities: unknown;
  pulledOn: string;
}): Promise<void> {
  await db.execute(
    `INSERT INTO ${t("page_health")} (id, company_id, sprint_id, url, strategy, performance, seo, accessibility, best_practices,
       lcp_ms, cls, inp_ms, lab_lcp_ms, lab_cls, lab_inp_ms, field_lcp_ms, field_cls, field_inp_ms, field_scope, source, opportunities, pulled_on)
     VALUES ($1, $2, $3, $4, $5, $6::int, $7::int, $8::int, $9::int, $10::real, $11::real, $12::real, $13::real, $14::real, $15::real,
       $16::real, $17::real, $18::real, $19, $20, $21::jsonb, $22::date)
     ON CONFLICT (sprint_id, url, strategy, pulled_on) DO UPDATE SET
       performance = EXCLUDED.performance, seo = EXCLUDED.seo, accessibility = EXCLUDED.accessibility,
       best_practices = EXCLUDED.best_practices, lcp_ms = EXCLUDED.lcp_ms, cls = EXCLUDED.cls, inp_ms = EXCLUDED.inp_ms,
       lab_lcp_ms = EXCLUDED.lab_lcp_ms, lab_cls = EXCLUDED.lab_cls, lab_inp_ms = EXCLUDED.lab_inp_ms,
       field_lcp_ms = EXCLUDED.field_lcp_ms, field_cls = EXCLUDED.field_cls, field_inp_ms = EXCLUDED.field_inp_ms,
       field_scope = EXCLUDED.field_scope, source = EXCLUDED.source, opportunities = EXCLUDED.opportunities, pulled_at = now()`,
    [
      row.id, row.companyId, row.sprintId, row.url, row.strategy, row.performance, row.seo, row.accessibility, row.bestPractices,
      row.lcpMs, row.cls, row.inpMs, row.labLcpMs, row.labCls, row.labInpMs, row.fieldLcpMs, row.fieldCls, row.fieldInpMs,
      row.fieldScope, row.source, jsonParam(row.opportunities ?? []), row.pulledOn,
    ],
  );
}

/** Latest reading per URL and strategy. */
export async function latestPageHealth(db: SeoDb, sprintId: string): Promise<PageHealth[]> {
  const rows = await db.query(
    `SELECT DISTINCT ON (url, strategy) url, strategy, performance, seo, accessibility, best_practices, lcp_ms, cls, inp_ms, source,
        field_scope, opportunities, pulled_on::text AS pulled_on, pulled_at
       FROM ${t("page_health")} WHERE sprint_id = $1
      ORDER BY url, strategy, pulled_at DESC`,
    [sprintId],
  );
  return rows.map(healthFrom);
}

export async function pageHealthHistory(db: SeoDb, sprintId: string, url: string, limit = 30): Promise<PageHealth[]> {
  const rows = await db.query(
    `SELECT url, strategy, performance, seo, accessibility, best_practices, lcp_ms, cls, inp_ms, source, field_scope, opportunities,
        pulled_on::text AS pulled_on, pulled_at
       FROM ${t("page_health")} WHERE sprint_id = $1 AND url = $2 ORDER BY pulled_at DESC LIMIT $3::int`,
    [sprintId, url, limit],
  );
  return rows.map(healthFrom);
}

// ---------------------------------------------------------------------------
// Audit snapshots and findings
// ---------------------------------------------------------------------------

export interface Snapshot {
  id: string;
  sprintId: string;
  day: number;
  kind: string;
  capturedOn: string | null;
  capturedAt: string | null;
  traffic: Record<string, unknown>;
  rankings: Record<string, unknown>;
  authority: Record<string, unknown>;
  content: Record<string, unknown>;
  cwv: Record<string, unknown>;
  tasks: Record<string, unknown>;
  source: string;
  notes: string | null;
}

function snapshotFrom(row: Row): Snapshot {
  return {
    id: String(row.id),
    sprintId: String(row.sprint_id),
    day: Number(row.day ?? 0),
    kind: String(row.kind ?? "manual"),
    capturedOn: s(row.captured_on)?.slice(0, 10) ?? null,
    capturedAt: iso(row.captured_at),
    traffic: json(row.traffic, {}),
    rankings: json(row.rankings, {}),
    authority: json(row.authority, {}),
    content: json(row.content, {}),
    cwv: json(row.cwv, {}),
    tasks: json(row.tasks, {}),
    source: String(row.source ?? "none"),
    notes: s(row.notes),
  };
}

export async function insertSnapshot(db: SeoDb, snap: {
  id: string;
  companyId: string;
  sprintId: string;
  day: number;
  kind: "scheduled" | "manual";
  capturedOn: string;
  traffic: unknown;
  rankings: unknown;
  authority: unknown;
  content: unknown;
  cwv: unknown;
  tasks: unknown;
  source: string;
  notes: string | null;
}): Promise<boolean> {
  const sql = `INSERT INTO ${t("audit_snapshots")} (id, company_id, sprint_id, day, kind, captured_on, traffic, rankings, authority, content, cwv, tasks, source, notes)
     VALUES ($1, $2, $3, $4::int, $5, $6::date, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)${
       snap.kind === "scheduled" ? " ON CONFLICT (sprint_id, day) WHERE kind = 'scheduled' DO NOTHING" : ""
     }`;
  const result = await db.execute(sql, [
    snap.id, snap.companyId, snap.sprintId, snap.day, snap.kind, snap.capturedOn, jsonParam(snap.traffic), jsonParam(snap.rankings),
    jsonParam(snap.authority), jsonParam(snap.content), jsonParam(snap.cwv), jsonParam(snap.tasks), snap.source, snap.notes,
  ]);
  return result.rowCount > 0;
}

export async function listSnapshots(db: SeoDb, companyId: string, sprintId: string): Promise<Snapshot[]> {
  const rows = await db.query(
    `SELECT id, sprint_id, day, kind, captured_on::text AS captured_on, captured_at, traffic, rankings, authority, content, cwv, tasks, source, notes
       FROM ${t("audit_snapshots")} WHERE company_id = $1 AND sprint_id = $2 ORDER BY day, captured_at`,
    [companyId, sprintId],
  );
  return rows.map(snapshotFrom);
}

export interface Finding {
  id: string;
  sprintId: string;
  finding: string;
  severity: string;
  category: string | null;
  url: string | null;
  source: string | null;
  status: string;
  snapshotId: string | null;
  createdAt: string | null;
  resolvedAt: string | null;
}

function findingFrom(row: Row): Finding {
  return {
    id: String(row.id),
    sprintId: String(row.sprint_id),
    finding: String(row.finding ?? ""),
    severity: String(row.severity ?? "info"),
    category: s(row.category),
    url: s(row.url),
    source: s(row.source),
    status: String(row.status ?? "open"),
    snapshotId: s(row.snapshot_id),
    createdAt: iso(row.created_at),
    resolvedAt: iso(row.resolved_at),
  };
}

export async function upsertFinding(db: SeoDb, f: {
  id: string;
  companyId: string;
  sprintId: string;
  finding: string;
  severity: string;
  category: string;
  url: string | null;
  source: string;
  snapshotId?: string | null;
}): Promise<void> {
  await db.execute(
    `INSERT INTO ${t("audits")} (id, company_id, sprint_id, finding, severity, category, url, source, snapshot_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open')
     ON CONFLICT (sprint_id, category, url, finding) WHERE status = 'open' AND source IS NOT NULL
     DO UPDATE SET severity = EXCLUDED.severity, updated_at = now()`,
    [f.id, f.companyId, f.sprintId, f.finding.slice(0, 1000), f.severity, f.category, f.url ?? "", f.source, f.snapshotId ?? null],
  );
}

/** Close open findings of one check on one URL that the latest run no longer reports. */
export async function resolveStaleFindings(db: SeoDb, input: { sprintId: string; category: string; url: string | null; source: string; current: string[] }): Promise<number> {
  const result = await db.execute(
    `UPDATE ${t("audits")} SET status = 'resolved', resolved_at = now(), updated_at = now()
      WHERE sprint_id = $1 AND category = $2 AND url = $3 AND source = $4 AND status = 'open'
        AND finding NOT IN ${jsonTextList(5)}`,
    [input.sprintId, input.category, input.url ?? "", input.source, jsonParam(input.current.map((f) => f.slice(0, 1000)))],
  );
  return result.rowCount;
}

export async function listFindings(db: SeoDb, companyId: string, sprintId: string, opts: { status?: string; limit?: number } = {}): Promise<Finding[]> {
  const params: unknown[] = [companyId, sprintId];
  let statusSql = "";
  if (opts.status) {
    params.push(opts.status);
    statusSql = `AND status = $${params.length}`;
  }
  params.push(Math.min(opts.limit ?? 200, 500));
  const rows = await db.query(
    `SELECT id, sprint_id, finding, severity, category, url, source, status, snapshot_id, created_at, resolved_at
       FROM ${t("audits")} WHERE company_id = $1 AND sprint_id = $2 ${statusSql}
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, created_at DESC
      LIMIT $${params.length}::int`,
    params,
  );
  return rows.map(findingFrom);
}

export async function resolveFinding(db: SeoDb, companyId: string, id: string): Promise<number> {
  const result = await db.execute(
    `UPDATE ${t("audits")} SET status = 'resolved', resolved_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  return result.rowCount;
}

// ---------------------------------------------------------------------------
// Optimizations
// ---------------------------------------------------------------------------

export interface Optimization {
  id: string;
  companyId: string;
  sprintId: string;
  signalType: string;
  severity: string;
  subject: string;
  evidence: Record<string, unknown>;
  hypothesis: string;
  hypothesisType: string;
  proposedAction: string;
  proposedTasks: Array<{ title: string; taskType: string; owner: TaskOwner; autopilotEligible: boolean; playbook: string }>;
  targetKeywordIds: string[];
  targetUrl: string | null;
  status: string;
  approvalIssueId: string | null;
  detectedOn: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;
  generatedTaskIds: string[];
  baseline: Record<string, unknown> | null;
  measureOn: string | null;
  measuredAt: string | null;
  outcome: Record<string, unknown> | null;
  result: string | null;
  createdAt: string | null;
}

const OPT_SELECT = `id, company_id, sprint_id, signal_type, severity, subject, evidence, hypothesis, hypothesis_type, proposed_action,
  proposed_tasks, target_keyword_ids, target_url, status, approval_issue_id, detected_on::text AS detected_on, approved_at, approved_by,
  rejected_at, rejected_reason, generated_task_ids, baseline, measure_on::text AS measure_on, measured_at, outcome, result, created_at`;

function optimizationFrom(row: Row): Optimization {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    sprintId: String(row.sprint_id),
    signalType: String(row.signal_type),
    severity: String(row.severity ?? "medium"),
    subject: String(row.subject ?? ""),
    evidence: json(row.evidence, {}),
    hypothesis: String(row.hypothesis ?? ""),
    hypothesisType: String(row.hypothesis_type ?? ""),
    proposedAction: String(row.proposed_action ?? ""),
    proposedTasks: json(row.proposed_tasks, []),
    targetKeywordIds: strList(row.target_keyword_ids),
    targetUrl: s(row.target_url),
    status: String(row.status ?? "proposed"),
    approvalIssueId: s(row.approval_issue_id),
    detectedOn: s(row.detected_on)?.slice(0, 10) ?? null,
    approvedAt: iso(row.approved_at),
    approvedBy: s(row.approved_by),
    rejectedAt: iso(row.rejected_at),
    rejectedReason: s(row.rejected_reason),
    generatedTaskIds: strList(row.generated_task_ids),
    baseline: json<Record<string, unknown> | null>(row.baseline, null),
    measureOn: s(row.measure_on)?.slice(0, 10) ?? null,
    measuredAt: iso(row.measured_at),
    outcome: json<Record<string, unknown> | null>(row.outcome, null),
    result: s(row.result),
    createdAt: iso(row.created_at),
  };
}

const OPT_COLUMNS: Record<string, ColumnKind> = {
  status: "text",
  approval_issue_id: "text",
  approved_at: "ts",
  approved_by: "text",
  rejected_at: "ts",
  rejected_reason: "text",
  generated_task_ids: "jsonb",
  baseline: "jsonb",
  measure_on: "date",
  measured_at: "ts",
  outcome: "jsonb",
  result: "text",
  updated_at: "ts",
};

export async function insertOptimization(db: SeoDb, o: {
  id: string;
  companyId: string;
  sprintId: string;
  signalType: string;
  severity: string;
  subject: string;
  evidence: unknown;
  hypothesis: string;
  hypothesisType: string;
  proposedAction: string;
  proposedTasks: unknown;
  targetKeywordIds: string[];
  targetUrl: string | null;
  detectedOn: string;
}): Promise<boolean> {
  const result = await db.execute(
    `INSERT INTO ${t("optimizations")} (id, company_id, sprint_id, signal_type, severity, subject, evidence, hypothesis, hypothesis_type,
       proposed_action, proposed_tasks, target_keyword_ids, target_url, detected_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14::date)
     ON CONFLICT (sprint_id, signal_type, subject) WHERE status IN ('proposed', 'approved') DO NOTHING`,
    [
      o.id, o.companyId, o.sprintId, o.signalType, o.severity, o.subject, jsonParam(o.evidence), o.hypothesis, o.hypothesisType,
      o.proposedAction, jsonParam(o.proposedTasks), jsonParam(o.targetKeywordIds), o.targetUrl, o.detectedOn,
    ],
  );
  return result.rowCount > 0;
}

export async function listOptimizations(db: SeoDb, companyId: string, sprintId: string, filter: { status?: string } = {}): Promise<Optimization[]> {
  const params: unknown[] = [companyId, sprintId];
  let statusSql = "";
  if (filter.status) {
    params.push(filter.status);
    statusSql = `AND status = $${params.length}`;
  }
  const rows = await db.query(`SELECT ${OPT_SELECT} FROM ${t("optimizations")} WHERE company_id = $1 AND sprint_id = $2 ${statusSql} ORDER BY created_at DESC`, params);
  return rows.map(optimizationFrom);
}

export async function getOptimization(db: SeoDb, companyId: string, id: string): Promise<Optimization | null> {
  const rows = await db.query(`SELECT ${OPT_SELECT} FROM ${t("optimizations")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [id, companyId]);
  return rows[0] ? optimizationFrom(rows[0]) : null;
}

export async function updateOptimization(db: SeoDb, companyId: string, id: string, patch: Record<string, unknown>): Promise<number> {
  return patchRow(db, "optimizations", OPT_COLUMNS, { companyId, id }, patch);
}

export async function countOptimizationsSince(db: SeoDb, sprintId: string, since: string): Promise<number> {
  const rows = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${t("optimizations")} WHERE sprint_id = $1 AND detected_on >= $2::date`,
    [sprintId, since],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function dueMeasurements(db: SeoDb, sprintId: string, today: string): Promise<Optimization[]> {
  const rows = await db.query(
    `SELECT ${OPT_SELECT} FROM ${t("optimizations")} WHERE sprint_id = $1 AND status = 'approved' AND measure_on <= $2::date ORDER BY measure_on LIMIT 20`,
    [sprintId, today],
  );
  return rows.map(optimizationFrom);
}

// ---------------------------------------------------------------------------
// Integrations and OAuth sessions
// ---------------------------------------------------------------------------

export type Provider = "gsc" | "bing" | "pagespeed";

export interface Integration {
  id: string;
  companyId: string;
  sprintId: string;
  provider: Provider;
  status: string;
  propertyUrl: string | null;
  tokenSealed: string | null;
  expiresAt: string | null;
  scopes: string[];
  keyVersion: number | null;
  settings: Record<string, unknown>;
  stats: Record<string, unknown>;
  lastPullAt: string | null;
  lastError: string | null;
  alertIssueId: string | null;
  connectedByUserId: string | null;
  updatedAt: string | null;
}

const INTEGRATION_SELECT = `id, company_id, sprint_id, provider, status, property_url, token_sealed, expires_at, scopes, key_version, settings,
  stats, last_pull_at, last_error, alert_issue_id, connected_by_user_id, updated_at`;

function integrationFrom(row: Row): Integration {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    sprintId: String(row.sprint_id),
    provider: String(row.provider) as Provider,
    status: String(row.status ?? "disconnected"),
    propertyUrl: s(row.property_url),
    tokenSealed: s(row.token_sealed),
    expiresAt: iso(row.expires_at),
    scopes: strList(row.scopes),
    keyVersion: n(row.key_version),
    settings: json(row.settings, {}),
    stats: json(row.stats, {}),
    lastPullAt: iso(row.last_pull_at),
    lastError: s(row.last_error),
    alertIssueId: s(row.alert_issue_id),
    connectedByUserId: s(row.connected_by_user_id),
    updatedAt: iso(row.updated_at),
  };
}

const INTEGRATION_COLUMNS: Record<string, ColumnKind> = {
  status: "text",
  property_url: "text",
  token_sealed: "text",
  expires_at: "ts",
  scopes: "jsonb",
  key_version: "int",
  settings: "jsonb",
  stats: "jsonb",
  last_pull_at: "ts",
  last_error: "text",
  alert_issue_id: "text",
  connected_by_user_id: "text",
  updated_at: "ts",
};

export async function ensureIntegration(db: SeoDb, row: { id: string; companyId: string; sprintId: string; provider: Provider; status: string }): Promise<void> {
  await db.execute(
    `INSERT INTO ${t("integrations")} (id, company_id, sprint_id, provider, status) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (sprint_id, provider) DO NOTHING`,
    [row.id, row.companyId, row.sprintId, row.provider, row.status],
  );
}

export async function listIntegrations(db: SeoDb, companyId: string, sprintId: string): Promise<Integration[]> {
  const rows = await db.query(`SELECT ${INTEGRATION_SELECT} FROM ${t("integrations")} WHERE company_id = $1 AND sprint_id = $2 ORDER BY provider`, [companyId, sprintId]);
  return rows.map(integrationFrom);
}

export async function getIntegration(db: SeoDb, companyId: string, sprintId: string, provider: Provider): Promise<Integration | null> {
  const rows = await db.query(
    `SELECT ${INTEGRATION_SELECT} FROM ${t("integrations")} WHERE company_id = $1 AND sprint_id = $2 AND provider = $3 LIMIT 1`,
    [companyId, sprintId, provider],
  );
  return rows[0] ? integrationFrom(rows[0]) : null;
}

export async function updateIntegration(db: SeoDb, companyId: string, id: string, patch: Record<string, unknown>): Promise<number> {
  return patchRow(db, "integrations", INTEGRATION_COLUMNS, { companyId, id }, patch);
}

export async function insertOAuthSession(db: SeoDb, row: {
  state: string;
  companyId: string;
  sprintId: string;
  provider: string;
  createdByUserId: string | null;
  returnTo: string | null;
  ttlSeconds: number;
}): Promise<void> {
  await db.execute(
    `INSERT INTO ${t("oauth_sessions")} (state, company_id, sprint_id, provider, created_by_user_id, return_to, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7::int * interval '1 second'))`,
    [row.state, row.companyId, row.sprintId, row.provider, row.createdByUserId, row.returnTo, row.ttlSeconds],
  );
}

export interface OAuthSession {
  state: string;
  companyId: string;
  sprintId: string;
  provider: string;
  createdByUserId: string | null;
  returnTo: string | null;
  expired: boolean;
}

export async function getOAuthSession(db: SeoDb, state: string): Promise<OAuthSession | null> {
  const rows = await db.query(
    `SELECT state, company_id, sprint_id, provider, created_by_user_id, return_to, (expires_at < now()) AS expired
       FROM ${t("oauth_sessions")} WHERE state = $1 LIMIT 1`,
    [state],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    state: String(row.state),
    companyId: String(row.company_id),
    sprintId: String(row.sprint_id),
    provider: String(row.provider),
    createdByUserId: s(row.created_by_user_id),
    returnTo: s(row.return_to),
    expired: Boolean(row.expired),
  };
}

export async function deleteOAuthSession(db: SeoDb, state: string): Promise<void> {
  await db.execute(`DELETE FROM ${t("oauth_sessions")} WHERE state = $1`, [state]);
}

export async function deleteExpiredOAuthSessions(db: SeoDb): Promise<void> {
  await db.execute(`DELETE FROM ${t("oauth_sessions")} WHERE expires_at < now() - interval '1 day'`);
}

// ---------------------------------------------------------------------------
// Aggregates used by guards, snapshots and the UI
// ---------------------------------------------------------------------------

export async function completionFacts(db: SeoDb, sprintId: string): Promise<{
  activeKeywords: number;
  keywordsWithoutIntent: number;
  priorityKeywords: number;
  directoriesNotStarted: number;
  latestSnapshotDay: number | null;
}> {
  const rows = await db.query(
    `SELECT
       (SELECT count(*)::int FROM ${t("keywords")} k WHERE k.sprint_id = $1 AND k.retired_at IS NULL) AS active_keywords,
       (SELECT count(*)::int FROM ${t("keywords")} k WHERE k.sprint_id = $1 AND k.retired_at IS NULL AND (k.intent IS NULL OR k.intent = '')) AS no_intent,
       (SELECT count(*)::int FROM ${t("keywords")} k WHERE k.sprint_id = $1 AND k.retired_at IS NULL AND k.is_priority) AS priority,
       (SELECT count(*)::int FROM ${t("backlinks")} b WHERE b.sprint_id = $1 AND b.type = 'directory' AND b.status = 'not_started') AS dirs,
       (SELECT max(a.day) FROM ${t("audit_snapshots")} a WHERE a.sprint_id = $1) AS latest_day`,
    [sprintId],
  );
  const row = rows[0] ?? {};
  return {
    activeKeywords: Number(row.active_keywords ?? 0),
    keywordsWithoutIntent: Number(row.no_intent ?? 0),
    priorityKeywords: Number(row.priority ?? 0),
    directoriesNotStarted: Number(row.dirs ?? 0),
    latestSnapshotDay: n(row.latest_day),
  };
}

export async function sprintCounts(db: SeoDb, companyId: string): Promise<Record<string, { open: number; due: number; done: number; total: number; blocked: number; proposals: number }>> {
  const rows = await db.query(
    `SELECT s.id,
        (SELECT count(*)::int FROM ${t("sprint_tasks")} x WHERE x.sprint_id = s.id) AS total,
        (SELECT count(*)::int FROM ${t("sprint_tasks")} x WHERE x.sprint_id = s.id AND x.status = 'done') AS done,
        (SELECT count(*)::int FROM ${t("sprint_tasks")} x WHERE x.sprint_id = s.id AND x.status = 'blocked') AS blocked,
        (SELECT count(*)::int FROM ${t("sprint_tasks")} x WHERE x.sprint_id = s.id AND x.issue_id IS NOT NULL AND x.status IN ('not_started', 'in_progress', 'blocked')) AS open_issues,
        (SELECT count(*)::int FROM ${t("sprint_tasks")} x WHERE x.sprint_id = s.id AND x.status IN ('not_started', 'in_progress', 'blocked')
            AND (x.due_day IS NULL OR x.due_day <= coalesce(s.current_day, 0))) AS due,
        (SELECT count(*)::int FROM ${t("optimizations")} o WHERE o.sprint_id = s.id AND o.status = 'proposed') AS proposals
       FROM ${t("sprints")} s WHERE s.company_id = $1`,
    [companyId],
  );
  const out: Record<string, { open: number; due: number; done: number; total: number; blocked: number; proposals: number }> = {};
  for (const row of rows) {
    out[String(row.id)] = {
      open: Number(row.open_issues ?? 0),
      due: Number(row.due ?? 0),
      done: Number(row.done ?? 0),
      total: Number(row.total ?? 0),
      blocked: Number(row.blocked ?? 0),
      proposals: Number(row.proposals ?? 0),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// "Needs you" digests (one row per sprint per week; items as one jsonb array)
// ---------------------------------------------------------------------------

export interface NeedsYouDigest {
  id: string;
  companyId: string;
  sprintId: string;
  weekStart: string;
  issueId: string | null;
  issueIdentifier: string | null;
  items: NeedsYouItem[];
  status: "open" | "done";
  updatedAt: string | null;
}

const NEEDS_YOU_SELECT = `id, company_id, sprint_id, week_start::text AS week_start, issue_id, issue_identifier, items, status, updated_at`;

function needsYouFrom(row: Row): NeedsYouDigest {
  const items = json<unknown>(row.items, []);
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    sprintId: String(row.sprint_id),
    weekStart: String(row.week_start ?? "").slice(0, 10),
    issueId: s(row.issue_id),
    issueIdentifier: s(row.issue_identifier),
    items: Array.isArray(items) ? (items as NeedsYouItem[]) : [],
    status: row.status === "done" ? "done" : "open",
    updatedAt: iso(row.updated_at),
  };
}

/** The digest for one week (Monday date). */
export async function getNeedsYou(db: SeoDb, companyId: string, sprintId: string, weekStart: string): Promise<NeedsYouDigest | null> {
  const rows = await db.query(
    `SELECT ${NEEDS_YOU_SELECT} FROM ${t("needs_you")} WHERE company_id = $1 AND sprint_id = $2 AND week_start = $3::date LIMIT 1`,
    [companyId, sprintId, weekStart],
  );
  return rows[0] ? needsYouFrom(rows[0]) : null;
}

export async function latestNeedsYouBefore(db: SeoDb, companyId: string, sprintId: string, weekStart: string): Promise<NeedsYouDigest | null> {
  const rows = await db.query(
    `SELECT ${NEEDS_YOU_SELECT} FROM ${t("needs_you")} WHERE company_id = $1 AND sprint_id = $2 AND week_start < $3::date ORDER BY week_start DESC LIMIT 1`,
    [companyId, sprintId, weekStart],
  );
  return rows[0] ? needsYouFrom(rows[0]) : null;
}

export async function getNeedsYouByIssue(db: SeoDb, companyId: string, issueId: string): Promise<NeedsYouDigest | null> {
  const rows = await db.query(`SELECT ${NEEDS_YOU_SELECT} FROM ${t("needs_you")} WHERE company_id = $1 AND issue_id = $2 LIMIT 1`, [companyId, issueId]);
  return rows[0] ? needsYouFrom(rows[0]) : null;
}

/** One statement: insert this week's digest or replace its items / issue. */
export async function upsertNeedsYou(db: SeoDb, row: { id: string; companyId: string; sprintId: string; weekStart: string; items: NeedsYouItem[]; status: "open" | "done" }): Promise<void> {
  await db.execute(
    `INSERT INTO ${t("needs_you")} (id, company_id, sprint_id, week_start, items, status)
     VALUES ($1, $2, $3, $4::date, $5::jsonb, $6)
     ON CONFLICT (sprint_id, week_start) DO UPDATE SET items = EXCLUDED.items, status = EXCLUDED.status, updated_at = now()`,
    [row.id, row.companyId, row.sprintId, row.weekStart, jsonParam(row.items), row.status],
  );
}

export async function setNeedsYouIssue(db: SeoDb, companyId: string, id: string, issueId: string | null, identifier: string | null): Promise<void> {
  await db.execute(`UPDATE ${t("needs_you")} SET issue_id = $1, issue_identifier = $2, updated_at = now() WHERE id = $3 AND company_id = $4`, [issueId, identifier, id, companyId]);
}
