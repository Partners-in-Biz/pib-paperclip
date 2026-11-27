/**
 * Per-turn timing for Direct voice (plan PAR-14996, T1). Pure: `DirectSession` feeds browser `Date.now()` marks
 * into a `TurnClock`; `assignReplies` pairs agent replies with the turns they answer; `turnStats` turns the rows
 * into p50/p95 per step. A step that did not happen (barge-in, no reply) is left out, never counted as zero.
 */
import { ENDPOINT_END_QUIET_MS } from "../limits.js";

export type TurnProvider = "gemini" | "grok";
export type ReplyVia = "event" | "poll";

/** Marks of one spoken reply (the first comment of a reply group), all browser ms except `gap`. */
export interface SpeakMarks {
  speakStartAt?: number;
  audioAt?: number;
  playAt?: number;
  latencyKnown?: boolean;
  provider?: TurnProvider;
  /** Silent ms between the chunks of this reply. */
  gap?: number;
  /** Provider time of the speak call that voiced chunk 0, as the worker measured it (0.2.5+). */
  ttsProviderMs?: number;
}

/**
 * What became of one turn, set exactly once (plan PAR-15051, T1a). `voiced` needs `playAt`; every other value but
 * `answered_together` is a miss and has a note that starts with `Turn <n>:`.
 */
export const TURN_OUTCOMES = [
  "voiced",
  "answered_together",
  "no_reply",
  "voice_failed",
  "sound_blocked",
  "hung_up_voicing",
  "talked_over",
  "not_sent",
  "not_heard",
] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

/** One turn: what the browser saw and, once a reply is assigned, what the agent side did. */
export interface TurnRow extends SpeakMarks {
  n: number;
  /** Endpointer `start` event: when the person began speaking. */
  startAt?: number;
  endAt: number;
  endKind: "end" | "cap";
  textAt?: number;
  /** Provider time of the transcribe call, as the worker measured it (0.2.5+). */
  sttProviderMs?: number;
  postStartAt?: number;
  postedAt?: number;
  /** The posted comment's own `createdAt` (server clock). */
  serverPostedAt?: number;
  commentId?: string;
  replyServerAt?: number;
  finalServerAt?: number;
  replyComments?: number;
  seenAt?: number;
  via?: ReplyVia;
  /** Set when the reply arrived while this many turns were still unanswered. */
  queuedTurns?: number;
  outcome?: TurnOutcome;
  /** When the local "One moment" line was played for this turn. */
  fillerAt?: number;
}

/** Agent comments of one run (or one lone comment), read from the chat. */
export interface ReplyGroup {
  key: string;
  firstId: string;
  firstServerAt: number;
  finalServerAt: number;
  count: number;
  seenAt: number;
  via: ReplyVia;
  speak?: SpeakMarks;
}

export const STEP_NAMES = ["stt", "sttProvider", "sttRest", "post", "agent", "agentFinal", "detect", "queue", "tts", "ttsProvider", "start", "silence", "gap"] as const;
export type StepName = (typeof STEP_NAMES)[number];
export type StepValues = Partial<Record<StepName, number>>;

const SPLIT_UNDER_MS = 1_500;

const MARK_FIELDS = ["speakStartAt", "audioAt", "playAt", "latencyKnown", "provider", "gap", "ttsProviderMs"] as const;

/** Browser time of a server time is `server - skew`; the skew is one median per call. */
export function clockSkew(rows: TurnRow[]): number {
  const samples: number[] = [];
  for (const r of rows) {
    if (r.serverPostedAt !== undefined && r.postStartAt !== undefined && r.postedAt !== undefined) {
      samples.push(r.serverPostedAt - (r.postStartAt + r.postedAt) / 2);
    }
  }
  if (samples.length === 0) return 0;
  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  return samples.length % 2 ? samples[mid]! : (samples[mid - 1]! + samples[mid]!) / 2;
}

/**
 * Gives each reply group to the oldest posted turn that has no reply yet and was posted before the group's first
 * comment (first come, first served). A group that finds more than one such turn marks the one it answers with
 * `queuedTurns`; a turn no group reaches keeps no reply fields.
 */
export function assignReplies(turns: TurnRow[], groups: ReplyGroup[]): TurnRow[] {
  const rows = turns.map((t) => {
    const copy: TurnRow = { ...t };
    for (const f of ["replyServerAt", "finalServerAt", "replyComments", "seenAt", "via", "queuedTurns", ...MARK_FIELDS] as const) delete copy[f];
    return copy;
  });
  for (const { group: g, row, waiting } of pairReplies(rows, groups)) {
    row.replyServerAt = g.firstServerAt;
    row.finalServerAt = g.finalServerAt;
    row.replyComments = g.count;
    row.seenAt = g.seenAt;
    row.via = g.via;
    if (waiting > 1) row.queuedTurns = waiting;
    if (g.speak) for (const f of MARK_FIELDS) if (g.speak[f] !== undefined) (row as unknown as Record<string, unknown>)[f] = g.speak[f];
  }
  return rows;
}

/** The pairing `assignReplies` uses, on the rows given (not copies): which group answers which turn. */
export function pairReplies(rows: TurnRow[], groups: ReplyGroup[]): Array<{ group: ReplyGroup; row: TurnRow; waiting: number }> {
  const open = rows.filter((r) => r.serverPostedAt !== undefined).sort((a, b) => a.serverPostedAt! - b.serverPostedAt! || a.n - b.n);
  const taken = new Set<TurnRow>();
  const pairs: Array<{ group: ReplyGroup; row: TurnRow; waiting: number }> = [];
  for (const group of [...groups].sort((a, b) => a.firstServerAt - b.firstServerAt)) {
    const waiting = open.filter((r) => !taken.has(r) && r.serverPostedAt! <= group.firstServerAt);
    const row = waiting[0];
    if (!row) continue;
    taken.add(row);
    pairs.push({ group, row, waiting: waiting.length });
  }
  return pairs;
}

/** The steps one turn went through; the ones missing a mark are absent. */
export function rowSteps(row: TurnRow, skew: number, quietMs = ENDPOINT_END_QUIET_MS): StepValues {
  const out: StepValues = {};
  const diff = (to: number | undefined, from: number | undefined) => (to !== undefined && from !== undefined ? to - from : undefined);
  const set = (k: StepName, v: number | undefined) => {
    if (v !== undefined && Number.isFinite(v)) out[k] = v;
  };
  const stt = diff(row.textAt, row.endAt);
  set("stt", stt);
  set("sttProvider", row.sttProviderMs);
  if (stt !== undefined && row.sttProviderMs !== undefined) set("sttRest", stt - row.sttProviderMs);
  set("post", diff(row.postedAt, row.textAt));
  set("agent", diff(row.replyServerAt, row.serverPostedAt));
  set("agentFinal", diff(row.finalServerAt, row.serverPostedAt));
  if (row.seenAt !== undefined && row.replyServerAt !== undefined) set("detect", Math.max(0, row.seenAt - (row.replyServerAt - skew)));
  set("queue", diff(row.speakStartAt, row.seenAt));
  set("tts", diff(row.audioAt, row.speakStartAt));
  set("ttsProvider", row.ttsProviderMs);
  set("start", diff(row.playAt, row.audioAt));
  if (row.playAt !== undefined) set("silence", row.playAt - (row.endKind === "end" ? row.endAt - quietMs : row.endAt));
  set("gap", row.gap);
  return out;
}

export interface StepStat {
  n: number;
  p50: number | null;
  p95: number | null;
}

export interface TurnStats {
  turns: number;
  /** Turns a reply was assigned to. */
  answered: number;
  steps: Record<StepName, StepStat>;
  gemini: number;
  grok: number;
  /** Turns whose speech began under 1.5 s after the previous turn ended, with no reply seen in between. */
  splits: number;
  skewMs: number;
}

/** Nearest-rank percentile of a sorted list. */
export function nearestRank(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export function turnStats(rows: TurnRow[], quietMs = ENDPOINT_END_QUIET_MS): TurnStats {
  const skew = clockSkew(rows);
  const values = Object.fromEntries(STEP_NAMES.map((s) => [s, [] as number[]])) as Record<StepName, number[]>;
  for (const row of rows) {
    const steps = rowSteps(row, skew, quietMs);
    for (const s of STEP_NAMES) if (steps[s] !== undefined) values[s].push(steps[s]!);
  }
  const steps = Object.fromEntries(
    STEP_NAMES.map((s) => {
      const sorted = [...values[s]].sort((a, b) => a - b);
      return [s, { n: sorted.length, p50: nearestRank(sorted, 50), p95: nearestRank(sorted, 95) }];
    }),
  ) as Record<StepName, StepStat>;
  const byEnd = [...rows].sort((a, b) => a.endAt - b.endAt);
  let splits = 0;
  for (let i = 1; i < byEnd.length; i += 1) {
    const prev = byEnd[i - 1]!;
    const cur = byEnd[i]!;
    if (cur.startAt === undefined) continue;
    const gap = cur.startAt - prev.endAt;
    const replied = prev.seenAt !== undefined && prev.seenAt <= cur.startAt;
    if (gap < SPLIT_UNDER_MS && !replied) splits += 1;
  }
  return {
    turns: rows.length,
    answered: rows.filter((r) => r.replyServerAt !== undefined).length,
    steps,
    gemini: rows.filter((r) => r.provider === "gemini").length,
    grok: rows.filter((r) => r.provider === "grok").length,
    splits,
    skewMs: Math.round(skew),
  };
}

export interface TimingConstants {
  quietMs: number;
  firstChunkChars: number;
  awaitPollMs: number;
  /** Window after a post in which the reply is read faster; 0 when there is none. */
  fastWindowMs: number;
  geminiPrefetch: boolean;
}

/** `plugin-voice <version>` plus the constants in force, so two calls can be compared. */
export function timingStamp(version: string, c: TimingConstants): string {
  return [
    `plugin-voice ${version}`,
    `quiet ${c.quietMs} ms`,
    `first chunk ${c.firstChunkChars} chars`,
    `await poll ${c.awaitPollMs} ms`,
    `fast window ${c.fastWindowMs} ms`,
    `Gemini prefetch ${c.geminiPrefetch ? "on" : "off"}`,
  ].join(", ");
}

const tsOf = (iso: unknown): number | undefined => {
  const at = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : undefined;
};
export { tsOf as parseServerTime };

/** Collects the marks of one call. Rows handed to the caller are live: set marks on them directly. */
export class TurnClock {
  private readonly turns: TurnRow[] = [];
  private readonly groups = new Map<string, ReplyGroup>();
  private readonly speaks = new Map<string, SpeakMarks>();
  /** Reply comment id to the key of its group. */
  private readonly groupOf = new Map<string, string>();

  /** A turn whose speech ended at `endAt`; `textAt` is set once it is transcribed. */
  addTurn(init: { startAt?: number; endAt: number; endKind: "end" | "cap"; textAt?: number }): TurnRow {
    const row: TurnRow = { n: this.turns.length + 1, ...init };
    this.turns.push(row);
    return row;
  }

  /** One agent comment read from the chat; comments of the same run join one group. */
  noteReply(row: { id: string; runId?: string | null; createdAt?: string | null }, seenAt: number, via: ReplyVia): void {
    const at = tsOf(row.createdAt);
    if (at === undefined) return;
    const key = row.runId ? `run:${row.runId}` : `row:${row.id}`;
    this.groupOf.set(row.id, key);
    const group = this.groups.get(key);
    if (!group) {
      this.groups.set(key, { key, firstId: row.id, firstServerAt: at, finalServerAt: at, count: 1, seenAt, via });
      return;
    }
    group.count += 1;
    if (at < group.firstServerAt) {
      group.firstServerAt = at;
      group.firstId = row.id;
    }
    group.finalServerAt = Math.max(group.finalServerAt, at);
  }

  /** The marks the speaker writes for the reply that starts with this comment. */
  speakMarks(commentId: string): SpeakMarks {
    let marks = this.speaks.get(commentId);
    if (!marks) {
      marks = {};
      this.speaks.set(commentId, marks);
    }
    return marks;
  }

  get size(): number {
    return this.turns.length;
  }

  /** The live row of turn `n` (1-based). */
  turn(n: number): TurnRow | undefined {
    return this.turns[n - 1];
  }

  /** The live turn a reply comment answers, by the same pairing as `rows()`; undefined while it answers none. */
  turnForReply(commentId: string): TurnRow | undefined {
    const key = this.groupOf.get(commentId);
    if (!key) return undefined;
    return pairReplies(this.turns, [...this.groups.values()]).find((p) => p.group.key === key)?.row;
  }

  rows(): TurnRow[] {
    return assignReplies(this.turns, this.groupsWithMarks());
  }

  private groupsWithMarks(): ReplyGroup[] {
    return [...this.groups.values()].map((g) => ({ ...g, speak: this.speaks.get(g.firstId) }));
  }
}
