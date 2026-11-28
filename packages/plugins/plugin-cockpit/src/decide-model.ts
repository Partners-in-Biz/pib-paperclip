/**
 * The Decide queue as the owner sees it (PAR-15315, T1): one list of the things that wait on the owner for a
 * decision, most urgent first, in one shape the page can render one card at a time. Pure: the loader (decide.ts)
 * reads the host and hands plain sources in. The owner list itself comes from `waitingSplit(...).owner`, the same
 * function the 16:00 digest uses, so the two cannot drift.
 *
 * Which items can be decided inline (`mode: "decide"`) and which only link to the task (`mode: "open"`):
 *   - an ask with options, whose owner is the owner (or nobody): decide;
 *   - an approval of type `request_board_approval` or `approve_ceo_strategy` that is `pending`: decide. `hire_agent`
 *     and `budget_override_required` create an agent or move a budget, and a one-line card cannot show enough: open;
 *   - a `request_confirmation` card, pending, addressed to nobody or the owner: decide. Every other card kind
 *     (free text, checkbox, ask_user_questions) opens the task.
 */
import type { WaitingItem } from "./merge.js";

export const TITLE_MAX = 140;
export const DETAIL_FIELDS_MAX = 8;
export const DETAIL_VALUE_MAX = 200;
const WHY_MAX = 400;

export type DecideKind = "ask" | "approval" | "card";
export type DecideMode = "decide" | "open";
/** Sort class: money, legal, grant, decision, then everything else. */
export type DecideClass = "money" | "legal" | "grant" | "decision" | "other";

const CLASS_RANK: Record<DecideClass, number> = { money: 0, legal: 1, grant: 2, decision: 3, other: 4 };

/** Approval types the owner may decide with one click. */
export const INLINE_APPROVAL_TYPES: readonly string[] = ["request_board_approval", "approve_ceo_strategy"];

export interface DecideDetail {
  label: string;
  value: string;
}

export interface DecideItem {
  ref: { kind: DecideKind; id: string; issueId: string | null };
  /** One line, at most {@link TITLE_MAX} characters. */
  title: string;
  why: string;
  options: string[];
  /** One of `options`, or null. */
  recommended: string | null;
  /** What an approve does: the approval payload's string and number fields. */
  details: DecideDetail[];
  mode: DecideMode;
  href: string | null;
  since: string | null;
  overdue: boolean;
  class: DecideClass;
}

// ---------------------------------------------------------------------------
// Sources (what the loader reads)
// ---------------------------------------------------------------------------

export interface AskSource {
  id: string;
  issueId: string | null;
  question: string;
  why: string | null;
  /** What a yes does, when the ask has an effect. */
  effect: string | null;
  options: string[];
  recommended: string | null;
  kind: "decision" | "grant" | "money" | "legal" | "info";
  askedAt: string | null;
  dueBy: string | null;
  deadlineAt: string | null;
  /** The person the ask is for; null = the company's owner. */
  ownerUserId: string | null;
  /** False when the stored ask row could not be read: the card then only opens the task. */
  rowKnown: boolean;
  href: string | null;
}

export interface ApprovalSource {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown> | null;
  title: string;
  why: string;
  kind: WaitingItem["kind"];
  createdAt: string | null;
  href: string | null;
}

export interface CardSource {
  id: string;
  issueId: string;
  kind: string;
  status: string;
  title: string | null;
  text: string;
  createdAt: string | null;
  addresseeUserId?: string | null;
  addresseeAgentId?: string | null;
}

// ---------------------------------------------------------------------------
// Small rules
// ---------------------------------------------------------------------------

/** One line, cut to `max` characters (the last one is an ellipsis when it was cut). */
export function oneLine(text: string, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…` : flat;
}

/** The recommended option only when it is one of the options. */
export function keepRecommended(recommended: string | null | undefined, options: readonly string[]): string | null {
  return recommended && options.includes(recommended) ? recommended : null;
}

export function approvalMode(type: string, status: string): DecideMode {
  return status === "pending" && INLINE_APPROVAL_TYPES.includes(type) ? "decide" : "open";
}

/** The payload's string and number fields (at most 8, in the payload's order, each value cut to 200 characters). */
export function approvalDetails(payload: Record<string, unknown> | null | undefined): DecideDetail[] {
  const out: DecideDetail[] = [];
  if (!payload || typeof payload !== "object") return out;
  for (const [key, value] of Object.entries(payload)) {
    if (out.length >= DETAIL_FIELDS_MAX) break;
    if (typeof value === "string") {
      const text = oneLine(value, DETAIL_VALUE_MAX);
      if (text) out.push({ label: oneLine(key, 60), value: text });
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out.push({ label: oneLine(key, 60), value: String(value) });
    }
  }
  return out;
}

/** `decide`: Peet can click it. `open`: another kind of card. `null`: not his (addressed to an agent or another person) or not waiting. */
export function cardMode(card: Pick<CardSource, "kind" | "status" | "addresseeUserId" | "addresseeAgentId">, ownerUserId: string | null): DecideMode | null {
  if (card.status !== "pending") return null;
  if (card.addresseeAgentId) return null;
  if (card.addresseeUserId && card.addresseeUserId !== ownerUserId) return null;
  return card.kind === "request_confirmation" ? "decide" : "open";
}

function askClass(kind: AskSource["kind"]): DecideClass {
  return kind === "info" ? "other" : kind === "decision" ? "decision" : kind;
}

function approvalClass(kind: WaitingItem["kind"]): DecideClass {
  return kind === "money" || kind === "legal" || kind === "grant" ? kind : kind === "judgement" ? "decision" : "other";
}

function time(value: string | null | undefined): number {
  const t = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(t) ? Number.NaN : t;
}

function isOverdue(now: Date, ...dates: Array<string | null | undefined>): boolean {
  return dates.some((d) => {
    const t = time(d);
    return !Number.isNaN(t) && t < now.getTime();
  });
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export function askItem(ask: AskSource, ownerUserId: string | null, now: Date): DecideItem {
  const options = ask.options.filter((o) => typeof o === "string" && o.trim());
  const forOwner = !ask.ownerUserId || ask.ownerUserId === ownerUserId;
  return {
    ref: { kind: "ask", id: ask.id, issueId: ask.issueId },
    title: oneLine(ask.question, TITLE_MAX),
    why: oneLine([ask.why, ask.effect].filter(Boolean).join(" "), WHY_MAX),
    options,
    recommended: keepRecommended(ask.recommended, options),
    details: [],
    mode: ask.rowKnown && forOwner && options.length > 0 ? "decide" : "open",
    href: ask.href,
    since: ask.askedAt,
    overdue: isOverdue(now, ask.deadlineAt, ask.dueBy),
    class: askClass(ask.kind),
  };
}

export function approvalItem(approval: ApprovalSource): DecideItem {
  const mode = approvalMode(approval.type, approval.status);
  return {
    ref: { kind: "approval", id: approval.id, issueId: null },
    title: oneLine(approval.title, TITLE_MAX),
    why: oneLine(approval.why, WHY_MAX),
    options: mode === "decide" ? ["Approve", "Reject"] : [],
    recommended: null,
    details: mode === "decide" ? approvalDetails(approval.payload) : [],
    mode,
    href: approval.href,
    since: approval.createdAt,
    overdue: false,
    class: approvalClass(approval.kind),
  };
}

export function cardItem(card: CardSource, ownerUserId: string | null): DecideItem | null {
  const mode = cardMode(card, ownerUserId);
  if (!mode) return null;
  const lines = card.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const title = card.title || lines[0] || "A card waits for you";
  const rest = card.title ? lines : lines.slice(1);
  return {
    ref: { kind: "card", id: card.id, issueId: card.issueId },
    title: oneLine(title, TITLE_MAX),
    why: oneLine(rest.join(" "), WHY_MAX),
    options: mode === "decide" ? ["Accept", "Reject"] : [],
    recommended: null,
    details: [],
    mode,
    href: `/issues/${card.issueId}`,
    since: card.createdAt,
    overdue: false,
    class: "decision",
  };
}

/** Overdue first, then money > legal > grant > decision > other, then oldest `since` (none last), then ref kind and id so the order is stable. */
export function rankItems(items: DecideItem[]): DecideItem[] {
  return [...items].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const byClass = CLASS_RANK[a.class] - CLASS_RANK[b.class];
    if (byClass !== 0) return byClass;
    const ta = time(a.since);
    const tb = time(b.since);
    if (ta !== tb && !(Number.isNaN(ta) && Number.isNaN(tb))) {
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return ta - tb;
    }
    const key = (i: DecideItem) => `${i.ref.kind}:${i.ref.id}`;
    return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  });
}

export interface QueueInput {
  now: Date;
  ownerUserId: string | null;
  asks: AskSource[];
  approvals: ApprovalSource[];
  cards: CardSource[];
}

export function buildQueue(input: QueueInput): DecideItem[] {
  const items: DecideItem[] = [];
  for (const ask of input.asks) items.push(askItem(ask, input.ownerUserId, input.now));
  for (const approval of input.approvals) items.push(approvalItem(approval));
  for (const card of input.cards) {
    const item = cardItem(card, input.ownerUserId);
    if (item) items.push(item);
  }
  return rankItems(items);
}
