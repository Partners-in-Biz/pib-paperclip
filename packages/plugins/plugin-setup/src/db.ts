import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ModuleKey, SetupStatus } from "./kit-setup.js";
import { NAMESPACE } from "./namespace.js";

const T = {
  choices: `${NAMESPACE}.module_choices`,
  statuses: `${NAMESPACE}.statuses`,
  issues: `${NAMESPACE}.finish_issues`,
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
