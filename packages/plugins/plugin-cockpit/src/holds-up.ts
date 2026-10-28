/**
 * How much an issue holds up: the open issues it blocks, directly or through
 * other blocked issues (`public.issue_relations`, type `blocks`, the same
 * relation `watch.ts` reads). One recursive read per call; `UNION` drops
 * repeated pairs, so a relation cycle ends.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface BlockEdge {
  /** The blocking issue. */
  from: string;
  /** The issue it blocks. */
  to: string;
  /** Whether the blocked issue is still open (not done or cancelled). */
  toOpen: boolean;
}

/** Count, per root, the distinct open issues reachable over `blocks` edges (never the root itself). Pure; cycles end. */
export function holdsUpCounts(roots: string[], edges: BlockEdge[]): Map<string, number> {
  const next = new Map<string, BlockEdge[]>();
  for (const edge of edges) {
    const list = next.get(edge.from);
    if (list) list.push(edge);
    else next.set(edge.from, [edge]);
  }
  const out = new Map<string, number>();
  for (const root of roots) {
    const seen = new Set<string>([root]);
    const queue = [root];
    let open = 0;
    while (queue.length) {
      for (const edge of next.get(queue.shift()!) ?? []) {
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        if (edge.toOpen) open += 1;
        queue.push(edge.to);
      }
    }
    out.set(root, open);
  }
  return out;
}

/** Holds-up count for each issue id; a failed read gives an empty map (rank falls back to age). */
export async function readHoldsUp(ctx: PluginContext, companyId: string, issueIds: string[]): Promise<Map<string, number>> {
  if (!issueIds.length) return new Map();
  try {
    const rows = await ctx.db.query<{ from_id: string; to_id: string; open: boolean }>(
      `WITH RECURSIVE walk(from_id, to_id) AS (
         SELECT r.issue_id, r.related_issue_id FROM public.issue_relations r
          WHERE r.company_id = $1 AND r.type = 'blocks' AND r.issue_id = ANY($2::uuid[])
         UNION
         SELECT r.issue_id, r.related_issue_id FROM walk w JOIN public.issue_relations r
            ON r.issue_id = w.to_id AND r.company_id = $1 AND r.type = 'blocks'
       )
       SELECT w.from_id::text AS from_id, w.to_id::text AS to_id, (i.status NOT IN ('done', 'cancelled') AND i.hidden_at IS NULL) AS open
         FROM walk w JOIN public.issues i ON i.id = w.to_id AND i.company_id = $1`,
      [companyId, issueIds],
    );
    return holdsUpCounts(issueIds, rows.map((r) => ({ from: r.from_id, to: r.to_id, toOpen: r.open === true })));
  } catch {
    return new Map();
  }
}
