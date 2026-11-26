/**
 * Signing for Studio cards on a Planning Canvas board (PAR-14280; plan PAR-14257 B.2 D, E "S1, 3"). No React here, so
 * tests can load it.
 *
 * Every card asks Studio for its state and a signed link when it is drawn: "asset-urls" with the board's scope, so each
 * view passes Studio's client check. Cards drawn together share one call (one per board, at most 100 files), and a link
 * signed in the last minute is reused, so a pan across 500 nodes costs a few calls, not 500. A card asks again before
 * its link expires (300 s) and after an image error.
 */

/** Studio signs links for 300 s. */
export const SIGNED_FOR_MS = 300_000;
/** Ask again this long before a link expires. */
export const RESIGN_MARGIN_MS = 30_000;
/** A link signed this recently is reused by a card drawn again (panning, zoom). */
export const REUSE_MS = 60_000;
/** After a failure, or a second image error in a row, try again this soon. */
export const RETRY_MS = 20_000;
/** Cards drawn within this window share one call. */
export const BATCH_MS = 25;
/** The worker signs at most 100 files a call. */
export const MAX_BATCH = 100;

export type CardState =
  | { state: "loading" }
  | { state: "ready"; url: string; kind: string; name: string; mime: string; altText: string | null; expiresAt: number }
  /** No such file, or archived in Studio. */
  | { state: "removed" }
  /** Not this board's work, client media for a restricted member, or no Studio access: a placeholder, never retried. */
  | { state: "refused" }
  /** Studio's switch for board cards is off. */
  | { state: "off" }
  | { state: "error"; retryAt: number }
  /** An output card whose generation is still queued or running (PAR-14281). */
  | { state: "pending"; label: string }
  /** An output card whose generation failed. */
  | { state: "failed"; message: string };

export type StudioCall = (params: Record<string, unknown>) => Promise<unknown>;

interface Reply {
  urls?: Record<string, string>;
  failed?: string[];
  withheld?: string[];
  refused?: string[];
  removed?: string[];
  assets?: Record<string, { name?: string; kind?: string; mime?: string; altText?: string | null }>;
}

/** What one "asset-urls" reply means for each card. */
export function cardStatesFromReply(out: unknown, ids: string[], signedAt: number): Record<string, CardState> {
  const reply = (out ?? {}) as Reply;
  const has = (list: string[] | undefined, id: string) => Array.isArray(list) && list.includes(id);
  const states: Record<string, CardState> = {};
  for (const id of ids) {
    const url = reply.urls?.[id];
    const meta = reply.assets?.[id];
    if (typeof url === "string" && url && meta) {
      states[id] = { state: "ready", url, kind: meta.kind ?? "image", name: meta.name ?? "", mime: meta.mime ?? "", altText: meta.altText ?? null, expiresAt: signedAt + SIGNED_FOR_MS - RESIGN_MARGIN_MS };
    } else if (has(reply.removed, id)) states[id] = { state: "removed" };
    else if (has(reply.refused, id) || has(reply.withheld, id)) states[id] = { state: "refused" };
    else states[id] = { state: "error", retryAt: signedAt + RETRY_MS };
  }
  return states;
}

/** A failed call: the switch, a refusal (no Studio access, not a member) or a passing fault. */
export function cardStateFromError(error: unknown, now: number): CardState {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  if (code === "board_cards_off") return { state: "off" };
  // Core's restriction answer was missing: closed for now, but it comes back on its own.
  if (code === "MEMBER_RESTRICTION_UNAVAILABLE") return { state: "error", retryAt: now + RETRY_MS };
  if (name === "AccessRefused") return { state: "refused" };
  return { state: "error", retryAt: now + RETRY_MS };
}

/** When a card should ask again, in ms from now; null when it never does. */
export function nextCheckIn(state: CardState, now: number): number | null {
  if (state.state === "ready") return Math.max(0, state.expiresAt - now);
  if (state.state === "error") return Math.max(0, state.retryAt - now);
  return null;
}

interface Group {
  call: StudioCall;
  companyId: string;
  projectId: string | null;
  waiters: Map<string, Array<(state: CardState) => void>>;
}

interface Clock {
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
}

const realClock: Clock = { now: () => Date.now(), schedule: (fn, ms) => setTimeout(fn, ms) };

/** One per page: cards of every board on the page share it. */
export class BoardSigner {
  private groups = new Map<string, Group>();
  private cache = new Map<string, { state: CardState; at: number }>();
  private pending = false;

  constructor(private clock: Clock = realClock) {}

  /** The card's state. `fresh` skips a reused link (expiry and image errors). */
  request(call: StudioCall, companyId: string, projectId: string | null, assetId: string, opts: { fresh?: boolean } = {}): Promise<CardState> {
    const boardKey = `${companyId}|${projectId ?? ""}`;
    const hit = this.cache.get(`${boardKey}|${assetId}`);
    if (!opts.fresh && hit && hit.state.state === "ready" && this.clock.now() - hit.at < REUSE_MS) return Promise.resolve(hit.state);
    return new Promise((resolve) => {
      let group = this.groups.get(boardKey);
      if (!group) {
        group = { call, companyId, projectId, waiters: new Map() };
        this.groups.set(boardKey, group);
      }
      const list = group.waiters.get(assetId) ?? [];
      list.push(resolve);
      group.waiters.set(assetId, list);
      if (!this.pending) {
        this.pending = true;
        this.clock.schedule(() => void this.flush(), BATCH_MS);
      }
    });
  }

  /** Forget a link that failed to load, so the next request signs again. */
  forget(companyId: string, projectId: string | null, assetId: string): void {
    this.cache.delete(`${companyId}|${projectId ?? ""}|${assetId}`);
  }

  private async flush(): Promise<void> {
    this.pending = false;
    const groups = [...this.groups.entries()];
    this.groups.clear();
    await Promise.all(
      groups.flatMap(([boardKey, group]) => {
        const ids = [...group.waiters.keys()];
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += MAX_BATCH) chunks.push(ids.slice(i, i + MAX_BATCH));
        return chunks.map(async (chunk) => {
          const at = this.clock.now();
          let states: Record<string, CardState>;
          try {
            const out = await group.call({ companyId: group.companyId, assetIds: chunk, boardScope: { projectId: group.projectId } });
            states = cardStatesFromReply(out, chunk, at);
          } catch (error) {
            const state = cardStateFromError(error, at);
            states = Object.fromEntries(chunk.map((id) => [id, state]));
          }
          for (const id of chunk) {
            const state = states[id];
            if (state.state === "ready") this.cache.set(`${boardKey}|${id}`, { state, at });
            else this.cache.delete(`${boardKey}|${id}`);
            for (const resolve of group.waiters.get(id) ?? []) resolve(state);
          }
        });
      }),
    );
  }
}

/** The page's one signer. */
export const boardSigner = new BoardSigner();

/**
 * An embed node to place a Studio file on the board (`applyOps`). Core never reads `props`; the card reads only the
 * asset id, and checks it on every draw, so a node written by hand or by an agent gets the same refusals.
 */
export function embedNodeOp(input: { pluginKey: string; type: string; assetId: string; name: string; kind: string; at: { x: number; y: number }; key?: string }) {
  const key = input.key ?? `studio-${input.assetId.slice(0, 40)}-${Math.random().toString(36).slice(2, 10)}`;
  const video = input.kind === "video";
  return {
    op: "add" as const,
    item: {
      itemType: "node" as const,
      key,
      kind: "embed" as const,
      x: input.at.x,
      y: input.at.y,
      width: 320,
      height: video ? 220 : 280,
      zIndex: 1,
      color: "slate" as const,
      title: input.name.slice(0, 300),
      content: "",
      data: { plugin: input.pluginKey, type: input.type, assetId: input.assetId, props: {} },
    },
  };
}

/* The library panel (BoardLibrary.tsx): its reply and load states, kept here so tests load no React. */

export interface BoardLibraryItem {
  id: string;
  name: string;
  kind: string;
  mime: string;
  altText: string | null;
}

export interface BoardLibraryReply {
  board: { kind: "client" | "own"; name: string | null };
  assets: BoardLibraryItem[];
  withheld: boolean;
}

export type LibraryLoad = { status: "loading" } | { status: "off" } | { status: "error"; message: string } | { status: "ready"; reply: BoardLibraryReply };

/** A refused or failed "board-library" call. A person without Studio access reads one plain line. */
export function libraryLoadFromError(error: unknown): LibraryLoad {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  if (code === "board_cards_off") return { status: "off" };
  if (name === "AccessRefused" && code !== "MEMBER_RESTRICTION_UNAVAILABLE") return { status: "error", message: "Studio isn't open to you in this company." };
  return { status: "error", message: `Studio files didn't load: ${error instanceof Error ? error.message : String(error)}` };
}

/** Where the n-th placed card goes: the seam passes no viewport, so cards step down from the board's origin. */
export function placeAt(n: number): { x: number; y: number } {
  return { x: 80 + (n % 10) * 32, y: 80 + (n % 10) * 32 };
}
