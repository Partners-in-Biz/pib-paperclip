/**
 * Chart series for the Social page (read only): destinations published per
 * day and platform, destination statuses, and the weekly median 7-day
 * engagement lift. One SELECT per load.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clientWhere, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { table } from "./db.js";

/** Days of published counts sent to the page: the chart shows the last 14, the KPI compares with the 14 before. */
export const STATS_DAYS = 28;
/** Weeks of engagement lift. */
export const LIFT_WEEKS = 12;

export interface ScopeStats {
  days: number;
  /** Destinations published per UTC day (`YYYY-MM-DD`) and platform. Days without posts are left out. */
  publishedPerDay: Array<{ date: string; platform: string; count: number }>;
  /** Destinations of posts created in the last 30 days, per status. */
  destinationStatus: Record<string, number>;
  /** Median 7-day engagement lift per week (week starts Monday, UTC), oldest first. */
  liftPerWeek: Array<{ week: string; medianLift: number; posts: number }>;
}

export interface StatsRow {
  kind: string;
  bucket: string | null;
  key: string | null;
  n: number | string;
  value: number | string | null;
}

export function emptyStats(days = STATS_DAYS): ScopeStats {
  return { days, publishedPerDay: [], destinationStatus: {}, liftPerWeek: [] };
}

/** Rows of `statsQuery` → the page's series. */
export function shapeStats(rows: StatsRow[], days = STATS_DAYS): ScopeStats {
  const out = emptyStats(days);
  for (const row of rows) {
    const n = Number(row.n ?? 0);
    if (!Number.isFinite(n)) continue;
    if (row.kind === "published" && row.bucket) out.publishedPerDay.push({ date: row.bucket, platform: row.key ?? "other", count: n });
    else if (row.kind === "destination" && row.key) out.destinationStatus[row.key] = (out.destinationStatus[row.key] ?? 0) + n;
    else if (row.kind === "lift" && row.bucket && row.value !== null && row.value !== undefined) {
      const lift = Number(row.value);
      if (Number.isFinite(lift)) out.liftPerWeek.push({ week: row.bucket, medianLift: lift, posts: n });
    }
  }
  out.publishedPerDay.sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform));
  out.liftPerWeek.sort((a, b) => a.week.localeCompare(b.week));
  return out;
}

/** The one read behind `scopeStats` (exported for tests). */
export function statsQuery(ctx: PluginContext, companyId: string, scope: ClientScope, days = STATS_DAYS): { sql: string; params: unknown[] } {
  const params: unknown[] = [companyId];
  const w = clientWhere(scope, params.length + 1, "p");
  params.push(...w.params);
  params.push(days);
  const daysParam = `$${params.length}`;
  const destinations = table(ctx, "destinations");
  const posts = table(ctx, "posts");
  const accounts = table(ctx, "accounts");
  const scores = table(ctx, "post_scores");
  const sql = `SELECT 'published' AS kind, to_char(d.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS bucket,
         COALESCE(a.platform, 'other') AS key, count(*)::int AS n, NULL::float8 AS value
    FROM ${destinations} d
    JOIN ${posts} p ON p.id = d.post_id
    LEFT JOIN ${accounts} a ON a.id = d.account_id
   WHERE d.company_id = $1 AND ${w.sql} AND d.status = 'published' AND d.published_at IS NOT NULL
     AND d.published_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - make_interval(days => ${daysParam}::int - 1)
   GROUP BY 2, 3
  UNION ALL
  SELECT 'destination', NULL, d.status, count(*)::int, NULL::float8
    FROM ${destinations} d
    JOIN ${posts} p ON p.id = d.post_id
   WHERE d.company_id = $1 AND ${w.sql} AND p.created_at >= now() - interval '30 days'
   GROUP BY d.status
  UNION ALL
  SELECT 'lift', to_char(date_trunc('week', s.published_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD'), NULL, count(*)::int,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY s.lift))::float8
    FROM ${scores} s
    JOIN ${posts} p ON p.id = s.post_id
   WHERE s.company_id = $1 AND ${w.sql} AND s.metric_window = '7d' AND s.lift IS NOT NULL
     AND s.published_at >= now() - interval '${LIFT_WEEKS * 7} days'
   GROUP BY 2`;
  return { sql, params };
}

/** Chart series for one scope. A failed read gives empty series (the page still loads). */
export async function scopeStats(ctx: PluginContext, companyId: string, scope: ClientScope, days = STATS_DAYS): Promise<ScopeStats> {
  const { sql, params } = statsQuery(ctx, companyId, scope, days);
  try {
    return shapeStats(await ctx.db.query<StatsRow>(sql, params), days);
  } catch (error) {
    ctx.logger?.warn?.("social stats read failed", { error: error instanceof Error ? error.message : String(error) });
    return emptyStats(days);
  }
}
