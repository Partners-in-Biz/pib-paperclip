/**
 * Cockpit tables. Every write is one statement (host SQL guard).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "./namespace.js";

const T = {
  snapshots: `${NAMESPACE}.snapshots`,
  roles: `${NAMESPACE}.roles`,
  health: `${NAMESPACE}.health_issues`,
  brief: `${NAMESPACE}.brief_issues`,
};

export type SnapshotKind = "cockpit" | "setup";

export interface SnapshotRow {
  companyId: string;
  pluginKey: string;
  kind: SnapshotKind;
  payload: unknown;
  checkedAt: string;
  receivedAt: string;
}

export interface RolesRow {
  companyId: string;
  operatorAgentId: string | null;
  reviewerAgentId: string | null;
  ownerUserId: string | null;
  reviewOutward: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface HealthIssueRow {
  companyId: string;
  issueId: string;
  fingerprint: string;
  problemKeys: string[];
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

function text(value: unknown): string | null {
  return value == null || value === "" ? null : String(value);
}

// ---------------------------------------------------------------------------
// Snapshots (projection)
// ---------------------------------------------------------------------------

/** Keeps the newest report per (company, plugin, kind): an older `checkedAt` never replaces a newer one. */
export async function upsertSnapshot(ctx: PluginContext, row: SnapshotRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.snapshots} (company_id, plugin_key, kind, payload, checked_at, received_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (company_id, plugin_key, kind) DO UPDATE SET payload = EXCLUDED.payload, checked_at = EXCLUDED.checked_at, received_at = EXCLUDED.received_at
     WHERE ${T.snapshots}.checked_at <= EXCLUDED.checked_at`,
    [row.companyId, row.pluginKey, row.kind, JSON.stringify(row.payload), row.checkedAt, row.receivedAt],
  );
}

export async function listSnapshots(ctx: PluginContext, companyId: string, kind: SnapshotKind): Promise<SnapshotRow[]> {
  const rows = await ctx.db.query<Raw>(
    `SELECT company_id, plugin_key, kind, payload, checked_at, received_at FROM ${T.snapshots} WHERE company_id = $1 AND kind = $2 ORDER BY plugin_key`,
    [companyId, kind],
  );
  return rows.map((row) => ({
    companyId: String(row.company_id),
    pluginKey: String(row.plugin_key),
    kind: String(row.kind) as SnapshotKind,
    payload: json(row.payload, null),
    checkedAt: iso(row.checked_at),
    receivedAt: iso(row.received_at),
  }));
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function toRoles(row: Raw): RolesRow {
  return {
    companyId: String(row.company_id),
    operatorAgentId: text(row.operator_agent_id),
    reviewerAgentId: text(row.reviewer_agent_id),
    ownerUserId: text(row.owner_user_id),
    reviewOutward: row.review_outward === true || row.review_outward === "true",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    updatedBy: text(row.updated_by),
  };
}

const ROLE_COLUMNS = "company_id, operator_agent_id, reviewer_agent_id, owner_user_id, review_outward, created_at, updated_at, updated_by";

export async function getRoles(ctx: PluginContext, companyId: string): Promise<RolesRow | null> {
  const rows = await ctx.db.query<Raw>(`SELECT ${ROLE_COLUMNS} FROM ${T.roles} WHERE company_id = $1`, [companyId]);
  return rows[0] ? toRoles(rows[0]) : null;
}

export async function listRoles(ctx: PluginContext): Promise<RolesRow[]> {
  const rows = await ctx.db.query<Raw>(`SELECT ${ROLE_COLUMNS} FROM ${T.roles} ORDER BY company_id`);
  return rows.map(toRoles);
}

export async function saveRoles(ctx: PluginContext, row: RolesRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.roles} (${ROLE_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (company_id) DO UPDATE SET operator_agent_id = EXCLUDED.operator_agent_id, reviewer_agent_id = EXCLUDED.reviewer_agent_id,
       owner_user_id = EXCLUDED.owner_user_id, review_outward = EXCLUDED.review_outward, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
    [row.companyId, row.operatorAgentId, row.reviewerAgentId, row.ownerUserId, row.reviewOutward, row.createdAt, row.updatedAt, row.updatedBy],
  );
}

// ---------------------------------------------------------------------------
// System health issue
// ---------------------------------------------------------------------------

export async function getHealthIssue(ctx: PluginContext, companyId: string): Promise<HealthIssueRow | null> {
  const rows = await ctx.db.query<Raw>(`SELECT company_id, issue_id, fingerprint, problem_keys FROM ${T.health} WHERE company_id = $1`, [companyId]);
  const row = rows[0];
  if (!row) return null;
  return { companyId: String(row.company_id), issueId: String(row.issue_id), fingerprint: String(row.fingerprint ?? ""), problemKeys: json(row.problem_keys, [] as string[]) };
}

export async function saveHealthIssue(ctx: PluginContext, row: HealthIssueRow, now: string): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.health} (company_id, issue_id, fingerprint, problem_keys, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (company_id) DO UPDATE SET issue_id = EXCLUDED.issue_id, fingerprint = EXCLUDED.fingerprint, problem_keys = EXCLUDED.problem_keys, updated_at = EXCLUDED.updated_at`,
    [row.companyId, row.issueId, row.fingerprint, JSON.stringify(row.problemKeys), now],
  );
}

export async function clearHealthIssue(ctx: PluginContext, companyId: string): Promise<void> {
  await ctx.db.execute(`DELETE FROM ${T.health} WHERE company_id = $1`, [companyId]);
}

// ---------------------------------------------------------------------------
// Daily brief issue (one per ISO week)
// ---------------------------------------------------------------------------

export async function getBriefIssue(ctx: PluginContext, companyId: string, weekKey: string): Promise<string | null> {
  const rows = await ctx.db.query<Raw>(`SELECT issue_id FROM ${T.brief} WHERE company_id = $1 AND week_key = $2`, [companyId, weekKey]);
  return rows[0] ? String(rows[0].issue_id) : null;
}

export async function saveBriefIssue(ctx: PluginContext, companyId: string, weekKey: string, issueId: string, now: string): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${T.brief} (company_id, week_key, issue_id, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, week_key) DO UPDATE SET issue_id = EXCLUDED.issue_id`,
    [companyId, weekKey, issueId, now],
  );
}
