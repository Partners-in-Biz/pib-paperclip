import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BootstrapOptions, BootstrapRunState, OwnerGrant, RunStatus, StepId, StepRecord } from "./bootstrap.js";
import type { ModuleKey, SetupStatus } from "./kit-setup.js";
import { NAMESPACE } from "./namespace.js";

const T = {
  choices: `${NAMESPACE}.module_choices`,
  statuses: `${NAMESPACE}.statuses`,
  issues: `${NAMESPACE}.finish_issues`,
  runs: `${NAMESPACE}.bootstrap_runs`,
  hires: `${NAMESPACE}.template_hires`,
  approvals: `${NAMESPACE}.starter_pack_approvals`,
  imports: `${NAMESPACE}.starter_pack_imports`,
};

export interface ChoiceRow {
  companyId: string;
  modules: Partial<Record<ModuleKey, boolean>>;
  updatedAt: string;
  updatedBy: string | null;
}

export interface StatusRow {
  companyId: string;
  pluginKey: string;
  status: SetupStatus;
  checkedAt: string;
  receivedAt: string;
}

export interface FinishIssueRow {
  companyId: string;
  issueId: string;
  fingerprint: string;
  missingCount: number;
}

type Raw = Record<string, unknown>;

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

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value == null ? "" : String(value);
}

function toChoice(row: Raw): ChoiceRow {
  return {
    companyId: String(row.company_id),
    modules: json(row.modules, {}),
    updatedAt: iso(row.updated_at),
    updatedBy: row.updated_by == null ? null : String(row.updated_by),
  };
}

export async function getChoice(ctx: PluginContext, companyId: string): Promise<ChoiceRow | null> {
  const rows = await ctx.db.query<Raw>(`SELECT company_id, modules, updated_at, updated_by FROM ${T.choices} WHERE company_id = $1`, [companyId]);
  return rows[0] ? toChoice(rows[0]) : null;
}

export async function listChoices(ctx: PluginContext): Promise<ChoiceRow[]> {
  const rows = await ctx.db.query<Raw>(`SELECT company_id, modules, updated_at, updated_by FROM ${T.choices} ORDER BY company_id`);
  return rows.map(toChoice);
}

export async function saveChoice(ctx: PluginContext, row: ChoiceRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.choices} (company_id, modules, updated_at, updated_by) VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (company_id) DO UPDATE SET modules = EXCLUDED.modules, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [row.companyId, JSON.stringify(row.modules), row.updatedAt, row.updatedBy],
  );
}

/** Keeps the newest status per (company, plugin): an older `checkedAt` never replaces a newer one. */
export async function upsertStatus(ctx: PluginContext, row: StatusRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.statuses} (company_id, plugin_key, status, checked_at, received_at) VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (company_id, plugin_key) DO UPDATE SET status = EXCLUDED.status, checked_at = EXCLUDED.checked_at, received_at = EXCLUDED.received_at
     WHERE ${T.statuses}.checked_at <= EXCLUDED.checked_at`,
    [row.companyId, row.pluginKey, JSON.stringify(row.status), row.checkedAt, row.receivedAt],
  );
}

export async function listStatuses(ctx: PluginContext, companyId: string): Promise<StatusRow[]> {
  const rows = await ctx.db.query<Raw>(
    `SELECT company_id, plugin_key, status, checked_at, received_at FROM ${T.statuses} WHERE company_id = $1 ORDER BY plugin_key`,
    [companyId],
  );
  return rows.map((row) => ({
    companyId: String(row.company_id),
    pluginKey: String(row.plugin_key),
    status: json(row.status, null as unknown as SetupStatus),
    checkedAt: iso(row.checked_at),
    receivedAt: iso(row.received_at),
  })).filter((row) => row.status && Array.isArray(row.status.items));
}

export async function getFinishIssue(ctx: PluginContext, companyId: string): Promise<FinishIssueRow | null> {
  const rows = await ctx.db.query<Raw>(`SELECT company_id, issue_id, fingerprint, missing_count FROM ${T.issues} WHERE company_id = $1`, [companyId]);
  const row = rows[0];
  if (!row) return null;
  return { companyId: String(row.company_id), issueId: String(row.issue_id), fingerprint: String(row.fingerprint ?? ""), missingCount: Number(row.missing_count ?? 0) };
}

export async function saveFinishIssue(ctx: PluginContext, row: FinishIssueRow, now: string): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.issues} (company_id, issue_id, fingerprint, missing_count, updated_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (company_id) DO UPDATE SET issue_id = EXCLUDED.issue_id, fingerprint = EXCLUDED.fingerprint, missing_count = EXCLUDED.missing_count, updated_at = EXCLUDED.updated_at`,
    [row.companyId, row.issueId, row.fingerprint, row.missingCount, now],
  );
}

export async function clearFinishIssue(ctx: PluginContext, companyId: string): Promise<void> {
  await ctx.db.execute(`DELETE FROM ${T.issues} WHERE company_id = $1`, [companyId]);
}

// ---------------------------------------------------------------------------
// Bootstrap runs, template hires, starter pack approvals (migration 002)
// ---------------------------------------------------------------------------

const RUN_COLUMNS = "company_id, status, options, steps, grants, source, started_by, created_at, updated_at, completed_at";

function toRun(row: Raw): BootstrapRunState {
  return {
    companyId: String(row.company_id),
    status: String(row.status ?? "created") as RunStatus,
    options: json<BootstrapOptions>(row.options, {}),
    steps: json<Partial<Record<StepId, StepRecord>>>(row.steps, {}),
    grants: json<OwnerGrant[]>(row.grants, []),
    source: String(row.source ?? ""),
    startedBy: row.started_by == null ? null : String(row.started_by),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at == null ? null : iso(row.completed_at),
  };
}

export async function getRun(ctx: PluginContext, companyId: string): Promise<BootstrapRunState | null> {
  const rows = await ctx.db.query<Raw>(`SELECT ${RUN_COLUMNS} FROM ${T.runs} WHERE company_id = $1`, [companyId]);
  return rows[0] ? toRun(rows[0]) : null;
}

/** Remembers that a company exists and has not been bootstrapped; never changes an existing row. */
export async function ensureRun(ctx: PluginContext, input: { companyId: string; source: string; now: string }): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.runs} (company_id, status, options, steps, grants, source, created_at, updated_at) VALUES ($1, 'created', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, $2, $3, $3)
     ON CONFLICT (company_id) DO NOTHING`,
    [input.companyId, input.source, input.now],
  );
}

export async function saveRun(ctx: PluginContext, run: BootstrapRunState): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.runs} (company_id, status, options, steps, grants, source, started_by, created_at, updated_at, completed_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)
     ON CONFLICT (company_id) DO UPDATE SET status = EXCLUDED.status, options = EXCLUDED.options, steps = EXCLUDED.steps, grants = EXCLUDED.grants,
       source = EXCLUDED.source, started_by = EXCLUDED.started_by, updated_at = EXCLUDED.updated_at, completed_at = EXCLUDED.completed_at`,
    [run.companyId, run.status, JSON.stringify(run.options), JSON.stringify(run.steps), JSON.stringify(run.grants), run.source, run.startedBy, run.createdAt, run.updatedAt, run.completedAt],
  );
}

export interface TemplateHireRow {
  companyId: string;
  templateKey: string;
  packVersion: number;
  issueId: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  status: string;
  createdAt: string;
}

function toHire(row: Raw): TemplateHireRow {
  return {
    companyId: String(row.company_id),
    templateKey: String(row.template_key),
    packVersion: Number(row.pack_version ?? 0),
    issueId: String(row.issue_id),
    assigneeAgentId: row.assignee_agent_id == null ? null : String(row.assignee_agent_id),
    assigneeUserId: row.assignee_user_id == null ? null : String(row.assignee_user_id),
    status: String(row.status ?? "open"),
    createdAt: iso(row.created_at),
  };
}

export async function listTemplateHires(ctx: PluginContext, companyId: string): Promise<TemplateHireRow[]> {
  const rows = await ctx.db.query<Raw>(
    `SELECT company_id, template_key, pack_version, issue_id, assignee_agent_id, assignee_user_id, status, created_at FROM ${T.hires} WHERE company_id = $1 ORDER BY template_key`,
    [companyId],
  );
  return rows.map(toHire);
}

export async function saveTemplateHire(ctx: PluginContext, row: TemplateHireRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.hires} (company_id, template_key, pack_version, issue_id, assignee_agent_id, assignee_user_id, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (company_id, template_key) DO UPDATE SET pack_version = EXCLUDED.pack_version, issue_id = EXCLUDED.issue_id, assignee_agent_id = EXCLUDED.assignee_agent_id,
       assignee_user_id = EXCLUDED.assignee_user_id, status = EXCLUDED.status, created_at = EXCLUDED.created_at`,
    [row.companyId, row.templateKey, row.packVersion, row.issueId, row.assigneeAgentId, row.assigneeUserId, row.status, row.createdAt],
  );
}

export interface StarterApprovalRow {
  packVersion: number;
  contentHash: string;
  approvedBy: string;
  approvedAt: string;
}

export async function getStarterApproval(ctx: PluginContext, packVersion: number, contentHash: string): Promise<StarterApprovalRow | null> {
  const rows = await ctx.db.query<Raw>(
    `SELECT pack_version, content_hash, approved_by, approved_at FROM ${T.approvals} WHERE pack_version = $1 AND content_hash = $2`,
    [packVersion, contentHash],
  );
  const row = rows[0];
  return row ? { packVersion: Number(row.pack_version), contentHash: String(row.content_hash), approvedBy: String(row.approved_by), approvedAt: iso(row.approved_at) } : null;
}

export async function saveStarterApproval(ctx: PluginContext, row: StarterApprovalRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.approvals} (pack_version, content_hash, approved_by, approved_at) VALUES ($1, $2, $3, $4) ON CONFLICT (pack_version, content_hash) DO NOTHING`,
    [row.packVersion, row.contentHash, row.approvedBy, row.approvedAt],
  );
}

export interface StarterImportRow {
  companyId: string;
  packVersion: number;
  contentHash: string;
  result: Record<string, unknown>;
  importedBy: string | null;
  importedAt: string;
}

export async function getStarterImport(ctx: PluginContext, companyId: string, packVersion: number, contentHash: string): Promise<StarterImportRow | null> {
  const rows = await ctx.db.query<Raw>(
    `SELECT company_id, pack_version, content_hash, result, imported_by, imported_at FROM ${T.imports} WHERE company_id = $1 AND pack_version = $2 AND content_hash = $3`,
    [companyId, packVersion, contentHash],
  );
  const row = rows[0];
  return row
    ? { companyId: String(row.company_id), packVersion: Number(row.pack_version), contentHash: String(row.content_hash), result: json<Record<string, unknown>>(row.result, {}), importedBy: row.imported_by == null ? null : String(row.imported_by), importedAt: iso(row.imported_at) }
    : null;
}

export async function saveStarterImport(ctx: PluginContext, row: StarterImportRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.imports} (company_id, pack_version, content_hash, result, imported_by, imported_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (company_id, pack_version, content_hash) DO UPDATE SET result = EXCLUDED.result, imported_by = EXCLUDED.imported_by, imported_at = EXCLUDED.imported_at`,
    [row.companyId, row.packVersion, row.contentHash, JSON.stringify(row.result), row.importedBy, row.importedAt],
  );
}
