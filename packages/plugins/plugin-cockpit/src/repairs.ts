/**
 * Repairs: system actions taken to fix issues detected by the Cockpit's checks.
 * Each repair records what was wrong (kind), what was fixed (target_kind, target_id),
 * the action taken, the outcome, and details if needed.
 */
import { randomBytes } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { redactSecrets } from "./watch-model.js";
import { NAMESPACE } from "./namespace.js";

const TABLE = `${NAMESPACE}.repairs`;

export const REPAIR_DETAIL_MAX = 2000;

export interface RepairRow {
  id: string;
  companyId: string;
  kind: string;
  targetKind: string;
  targetId: string;
  action: string;
  outcome: string;
  detail: string;
  actor: string;
  createdAt: string;
}

const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (value == null || value === "") return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const str = (value: unknown): string | null => (value == null || value === "" ? null : String(value));

type Raw = Record<string, unknown>;

function rowFrom(r: Raw): RepairRow {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    kind: String(r.kind),
    targetKind: String(r.target_kind),
    targetId: String(r.target_id),
    action: String(r.action),
    outcome: String(r.outcome),
    detail: str(r.detail) ?? "",
    actor: String(r.actor),
    createdAt: iso(r.created_at) ?? "",
  };
}

const newId = (): string => `rep${randomBytes(6).toString("hex")}`;

/**
 * Records a repair action. The detail is passed through redactSecrets to remove
 * credentials, then truncated to REPAIR_DETAIL_MAX characters.
 */
export async function recordRepair(
  ctx: PluginContext,
  companyId: string,
  input: {
    kind: string;
    targetKind: string;
    targetId: string;
    action: string;
    outcome: string;
    detail?: string;
    actor: string;
  },
): Promise<RepairRow> {
  const id = newId();
  let detail = input.detail ?? "";
  // Redact secrets first, then truncate
  detail = redactSecrets(detail);
  if (detail.length > REPAIR_DETAIL_MAX) {
    detail = detail.slice(0, REPAIR_DETAIL_MAX - 1) + "…";
  }

  await ctx.db.execute(
    `INSERT INTO ${TABLE} (id, company_id, kind, target_kind, target_id, action, outcome, detail, actor, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [id, companyId, input.kind, input.targetKind, input.targetId, input.action, input.outcome, detail, input.actor],
  );

  const rows = await ctx.db.query<Raw>(`SELECT id, company_id, kind, target_kind, target_id, action, outcome, detail, actor, created_at FROM ${TABLE} WHERE id = $1`, [id]);
  return rowFrom(rows[0]!);
}

/**
 * Lists repairs for a company, optionally filtered by kind and/or since timestamp.
 * Results are ordered by created_at DESC (newest first), then by id DESC.
 * Default limit is 100, clamped to 1..500.
 * When filtering by many targetIds, the function fetches with a higher limit and filters in JavaScript
 * to avoid missing records due to LIMIT applying before the filter.
 */
export async function listRepairs(
  ctx: PluginContext,
  companyId: string,
  opts?: {
    kind?: string;
    targetIds?: string[];
    since?: string;
    limit?: number;
  },
): Promise<RepairRow[]> {
  // When filtering by targetIds, use a much higher limit to ensure we don't miss records
  // due to LIMIT applying before the JavaScript filter
  const hasTargetIds = opts?.targetIds && opts.targetIds.length > 0;
  const baseLimit = opts?.limit ?? 100;
  // When filtering by targetIds, fetch all records up to the max limit (500) to ensure no truncation
  const limit = Math.max(1, Math.min(500, hasTargetIds ? 500 : baseLimit));

  let query = `SELECT id, company_id, kind, target_kind, target_id, action, outcome, detail, actor, created_at FROM ${TABLE} WHERE company_id = $1`;
  const params: unknown[] = [companyId];

  if (opts?.kind) {
    params.push(opts.kind);
    query += ` AND kind = $${params.length}`;
  }

  if (opts?.since) {
    params.push(opts.since);
    query += ` AND created_at >= $${params.length}::timestamptz`;
  }

  query += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const rows = await ctx.db.query<Raw>(query, params);
  const allRows = rows.map(rowFrom);

  // Filter by targetIds in JavaScript if provided
  if (hasTargetIds) {
    const targetIdSet = new Set(opts.targetIds!);
    return allRows.filter((r) => targetIdSet.has(r.targetId));
  }

  return allRows;
}
