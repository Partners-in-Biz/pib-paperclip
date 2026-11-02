/**
 * Attention counts line for the 04:00 push digest (PAR-7133): in the last 24 h,
 * how many sent pushes were `needs_you` vs other, and how many asks are open.
 * Counts for ONE company; the digest only adds the line for the owner company.
 * Digest, collapse and test rows are not items, so they are left out of "other".
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { NAMESPACE } from "../namespace.js";

export interface AttentionCounts {
  needsYou: number;
  other: number;
  openAsks: number;
}

export async function countAttention(ctx: PluginContext, companyId: string, now: Date): Promise<AttentionCounts> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const pushes = await ctx.db.query<{ needs_you: string; other: string }>(
    `SELECT count(*) FILTER (WHERE class = 'needs_you')::text AS needs_you,
            count(*) FILTER (WHERE class NOT IN ('needs_you', 'digest', 'collapse', 'test'))::text AS other
       FROM ${NAMESPACE}.push_log WHERE company_id = $1 AND status = 'sent' AND created_at >= $2`,
    [companyId, since],
  );
  const asks = await ctx.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${NAMESPACE}.asks WHERE company_id = $1 AND status = 'open'`,
    [companyId],
  );
  return { needsYou: Number(pushes[0]?.needs_you ?? 0), other: Number(pushes[0]?.other ?? 0), openAsks: Number(asks[0]?.n ?? 0) };
}

export function attentionLine(c: AttentionCounts): string {
  return `Last 24h: ${c.needsYou} need you, ${c.other} other · ${c.openAsks} open ask${c.openAsks === 1 ? "" : "s"}`;
}
