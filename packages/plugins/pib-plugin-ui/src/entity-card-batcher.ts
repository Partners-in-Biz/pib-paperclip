/**
 * Entity card batcher (plan PAR-14389 C.1). The cards of one plugin on one board share one batcher: ids asked
 * within a short window go out as one `canvas.cards.resolve` call (at most 100 ids), and the answers are kept for
 * as long as the batcher lives (the board stays open). No timed cache; a reload builds a new batcher.
 *
 * Every refusal shape maps to the same `hidden` state, so a card never says why it is closed:
 *   - `{ type, id, hidden: true }` (the plugin's own answer)
 *   - core 403 `MEMBER_RESTRICTED` or `CANVAS_CARDS_PERSON_ONLY`, or any 403
 *   - the kit guard's `{ ok: false, refused: true }` (read with `isRefusal`)
 *   - Social's `{ ok: false, error: { code: "SOCIAL_RULE" } }`
 * A 5xx, a network failure or an answer it cannot read becomes `error`, which the card draws with a retry.
 * This package has no `zod` or `shared` dependency, so the shapes are read by hand (same bounds as
 * `packages/shared/src/canvas-cards.ts`).
 */
import { isRefusal } from "./refusal.js";

export const CARD_BATCH_WINDOW_MS = 30;
export const CARD_BATCH_MAX_IDS = 100;
const CARD_META_MAX = 4;

export interface EntityCardMeta {
  label: string;
  value: string;
}

export interface EntityCardSummary {
  type: string;
  id: string;
  title: string;
  subtitle?: string;
  status?: string;
  meta?: EntityCardMeta[];
  href: string;
}

export type EntityCardState =
  | { state: "card"; card: EntityCardSummary }
  | { state: "hidden" }
  | { state: "error" };

export type CardsResolve = (params: { items: { type: string; id: string }[] }) => Promise<unknown>;

const HIDDEN: EntityCardState = { state: "hidden" };
const FAILED: EntityCardState = { state: "error" };
const REFUSAL_CODES = ["MEMBER_RESTRICTED", "CANVAS_CARDS_PERSON_ONLY"];

/** A thrown error that means "not allowed": a 403 or one of core's two codes (the bridge may give only the message). */
function isForbiddenError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
  if (e.status === 403 || e.statusCode === 403) return true;
  if (typeof e.code === "string" && REFUSAL_CODES.includes(e.code)) return true;
  return typeof e.message === "string" && REFUSAL_CODES.some((code) => (e.message as string).includes(code));
}

/** A whole-answer refusal in the kit's shape or Social's. */
function isRefusedAnswer(answer: unknown): boolean {
  if (isRefusal(answer)) return true;
  if (!answer || typeof answer !== "object") return false;
  const v = answer as { ok?: unknown; error?: unknown };
  return v.ok === false && !!v.error && typeof v.error === "object" && (v.error as { code?: unknown }).code === "SOCIAL_RULE";
}

/** Relative app path with exactly one leading slash and no control characters (browsers drop tab and newline, so "/\t/x" would become "//x"). Anything else is not drawn as a link. */
export function isCardHref(href: unknown): href is string {
  return typeof href === "string" && /^\/(?![/\\])/.test(href) && !/[\u0000-\u001f\u007f]/.test(href);
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function summaryOf(raw: Record<string, unknown>, type: string, id: string): EntityCardSummary | null {
  if (typeof raw.title !== "string" || typeof raw.href !== "string") return null;
  const meta = Array.isArray(raw.meta)
    ? raw.meta
        .filter((m): m is { label: string; value: string } => !!m && typeof (m as EntityCardMeta).label === "string" && typeof (m as EntityCardMeta).value === "string")
        .slice(0, CARD_META_MAX)
    : undefined;
  return { type, id, title: raw.title.slice(0, 200), subtitle: text(raw.subtitle, 200), status: text(raw.status, 80), meta, href: raw.href };
}

const keyOf = (type: string, id: string) => `${type}\u0000${id}`;

export interface CardBatcher {
  /** The state of one card; asks are grouped and answers kept. */
  load(type: string, id: string): Promise<EntityCardState>;
  /** Forgets a failed card and asks again. */
  retry(type: string, id: string): Promise<EntityCardState>;
}

export function createCardBatcher(resolve: CardsResolve, options: { windowMs?: number; maxIds?: number } = {}): CardBatcher {
  const windowMs = options.windowMs ?? CARD_BATCH_WINDOW_MS;
  const maxIds = options.maxIds ?? CARD_BATCH_MAX_IDS;
  const answers = new Map<string, Promise<EntityCardState>>();
  let queue: { type: string; id: string; settle: (state: EntityCardState) => void }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function send(batch: typeof queue): Promise<void> {
    const settleAll = (state: EntityCardState) => batch.forEach((item) => item.settle(state));
    let answer: unknown;
    try {
      answer = await resolve({ items: batch.map(({ type, id }) => ({ type, id })) });
    } catch (error) {
      settleAll(isForbiddenError(error) ? HIDDEN : FAILED);
      return;
    }
    if (isRefusedAnswer(answer)) return settleAll(HIDDEN);
    const cards = answer && typeof answer === "object" ? (answer as { cards?: unknown }).cards : undefined;
    if (!Array.isArray(cards)) return settleAll(FAILED);
    const byKey = new Map<string, Record<string, unknown>>();
    for (const c of cards) {
      if (c && typeof c === "object" && typeof (c as { type?: unknown }).type === "string" && typeof (c as { id?: unknown }).id === "string") {
        byKey.set(keyOf((c as { type: string }).type, (c as { id: string }).id), c as Record<string, unknown>);
      }
    }
    for (const item of batch) {
      const raw = byKey.get(keyOf(item.type, item.id));
      // A card the plugin did not answer is a "no" like any other.
      if (!raw || raw.hidden === true) item.settle(HIDDEN);
      else {
        const card = summaryOf(raw, item.type, item.id);
        item.settle(card ? { state: "card", card } : FAILED);
      }
    }
  }

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    const pending = queue;
    queue = [];
    for (let i = 0; i < pending.length; i += maxIds) void send(pending.slice(i, i + maxIds));
  }

  function load(type: string, id: string): Promise<EntityCardState> {
    const key = keyOf(type, id);
    const known = answers.get(key);
    if (known) return known;
    const promise = new Promise<EntityCardState>((settle) => {
      queue.push({ type, id, settle });
      if (queue.length >= maxIds) flush();
      else if (!timer) timer = setTimeout(flush, windowMs);
    });
    answers.set(key, promise);
    return promise;
  }

  return {
    load,
    retry(type, id) {
      answers.delete(keyOf(type, id));
      return load(type, id);
    },
  };
}
