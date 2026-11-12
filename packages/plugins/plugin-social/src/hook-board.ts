/**
 * The hook board: which parts of our posts worked. A post is built from three parts, each named in a tag:
 * `hook:<name>` (the first line, or the first five seconds), `body:<name>` (the middle: the explanation, the proof,
 * the demonstration) and `cta:<name>` (the closing ask). The same part is used on several posts, so many hooks can be
 * tried over a few bodies and asks. The board groups a scope's published posts by each part, adds up how many people
 * each reached and how many acted, names the control (the best hook, body and ask so far) and says which parts to
 * make again and which to drop. It is honest about small numbers: under `MIN_REACH` people a part gets no verdict,
 * because a rate on a handful of views is noise.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { listPosts, metricsForCompany, type MetricsRow, type PostRow } from "./db.js";

export const PART_TAGS = { hook: "hook:", body: "body:", cta: "cta:" } as const;
export type Part = keyof typeof PART_TAGS;
export const HOOK_TAG = PART_TAGS.hook;
/** People a part must reach, over all its posts, before it is ranked. */
export const MIN_REACH = 100;

export interface PartRow {
  name: string;
  posts: number;
  reach: number;
  actions: number;
  /** Actions per 100 people reached; null under `MIN_REACH`. */
  rate: number | null;
  verdict: "double down" | "keep testing" | "drop" | "too little reach";
  postIds: string[];
}

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) || 0 : 0);

/** The name a post gives one of its parts, from its tags; null when it has none. */
export function partOf(post: Pick<PostRow, "overrides">, part: Part): string | null {
  const prefix = PART_TAGS[part];
  const tags = (post.overrides as Record<string, unknown> | null | undefined)?.tags;
  const tag = Array.isArray(tags) ? tags.find((t): t is string => typeof t === "string" && t.startsWith(prefix) && t.length > prefix.length) : undefined;
  return tag ? tag.slice(prefix.length).trim() : null;
}

export const hookOf = (post: Pick<PostRow, "overrides">): string | null => partOf(post, "hook");

/** Reach and actions of each post: the best reading per destination, added over the post's destinations. */
export function postTotals(metrics: MetricsRow[]): Map<string, { reach: number; actions: number }> {
  const byDestination = new Map<string, { postId: string; reach: number; actions: number }>();
  for (const m of metrics) {
    const key = `${m.post_id}:${m.destination_id ?? m.account_id ?? m.platform ?? ""}`;
    const reach = Math.max(num(m.impressions), num(m.reach), num(m.views));
    const actions = num(m.likes) + num(m.comments) + num(m.shares) + num(m.saves) + num(m.clicks);
    const known = byDestination.get(key);
    byDestination.set(key, { postId: m.post_id, reach: Math.max(known?.reach ?? 0, reach), actions: Math.max(known?.actions ?? 0, actions) });
  }
  const out = new Map<string, { reach: number; actions: number }>();
  for (const d of byDestination.values()) {
    const known = out.get(d.postId) ?? { reach: 0, actions: 0 };
    out.set(d.postId, { reach: known.reach + d.reach, actions: known.actions + d.actions });
  }
  return out;
}

/** Rank the values of one part. Pure: posts with the part's name and totals in, rows out (best rate first, unranked last by reach). */
export function rankParts(posts: Array<{ id: string; name: string; reach: number; actions: number }>): PartRow[] {
  const groups = new Map<string, PartRow>();
  for (const p of posts) {
    const row = groups.get(p.name) ?? { name: p.name, posts: 0, reach: 0, actions: 0, rate: null, verdict: "too little reach" as const, postIds: [] };
    row.posts += 1;
    row.reach += p.reach;
    row.actions += p.actions;
    row.postIds.push(p.id);
    groups.set(p.name, row);
  }
  const rows = [...groups.values()];
  const ranked = rows.filter((r) => r.reach >= MIN_REACH);
  for (const r of ranked) r.rate = Math.round((r.actions / r.reach) * 1000) / 10;
  const rates = ranked.map((r) => r.rate!).sort((a, b) => a - b);
  const median = rates.length ? rates[Math.floor(rates.length / 2)]! : 0;
  for (const r of ranked) {
    // One ranked value has nothing to be compared with. Otherwise: clearly above the middle, clearly below, or neither.
    r.verdict = ranked.length < 2 ? "keep testing" : r.rate! >= median * 1.3 && r.rate! > 0 ? "double down" : r.rate! <= median * 0.7 ? "drop" : "keep testing";
  }
  return rows.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.reach - a.reach);
}

export async function hookBoard(ctx: PluginContext, companyId: string, scope: ClientScope, days = 28) {
  const period = Math.min(90, Math.max(7, Math.round(days) || 28));
  const since = Date.now() - period * 86_400_000;
  const posts = (await listPosts(ctx, companyId, { scope, limit: 500 })).filter(
    (p) => (p.status === "published" || p.status === "partially_published") && p.published_at && new Date(String(p.published_at)).getTime() >= since,
  );
  const totals = postTotals(await metricsForCompany(ctx, companyId, scope));
  const rankOf = (part: Part) =>
    rankParts(posts.flatMap((p) => {
      const name = partOf(p, part);
      return name ? [{ id: p.id, name, ...(totals.get(p.id) ?? { reach: 0, actions: 0 }) }] : [];
    }));
  const hooks = rankOf("hook");
  const bodies = rankOf("body");
  const ctas = rankOf("cta");
  const tagged = posts.filter((p) => partOf(p, "hook")).length;
  const reachAll = posts.reduce((sum, p) => sum + (totals.get(p.id)?.reach ?? 0), 0);
  const best = (rows: PartRow[]): string | null => rows.find((r) => r.rate !== null)?.name ?? null;
  // The control: the best of each part so far. New hooks are written to beat it.
  const control = { hook: best(hooks), body: best(bodies), cta: best(ctas) };
  const notes: string[] = [];
  if (posts.length && tagged < posts.length) notes.push(`${posts.length - tagged} of ${posts.length} published posts carry no hook tag, so they teach nothing. Tag every post: hook:<short name>, and body:<name> and cta:<name> where it has them.`);
  if (hooks.length && !hooks.some((h) => h.rate !== null)) {
    notes.push(`No hook has reached ${MIN_REACH} people yet (all posts together reached ${reachAll} in ${period} days). The numbers cannot rank anything: the first job is reach. Make short video the main format, reply where the audience already is, and ask for a small boost on the strongest post.`);
  }
  const winners = hooks.filter((h) => h.verdict === "double down");
  if (winners.length) {
    notes.push(`Double down: say ${winners.map((h) => `"${h.name}"`).join(", ")} again with a different look or setting, on the best body${control.body ? ` ("${control.body}")` : ""} and ask${control.cta ? ` ("${control.cta}")` : ""}. Stop making the parts marked drop. Then write new hooks to beat the control.`);
  }
  return { periodDays: period, published: posts.length, tagged, reach: reachAll, minReach: MIN_REACH, control, hooks, bodies, ctas, notes };
}
