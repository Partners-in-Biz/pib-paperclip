/**
 * The Decide queue (PAR-15315, T1): the loader behind the data action `decide.queue`.
 *
 * Asks and approvals come from the same owner list the 16:00 digest uses (`waitingSplit(...).owner`), so the two
 * cannot drift. Approval cards cannot be listed company-wide (the host gives them one issue at a time), so a call
 * never scans them: they come from a stored index that `refreshOwnerCards` rebuilds in the background.
 *
 * Time: one deadline of `QUEUE_MS` from the start of the call (each `loadCompanyData` section is cut by its own
 * race), and an outer race at `QUEUE_MS + 2 s`. Worst case 17 s, under the 30 s host RPC timeout.
 */
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { listOpenAsks, type AskRow } from "./asks.js";
import { loadCompanyData, waitingSplit } from "./brief.js";
import { briefBudget } from "./budget.js";
import { describeEffect } from "./ask-model.js";
import { assignableUser } from "./constants.js";
import { getRoles } from "./db.js";
import { buildQueue, type ApprovalSource, type AskSource, type CardSource, type DecideItem } from "./decide-model.js";
import { readOwnerCards } from "./digest.js";
import { CockpitError, message, type Env } from "./env.js";
import type { ApprovalLite, WaitingEntry } from "./merge.js";

/** One deadline for the whole call. */
export const QUEUE_MS = 15_000;
/** The outer race: past this the call answers with what it has. */
export const OUTER_MS = QUEUE_MS + 2_000;
/** The card index is rebuilt in the background when it is older than this. */
export const INDEX_STALE_MS = 120_000;
/** A built queue is kept this long per company. */
export const CACHE_MS = 60_000;
/** The index read: waiting scope, oldest first, 60 s in all, 5 s per call. */
export const INDEX_BUDGET_MS = 60_000;
export const INDEX_CALL_MS = 5_000;

const INDEX_KEY = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "cockpit", stateKey: `decide-cards:${companyId}` });

export interface CardIndex {
  at: string;
  pending: CardSource[];
  unread: string | null;
}

export interface DecideQueue {
  items: DecideItem[];
  /** True for a caller who is not the owner: the queue is empty. */
  notOwner: boolean;
  /** What could not be read, in words for the page; empty when everything was. */
  partial: string[];
  /** When the stored card list was built, or null when it has not been built yet. */
  cardsAsOf: string | null;
  /** True while a background refresh of the card list runs. */
  cardsRefreshing: boolean;
  builtAt: string;
}

// ---------------------------------------------------------------------------
// Card index
// ---------------------------------------------------------------------------

const refreshing = new Map<string, Promise<void>>();

export function cardsRefreshing(companyId: string): boolean {
  return refreshing.has(companyId);
}

export async function readCardIndex(env: Env, companyId: string): Promise<CardIndex | null> {
  const raw = await env.ctx.state.get(INDEX_KEY(companyId)).catch(() => null);
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!row || typeof row.at !== "string" || !Array.isArray(row.pending)) return null;
  return { at: row.at, pending: row.pending as CardSource[], unread: typeof row.unread === "string" ? row.unread : null };
}

/** Reads the waiting issues' cards (oldest first) and stores them. Throws on a failed write. Never runs inside a page call. */
export async function refreshOwnerCards(env: Env, companyId: string): Promise<CardIndex> {
  const roles = await getRoles(env.ctx, companyId);
  const result = await readOwnerCards(env, companyId, new Date(0), {
    scope: "waiting",
    order: "asc",
    budgetMs: INDEX_BUDGET_MS,
    callMs: INDEX_CALL_MS,
    ownerUserId: assignableUser(roles?.ownerUserId ?? null),
  });
  const index: CardIndex = {
    at: env.now().toISOString(),
    pending: result.pending.map((c) => ({ id: c.id, issueId: c.issueId, kind: c.kind, status: c.status, title: c.title, text: c.text, createdAt: c.createdAt, addresseeUserId: c.addresseeUserId ?? null })),
    unread: result.unread,
  };
  await env.ctx.state.set(INDEX_KEY(companyId), index as unknown as Record<string, unknown>);
  return index;
}

/** Starts a refresh unless one is running for this company. Fire and forget: the caller never awaits it. */
export function startCardRefresh(env: Env, companyId: string): boolean {
  if (refreshing.has(companyId)) return false;
  const run = refreshOwnerCards(env, companyId)
    .then(() => undefined)
    .catch((error) => env.ctx.logger.info("Decide: the card list could not be refreshed", { companyId, error: message(error) }))
    .finally(() => {
      refreshing.delete(companyId);
    });
  refreshing.set(companyId, run);
  return true;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const cache = new Map<string, { at: number; value: DecideQueue }>();

/** Every decide action calls this for its company (T2), so the next read builds again. */
export function clearDecideCache(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function askSource(entry: WaitingEntry, row: AskRow | undefined): AskSource {
  const info = entry.ask!;
  if (!row) {
    return { id: info.id, issueId: entry.issueId ?? null, question: info.question, why: info.why, effect: null, options: info.options, recommended: null, kind: info.kind, askedAt: info.askedAt, dueBy: info.dueBy, deadlineAt: null, ownerUserId: null, rowKnown: false, href: entry.href ?? null };
  }
  return { id: row.id, issueId: row.issueId, question: row.question, why: row.why, effect: row.effect ? describeEffect(row.effect) : null, options: row.options, recommended: row.recommended, kind: row.kind, askedAt: row.askedAt, dueBy: row.dueBy, deadlineAt: row.deadlineAt, ownerUserId: row.ownerUserId, rowKnown: true, href: entry.href ?? null };
}

function approvalSource(entry: WaitingEntry, approval: ApprovalLite): ApprovalSource {
  return { id: approval.id, type: approval.type, status: approval.status, payload: approval.payload ?? null, title: entry.title, why: entry.why, kind: entry.kind, createdAt: approval.createdAt ?? null, href: entry.href ?? null };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

interface Gathered {
  data?: Awaited<ReturnType<typeof loadCompanyData>>;
  asks?: AskRow[];
  index?: CardIndex | null;
}

function assemble(g: Gathered, ownerUserId: string, now: Date): DecideItem[] {
  const entries = g.data ? waitingSplit(g.data, now).owner : [];
  const askById = new Map((g.asks ?? []).map((a) => [a.id, a]));
  const approvalById = new Map((g.data?.approvals ?? []).map((a) => [a.id, a]));
  const asks: AskSource[] = [];
  const approvals: ApprovalSource[] = [];
  for (const entry of entries) {
    if (entry.ask) asks.push(askSource(entry, askById.get(entry.ask.id)));
    else if (entry.key.startsWith("host-approval:")) {
      const approval = approvalById.get(entry.key.slice("host-approval:".length));
      if (approval) approvals.push(approvalSource(entry, approval));
    }
  }
  return buildQueue({ now, ownerUserId, asks, approvals, cards: g.index?.pending ?? [] });
}

/** Who may read the queue: the company's owner, signed in as a person. Fails closed. */
async function requireOwnerOrNot(env: Env, context: PluginPerformActionContext): Promise<{ companyId: string; ownerUserId: string; isOwner: boolean }> {
  if (!context.companyId) throw new CockpitError("Company is required");
  const actor = context.actor;
  if (!actor || actor.type !== "user") throw new CockpitError("Only a board user can read the Decide queue");
  const caller = assignableUser(typeof actor.userId === "string" ? actor.userId : null);
  if (!caller) throw new CockpitError("Only a board user can read the Decide queue");
  const roles = await getRoles(env.ctx, context.companyId);
  const owner = assignableUser(roles?.ownerUserId ?? null);
  return { companyId: context.companyId, ownerUserId: owner ?? "", isOwner: !!owner && owner === caller };
}

export async function decideQueue(env: Env, context: PluginPerformActionContext): Promise<DecideQueue> {
  const { companyId, ownerUserId, isOwner } = await requireOwnerOrNot(env, context);
  const now = env.now();
  if (!isOwner) return { items: [], notOwner: true, partial: [], cardsAsOf: null, cardsRefreshing: false, builtAt: now.toISOString() };

  const hit = cache.get(companyId);
  if (hit && now.getTime() - hit.at < CACHE_MS) return { ...hit.value, cardsRefreshing: cardsRefreshing(companyId) };

  const startedAt = Date.now();
  const log = (text: string, meta: Record<string, unknown>) => env.ctx.logger.info(text, meta);
  const budget = briefBudget(log, { totalMs: QUEUE_MS });
  const gathered: Gathered = {};
  const read = async () => {
    // The index read is one state key: it comes first so a stale one starts its refresh at once.
    const index = await budget.guard("cards", () => readCardIndex(env, companyId), null as CardIndex | null);
    gathered.index = index;
    if (!index || now.getTime() - Date.parse(index.at) > INDEX_STALE_MS) startCardRefresh(env, companyId);
    await Promise.all([
      budget.guard("asks", () => listOpenAsks(env, companyId, 200), [] as AskRow[]).then((asks) => {
        gathered.asks = asks;
      }),
      loadCompanyData(env, companyId, 1, 24, budget).then((data) => {
        gathered.data = data;
      }),
    ]);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const outer = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), Math.max(0, OUTER_MS - (Date.now() - startedAt)));
  });
  const failed: string[] = [];
  const done = await Promise.race([read().then(() => "done" as const).catch((error) => {
    failed.push(message(error));
    return "done" as const;
  }), outer]);
  clearTimeout(timer);

  const partial: string[] = [];
  if (done === "late") partial.push("the queue (ran out of time; what was read is shown)");
  if (failed.length) partial.push("the queue (a read failed)");
  if (!gathered.data && done === "done" && !failed.length) partial.push("the owner list");
  for (const name of budget.degraded) {
    if (name === "cards") partial.push("the stored approval cards");
    else if (name === "asks") partial.push("the questions agents asked");
    else if (name === "approvals") partial.push("approvals");
    else if (["snapshots", "ownerIssues", "ownChecks"].includes(name)) partial.push("some waiting lists");
  }
  if (!gathered.data && done === "late") partial.push("the owner list");
  // Cards the last refresh could not read are told to the page but do not stop the cache: only a refresh changes them.
  const unreadCards = gathered.index?.unread ? [gathered.index.unread] : [];
  const value: DecideQueue = {
    items: assemble(gathered, ownerUserId, now),
    notOwner: false,
    partial: [...new Set([...partial, ...unreadCards])],
    cardsAsOf: gathered.index?.at ?? null,
    cardsRefreshing: cardsRefreshing(companyId),
    builtAt: now.toISOString(),
  };
  // A partial answer is not kept: the next call tries again.
  if (partial.length === 0) cache.set(companyId, { at: now.getTime(), value });
  return value;
}
