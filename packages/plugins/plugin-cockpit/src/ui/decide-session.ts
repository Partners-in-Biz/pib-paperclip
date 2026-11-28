/**
 * The Decide tab's state, without React (PAR-15315, T3): one card at a time, a decision drops the card locally
 * (no queue re-fetch), Refresh re-fetches, and a queue that says `cardsRefreshing` is fetched once more 20 s later.
 * The page wraps this in a hook; tests drive it with fake timers.
 */
import type { DecideItem } from "../decide-model.js";

/** The `decide.queue` answer, as the page reads it. */
export interface DecideData {
  items: DecideItem[];
  notOwner: boolean;
  partial: string[];
  cardsAsOf: string | null;
  cardsRefreshing: boolean;
  builtAt?: string;
}

export interface DecideMedia {
  kind: "image" | "video";
  src: string;
  name: string | null;
}

export type DecideResult = "ok" | "already_decided" | "issue_closed";
const SETTLED: readonly string[] = ["ok", "already_decided", "issue_closed"];
const FLASH_TEXT: Record<DecideResult, string> = { ok: "Done", already_decided: "Already decided", issue_closed: "Done. The task is closed." };

export const FLASH_MS = 1_000;
export const REFETCH_MS = 20_000;

export interface DecideState {
  loading: boolean;
  loadError: string | null;
  data: DecideData | null;
  /** The cards still to go through: the queue minus what was decided here. */
  items: DecideItem[];
  pos: number;
  busy: boolean;
  flash: string | null;
  error: string | null;
  /** Media by issue id: a value (or null for none) once read; absent while not asked for. */
  media: Record<string, DecideMedia | null>;
}

export interface DecideDeps {
  load: () => Promise<DecideData>;
  /** Run the decision the option stands for; resolves with the worker's `result`. */
  act: (item: DecideItem, option: string) => Promise<string>;
  media: (issueId: string) => Promise<DecideMedia | null>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/** The action key and params that an option click stands for. */
export function decisionCall(item: DecideItem, option: string): { action: "decide.ask" | "decide.approval" | "decide.card"; params: Record<string, unknown> } {
  if (item.ref.kind === "ask") return { action: "decide.ask", params: { askId: item.ref.id, option } };
  if (item.ref.kind === "approval") return { action: "decide.approval", params: { approvalId: item.ref.id, action: option === "Approve" ? "approve" : "reject" } };
  return { action: "decide.card", params: { issueId: item.ref.issueId, interactionId: item.ref.id, action: option === "Accept" ? "accept" : "reject" } };
}

const sameRef = (a: DecideItem, b: DecideItem) => a.ref.kind === b.ref.kind && a.ref.id === b.ref.id;

export class DecideSession {
  state: DecideState = { loading: false, loadError: null, data: null, items: [], pos: 0, busy: false, flash: null, error: null, media: {} };
  private listeners = new Set<() => void>();
  private asked = new Set<string>();
  private refetchTimer: unknown = null;
  private flashTimer: unknown = null;
  private disposed = false;
  private generation = 0;

  constructor(private deps: DecideDeps) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  getSnapshot = (): DecideState => this.state;

  private set(patch: Partial<DecideState>): void {
    this.state = { ...this.state, ...patch };
    this.wantMedia();
    for (const fn of this.listeners) fn();
  }

  private timer(fn: () => void, ms: number): unknown {
    return (this.deps.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms);
  }

  private untimer(id: unknown): void {
    if (id !== null) (this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(id);
  }

  /** The current card and the next one only. */
  private wantMedia(): void {
    const { items, pos } = this.state;
    for (const item of [items[pos], items[pos + 1]]) {
      const id = item?.ref.issueId;
      if (!id || this.asked.has(id)) continue;
      this.asked.add(id);
      void this.deps.media(id).then(
        (m) => this.setMedia(id, m),
        () => this.setMedia(id, null),
      );
    }
  }

  private setMedia(issueId: string, media: DecideMedia | null): void {
    if (this.disposed) return;
    this.state = { ...this.state, media: { ...this.state.media, [issueId]: media } };
    for (const fn of this.listeners) fn();
  }

  /** Fetch the queue. `again` is the one automatic re-fetch, which does not schedule another. */
  async refresh(again = false): Promise<void> {
    this.untimer(this.refetchTimer);
    this.refetchTimer = null;
    const mine = ++this.generation;
    const keep = this.state.items[this.state.pos];
    this.set({ loading: true, loadError: null });
    try {
      const data = await this.deps.load();
      if (this.disposed || mine !== this.generation) return;
      const at = keep ? data.items.findIndex((i) => sameRef(i, keep)) : -1;
      this.set({ loading: false, data, items: data.items, pos: at >= 0 ? at : 0, error: null });
      if (data.cardsRefreshing && !again) {
        this.refetchTimer = this.timer(() => {
          this.refetchTimer = null;
          void this.refresh(true);
        }, REFETCH_MS);
      }
    } catch (err) {
      if (this.disposed || mine !== this.generation) return;
      this.set({ loading: false, loadError: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Space: the next card, without deciding. After the last one it goes back to the first. */
  next(): void {
    const { items, pos, busy } = this.state;
    if (busy || items.length < 2) return;
    this.set({ pos: (pos + 1) % items.length, error: null });
  }

  /** Click an option on the current card. */
  async decide(option: string): Promise<void> {
    const { items, pos, busy } = this.state;
    const item = items[pos];
    if (!item || busy || item.mode !== "decide" || !item.options.includes(option)) return;
    this.set({ busy: true, error: null });
    let result: string;
    try {
      result = await this.deps.act(item, option);
    } catch (err) {
      if (!this.disposed) this.set({ busy: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (this.disposed) return;
    if (!SETTLED.includes(result)) {
      this.set({ busy: false, error: `Unexpected answer: ${result}` });
      return;
    }
    this.set({ flash: FLASH_TEXT[result as DecideResult] });
    this.flashTimer = this.timer(() => {
      this.flashTimer = null;
      if (this.disposed) return;
      const rest = this.state.items.filter((i) => !sameRef(i, item));
      const at = Math.min(this.state.pos, Math.max(0, rest.length - 1));
      this.set({ items: rest, pos: rest.length ? at : 0, flash: null, busy: false });
    }, FLASH_MS);
  }

  dispose(): void {
    this.disposed = true;
    this.untimer(this.refetchTimer);
    this.untimer(this.flashTimer);
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// Keys and media (pure)
// ---------------------------------------------------------------------------

export type DecideKey = "next" | "open";

interface KeyLike {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  target?: unknown;
}

/** True when typing goes to a field: no shortcut then. */
export function inField(target: KeyLike["target"]): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = String(el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

/** Space is next, Enter opens the task. Nothing else, and never a decision. */
export function keyIntent(e: KeyLike): DecideKey | null {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat || inField(e.target)) return null;
  if (e.key === " " || e.key === "Spacebar") return "next";
  if (e.key === "Enter") return "open";
  return null;
}

/** The newest image or video among an issue's attachments. */
export function pickMedia(rows: unknown): DecideMedia | null {
  const list = Array.isArray(rows) ? rows : rows && typeof rows === "object" ? ((rows as Record<string, unknown>).data ?? (rows as Record<string, unknown>).items) : null;
  if (!Array.isArray(list)) return null;
  let best: { time: number; media: DecideMedia } | null = null;
  for (const raw of list) {
    const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (!row || typeof row.contentType !== "string" || typeof row.contentPath !== "string" || !row.contentPath.startsWith("/")) continue;
    const kind = row.contentType.startsWith("image/") ? "image" : row.contentType.startsWith("video/") ? "video" : null;
    if (!kind) continue;
    const parsed = typeof row.createdAt === "string" ? Date.parse(row.createdAt) : Number.NaN;
    const time = Number.isNaN(parsed) ? 0 : parsed;
    if (!best || time >= best.time) best = { time, media: { kind, src: row.contentPath, name: typeof row.originalFilename === "string" ? row.originalFilename : null } };
  }
  return best?.media ?? null;
}
