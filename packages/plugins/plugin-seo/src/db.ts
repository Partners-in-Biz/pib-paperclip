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
import type { AutopilotMode, Pacing, SignoffMode, SprintStatus, TaskSource, TaskStatus } from "./engine/sprint.js";
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

/** A boolean column as the host returns it (true, or the text "t" / "true"); anything else, including a missing column, is false. */
function flag(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
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
  /** The client's own Paperclip project: the root issue and every task issue of the sprint open there. */
  clientProjectId: string | null;
  siteAccess: SiteAccess;
  /** The CRM website (projected into crm_sites) a `wordpress` sprint changes through the PiB Connector. */
  siteId: string | null;
  repoUrl: string | null;
  defaultBranch: string;
  framework: string | null;
  hosting: string | null;
  changePolicy: ChangePolicy;
  /** Google / Bing / IndexNow verification and indexing follow-up state. */
  verification: Record<string, unknown>;
  /** The 0.23.0 extras, each off until a person switches it on for this sprint (engine/switches.ts). */
  geoEnabled: boolean;
  ga4Enabled: boolean;
  chunksEnabled: boolean;
  /** auto: template tasks open by the calendar. manual: they open only when a person starts their week (engine/sprint.ts). */
  pacing: Pacing;
  /** auto: the plugin waits for the client, drafts the approval email and applies what the client approved (service/client-signoff.ts). */
  clientSignoff: SignoffMode;
  /** Manual pacing: the plugin starts each week in order up to this one (engine/pacing.ts); null = a person starts every week. */
  releaseThrough: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const SPRINT_SELECT = `id, company_id, name, site_url, site_name, client_kind, client_ref, client_name, status, start_date::text AS start_date,
  template_id, template_version, autopilot_mode, owner_user_id, project_id, root_issue_id, root_issue_identifier, agent_id, notes,
  paused_reason, health, scoreboard, today, current_day, current_week, current_phase, last_daily_on::text AS last_daily_on,
  last_weekly_on::text AS last_weekly_on, audit_days_done, seeded_at, site_project_id, client_project_id, site_access, site_id, repo_url, default_branch, framework,
  hosting, change_policy, verification, geo_enabled, ga4_enabled, chunks_enabled, pacing, client_signoff, release_through, created_at, updated_at`;

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
    clientProjectId: s(row.client_project_id),
    siteAccess: (SITE_ACCESS as readonly string[]).includes(String(row.site_access)) ? (String(row.site_access) as SiteAccess) : "unlinked",
    siteId: s(row.site_id),
    repoUrl: s(row.repo_url),
    defaultBranch: s(row.default_branch) ?? "main",
    framework: s(row.framework),
    hosting: s(row.hosting),
    changePolicy: (CHANGE_POLICIES as readonly string[]).includes(String(row.change_policy)) ? (String(row.change_policy) as ChangePolicy) : "merge_seo_scope",
    verification: json<Record<string, unknown>>(row.verification, {}),
    // Only a real true switches an extra on: a missing or odd value is off.
    geoEnabled: flag(row.geo_enabled),
    ga4Enabled: flag(row.ga4_enabled),
    chunksEnabled: flag(row.chunks_enabled),
    pacing: String(row.pacing) === "manual" ? "manual" : "auto",
    clientSignoff: String(row.client_signoff) === "auto" ? "auto" : "manual",
    releaseThrough: n(row.release_through),
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
  pacing: "text",
  client_signoff: "text",
  release_through: "int",
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
  client_project_id: "text",
  site_access: "text",
  site_id: "text",
  repo_url: "text",
  default_branch: "text",
  framework: "text",
  hosting: "text",
  change_policy: "text",
  verification: "jsonb",
  geo_enabled: "bool",
  ga4_enabled: "bool",
  chunks_enabled: "bool",
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

/**
 * The three extras' switches as they are right now (one small read), or null when the sprint is gone. The daily run uses it
 * to follow a switch a person flipped while the sprint waited in the queue.
 */
export async function getSprintSwitches(db: SeoDb, companyId: string, id: string): Promise<{ geo: boolean; ga4: boolean; chunks: boolean } | null> {
  const rows = await db.query(`SELECT geo_enabled, ga4_enabled, chunks_enabled FROM ${t("sprints")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [id, companyId]);
  const row = rows[0];
  return row ? { geo: flag(row.geo_enabled), ga4: flag(row.ga4_enabled), chunks: flag(row.chunks_enabled) } : null;
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
  /** The extras the sprint starts with; all off unless a person chose otherwise (service/switches.ts). */
  switches?: { geo: boolean; ga4: boolean; chunks: boolean };
}): Promise<void> {
  await db.execute(
    `INSERT INTO ${t("sprints")} (id, company_id, name, site_url, site_name, client_kind, client_ref, client_name, status, start_date,
       template_id, template_version, autopilot_mode, owner_user_id, notes, geo_enabled, ga4_enabled, chunks_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12::int, $13, $14, $15, $16::boolean, $17::boolean, $18::boolean)`,
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
      sprint.switches?.geo === true,
      sprint.switches?.ga4 === true,
      sprint.switches?.chunks === true,
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
  /** When a person started the task's week (or the task) on a manual-pacing sprint; null until then. */
  releasedAt: string | null;
  /** Derived: a template task of a manual-pacing sprint that nobody has started yet. It is not due, whatever its day. */
  held: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

const TASK_SELECT = `id, company_id, sprint_id, template_key, week, phase, due_day, focus, title, description, task_type, owner,
  autopilot_eligible, playbook_key, status, source, parent_optimization_id, context, issue_id, issue_identifier, issue_status,
  assignee_kind, blocker_reason, human_ask, evidence, started_at, completed_at, completed_by, created_at, updated_at, issue_project_id, released_at,
  (status = 'not_started' AND source = 'template' AND released_at IS NULL AND issue_id IS NULL
    AND EXISTS (SELECT 1 FROM ${t("sprints")} sp WHERE sp.id = ${t("sprint_tasks")}.sprint_id AND sp.pacing = 'manual')) AS held`;

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
    releasedAt: iso(row.released_at),
    held: flag(row.held),
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
  released_at: "ts",
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

/**
 * Switching a sprint to manual pacing: template tasks that have not started, in weeks that already have an issue open, are
 * released so the week under way finishes. Returns how many tasks it released.
 */
export async function releaseOpenWeeks(db: SeoDb, companyId: string, sprintId: string): Promise<number> {
  const result = await db.execute(
    `UPDATE ${t("sprint_tasks")} q SET released_at = now(), updated_at = now()
      WHERE q.company_id = $1 AND q.sprint_id = $2 AND q.status = 'not_started' AND q.source = 'template' AND q.released_at IS NULL AND q.issue_id IS NULL
        AND EXISTS (SELECT 1 FROM ${t("sprint_tasks")} o WHERE o.sprint_id = q.sprint_id AND o.week = q.week AND o.issue_id IS NOT NULL)`,
    [companyId, sprintId],
  );
  return result.rowCount;
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

export interface TrafficDay {
  on: string;
  impressions: number;
  clicks: number;
  /** Tracked keywords with Search Console data that day. */
  keywords: number;
}

/**
 * Search Console impressions and clicks of the sprint's tracked keywords per
 * day (the page's traffic chart), oldest first. Read only.
 */
export async function sprintTraffic(db: SeoDb, companyId: string, sprintId: string, days = 56): Promise<TrafficDay[]> {
  const rows = await db.query(
    `SELECT h.recorded_on::text AS on_day, COALESCE(sum(h.impressions), 0)::int AS impressions,
            COALESCE(sum(h.clicks), 0)::int AS clicks, count(DISTINCT h.keyword_id)::int AS keywords
       FROM ${t("rank_history")} h JOIN ${t("keywords")} k ON k.id = h.keyword_id
      WHERE k.sprint_id = $1 AND h.company_id = $2 AND h.source = 'gsc' AND h.recorded_on IS NOT NULL
        AND h.recorded_on >= current_date - $3::int
      GROUP BY h.recorded_on
      ORDER BY h.recorded_on`,
    [sprintId, companyId, days],
  );
  return rows.map((row) => ({
    on: String(row.on_day).slice(0, 10),
    impressions: n(row.impressions) ?? 0,
    clicks: n(row.clicks) ?? 0,
    keywords: n(row.keywords) ?? 0,
  }));
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
  /** AI-search readiness score and AI-answer sampling (engine/geo.ts GeoSnapshot); empty before 0.23.0. */
  geo: Record<string, unknown>;
  /** GA4 organic numbers over the last four weeks (engine/analytics.ts); empty without GA4. */
  analytics: Record<string, unknown>;
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
    geo: json(row.geo, {}),
    analytics: json(row.analytics, {}),
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
  geo?: unknown;
  analytics?: unknown;
  source: string;
  notes: string | null;
}): Promise<boolean> {
  const sql = `INSERT INTO ${t("audit_snapshots")} (id, company_id, sprint_id, day, kind, captured_on, traffic, rankings, authority, content, cwv, tasks, source, notes, geo, analytics)
     VALUES ($1, $2, $3, $4::int, $5, $6::date, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15::jsonb, $16::jsonb)${
       snap.kind === "scheduled" ? " ON CONFLICT (sprint_id, day) WHERE kind = 'scheduled' DO NOTHING" : ""
     }`;
  const result = await db.execute(sql, [
    snap.id, snap.companyId, snap.sprintId, snap.day, snap.kind, snap.capturedOn, jsonParam(snap.traffic), jsonParam(snap.rankings),
    jsonParam(snap.authority), jsonParam(snap.content), jsonParam(snap.cwv), jsonParam(snap.tasks), snap.source, snap.notes,
    jsonParam(snap.geo ?? {}), jsonParam(snap.analytics ?? {}),
  ]);
  return result.rowCount > 0;
}

export async function listSnapshots(db: SeoDb, companyId: string, sprintId: string): Promise<Snapshot[]> {
  const rows = await db.query(
    `SELECT id, sprint_id, day, kind, captured_on::text AS captured_on, captured_at, traffic, rankings, authority, content, cwv, tasks, geo, analytics, source, notes
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

/** The text of the open findings one check recorded for one resource (a re-run keeps those it could not judge). */
export async function openFindingTexts(db: SeoDb, input: { sprintId: string; category: string; url: string | null; source: string }): Promise<string[]> {
  const rows = await db.query(
    `SELECT finding FROM ${t("audits")} WHERE sprint_id = $1 AND category = $2 AND url = $3 AND source = $4 AND status = 'open' LIMIT 200`,
    [input.sprintId, input.category, input.url ?? "", input.source],
  );
  return rows.map((r) => String(r.finding ?? ""));
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

export type Provider = "gsc" | "bing" | "pagespeed" | "ga4";

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
  liveContentWithSocial: number;
  geoAuditAgeDays: number | null;
  aiSamplesRecent: number;
  geoOff: boolean;
}> {
  const rows = await db.query(
    `SELECT
       (SELECT count(*)::int FROM ${t("keywords")} k WHERE k.sprint_id = $1 AND k.retired_at IS NULL) AS active_keywords,
       (SELECT count(*)::int FROM ${t("keywords")} k WHERE k.sprint_id = $1 AND k.retired_at IS NULL AND (k.intent IS NULL OR k.intent = '')) AS no_intent,
       (SELECT count(*)::int FROM ${t("keywords")} k WHERE k.sprint_id = $1 AND k.retired_at IS NULL AND k.is_priority) AS priority,
       (SELECT count(*)::int FROM ${t("backlinks")} b WHERE b.sprint_id = $1 AND b.type IN ('directory', 'citation') AND b.status = 'not_started') AS dirs,
       (SELECT max(a.day) FROM ${t("audit_snapshots")} a WHERE a.sprint_id = $1) AS latest_day,
       (SELECT count(*)::int FROM ${t("content")} c WHERE c.sprint_id = $1 AND c.status = 'live' AND jsonb_array_length(COALESCE(c.social_post_ids, '[]'::jsonb)) > 0) AS live_social,
       (SELECT (current_date - max(g.audited_on)) FROM ${t("geo_audits")} g WHERE g.sprint_id = $1) AS geo_age,
       (SELECT count(DISTINCT (m.query_key, m.engine))::int FROM ${t("ai_mentions")} m WHERE m.sprint_id = $1 AND m.sampled_on >= current_date - 14) AS ai_samples,
       (SELECT NOT x.geo_enabled FROM ${t("sprints")} x WHERE x.id = $1) AS geo_off`,
    [sprintId],
  );
  const row = rows[0] ?? {};
  return {
    activeKeywords: Number(row.active_keywords ?? 0),
    keywordsWithoutIntent: Number(row.no_intent ?? 0),
    priorityKeywords: Number(row.priority ?? 0),
    directoriesNotStarted: Number(row.dirs ?? 0),
    latestSnapshotDay: n(row.latest_day),
    liveContentWithSocial: Number(row.live_social ?? 0),
    geoAuditAgeDays: n(row.geo_age),
    aiSamplesRecent: Number(row.ai_samples ?? 0),
    geoOff: flag(row.geo_off),
  };
}

export interface SprintTotals {
  total: number;
  done: number;
  /** Skipped or not needed (`skipped`, `na`). */
  skipped: number;
  /** Open tasks that have an issue. */
  openIssues: number;
  /** Optimization proposals waiting for a decision. */
  proposals: number;
}

/**
 * Per sprint: task totals, open issues and proposals. Due, overdue, stuck and
 * waiting come from the open tasks through engine/due.ts (service/overview.ts),
 * so every page and tool counts them the same way.
 */
export async function sprintTotals(db: SeoDb, companyId: string): Promise<Record<string, SprintTotals>> {
  const rows = await db.query(
    `SELECT s.id,
        (SELECT count(*)::int FROM ${t("sprint_tasks")} x WHERE x.sprint_id = s.id) AS total,
        (SELECT count(*)::int FROM ${t("sprint_tasks")} x WHERE x.sprint_id = s.id AND x.status = 'done') AS done,
        (SELECT count(*)::int FROM ${t("sprint_tasks")} x WHERE x.sprint_id = s.id AND x.status IN ('skipped', 'na')) AS skipped,
        (SELECT count(*)::int FROM ${t("sprint_tasks")} x WHERE x.sprint_id = s.id AND x.issue_id IS NOT NULL AND x.status IN ('not_started', 'in_progress', 'blocked')) AS open_issues,
        (SELECT count(*)::int FROM ${t("optimizations")} o WHERE o.sprint_id = s.id AND o.status = 'proposed') AS proposals
       FROM ${t("sprints")} s WHERE s.company_id = $1`,
    [companyId],
  );
  const out: Record<string, SprintTotals> = {};
  for (const row of rows) {
    out[String(row.id)] = {
      total: Number(row.total ?? 0),
      done: Number(row.done ?? 0),
      skipped: Number(row.skipped ?? 0),
      openIssues: Number(row.open_issues ?? 0),
      proposals: Number(row.proposals ?? 0),
    };
  }
  return out;
}

/**
 * Tasks whose issue is open and waiting on or with an agent (the issue threads the plugin keeps small), on sprints that
 * are not paused or archived: moving a thread wakes the agent, and a paused sprint's work stays still.
 */
export async function listTasksWithOpenIssues(db: SeoDb, companyId: string): Promise<SprintTask[]> {
  const rows = await db.query(
    `SELECT ${TASK_SELECT} FROM ${t("sprint_tasks")}
      WHERE company_id = $1 AND issue_id IS NOT NULL AND status IN ('not_started', 'in_progress', 'blocked')
        AND (issue_status IS NULL OR issue_status IN ('todo', 'in_progress', 'blocked', 'backlog'))
        AND sprint_id IN (SELECT id FROM ${t("sprints")} WHERE company_id = $1 AND status NOT IN ('paused', 'archived'))
      ORDER BY sprint_id, week, created_at LIMIT 1000`,
    [companyId],
  );
  return rows.map(taskFrom);
}

export interface TaskPreviewRow {
  id: string;
  pageUrl: string;
  title: string;
  status: string;
  reviewStatus: string;
  reviewNote: string | null;
}

/** A task's previews, newest first (a continuation issue lists them). */
export async function previewsForTask(db: SeoDb, companyId: string, taskId: string, limit = 30): Promise<TaskPreviewRow[]> {
  const rows = await db.query(
    `SELECT id, page_url, title, status, review_status, review_note FROM ${t("previews")}
      WHERE company_id = $1 AND task_id = $2 ORDER BY created_at DESC LIMIT $3::int`,
    [companyId, taskId, Math.max(1, Math.min(100, limit))],
  );
  return rows.map((r) => ({ id: String(r.id), pageUrl: String(r.page_url), title: String(r.title), status: String(r.status), reviewStatus: String(r.review_status ?? "pending"), reviewNote: s(r.review_note) }));
}

/** Every open task (not started, in progress, blocked) of the company's sprints, in plan order. */
export async function listOpenTasksForCompany(db: SeoDb, companyId: string): Promise<SprintTask[]> {
  const rows = await db.query(
    `SELECT ${TASK_SELECT} FROM ${t("sprint_tasks")}
      WHERE company_id = $1 AND status IN ('not_started', 'in_progress', 'blocked')
      ORDER BY sprint_id, week, created_at, title LIMIT 5000`,
    [companyId],
  );
  return rows.map(taskFrom);
}

/**
 * Issues whose latest run (last 30 days) stopped at the host's workspace
 * check (`error_code` = `code`, e.g. workspace_validation_failed): the
 * project has no checkout of its repo on the server, so nothing the agent
 * does on them runs. A later run that got past the check clears it.
 */
export async function issuesWithFailingRuns(db: SeoDb, companyId: string, issueIds: string[], code: string): Promise<Map<string, { at: string | null }>> {
  const out = new Map<string, { at: string | null }>();
  const ids = [...new Set(issueIds.filter(Boolean))].slice(0, 500);
  if (ids.length === 0) return out;
  const rows = await db.query(
    `SELECT DISTINCT ON (r.context_snapshot->>'issueId') r.context_snapshot->>'issueId' AS issue_id, r.error_code, r.created_at::text AS at
       FROM public.heartbeat_runs r
      WHERE r.company_id = $1 AND r.created_at >= now() - interval '30 days'
        AND r.context_snapshot->>'issueId' IN (SELECT jsonb_array_elements_text($2::jsonb))
      ORDER BY r.context_snapshot->>'issueId', r.created_at DESC`,
    [companyId, JSON.stringify(ids)],
  );
  for (const row of rows) if (row.error_code === code && row.issue_id) out.set(String(row.issue_id), { at: s(row.at) });
  return out;
}

export interface LatestRun {
  /** The run's error text, if it failed. */
  error: string | null;
  at: string | null;
  /** Queued or running, and started in the last two hours (an older "running" row is a leftover, not work in flight). */
  active: boolean;
}

/**
 * Each issue's latest run in the last `days` days (the host's `heartbeat_runs`): what it ended with, and whether one
 * is in flight. The thread guard (service/thread.ts) leaves an issue alone while an agent is working on it and moves
 * the ones whose latest run failed with `spawn E2BIG`. One statement for all the ids.
 */
export async function latestRuns(db: SeoDb, companyId: string, issueIds: string[], days = 3): Promise<Map<string, LatestRun>> {
  const out = new Map<string, LatestRun>();
  const ids = [...new Set(issueIds.filter(Boolean))].slice(0, 500);
  if (ids.length === 0) return out;
  const rows = await db.query(
    `SELECT DISTINCT ON (r.context_snapshot->>'issueId') r.context_snapshot->>'issueId' AS issue_id, r.error, r.created_at::text AS at,
            (r.status IN ('queued', 'running') AND r.created_at >= now() - interval '2 hours') AS active
       FROM public.heartbeat_runs r
      WHERE r.company_id = $1 AND r.created_at >= now() - ($3::int * interval '1 day')
        AND r.context_snapshot->>'issueId' IN (SELECT jsonb_array_elements_text($2::jsonb))
      ORDER BY r.context_snapshot->>'issueId', r.created_at DESC`,
    [companyId, JSON.stringify(ids), days],
  );
  for (const row of rows) if (row.issue_id) out.set(String(row.issue_id), { error: s(row.error), at: s(row.at), active: row.active === true || row.active === "t" || row.active === "true" });
  return out;
}

export interface ThreadSize {
  comments: number;
  bytes: number;
}

/**
 * How big each issue's thread is: comments (not deleted) and their bytes. Reads the core `issue_comments` table,
 * which the manifest lists in `database.coreReadTables`; throws when the host has not granted it yet.
 */
export async function threadSizes(db: SeoDb, companyId: string, issueIds: string[]): Promise<Map<string, ThreadSize>> {
  const out = new Map<string, ThreadSize>();
  const ids = [...new Set(issueIds.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))].slice(0, 500);
  if (ids.length === 0) return out;
  const rows = await db.query(
    `SELECT c.issue_id::text AS issue_id, count(*)::int AS comments, COALESCE(sum(octet_length(c.body)), 0)::bigint AS bytes
       FROM public.issue_comments c
      WHERE c.company_id = $1 AND c.deleted_at IS NULL
        AND c.issue_id IN (SELECT jsonb_array_elements_text($2::jsonb)::uuid)
      GROUP BY c.issue_id`,
    [companyId, JSON.stringify(ids)],
  );
  for (const row of rows) out.set(String(row.issue_id), { comments: Number(row.comments ?? 0), bytes: Number(row.bytes ?? 0) });
  return out;
}

/** The newest comments of one issue (author kind, time, body), newest first. */
export async function lastComments(db: SeoDb, companyId: string, issueId: string, limit = 3): Promise<Array<{ author: string; at: string; body: string }>> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issueId)) return [];
  const rows = await db.query(
    `SELECT CASE WHEN c.author_agent_id IS NOT NULL THEN 'agent' WHEN c.author_user_id IS NOT NULL THEN 'person' ELSE 'plugin' END AS author,
            c.created_at::text AS at, left(c.body, 1200) AS body
       FROM public.issue_comments c
      WHERE c.company_id = $1 AND c.issue_id = $2::uuid AND c.deleted_at IS NULL
      ORDER BY c.created_at DESC LIMIT $3::int`,
    [companyId, issueId, Math.max(1, Math.min(10, limit))],
  );
  return rows.map((r) => ({ author: String(r.author), at: String(r.at), body: String(r.body ?? "") }));
}

/** A task's issue was replaced by a continuation issue: the previews that point at it follow. */
export async function repointPreviews(db: SeoDb, companyId: string, fromIssueId: string, toIssueId: string): Promise<number> {
  const result = await db.execute(`UPDATE ${t("previews")} SET issue_id = $3 WHERE company_id = $1 AND issue_id = $2`, [companyId, fromIssueId, toIssueId]);
  return result.rowCount;
}

/**
 * Issues an agent run has started on (last 30 days), with when the first one began. The host raises no
 * issue.updated event when an agent picks an issue up, so this is how a task learns its work started.
 */
/** Issues (of those given) with a run queued or running right now. */
export async function issuesWithActiveRuns(db: SeoDb, companyId: string, issueIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(issueIds.filter(Boolean))].slice(0, 500);
  if (ids.length === 0) return new Set();
  const rows = await db.query(
    `SELECT DISTINCT r.context_snapshot->>'issueId' AS issue_id
       FROM public.heartbeat_runs r
      WHERE r.company_id = $1 AND r.status IN ('queued', 'running') AND r.created_at >= now() - interval '2 days'
        AND r.context_snapshot->>'issueId' IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [companyId, JSON.stringify(ids)],
  );
  return new Set(rows.map((r) => String(r.issue_id)).filter(Boolean));
}

export async function issuesWithStartedRuns(db: SeoDb, companyId: string, issueIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(issueIds.filter(Boolean))].slice(0, 500);
  if (ids.length === 0) return out;
  const rows = await db.query(
    `SELECT r.context_snapshot->>'issueId' AS issue_id, min(r.started_at)::text AS at
       FROM public.heartbeat_runs r
      WHERE r.company_id = $1 AND r.created_at >= now() - interval '30 days' AND r.started_at IS NOT NULL
        AND r.context_snapshot->>'issueId' IN (SELECT jsonb_array_elements_text($2::jsonb))
      GROUP BY 1`,
    [companyId, JSON.stringify(ids)],
  );
  for (const row of rows) if (row.issue_id) out.set(String(row.issue_id), s(row.at));
  return out;
}

/** Open Needs you digests of the company's sprints that are not archived, newest week first. */
export async function openNeedsYouDigests(db: SeoDb, companyId: string): Promise<Array<{ sprintId: string; items: NeedsYouItem[] }>> {
  const rows = await db.query(
    `SELECT n.sprint_id, n.items FROM ${t("needs_you")} n JOIN ${t("sprints")} s ON s.id = n.sprint_id
      WHERE n.company_id = $1 AND n.status = 'open' AND s.status <> 'archived'
      ORDER BY n.week_start DESC LIMIT 200`,
    [companyId],
  );
  return rows.map((row) => ({ sprintId: String(row.sprint_id), items: json<NeedsYouItem[]>(row.items, []) }));
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

/** The sprint's latest digests, newest week first (to find the last state of an item that has moved on from this week's). */
export async function recentNeedsYouDigests(db: SeoDb, companyId: string, sprintId: string, limit = 8): Promise<NeedsYouDigest[]> {
  const rows = await db.query(
    `SELECT ${NEEDS_YOU_SELECT} FROM ${t("needs_you")} WHERE company_id = $1 AND sprint_id = $2 ORDER BY week_start DESC LIMIT $3::int`,
    [companyId, sprintId, Math.min(Math.max(limit, 1), 26)],
  );
  return rows.map(needsYouFrom);
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

// ---------------------------------------------------------------------------
// Learned playbooks (one per scope: a CRM client, or PiB's own sites)
// ---------------------------------------------------------------------------

export interface Playbook {
  id: string;
  companyId: string;
  scopeKey: string;
  clientKind: ClientKind | null;
  clientRef: string | null;
  clientName: string | null;
  playbook: string;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PlaybookVersion {
  version: number;
  playbook: string;
  reason: string;
  optimizationId: string | null;
  changeId: string | null;
  decidedBy: string | null;
  createdAt: string | null;
}

export type PlaybookChangeStatus = "pending" | "kept" | "discarded";
export type PlaybookChangeSource = "measured" | "agent" | "person";

export interface PlaybookChange {
  id: string;
  companyId: string;
  playbookId: string;
  sprintId: string | null;
  optimizationId: string | null;
  source: PlaybookChangeSource;
  op: "add" | "remove" | "replace";
  section: string | null;
  body: string;
  diff: string;
  reason: string;
  status: PlaybookChangeStatus;
  baseVersion: number;
  resultVersion: number | null;
  proposedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string | null;
}

export type NewPlaybookChange = Pick<
  PlaybookChange,
  "id" | "companyId" | "playbookId" | "sprintId" | "optimizationId" | "source" | "op" | "section" | "body" | "diff" | "reason" | "baseVersion" | "proposedBy"
>;

export interface PlaybookChangePatch {
  status?: "kept" | "discarded";
  resultVersion?: number;
  decidedBy?: string;
  decisionNote?: string | null;
}

const PLAYBOOK_SELECT = `id, company_id, scope_key, client_kind, client_ref, client_name, playbook, version, created_at, updated_at`;

function playbookFrom(row: Row): Playbook {
  const ref = s(row.client_ref);
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    scopeKey: String(row.scope_key),
    clientKind: ref ? (isClientKind(row.client_kind) ? row.client_kind : "company") : null,
    clientRef: ref,
    clientName: ref ? s(row.client_name) : null,
    playbook: String(row.playbook ?? ""),
    version: n(row.version) ?? 1,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function findPlaybook(db: SeoDb, companyId: string, scopeKey: string): Promise<Playbook | null> {
  const rows = await db.query(`SELECT ${PLAYBOOK_SELECT} FROM ${t("playbooks")} WHERE company_id = $1 AND scope_key = $2 LIMIT 1`, [companyId, scopeKey]);
  return rows[0] ? playbookFrom(rows[0]) : null;
}

export async function getPlaybook(db: SeoDb, companyId: string, id: string): Promise<Playbook | null> {
  const rows = await db.query(`SELECT ${PLAYBOOK_SELECT} FROM ${t("playbooks")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [id, companyId]);
  return rows[0] ? playbookFrom(rows[0]) : null;
}

/** Create the scope's playbook at version 1; a concurrent create wins and this is a no-op. */
export async function insertPlaybook(db: SeoDb, p: { id: string; companyId: string; scopeKey: string; clientKind: ClientKind | null; clientRef: string | null; clientName: string | null; playbook: string }): Promise<boolean> {
  const result = await db.execute(
    `INSERT INTO ${t("playbooks")} (id, company_id, scope_key, client_kind, client_ref, client_name, playbook, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
     ON CONFLICT (company_id, scope_key) DO NOTHING`,
    [p.id, p.companyId, p.scopeKey, p.clientRef ? p.clientKind ?? "company" : null, p.clientRef, p.clientRef ? p.clientName : null, p.playbook],
  );
  return result.rowCount > 0;
}

export async function setPlaybookClientName(db: SeoDb, companyId: string, id: string, clientName: string): Promise<void> {
  await db.execute(`UPDATE ${t("playbooks")} SET client_name = $1, updated_at = now() WHERE id = $2 AND company_id = $3`, [clientName, id, companyId]);
}

/** Replace the markdown while the playbook is still at `expectedVersion`; bumps the version. */
export async function savePlaybook(db: SeoDb, companyId: string, id: string, expectedVersion: number, playbook: string): Promise<boolean> {
  const result = await db.execute(
    `UPDATE ${t("playbooks")} SET playbook = $1, version = version + 1, updated_at = now() WHERE id = $2 AND company_id = $3 AND version = $4::int`,
    [playbook, id, companyId, expectedVersion],
  );
  return result.rowCount > 0;
}

export async function insertPlaybookVersion(db: SeoDb, v: { id: string; companyId: string; playbookId: string; version: number; playbook: string; reason: string; optimizationId: string | null; changeId: string | null; decidedBy: string | null }): Promise<void> {
  await db.execute(
    `INSERT INTO ${t("playbook_versions")} (id, company_id, playbook_id, version, playbook, reason, optimization_id, change_id, decided_by)
     VALUES ($1, $2, $3, $4::int, $5, $6, $7, $8, $9)
     ON CONFLICT (playbook_id, version) DO NOTHING`,
    [v.id, v.companyId, v.playbookId, v.version, v.playbook, v.reason, v.optimizationId, v.changeId, v.decidedBy],
  );
}

export async function listPlaybookVersions(db: SeoDb, companyId: string, playbookId: string, limit = 20): Promise<PlaybookVersion[]> {
  const rows = await db.query(
    `SELECT version, playbook, reason, optimization_id, change_id, decided_by, created_at FROM ${t("playbook_versions")}
      WHERE company_id = $1 AND playbook_id = $2 ORDER BY version DESC LIMIT $3::int`,
    [companyId, playbookId, Math.max(1, Math.min(limit, 100))],
  );
  return rows.map((row) => ({
    version: n(row.version) ?? 1,
    playbook: String(row.playbook ?? ""),
    reason: String(row.reason ?? ""),
    optimizationId: s(row.optimization_id),
    changeId: s(row.change_id),
    decidedBy: s(row.decided_by),
    createdAt: iso(row.created_at),
  }));
}

const CHANGE_SELECT = `id, company_id, playbook_id, sprint_id, optimization_id, source, op, section, body, diff, reason, status, base_version,
  result_version, proposed_by, decided_by, decided_at, decision_note, created_at`;

function changeFrom(row: Row): PlaybookChange {
  const op = String(row.op);
  const source = String(row.source);
  const status = String(row.status);
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    playbookId: String(row.playbook_id),
    sprintId: s(row.sprint_id),
    optimizationId: s(row.optimization_id),
    source: source === "measured" || source === "person" ? source : "agent",
    op: op === "remove" || op === "replace" ? op : "add",
    section: s(row.section),
    body: String(row.body ?? ""),
    diff: String(row.diff ?? ""),
    reason: String(row.reason ?? ""),
    status: status === "kept" || status === "discarded" ? status : "pending",
    baseVersion: n(row.base_version) ?? 1,
    resultVersion: n(row.result_version),
    proposedBy: s(row.proposed_by),
    decidedBy: s(row.decided_by),
    decidedAt: iso(row.decided_at),
    decisionNote: s(row.decision_note),
    createdAt: iso(row.created_at),
  };
}

/** False when a drafted change for the same measured optimization already exists. */
export async function insertPlaybookChange(db: SeoDb, c: NewPlaybookChange): Promise<boolean> {
  const result = await db.execute(
    `INSERT INTO ${t("playbook_changes")} (id, company_id, playbook_id, sprint_id, optimization_id, source, op, section, body, diff, reason, base_version, proposed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::int, $13)
     ON CONFLICT (optimization_id) WHERE source = 'measured' DO NOTHING`,
    [c.id, c.companyId, c.playbookId, c.sprintId, c.optimizationId, c.source, c.op, c.section, c.body, c.diff, c.reason, c.baseVersion, c.proposedBy],
  );
  return result.rowCount > 0;
}

export async function getPlaybookChange(db: SeoDb, companyId: string, id: string): Promise<PlaybookChange | null> {
  const rows = await db.query(`SELECT ${CHANGE_SELECT} FROM ${t("playbook_changes")} WHERE id = $1 AND company_id = $2 LIMIT 1`, [id, companyId]);
  return rows[0] ? changeFrom(rows[0]) : null;
}

export async function listPlaybookChanges(db: SeoDb, companyId: string, playbookId: string, filter: { status?: PlaybookChangeStatus; limit?: number } = {}): Promise<PlaybookChange[]> {
  const params: unknown[] = [companyId, playbookId];
  let statusSql = "";
  if (filter.status) {
    params.push(filter.status);
    statusSql = `AND status = $${params.length}`;
  }
  params.push(Math.max(1, Math.min(filter.limit ?? 50, 200)));
  const rows = await db.query(
    `SELECT ${CHANGE_SELECT} FROM ${t("playbook_changes")} WHERE company_id = $1 AND playbook_id = $2 ${statusSql} ORDER BY created_at DESC LIMIT $${params.length}::int`,
    params,
  );
  return rows.map(changeFrom);
}

/** Pending changes proposed from one sprint (what its Needs you item lists). */
export async function pendingPlaybookChangesForSprint(db: SeoDb, companyId: string, sprintId: string): Promise<PlaybookChange[]> {
  const rows = await db.query(
    `SELECT ${CHANGE_SELECT} FROM ${t("playbook_changes")} WHERE company_id = $1 AND sprint_id = $2 AND status = 'pending' ORDER BY created_at LIMIT 50`,
    [companyId, sprintId],
  );
  return rows.map(changeFrom);
}

/** Decide or annotate a change. With `onlyPending`, applies only while it is still pending (the claim). */
export async function updatePlaybookChange(db: SeoDb, companyId: string, id: string, patch: PlaybookChangePatch, onlyPending: boolean): Promise<boolean> {
  const params: unknown[] = [];
  const sets: string[] = [];
  if (patch.status) {
    params.push(patch.status);
    sets.push(`status = $${params.length}`, "decided_at = now()");
  }
  if (patch.resultVersion != null) {
    params.push(patch.resultVersion);
    sets.push(`result_version = $${params.length}::int`);
  }
  if (patch.decidedBy !== undefined) {
    params.push(patch.decidedBy);
    sets.push(`decided_by = $${params.length}`);
  }
  if (patch.decisionNote !== undefined) {
    params.push(patch.decisionNote);
    sets.push(`decision_note = $${params.length}`);
  }
  if (sets.length === 0) return false;
  params.push(id, companyId);
  const result = await db.execute(
    `UPDATE ${t("playbook_changes")} SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length - 1} AND company_id = $${params.length}${onlyPending ? " AND status = 'pending'" : ""}`,
    params,
  );
  return result.rowCount > 0;
}

// ---------------------------------------------------------------------------
// Announcements: content.published once the change is live (0.8.0)
// ---------------------------------------------------------------------------

export type AnnouncementStatus = "waiting" | "sent" | "stuck" | "dropped";

export interface Announcement {
  key: string;
  companyId: string;
  sprintId: string;
  contentId: string | null;
  taskId: string | null;
  /** The merge task of an approved PR that must be done first. */
  waitTaskId: string | null;
  url: string | null;
  status: AnnouncementStatus;
  checks: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  payload: Record<string, unknown> | null;
  queuedAt: string | null;
  nextCheckAt: string | null;
  sentAt: string | null;
}

const ANNOUNCEMENT_SELECT = `key, company_id, sprint_id, content_id, task_id, wait_task_id, url, status, checks, last_http_status, last_error, payload,
  queued_at::text AS queued_at, next_check_at::text AS next_check_at, sent_at::text AS sent_at`;

const ANNOUNCEMENT_COLUMNS: Record<string, ColumnKind> = {
  wait_task_id: "text",
  url: "text",
  status: "text",
  checks: "int",
  last_http_status: "int",
  last_error: "text",
  payload: "jsonb",
  next_check_at: "ts",
  sent_at: "ts",
  updated_at: "ts",
};

function announcementFrom(row: Row): Announcement {
  const status = String(row.status ?? "waiting");
  return {
    key: String(row.key),
    companyId: String(row.company_id),
    sprintId: String(row.sprint_id),
    contentId: s(row.content_id),
    taskId: s(row.task_id),
    waitTaskId: s(row.wait_task_id),
    url: s(row.url),
    status: (["waiting", "sent", "stuck", "dropped"].includes(status) ? status : "waiting") as AnnouncementStatus,
    checks: Number(row.checks ?? 0),
    lastHttpStatus: n(row.last_http_status),
    lastError: s(row.last_error),
    payload: json<Record<string, unknown> | null>(row.payload, null),
    queuedAt: iso(row.queued_at),
    nextCheckAt: iso(row.next_check_at),
    sentAt: iso(row.sent_at),
  };
}

/**
 * Queue (or re-queue) an announcement. A key already sent stays sent; a
 * stuck or dropped one starts waiting again (the page was marked live again).
 */
export async function queueAnnouncement(db: SeoDb, a: { key: string; companyId: string; sprintId: string; contentId: string | null; taskId: string | null; waitTaskId: string | null }): Promise<void> {
  await db.execute(
    `INSERT INTO ${t("announcements")} AS a (key, company_id, sprint_id, content_id, task_id, wait_task_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (key) DO UPDATE SET
       content_id = COALESCE(EXCLUDED.content_id, a.content_id),
       task_id = COALESCE(EXCLUDED.task_id, a.task_id),
       wait_task_id = COALESCE(EXCLUDED.wait_task_id, a.wait_task_id),
       status = CASE WHEN a.status IN ('stuck', 'dropped') THEN 'waiting' ELSE a.status END,
       checks = CASE WHEN a.status IN ('stuck', 'dropped') THEN 0 ELSE a.checks END,
       queued_at = CASE WHEN a.status IN ('stuck', 'dropped') THEN now() ELSE a.queued_at END,
       next_check_at = CASE WHEN a.status = 'sent' THEN a.next_check_at ELSE now() END,
       updated_at = now()`,
    [a.key, a.companyId, a.sprintId, a.contentId, a.taskId, a.waitTaskId],
  );
}

export async function getAnnouncement(db: SeoDb, companyId: string, key: string): Promise<Announcement | null> {
  const rows = await db.query(`SELECT ${ANNOUNCEMENT_SELECT} FROM ${t("announcements")} WHERE key = $1 AND company_id = $2`, [key, companyId]);
  return rows[0] ? announcementFrom(rows[0]) : null;
}

/** Waiting (and stuck, checked daily) announcements whose next check is due. */
export async function dueAnnouncements(db: SeoDb, companyId: string, limit = 20): Promise<Announcement[]> {
  const rows = await db.query(
    `SELECT ${ANNOUNCEMENT_SELECT} FROM ${t("announcements")}
      WHERE company_id = $1 AND status IN ('waiting', 'stuck') AND next_check_at <= now() ORDER BY next_check_at LIMIT ${Math.max(1, Math.min(limit, 100))}`,
    [companyId],
  );
  return rows.map(announcementFrom);
}

/** Waiting and stuck announcements that wait for this (merge) task. */
export async function announcementsWaitingOn(db: SeoDb, companyId: string, taskId: string): Promise<Announcement[]> {
  const rows = await db.query(
    `SELECT ${ANNOUNCEMENT_SELECT} FROM ${t("announcements")} WHERE company_id = $1 AND wait_task_id = $2 AND status IN ('waiting', 'stuck')`,
    [companyId, taskId],
  );
  return rows.map(announcementFrom);
}

/** Sent in the last 24 hours: re-sent hourly (events arrive at most once; Social dedupes the key). */
export async function recentlySentAnnouncements(db: SeoDb, companyId: string, limit = 50): Promise<Announcement[]> {
  const rows = await db.query(
    `SELECT ${ANNOUNCEMENT_SELECT} FROM ${t("announcements")}
      WHERE company_id = $1 AND status = 'sent' AND sent_at >= now() - interval '24 hours' ORDER BY sent_at LIMIT ${Math.max(1, Math.min(limit, 100))}`,
    [companyId],
  );
  return rows.map(announcementFrom);
}

/** Waiting and stuck announcements, for `today` and the Cockpit (one sprint, or the whole company). */
export async function openAnnouncements(db: SeoDb, companyId: string, sprintId?: string): Promise<Announcement[]> {
  const rows = await db.query(
    `SELECT ${ANNOUNCEMENT_SELECT} FROM ${t("announcements")}
      WHERE company_id = $1 AND status IN ('waiting', 'stuck')${sprintId ? " AND sprint_id = $2" : ""} ORDER BY queued_at LIMIT 50`,
    sprintId ? [companyId, sprintId] : [companyId],
  );
  return rows.map(announcementFrom);
}

export async function updateAnnouncement(db: SeoDb, companyId: string, key: string, patch: Record<string, unknown>): Promise<number> {
  return patchRow(db, "announcements", ANNOUNCEMENT_COLUMNS, { companyId, id: key, idColumn: "key" }, patch);
}

// ---------------------------------------------------------------------------
// GEO (AI search): audits and sampled AI answers
// ---------------------------------------------------------------------------

export interface GeoAuditRow {
  id: string;
  sprintId: string;
  auditedOn: string;
  auditedAt: string | null;
  score: number;
  band: string;
  complete: boolean;
  breakdown: Record<string, unknown>;
  sections: Record<string, unknown>;
  findingCount: number;
  source: string;
}

function geoAuditFrom(row: Row): GeoAuditRow {
  return {
    id: String(row.id),
    sprintId: String(row.sprint_id),
    auditedOn: s(row.audited_on)?.slice(0, 10) ?? "",
    auditedAt: iso(row.audited_at),
    score: Number(row.score ?? 0),
    band: String(row.band ?? "weak"),
    complete: row.complete === true || row.complete === "t" || row.complete === "true",
    breakdown: json(row.breakdown, {}),
    sections: json(row.sections, {}),
    findingCount: Number(row.finding_count ?? 0),
    source: String(row.source ?? "tool"),
  };
}

const GEO_AUDIT_SELECT = "id, sprint_id, audited_on::text AS audited_on, audited_at, score, band, complete, breakdown, sections, finding_count, source";

export async function insertGeoAudit(db: SeoDb, a: {
  id: string;
  companyId: string;
  sprintId: string;
  auditedOn: string;
  score: number;
  band: string;
  complete: boolean;
  breakdown: unknown;
  sections: unknown;
  findingCount: number;
  source: "tool" | "snapshot" | "scheduled";
}): Promise<void> {
  await db.execute(
    `INSERT INTO ${t("geo_audits")} (id, company_id, sprint_id, audited_on, score, band, complete, breakdown, sections, finding_count, source)
     VALUES ($1, $2, $3, $4::date, $5::int, $6, $7::boolean, $8::jsonb, $9::jsonb, $10::int, $11)`,
    [a.id, a.companyId, a.sprintId, a.auditedOn, a.score, a.band, a.complete, jsonParam(a.breakdown), jsonParam(a.sections), a.findingCount, a.source],
  );
}

/** The newest geo-audits of a sprint, newest first. */
export async function listGeoAudits(db: SeoDb, companyId: string, sprintId: string, limit = 12): Promise<GeoAuditRow[]> {
  const rows = await db.query(
    `SELECT ${GEO_AUDIT_SELECT} FROM ${t("geo_audits")} WHERE company_id = $1 AND sprint_id = $2 ORDER BY audited_at DESC LIMIT $3::int`,
    [companyId, sprintId, Math.min(Math.max(limit, 1), 100)],
  );
  return rows.map(geoAuditFrom);
}

export async function latestGeoAudit(db: SeoDb, companyId: string, sprintId: string): Promise<GeoAuditRow | null> {
  return (await listGeoAudits(db, companyId, sprintId, 1))[0] ?? null;
}

export interface AiMentionRow {
  id: string;
  sprintId: string;
  query: string;
  engine: string;
  sampledOn: string;
  mentioned: boolean;
  cited: boolean;
  position: number | null;
  citedUrls: string[];
  competitors: string[];
  evidence: string | null;
  note: string | null;
  method: string | null;
  recordedBy: string | null;
}

function mentionFrom(row: Row): AiMentionRow {
  return {
    id: String(row.id),
    sprintId: String(row.sprint_id),
    query: String(row.query),
    engine: String(row.engine),
    sampledOn: s(row.sampled_on)?.slice(0, 10) ?? "",
    mentioned: row.mentioned === true || row.mentioned === "t" || row.mentioned === "true",
    cited: row.cited === true || row.cited === "t" || row.cited === "true",
    position: n(row.position),
    citedUrls: strList(row.cited_urls),
    competitors: strList(row.competitors),
    evidence: s(row.evidence),
    note: s(row.note),
    method: s(row.method),
    recordedBy: s(row.recorded_by),
  };
}

const MENTION_SELECT = "id, sprint_id, query, engine, sampled_on::text AS sampled_on, mentioned, cited, position, cited_urls, competitors, evidence, note, method, recorded_by";

/** Record one sampled answer; the same question on the same assistant on the same day is replaced. */
export async function upsertMention(db: SeoDb, m: {
  id: string;
  companyId: string;
  sprintId: string;
  query: string;
  queryKey: string;
  engine: string;
  sampledOn: string;
  mentioned: boolean;
  cited: boolean;
  position: number | null;
  citedUrls: string[];
  competitors: string[];
  evidence: string | null;
  note: string | null;
  method: string | null;
  recordedBy: string | null;
}): Promise<void> {
  await db.execute(
    `INSERT INTO ${t("ai_mentions")} (id, company_id, sprint_id, query, query_key, engine, sampled_on, mentioned, cited, position, cited_urls, competitors, evidence, note, method, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::boolean, $9::boolean, $10::int, $11::jsonb, $12::jsonb, $13, $14, $15, $16)
     ON CONFLICT (sprint_id, query_key, engine, sampled_on) DO UPDATE SET
       query = EXCLUDED.query, mentioned = EXCLUDED.mentioned, cited = EXCLUDED.cited, position = EXCLUDED.position,
       cited_urls = EXCLUDED.cited_urls, competitors = EXCLUDED.competitors, evidence = EXCLUDED.evidence, note = EXCLUDED.note,
       method = EXCLUDED.method, recorded_by = EXCLUDED.recorded_by`,
    [m.id, m.companyId, m.sprintId, m.query, m.queryKey, m.engine, m.sampledOn, m.mentioned, m.cited, m.position, jsonParam(m.citedUrls), jsonParam(m.competitors), m.evidence, m.note, m.method, m.recordedBy],
  );
}

/** Every sampled answer of a sprint (newest first), at most `limit`. */
export async function listMentions(db: SeoDb, companyId: string, sprintId: string, limit = 500): Promise<AiMentionRow[]> {
  const rows = await db.query(
    `SELECT ${MENTION_SELECT} FROM ${t("ai_mentions")} WHERE company_id = $1 AND sprint_id = $2 ORDER BY sampled_on DESC, created_at DESC LIMIT $3::int`,
    [companyId, sprintId, Math.min(Math.max(limit, 1), 1000)],
  );
  return rows.map(mentionFrom);
}

// ---------------------------------------------------------------------------
// GA4 weekly numbers
// ---------------------------------------------------------------------------

export interface Ga4WeekRow {
  weekStart: string;
  propertyId: string;
  sessions: number;
  engagedSessions: number;
  users: number;
  keyEvents: number;
  organic: { sessions: number; engagedSessions: number; users: number; keyEvents: number };
  channels: Array<{ channel: string; sessions: number; engagedSessions: number; keyEvents: number }>;
  landingPages: Array<{ path: string; sessions: number; engagedSessions: number; keyEvents: number }>;
  sources: Array<{ source: string; sessions: number; engagedSessions: number; keyEvents: number }>;
  keyEventNames: Array<{ name: string; count: number }>;
  aiReferrals: Array<{ assistant: string; sessions: number; keyEvents: number }>;
  pulledAt: string | null;
}

function ga4WeekFrom(row: Row): Ga4WeekRow {
  return {
    weekStart: s(row.week_start)?.slice(0, 10) ?? "",
    propertyId: String(row.property_id ?? ""),
    sessions: Number(row.sessions ?? 0),
    engagedSessions: Number(row.engaged_sessions ?? 0),
    users: Number(row.users ?? 0),
    keyEvents: Number(row.key_events ?? 0),
    organic: {
      sessions: Number(row.organic_sessions ?? 0),
      engagedSessions: Number(row.organic_engaged_sessions ?? 0),
      users: Number(row.organic_users ?? 0),
      keyEvents: Number(row.organic_key_events ?? 0),
    },
    channels: json(row.channels, []),
    landingPages: json(row.landing_pages, []),
    sources: json(row.sources, []),
    keyEventNames: json(row.key_event_names, []),
    aiReferrals: json(row.ai_referrals, []),
    pulledAt: iso(row.pulled_at),
  };
}

const GA4_SELECT = `week_start::text AS week_start, property_id, sessions, engaged_sessions, users, key_events, organic_sessions, organic_engaged_sessions,
  organic_users, organic_key_events, channels, landing_pages, sources, key_event_names, ai_referrals, pulled_at`;

export async function upsertGa4Week(db: SeoDb, row: Omit<Ga4WeekRow, "pulledAt"> & { id: string; companyId: string; sprintId: string }): Promise<void> {
  await db.execute(
    `INSERT INTO ${t("analytics_weeks")} (id, company_id, sprint_id, week_start, property_id, sessions, engaged_sessions, users, key_events,
       organic_sessions, organic_engaged_sessions, organic_users, organic_key_events, channels, landing_pages, sources, key_event_names, ai_referrals)
     VALUES ($1, $2, $3, $4::date, $5, $6::int, $7::int, $8::int, $9::int, $10::int, $11::int, $12::int, $13::int, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb)
     ON CONFLICT (sprint_id, week_start) DO UPDATE SET
       property_id = EXCLUDED.property_id, sessions = EXCLUDED.sessions, engaged_sessions = EXCLUDED.engaged_sessions, users = EXCLUDED.users,
       key_events = EXCLUDED.key_events, organic_sessions = EXCLUDED.organic_sessions, organic_engaged_sessions = EXCLUDED.organic_engaged_sessions,
       organic_users = EXCLUDED.organic_users, organic_key_events = EXCLUDED.organic_key_events, channels = EXCLUDED.channels,
       landing_pages = EXCLUDED.landing_pages, sources = EXCLUDED.sources, key_event_names = EXCLUDED.key_event_names,
       ai_referrals = EXCLUDED.ai_referrals, pulled_at = now()`,
    [
      row.id, row.companyId, row.sprintId, row.weekStart, row.propertyId, row.sessions, row.engagedSessions, row.users, row.keyEvents,
      row.organic.sessions, row.organic.engagedSessions, row.organic.users, row.organic.keyEvents,
      jsonParam(row.channels), jsonParam(row.landingPages), jsonParam(row.sources), jsonParam(row.keyEventNames), jsonParam(row.aiReferrals),
    ],
  );
}

/** The newest weeks of a sprint (ascending by week), at most `limit`. */
export async function listGa4Weeks(db: SeoDb, companyId: string, sprintId: string, limit = 26): Promise<Ga4WeekRow[]> {
  const rows = await db.query(
    `SELECT ${GA4_SELECT} FROM ${t("analytics_weeks")} WHERE company_id = $1 AND sprint_id = $2 ORDER BY week_start DESC LIMIT $3::int`,
    [companyId, sprintId, Math.min(Math.max(limit, 1), 104)],
  );
  return rows.map(ga4WeekFrom).reverse();
}

// ---------------------------------------------------------------------------
// Page groups (chunks of a site-wide task)
// ---------------------------------------------------------------------------

export type ChunkStatusValue = "queued" | "open" | "done" | "cancelled";

export interface TaskChunk {
  id: string;
  companyId: string;
  sprintId: string;
  taskId: string;
  parentIssueId: string;
  seq: number;
  total: number;
  label: string;
  urls: string[];
  status: ChunkStatusValue;
  issueId: string | null;
  issueIdentifier: string | null;
  openedAt: string | null;
  doneAt: string | null;
}

function chunkFrom(row: Row): TaskChunk {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    sprintId: String(row.sprint_id),
    taskId: String(row.task_id),
    parentIssueId: String(row.parent_issue_id),
    seq: Number(row.seq ?? 0),
    total: Number(row.total ?? 0),
    label: String(row.label ?? ""),
    urls: strList(row.urls),
    status: String(row.status ?? "queued") as ChunkStatusValue,
    issueId: s(row.issue_id),
    issueIdentifier: s(row.issue_identifier),
    openedAt: iso(row.opened_at),
    doneAt: iso(row.done_at),
  };
}

const CHUNK_SELECT = "id, company_id, sprint_id, task_id, parent_issue_id, seq, total, label, urls, status, issue_id, issue_identifier, opened_at, done_at";

const CHUNK_COLUMNS: Record<string, ColumnKind> = {
  status: "text",
  issue_id: "text",
  issue_identifier: "text",
  opened_at: "ts",
  done_at: "ts",
  updated_at: "ts",
};

export async function insertChunks(db: SeoDb, chunks: Array<{ id: string; companyId: string; sprintId: string; taskId: string; parentIssueId: string; seq: number; total: number; label: string; urls: string[] }>): Promise<number> {
  if (chunks.length === 0) return 0;
  const params: unknown[] = [];
  const values: string[] = [];
  for (const c of chunks) {
    const base = params.length;
    params.push(c.id, c.companyId, c.sprintId, c.taskId, c.parentIssueId, c.seq, c.total, c.label, jsonParam(c.urls));
    const p = (i: number) => `$${base + i}`;
    values.push(`(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}::int, ${p(7)}::int, ${p(8)}, ${p(9)}::jsonb)`);
  }
  const result = await db.execute(
    `INSERT INTO ${t("task_chunks")} (id, company_id, sprint_id, task_id, parent_issue_id, seq, total, label, urls)
     VALUES ${values.join(", ")} ON CONFLICT (parent_issue_id, seq) DO NOTHING`,
    params,
  );
  return result.rowCount;
}

/** The groups of one task (every parent issue it has had), in order. */
export async function listChunks(db: SeoDb, companyId: string, taskId: string): Promise<TaskChunk[]> {
  const rows = await db.query(
    `SELECT ${CHUNK_SELECT} FROM ${t("task_chunks")} WHERE company_id = $1 AND task_id = $2 ORDER BY created_at, seq`,
    [companyId, taskId],
  );
  return rows.map(chunkFrom);
}

/** Groups of every task of a sprint that is still unfinished (queued or open): what `today` reports. */
export async function unfinishedChunks(db: SeoDb, companyId: string, sprintId: string): Promise<TaskChunk[]> {
  const rows = await db.query(
    `SELECT ${CHUNK_SELECT} FROM ${t("task_chunks")} WHERE company_id = $1 AND sprint_id = $2 AND status IN ('queued', 'open') ORDER BY task_id, seq`,
    [companyId, sprintId],
  );
  return rows.map(chunkFrom);
}

export async function getChunk(db: SeoDb, companyId: string, id: string): Promise<TaskChunk | null> {
  const rows = await db.query(`SELECT ${CHUNK_SELECT} FROM ${t("task_chunks")} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return rows[0] ? chunkFrom(rows[0]) : null;
}

/** The task's issue was replaced by a continuation issue: its groups follow it (finished ones too, so the progress stays whole). */
export async function repointChunks(db: SeoDb, companyId: string, fromIssueId: string, toIssueId: string): Promise<number> {
  const result = await db.execute(`UPDATE ${t("task_chunks")} SET parent_issue_id = $3, updated_at = now() WHERE company_id = $1 AND parent_issue_id = $2`, [companyId, fromIssueId, toIssueId]);
  return result.rowCount;
}

export async function getChunkByIssue(db: SeoDb, companyId: string, issueId: string): Promise<TaskChunk | null> {
  const rows = await db.query(`SELECT ${CHUNK_SELECT} FROM ${t("task_chunks")} WHERE company_id = $1 AND issue_id = $2 LIMIT 1`, [companyId, issueId]);
  return rows[0] ? chunkFrom(rows[0]) : null;
}

/** Open groups of a company (their issues are re-read by the daily heal, in case an event was missed). */
export async function openChunks(db: SeoDb, companyId: string, limit = 100): Promise<TaskChunk[]> {
  const rows = await db.query(
    `SELECT ${CHUNK_SELECT} FROM ${t("task_chunks")} WHERE company_id = $1 AND status = 'open' ORDER BY opened_at LIMIT $2::int`,
    [companyId, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map(chunkFrom);
}

/** Tasks that have a queued group and no open one: the next group is due to open. */
export async function tasksWithIdleChunks(db: SeoDb, companyId: string): Promise<string[]> {
  const rows = await db.query(
    `SELECT DISTINCT q.task_id FROM ${t("task_chunks")} q
      WHERE q.company_id = $1 AND q.status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM ${t("task_chunks")} o WHERE o.task_id = q.task_id AND o.parent_issue_id = q.parent_issue_id AND o.status = 'open')
      LIMIT 50`,
    [companyId],
  );
  return rows.map((r) => String(r.task_id));
}

export async function updateChunk(db: SeoDb, companyId: string, id: string, patch: Record<string, unknown>): Promise<number> {
  return patchRow(db, "task_chunks", CHUNK_COLUMNS, { companyId, id }, patch);
}

/** Claim a queued group before its issue is created, so two runs never open it twice. */
export async function claimChunk(db: SeoDb, companyId: string, id: string): Promise<boolean> {
  const result = await db.execute(
    `UPDATE ${t("task_chunks")} SET status = 'open', opened_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 AND status = 'queued'`,
    [id, companyId],
  );
  return result.rowCount > 0;
}

export async function releaseChunk(db: SeoDb, companyId: string, id: string): Promise<void> {
  await db.execute(
    `UPDATE ${t("task_chunks")} SET status = 'queued', opened_at = NULL, updated_at = now() WHERE id = $1 AND company_id = $2 AND status = 'open' AND issue_id IS NULL`,
    [id, companyId],
  );
}

// ---------------------------------------------------------------------------
// Switches for the 0.23.0 extras (engine/switches.ts): what a company's new sprints start with, and the trail of changes
// ---------------------------------------------------------------------------

export type SwitchFeatureKey = "geo" | "ga4" | "chunks";

export interface CompanySwitches {
  geo: boolean;
  ga4: boolean;
  chunks: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** What a company's NEW sprints start with. No row: everything off. */
export async function getCompanySwitches(db: SeoDb, companyId: string): Promise<CompanySwitches> {
  const rows = await db.query(
    `SELECT geo_default, ga4_default, chunks_default, updated_by, updated_at FROM ${t("company_switches")} WHERE company_id = $1 LIMIT 1`,
    [companyId],
  );
  const row = rows[0];
  return {
    geo: flag(row?.geo_default),
    ga4: flag(row?.ga4_default),
    chunks: flag(row?.chunks_default),
    updatedBy: s(row?.updated_by),
    updatedAt: iso(row?.updated_at),
  };
}

const DEFAULT_COLUMN: Record<SwitchFeatureKey, string> = { geo: "geo_default", ga4: "ga4_default", chunks: "chunks_default" };

export async function setCompanySwitch(db: SeoDb, companyId: string, feature: SwitchFeatureKey, enabled: boolean, by: string): Promise<void> {
  const column = DEFAULT_COLUMN[feature];
  await db.execute(
    `INSERT INTO ${t("company_switches")} (company_id, ${column}, updated_by) VALUES ($1, $2::boolean, $3)
     ON CONFLICT (company_id) DO UPDATE SET ${column} = EXCLUDED.${column}, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [companyId, enabled, by],
  );
}

export interface SwitchLogRow {
  id: string;
  sprintId: string | null;
  feature: SwitchFeatureKey;
  scope: "sprint" | "company";
  enabled: boolean;
  changedBy: string;
  effect: Record<string, unknown>;
  createdAt: string | null;
}

function switchLogFrom(row: Row): SwitchLogRow {
  return {
    id: String(row.id),
    sprintId: s(row.sprint_id),
    feature: String(row.feature) as SwitchFeatureKey,
    scope: String(row.scope) === "company" ? "company" : "sprint",
    enabled: flag(row.enabled),
    changedBy: String(row.changed_by ?? ""),
    effect: json<Record<string, unknown>>(row.effect, {}),
    createdAt: iso(row.created_at),
  };
}

export async function insertSwitchLog(db: SeoDb, row: { id: string; companyId: string; sprintId: string | null; feature: SwitchFeatureKey; scope: "sprint" | "company"; enabled: boolean; changedBy: string; effect: Record<string, unknown> }): Promise<void> {
  await db.execute(
    `INSERT INTO ${t("switch_log")} (id, company_id, sprint_id, feature, scope, enabled, changed_by, effect) VALUES ($1, $2, $3, $4, $5, $6::boolean, $7, $8::jsonb)`,
    [row.id, row.companyId, row.sprintId, row.feature, row.scope, row.enabled, row.changedBy, jsonParam(row.effect)],
  );
}

/** The latest change per extra for one sprint (sprintId) or for the company's defaults (null): who, when, and what it did. */
export async function latestSwitchChanges(db: SeoDb, companyId: string, sprintId: string | null): Promise<SwitchLogRow[]> {
  const rows = await db.query(
    sprintId
      ? `SELECT DISTINCT ON (feature) id, sprint_id, feature, scope, enabled, changed_by, effect, created_at FROM ${t("switch_log")}
          WHERE company_id = $1 AND sprint_id = $2 ORDER BY feature, created_at DESC`
      : `SELECT DISTINCT ON (feature) id, sprint_id, feature, scope, enabled, changed_by, effect, created_at FROM ${t("switch_log")}
          WHERE company_id = $1 AND scope = 'company' ORDER BY feature, created_at DESC`,
    sprintId ? [companyId, sprintId] : [companyId],
  );
  return rows.map(switchLogFrom);
}
