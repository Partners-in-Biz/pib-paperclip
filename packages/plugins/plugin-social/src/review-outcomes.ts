/**
 * Review outcomes: the ledger behind approval sign-offs and the inputs a later
 * autonomy ladder needs (Q10-10).
 *
 * Every verdict on a post in review is one row: the Reviewer's pass or changes
 * (`record-review-verdict`), the owner's approval or return, the client's
 * approval or change request. Rows carry the post's TYPE (where it came from and
 * its format: `original:image`, `repurpose:text`, `rss:text`, `reply:text`) and
 * the scope, so first-pass rates and approval streaks can be read per type and per
 * client. `content_hash` ties a sign-off to the exact version that was checked:
 * a sign-off on older content no longer counts (`currentSignoffs`).
 *
 * Nothing here approves anything. Auto-approval is NOT built: the stats are
 * numbers for a person to read, and for a later policy (which changes an owner
 * design, "approvals only a person decides") to be set deliberately.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clientWhere, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { scopeOfRow } from "./clients.js";
import { postMedia, table, type PostRow } from "./db.js";
import { formatOf } from "./growth/engine.js";

export const STAGES = ["reviewer", "owner", "client"] as const;
export type Stage = (typeof STAGES)[number];
export type Outcome = "approved" | "changes";

/** Where a post came from, as far as risk goes: our own writing, a repurposed SEO page, an RSS item, a reply. */
export type PostKind = "original" | "repurpose" | "rss" | "reply";

export function postKind(source: string | null | undefined): PostKind {
  if (source === "repurpose") return "repurpose";
  if (source === "rss") return "rss";
  if (source === "inbox_reply") return "reply";
  return "original";
}

export interface PostType {
  kind: PostKind;
  format: string;
  /** `<kind>:<format>`, e.g. `repurpose:text`. */
  type: string;
}

/** The type of a post: its source class and its format (text, image, carousel, video). Pure. */
export function postTypeOf(post: Pick<PostRow, "source" | "media">): PostType {
  const kind = postKind(post.source);
  const format = formatOf(postMedia(post));
  return { kind, format, type: `${kind}:${format}` };
}

export interface OutcomeActor {
  userId?: string | null;
  agentId?: string | null;
  /** A name to show: the client's own name from the approval page, or the person's. */
  name?: string | null;
}

export interface RecordOutcomeInput {
  companyId: string;
  post: Pick<PostRow, "id" | "source" | "media" | "client_kind" | "client_ref">;
  platforms: string[];
  stage: Stage;
  outcome: Outcome;
  contentHash: string | null;
  /** How it was recorded: `tool` (an agent), `ui` (a person on the page), `link` (the client's approval page), `recorded` (a person on the client's behalf). */
  via: "tool" | "ui" | "link" | "recorded";
  actor?: OutcomeActor;
  note?: string | null;
}

function clipNote(note: string | null | undefined): string | null {
  const text = typeof note === "string" ? note.trim() : "";
  return text ? text.slice(0, 1000) : null;
}

/**
 * Records one verdict. The round counts the post's earlier verdicts at the same
 * stage, so a post sent back and forth has rounds 1, 2, 3 (first-pass rates read
 * round 1). A race on the same round retries once with the next one; a repeat of
 * the same call is harmless because the (post, stage, round) key is unique.
 */
export async function recordOutcome(ctx: PluginContext, input: RecordOutcomeInput): Promise<{ recorded: boolean; round: number }> {
  const outcomes = table(ctx, "review_outcomes");
  const { format, type } = postTypeOf(input.post);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rows = await ctx.db.query<{ n: string | number | null }>(
      `SELECT COALESCE(MAX(round), 0) AS n FROM ${outcomes} WHERE post_id = $1 AND company_id = $2 AND stage = $3`,
      [input.post.id, input.companyId, input.stage],
    );
    const round = Number(rows[0]?.n ?? 0) + 1;
    const result = await ctx.db.execute(
      `INSERT INTO ${outcomes}
        (id, company_id, post_id, stage, outcome, round, content_hash, post_type, format, source, platforms, client_kind, client_ref, via,
         actor_user_id, actor_agent_id, actor_name, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (post_id, stage, round) DO NOTHING`,
      [
        randomUUID(), input.companyId, input.post.id, input.stage, input.outcome, round, input.contentHash, type, format, input.post.source ?? null,
        JSON.stringify(Array.from(new Set(input.platforms)).sort()), input.post.client_ref ? input.post.client_kind ?? "company" : null, input.post.client_ref ?? null,
        input.via, input.actor?.userId ?? null, input.actor?.agentId ?? null, input.actor?.name ? input.actor.name.slice(0, 120) : null, clipNote(input.note),
      ],
    );
    if (result.rowCount === 1) return { recorded: true, round };
  }
  return { recorded: false, round: 0 };
}

export interface OutcomeRow {
  stage: Stage;
  outcome: Outcome;
  round: number;
  content_hash: string | null;
  note: string | null;
  via: string;
  actor_name: string | null;
  created_at: unknown;
}

/** A post's verdicts, newest first. */
export async function outcomesForPost(ctx: PluginContext, companyId: string, postId: string): Promise<OutcomeRow[]> {
  return ctx.db.query<OutcomeRow>(
    `SELECT stage, outcome, round, content_hash, note, via, actor_name, created_at FROM ${table(ctx, "review_outcomes")}
      WHERE post_id = $1 AND company_id = $2 ORDER BY created_at DESC, round DESC LIMIT 60`,
    [postId, companyId],
  );
}

/** `approved`: the latest verdict at the stage approved THIS version; `changes`: it asked for changes; `stale`: it approved an older version; `none`: no verdict yet. */
export type StageState = "approved" | "changes" | "stale" | "none";

/**
 * Where each sign-off stands for the content with `hash`. The latest verdict at a
 * stage wins; an approval counts only for the version it was given on. Pure.
 */
export function currentSignoffs(rows: Array<Pick<OutcomeRow, "stage" | "outcome" | "round" | "content_hash" | "created_at">>, hash: string): Record<Stage, StageState> {
  const out: Record<Stage, StageState> = { reviewer: "none", owner: "none", client: "none" };
  for (const stage of STAGES) {
    const latest = rows
      .filter((row) => row.stage === stage)
      .sort((a, b) => b.round - a.round || String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (!latest) continue;
    if (latest.outcome === "changes") out[stage] = "changes";
    else out[stage] = latest.content_hash === hash ? "approved" : "stale";
  }
  return out;
}

// ── autonomy inputs ─────────────────────────────────────────────────────────

export interface StatRow {
  post_type: string;
  stage: Stage;
  outcome: Outcome;
  round: number;
  post_id: string;
  created_at: unknown;
}

export interface TypeStats {
  postType: string;
  stage: Stage;
  /** Verdicts recorded. */
  total: number;
  approved: number;
  changes: number;
  /** Posts whose FIRST verdict at this stage was an approval, over posts with a first verdict. */
  firstPassApproved: number;
  firstPassTotal: number;
  firstPassRate: number | null;
  /** Approvals in a row, newest first, until the first request for changes. */
  streak: number;
  lastAt: string | null;
}

function stamp(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** Per post type and stage: counts, first-pass rate and the current approval streak. Pure; the numbers are inputs, never a decision. */
export function summariseOutcomes(rows: StatRow[]): TypeStats[] {
  const groups = new Map<string, StatRow[]>();
  for (const row of rows) {
    const key = `${row.post_type}\u0000${row.stage}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const out: TypeStats[] = [];
  for (const list of groups.values()) {
    const newest = [...list].sort((a, b) => (stamp(b.created_at) ?? "").localeCompare(stamp(a.created_at) ?? "") || b.round - a.round);
    const first = list.filter((row) => row.round === 1);
    const firstPassApproved = first.filter((row) => row.outcome === "approved").length;
    let streak = 0;
    for (const row of newest) {
      if (row.outcome !== "approved") break;
      streak += 1;
    }
    out.push({
      postType: list[0]!.post_type,
      stage: list[0]!.stage,
      total: list.length,
      approved: list.filter((row) => row.outcome === "approved").length,
      changes: list.filter((row) => row.outcome === "changes").length,
      firstPassApproved,
      firstPassTotal: first.length,
      firstPassRate: first.length ? Math.round((firstPassApproved / first.length) * 1000) / 1000 : null,
      streak,
      lastAt: stamp(newest[0]?.created_at),
    });
  }
  return out.sort((a, b) => a.postType.localeCompare(b.postType) || STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
}

/** Outcome rows of one scope in the last `days` days (most recent 2000). */
export async function statRows(ctx: PluginContext, companyId: string, scope: ClientScope, days: number): Promise<StatRow[]> {
  const params: unknown[] = [companyId, days];
  const w = clientWhere(scope, params.length + 1);
  params.push(...w.params);
  return ctx.db.query<StatRow>(
    `SELECT post_type, stage, outcome, round, post_id, created_at FROM ${table(ctx, "review_outcomes")}
      WHERE company_id = $1 AND created_at >= now() - make_interval(days => $2) AND ${w.sql}
      ORDER BY created_at DESC LIMIT 2000`,
    params,
  );
}

/** What `review-outcomes` returns for one scope. */
export async function reviewStats(ctx: PluginContext, companyId: string, scope: ClientScope, days = 90) {
  const stats = summariseOutcomes(await statRows(ctx, companyId, scope, days));
  return {
    days,
    scope: scope ? `${scope.kind}:${scope.id}` : null,
    types: stats,
    autonomy: {
      enabled: false,
      note: "Auto-approval is off. These numbers are inputs only: a person approves every post. A later policy has to be set by the owner on purpose.",
    },
  };
}

/** The scope a post belongs to, for callers that hold only the post row. */
export function outcomeScope(post: Pick<PostRow, "client_kind" | "client_ref">): ClientScope {
  return scopeOfRow(post);
}
