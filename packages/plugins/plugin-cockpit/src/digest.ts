/**
 * The owner's one daily digest (worker side).
 *
 * Once a day, from 16:00 SAST, the Cockpit lists everything that waits on the
 * owner in ONE issue assigned to them: questions agents asked, the host's
 * approval cards, tasks assigned to the owner and each plugin's waiting items,
 * each issue once, grouped by where the owner acts (digest-model.ts). The
 * issue is the one thing that reaches the owner that day; yesterday's is
 * closed when today's is posted.
 *
 * It runs inside the 15-minute ask-deadlines job, so a restart at 16:00 only
 * delays it: any sweep until the evening posts a missed one.
 *
 * Host limit: approval cards (`issue_thread_interactions`) are readable only
 * through `ctx.issues.listInteractions`, one issue at a time, and only with the
 * `issue.interactions.read` capability. Without it the digest says the cards
 * were not read instead of pretending there are none.
 */
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_APPLY_HOURS, defaultAnswer } from "./decision-rights-model.js";
import { readDecisionRights, ROUTED_REPAIR_KIND } from "./decision-rights.js";
import { askHardStop, getAsk, listOpenAsks, type AskRow } from "./asks.js";
import { loadCompanyData, waitingFrom } from "./brief.js";
import { briefBudget } from "./budget.js";
import { assignableUser, ORIGIN } from "./constants.js";
import { getRoles, listRoles } from "./db.js";
import {
  digestDue,
  digestTitle,
  nextHistory,
  oldestItem,
  parseHistory,
  renderDigest,
  sastDate,
  sastDayStart,
  type DigestDay,
  type DigestItem,
  type DigestSource,
  type DigestStats,
} from "./digest-model.js";
import { CockpitError, message, type Env } from "./env.js";
import { linkFor } from "./health.js";
import { readHoldsUp } from "./holds-up.js";
import { NAMESPACE } from "./namespace.js";
import { listRepairs } from "./repairs.js";

const DEFAULT_BASE_URL = "https://paperclip.partnersinbiz.online";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARD_KINDS = new Set(["ask_user_questions", "request_confirmation", "request_checkbox_confirmation"]);
/** Open issue statuses as SQL literals (constants: the host binds no arrays). */
const OPEN_SQL = "'todo', 'in_progress', 'in_review', 'blocked'";
/** The cards are read one issue at a time; past this the rest are reported as not read. */
const CARD_READ_BUDGET_MS = 90_000;
const CARD_READ_PARALLEL = 6;

const STATE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "cockpit", stateKey: "ownerDigest" });

interface DigestState {
  lastDate: string | null;
  lastPostedAt: string | null;
  issueId: string | null;
  history: DigestDay[];
}

async function readState(env: Env, companyId: string): Promise<DigestState> {
  const raw = await env.ctx.state.get(STATE(companyId)).catch(() => null);
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    lastDate: typeof row.lastDate === "string" ? row.lastDate : null,
    lastPostedAt: typeof row.lastPostedAt === "string" ? row.lastPostedAt : null,
    issueId: typeof row.issueId === "string" ? row.issueId : null,
    history: parseHistory(row.history),
  };
}

/** False only when the company switched the digest off in the Cockpit settings. */
function digestEnabled(config: unknown): boolean {
  const row = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).ownerDigest : null;
  return !(row && typeof row === "object" && (row as Record<string, unknown>).enabled === false);
}

export async function ownerDigestEnabled(env: Env, companyId: string): Promise<boolean> {
  try {
    return digestEnabled(await env.ctx.config.get(companyId));
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Approval cards
// ---------------------------------------------------------------------------

interface CardLite {
  id: string;
  issueId: string;
  kind: string;
  status: string;
  title: string | null;
  text: string;
  createdAt: string | null;
}

function cardText(payload: unknown): string {
  const row = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const out: string[] = [];
  for (const key of ["title", "prompt", "detailsMarkdown"]) if (typeof row[key] === "string") out.push(row[key] as string);
  if (Array.isArray(row.questions)) for (const q of row.questions) if (q && typeof q === "object" && typeof (q as Record<string, unknown>).prompt === "string") out.push((q as Record<string, unknown>).prompt as string);
  return out.join("\n");
}

/** Every card on the company's open issues that waits on a person, and how many were raised today. `unread` says what could not be read. */
export async function readOwnerCards(env: Env, companyId: string, dayStart: Date): Promise<{ pending: CardLite[]; raisedToday: number; unread: string | null }> {
  const list = (env.ctx.issues as { listInteractions?: (issueId: string, companyId: string) => Promise<unknown[]> }).listInteractions;
  if (typeof list !== "function") return { pending: [], raisedToday: 0, unread: "approval cards (this Paperclip has no way to list them)" };
  let issueIds: string[];
  try {
    const rows = await env.ctx.db.query<{ id: string }>(`SELECT id::text AS id FROM public.issues WHERE company_id = $1 AND hidden_at IS NULL AND status IN (${OPEN_SQL}) ORDER BY updated_at DESC LIMIT 1500`, [companyId]);
    issueIds = rows.map((r) => String(r.id));
  } catch (error) {
    env.ctx.logger.info("Owner digest: open issues could not be listed for the card read", { companyId, error: message(error) });
    return { pending: [], raisedToday: 0, unread: "approval cards" };
  }
  const pending: CardLite[] = [];
  let raisedToday = 0;
  let refused: string | null = null;
  let failed = 0;
  const startedAt = Date.now();
  let next = 0;
  let cut = false;
  const worker = async () => {
    while (next < issueIds.length && !refused) {
      if (Date.now() - startedAt > CARD_READ_BUDGET_MS) {
        cut = true;
        return;
      }
      const issueId = issueIds[next++]!;
      try {
        for (const raw of await list.call(env.ctx.issues, issueId, companyId)) {
          const card = raw as Record<string, unknown>;
          if (!CARD_KINDS.has(String(card.kind)) || card.addresseeAgentId) continue;
          const createdAt = card.createdAt instanceof Date ? card.createdAt.toISOString() : typeof card.createdAt === "string" ? card.createdAt : null;
          if (createdAt && Date.parse(createdAt) >= dayStart.getTime()) raisedToday += 1;
          if (card.status !== "pending" || card.dismissedAt) continue;
          const text = cardText(card.payload);
          pending.push({ id: String(card.id), issueId, kind: String(card.kind), status: "pending", title: typeof card.title === "string" && card.title.trim() ? card.title.trim() : null, text: [card.summary, text].filter((t) => typeof t === "string" && t).join("\n"), createdAt });
        }
      } catch (error) {
        const text = message(error);
        // A missing capability fails the same way for every issue: stop at the first one.
        if (/capabilit|not permitted|not allowed|forbidden|denied/i.test(text)) refused = text;
        else failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CARD_READ_PARALLEL, Math.max(1, issueIds.length)) }, worker));
  if (refused) {
    env.ctx.logger.info("Owner digest: approval cards could not be read", { companyId, error: refused });
    return { pending: [], raisedToday: 0, unread: "approval cards (the Cockpit is not allowed to read them yet)" };
  }
  const unread = cut ? `approval cards on ${issueIds.length - next} of ${issueIds.length} open tasks (ran out of time)` : failed > 0 ? `approval cards on ${failed} of ${issueIds.length} open tasks` : null;
  return { pending, raisedToday, unread };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface OwnerDigest {
  date: string;
  title: string;
  body: string;
  items: DigestItem[];
  stats: DigestStats;
  today: DigestDay;
}

function sourceOf(key: string): DigestSource {
  if (key.startsWith("ask:")) return "ask";
  if (key.startsWith("host-approval:")) return "approval";
  if (key.startsWith("issue:")) return "issue";
  return "plugin";
}

/** When an open ask answers itself, and with what; null when it waits for a person. Same rule as the deadline sweep. */
export function askAutoApply(ask: AskRow, ownProducts: readonly string[]): { answer: string; at: string } | null {
  if (!ask.deadlineAt || ask.defaultAppliedAt) return null;
  const answer = defaultAnswer({ kind: ask.kind, options: ask.options, recommended: ask.recommended, hasEffect: !!ask.effect, hardStop: askHardStop(ask, ownProducts) });
  if (!answer || answer !== ask.recommended) return null;
  return { answer, at: new Date(Math.max(Date.parse(ask.deadlineAt), Date.parse(ask.askedAt) + DEFAULT_APPLY_HOURS * 3_600_000)).toISOString() };
}

/** Everything that waits on the owner right now, as the digest. Null when the company has no owner. */
export async function buildOwnerDigest(env: Env, companyId: string): Promise<OwnerDigest | null> {
  const { ctx } = env;
  const now = env.now();
  const roles = await getRoles(ctx, companyId);
  const owner = assignableUser(roles?.ownerUserId ?? null);
  if (!owner) return null;
  const config = ((await ctx.config.get(companyId).catch(() => null)) ?? {}) as Record<string, unknown>;
  const base = (typeof config.publicBaseUrl === "string" && config.publicBaseUrl ? config.publicBaseUrl : DEFAULT_BASE_URL).replace(/\/+$/, "");
  const prefix = (await ctx.companies.get(companyId).catch(() => null))?.issuePrefix ?? null;
  const abs = (href: string | null | undefined): string | null => {
    if (!href) return null;
    const path = linkFor(href, prefix);
    return /^https?:\/\//i.test(path) ? path : `${base}${path}`;
  };
  const dayStart = sastDayStart(now);
  const unread: string[] = [];

  const budget = briefBudget((text, meta) => ctx.logger.info(text, meta));
  const data = await loadCompanyData(env, companyId, 1, 24, budget);
  for (const section of budget.degraded) if (["snapshots", "asks", "approvals", "ownerIssues"].includes(section)) unread.push(section === "snapshots" ? "the plugins' waiting lists" : section === "ownerIssues" ? "tasks assigned to you" : section);
  const { ownProducts } = await readDecisionRights(env, companyId);
  const [openAsks, state, cards] = await Promise.all([
    listOpenAsks(env, companyId, 200).catch(() => [] as AskRow[]),
    readState(env, companyId),
    readOwnerCards(env, companyId, dayStart),
  ]);
  if (cards.unread) unread.push(cards.unread);
  const askById = new Map(openAsks.map((a) => [a.id, a]));

  // The digest's own issues, the daily brief and the old hand-written digests are not work for the owner.
  const skip = new Set<string>();
  try {
    const rows = await ctx.db.query<{ id: string }>(
      `SELECT id::text AS id FROM public.issues WHERE company_id = $1 AND status IN (${OPEN_SQL}) AND (origin_kind IN ($2, $3) OR title LIKE '16:00 digest %')`,
      [companyId, ORIGIN.digest, ORIGIN.brief],
    );
    for (const row of rows) skip.add(String(row.id));
  } catch (error) {
    ctx.logger.info("Owner digest: its own issues could not be listed", { companyId, error: message(error) });
  }

  const items = new Map<string, DigestItem>();
  const byIssue = new Map<string, string>();
  const add = (item: DigestItem) => {
    items.set(item.key, item);
    if (item.issueId) byIssue.set(item.issueId, item.key);
  };
  for (const w of waitingFrom(data)) {
    // Tier A info cards need no action, and setup has its own page.
    if (w.key.startsWith("outward-send:") || w.key === "setup:missing") continue;
    if (w.issueId && skip.has(w.issueId)) continue;
    const source = sourceOf(w.key);
    const ask = source === "ask" ? askById.get(w.key.slice(4)) ?? null : null;
    add({
      key: w.key,
      source,
      action: source === "issue" ? w.title.replace(/^[A-Z][A-Z0-9]*-\d+\s+/, "") : w.title,
      detail: ask ? [ask.why, ...ask.steps, ...ask.links.map((l) => l.label)].filter(Boolean).join("\n") : w.why,
      href: abs(w.href),
      issueId: w.issueId ?? null,
      identifier: ask?.issueIdentifier ?? w.rank?.identifier ?? null,
      since: ask?.askedAt ?? w.since ?? null,
      holds: w.rank?.holdsUp ?? 0,
      autoApply: ask ? askAutoApply(ask, ownProducts) : null,
      askKind: ask?.kind ?? null,
    });
  }
  // An approval card says exactly what to do, so it replaces a plain "assigned to you" line for the same task; a Cockpit ask keeps its own.
  for (const card of cards.pending) {
    if (skip.has(card.issueId)) continue;
    const existingKey = byIssue.get(card.issueId);
    const existing = existingKey ? items.get(existingKey) : undefined;
    if (existing?.source === "ask") continue;
    if (existingKey) items.delete(existingKey);
    add({
      key: `card:${card.id}`,
      source: "card",
      action: card.title ?? card.text.split("\n")[0] ?? "Answer the card",
      detail: card.text,
      href: existing?.href ?? null,
      issueId: card.issueId,
      identifier: existing?.identifier ?? null,
      since: card.createdAt ?? existing?.since ?? null,
      holds: existing?.holds ?? 0,
    });
  }

  // Identifiers and links for items that came without one, and what each holds up.
  const list = [...items.values()];
  const issueIds = [...new Set(list.map((i) => i.issueId).filter((id): id is string => !!id && UUID.test(id)))];
  if (issueIds.length) {
    try {
      const rows = await ctx.db.query<{ id: string; identifier: string | null }>(`SELECT id::text AS id, identifier FROM public.issues WHERE company_id = $1 AND id::text IN (SELECT jsonb_array_elements_text($2::jsonb))`, [companyId, JSON.stringify(issueIds)]);
      const identifiers = new Map(rows.map((r) => [String(r.id), r.identifier ? String(r.identifier) : null]));
      for (const item of list) {
        if (!item.issueId) continue;
        item.identifier = item.identifier ?? identifiers.get(item.issueId) ?? null;
        if (!item.href && item.identifier) item.href = abs(`/issues/${item.identifier}`);
      }
    } catch (error) {
      ctx.logger.info("Owner digest: issue identifiers could not be read", { companyId, error: message(error) });
    }
    const holds = await readHoldsUp(ctx, companyId, issueIds);
    for (const item of list) if (item.issueId && holds.has(item.issueId)) item.holds = Math.max(item.holds, holds.get(item.issueId) ?? 0);
  }

  // The trend: asks raised to the owner today, what went to a seat instead, what answered itself.
  let newAsks: number | null = cards.raisedToday;
  try {
    const rows = await ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${NAMESPACE}.asks WHERE company_id = $1 AND source = 'agent' AND asked_at >= $2::timestamptz`, [companyId, dayStart.toISOString()]);
    newAsks += Number(rows[0]?.n ?? 0) || 0;
  } catch {
    newAsks = null;
  }
  const routedRows = await listRepairs(ctx, companyId, { kind: ROUTED_REPAIR_KIND, since: dayStart.toISOString(), limit: 500 }).catch(() => null);
  const since = state.lastPostedAt ?? new Date(now.getTime() - 86_400_000).toISOString();
  const applied: DigestStats["applied"] = [];
  for (const repair of await listRepairs(ctx, companyId, { kind: "ask_deadline", since, limit: 200 }).catch(() => [])) {
    if (repair.action !== "apply_default" || !repair.detail.startsWith("Applied by the 24-hour rule")) continue;
    const ask = await getAsk(env, companyId, repair.targetId).catch(() => null);
    const identifier = ask?.issueIdentifier ?? null;
    applied.push({ identifier, href: identifier ? abs(`/issues/${identifier}`) : null, answer: ask?.answer ?? repair.detail });
  }
  const history = state.history.filter((d) => d.date !== sastDate(now));
  const stats: DigestStats = { newAsks, routed: routedRows ? routedRows.filter((r) => r.outcome === "routed").length : null, applied, history, unread };

  const oldest = oldestItem(list);
  const oldestMs = oldest?.since ? Date.parse(oldest.since) : Number.NaN;
  const today: DigestDay = { date: sastDate(now), newAsks: newAsks ?? 0, open: list.length, oldestDays: Number.isFinite(oldestMs) ? Math.max(0, Math.floor((now.getTime() - oldestMs) / 86_400_000)) : null };
  return { date: today.date, title: digestTitle(now), body: renderDigest({ items: list, stats, now, cockpitHref: abs("/cockpit") }), items: list, stats, today };
}

// ---------------------------------------------------------------------------
// Post
// ---------------------------------------------------------------------------

export type DigestPostResult =
  | { posted: true; issueId: string; identifier: string | null; items: number; date: string }
  | { posted: false; reason: "no-owner" | "off" | "already-posted" | "nothing-waits"; date: string };

/** Posts today's digest issue for one company. Once a day: a second call the same day does nothing unless `force`. */
export async function postOwnerDigest(env: Env, companyId: string, options: { force?: boolean } = {}): Promise<DigestPostResult> {
  const { ctx } = env;
  const now = env.now();
  const date = sastDate(now);
  if (!(await ownerDigestEnabled(env, companyId))) return { posted: false, reason: "off", date };
  const state = await readState(env, companyId);
  if (state.lastDate === date && !options.force) return { posted: false, reason: "already-posted", date };
  const originId = `cockpit:digest:${companyId}:${date}`;
  if (!options.force) {
    // The state write can be lost between the create and the save: the issue itself is the second guard.
    const found = (await ctx.issues.list({ companyId, originKind: ORIGIN.digest as `plugin:${string}`, originId, limit: 5 }).catch(() => [])) as Array<{ id: string }>;
    if (found.length > 0) {
      await ctx.state.set(STATE(companyId), { ...state, lastDate: date, issueId: found[0]!.id });
      return { posted: false, reason: "already-posted", date };
    }
  }
  const digest = await buildOwnerDigest(env, companyId);
  if (!digest) return { posted: false, reason: "no-owner", date };
  const history = nextHistory(state.history, digest.today);
  const closePrevious = async (keep: string | null) => {
    if (!state.issueId || state.issueId === keep) return;
    const previous = await ctx.issues.get(state.issueId, companyId).catch(() => null);
    if (previous && !["done", "cancelled"].includes(String(previous.status))) {
      await ctx.issues.update(state.issueId, { status: "done" }, companyId).catch((error) => ctx.logger.info("Owner digest: yesterday's digest was not closed", { companyId, error: message(error) }));
    }
  };
  if (digest.items.length === 0) {
    await closePrevious(null);
    await ctx.state.set(STATE(companyId), { lastDate: date, lastPostedAt: now.toISOString(), issueId: null, history });
    return { posted: false, reason: "nothing-waits", date };
  }
  const roles = await getRoles(ctx, companyId);
  const owner = assignableUser(roles?.ownerUserId ?? null);
  if (!owner) return { posted: false, reason: "no-owner", date };
  const issue = await ctx.issues.create({
    companyId,
    title: digest.title,
    description: digest.body,
    status: "todo",
    priority: "medium",
    assigneeUserId: owner,
    originKind: ORIGIN.digest as `plugin:${string}`,
    originId,
  });
  await ctx.state.set(STATE(companyId), { lastDate: date, lastPostedAt: now.toISOString(), issueId: issue.id, history });
  await closePrevious(issue.id);
  return { posted: true, issueId: issue.id, identifier: (issue as { identifier?: string | null }).identifier ?? null, items: digest.items.length, date };
}

/** Called by the 15-minute sweep: posts the digest for every company whose 16:00 has come and that has none today. */
export async function ownerDigestTick(env: Env): Promise<{ posted: number; skipped: number; failed: number }> {
  const out = { posted: 0, skipped: 0, failed: 0 };
  const now = env.now();
  for (const row of await listRoles(env.ctx)) {
    try {
      if (!assignableUser(row.ownerUserId ?? null)) continue;
      const state = await readState(env, row.companyId);
      if (!digestDue(now, state.lastDate)) continue;
      const result = await postOwnerDigest(env, row.companyId);
      if (result.posted) out.posted += 1;
      else out.skipped += 1;
    } catch (error) {
      out.failed += 1;
      env.ctx.logger.warn("Owner digest failed for a company", { companyId: row.companyId, error: message(error) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Page actions (a board user only)
// ---------------------------------------------------------------------------

function boardCompany(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new CockpitError("Company is required");
  if (context.actor?.type !== "user") throw new CockpitError("Only a board user can read or post the owner's digest");
  return context.companyId;
}

export function registerOwnerDigest(env: Env): void {
  // The digest as it would be posted now, without posting it.
  env.ctx.actions.register("ownerDigest.preview", async (_params, context) => {
    const digest = await buildOwnerDigest(env, boardCompany(context));
    if (!digest) return { owner: false };
    return { owner: true, date: digest.date, title: digest.title, body: digest.body, items: digest.items.length, today: digest.today, unread: digest.stats.unread };
  });
  // Posts today's digest now (a missed day, or a first check after a release). `force` posts a second one the same day.
  env.ctx.actions.register("ownerDigest.post", async (params, context) => postOwnerDigest(env, boardCompany(context), { force: (params as Record<string, unknown> | null)?.force === true }));
}
