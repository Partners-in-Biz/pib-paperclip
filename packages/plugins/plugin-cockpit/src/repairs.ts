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

/** Key of a (target, action) pair in the map from latestRepairTimes. */
export const repairKey = (targetId: string, action: string): string => `${targetId}:${action}`;

/**
 * Latest created_at (ISO) per (target_id, action) among issue-target repairs of one kind, for the given
 * targets. "Already recorded?" checks use this, not listRepairs: that returns at most 500 rows, newest
 * first, so a check over it missed older rows and the ladder wrote the same rows again every tick
 * (about 35,000 a day by 2026-11-26).
 */
export async function latestRepairTimes(
  ctx: PluginContext,
  companyId: string,
  kind: string,
  targetIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = Array.from(new Set(targetIds.filter(Boolean)));
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await ctx.db.query<Raw>(
      `SELECT target_id, action, created_at FROM ${TABLE} WHERE company_id = $1 AND kind = $2 AND target_kind = 'issue' AND target_id = ANY(ARRAY(SELECT jsonb_array_elements_text($3::jsonb)))`,
      [companyId, kind, JSON.stringify(chunk)],
    );
    for (const r of rows) {
      const key = repairKey(String(r.target_id), String(r.action));
      const at = iso(r.created_at) ?? "";
      const prev = out.get(key);
      if (prev === undefined || at > prev) out.set(key, at);
    }
  }
  return out;
}

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
 * Lists repairs for a company, optionally filtered by kind, targetIds, and/or since timestamp.
 * Results are ordered by created_at DESC (newest first), then by id DESC.
 * Default limit is 100, clamped to 1..500.
 * When targetIds are provided, they are applied in the WHERE clause so LIMIT applies after filtering.
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
  const limit = Math.max(1, Math.min(500, opts?.limit ?? 100));

  let query = `SELECT id, company_id, kind, target_kind, target_id, action, outcome, detail, actor, created_at FROM ${TABLE} WHERE company_id = $1`;
  const params: unknown[] = [companyId];

  if (opts?.kind) {
    params.push(opts.kind);
    query += ` AND kind = $${params.length}`;
  }

  if (opts?.targetIds && opts.targetIds.length > 0) {
    // Build OR clause for each targetId to apply filter in WHERE (before LIMIT)
    const idClauses = opts.targetIds.map(() => {
      params.push("");  // Placeholder
      return `target_id = $${params.length}`;
    });
    // Replace placeholders with actual targetIds
    let idIdx = 0;
    for (let i = params.length - opts.targetIds.length; i < params.length; i++) {
      params[i] = opts.targetIds[idIdx++];
    }
    query += ` AND (${idClauses.join(" OR ")})`;
  }

  if (opts?.since) {
    params.push(opts.since);
    query += ` AND created_at >= $${params.length}::timestamptz`;
  }

  query += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const rows = await ctx.db.query<Raw>(query, params);
  return rows.map(rowFrom);
}
