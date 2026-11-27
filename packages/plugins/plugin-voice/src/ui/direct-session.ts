/**
 * Direct voice (plan PAR-14808, T4): the person talks to the agent itself. Each utterance is transcribed and
 * posted as the person's own comment in the agent's chat; the agent's own reply comments are read out word for
 * word (after `speech-text`) in that agent's voice. No realtime model sits in between.
 *
 * Reply delivery: the person's live-events socket (`ReplyFeed`) and an always-on poll both read new comments
 * into one `seen` set, so a comment is spoken at most once however it arrived.
 */
import { base64ToArrayBuffer, MicCapture, Player } from "./audio.js";
import { AgentChat, clip, type ApiClient, type ChatTarget } from "./agent-chat.js";
import type { CallContext } from "./call-context.js";
import { BargeInDetector, Endpointer } from "./endpointing.js";
import { ReplyFeed } from "./reply-feed.js";
import { chunk, REST_IN_CHAT, toSpeech } from "./speech-text.js";
import { pruneBuffers, writeBuffer } from "./transcript-buffer.js";
import type { TranscriptEntry } from "./live-session.js";
import type { CallRecord, LogEntry, SaveTarget } from "./transcript-report.js";
import { parseServerTime, TurnClock, timingStamp, type ReplyVia, type TurnRow } from "./turn-timing.js";
import { newUuid } from "./uuid.js";
import type { WakeGuard } from "./wake-lock.js";
import { concatPcm16, encodeWav } from "./wav.js";
import { PLUGIN_VERSION } from "../namespace.js";
import {
  DIRECT_REFETCH_MS,
  DIRECT_AWAIT_FAST_MS,
  DIRECT_AWAIT_POLL_MS,
  DIRECT_REPLY_POLL_MS,
  GEMINI_PREFETCH,
  DIRECT_SEND_ATTEMPTS,
  ENDPOINT_END_QUIET_MS,
  ENDPOINT_PREROLL_MS,
  SPEECH_FIRST_CHUNK_CHARS,
  TTS_SAMPLE_RATE,
  XAI_SPEAK_ATTEMPTS,
} from "../limits.js";

export type DirectState = "starting" | "listening" | "hearing" | "sending" | "working" | "speaking" | "ended" | "error";
export type SpeakProvider = "gemini" | "grok";

export type SpeakFn = (params: { agentId: string; text: string; provider: SpeakProvider }) => Promise<unknown>;
export type TranscribeFn = (params: { audio: string; mimeType: string }) => Promise<unknown>;

export const GEMINI_FALLBACK_NOTICE = "Gemini voice unavailable, using Grok.";
export const SOUND_BLOCKED_NOTICE = "Your browser is blocking sound. Tap the screen once, then ask again.";
export const READ_FAILED_NOTICE = "Cannot read the agent's reply right now. It will show in the chat.";
/** Reads of the chat that fail this many times in a row are shown to the person, not just retried. */
const READ_FAILS_BEFORE_NOTICE = 3;
const RESUME_WAIT_MS = 1_500;

/** The live-event side of the reply path; `ReplyFeed` in the browser, a fake in tests. */
export interface FeedLike {
  watch(issueId: string | null): void;
  onComment(cb: (issueId: string) => void): () => void;
  close(): void;
}

export interface CommentRow {
  id: string;
  body?: string | null;
  authorAgentId?: string | null;
  origin?: string | null;
  deletedAt?: string | null;
  createdAt?: string | null;
  createdByRunId?: string | null;
}

/** The constants a call ran under, stamped on its timing rows. */
const TIMING_CONSTANTS = {
  quietMs: ENDPOINT_END_QUIET_MS,
  firstChunkChars: SPEECH_FIRST_CHUNK_CHARS,
  awaitPollMs: DIRECT_AWAIT_POLL_MS,
  fastWindowMs: DIRECT_AWAIT_FAST_MS,
  geminiPrefetch: GEMINI_PREFETCH,
};

interface ReplyItem {
  text: string;
  commentId: string;
}

interface AudioClock {
  currentTime?: number;
  outputLatency?: number;
  baseLatency?: number;
}

export interface DirectSessionOptions {
  api: ApiClient;
  companyId: string;
  /** Where the call was opened, resolved once by the panel and frozen. */
  context: CallContext;
  /** Agent whose chat gets every turn (id, url key or name). Null: the company's CEO. */
  agentRef: string | null;
  /** Voice engine the call starts on; any Gemini failure moves the rest of the call to Grok. */
  provider: SpeakProvider;
  /** Created inside the tap handler so iOS lets it play. */
  audioContext: AudioContext;
  speak: SpeakFn;
  transcribe: TranscribeFn;
  /** Read on every frame, so the panel toggle applies at once. Default on. */
  interruptByTalking?: () => boolean;
  onState: (state: DirectState) => void;
  onTranscript: (entries: TranscriptEntry[]) => void;
  onLevel: (mic: number, voice: number) => void;
  onError: (message: string) => void;
  /** One line under the status ("The rest is in the chat"), or null to clear it. */
  onNotice?: (message: string | null) => void;
  /** The chat's agent is not the one the call asked for (404 on its chat): the header should switch. */
  onAgentChange?: (agent: { id: string | null; name: string }) => void;
  onEnd?: (call: CallRecord, targets: SaveTarget[]) => void;
  onAutosave?: (call: CallRecord) => void | Promise<void>;
  autosaveMs?: number;
  wakeLock?: WakeGuard;
  feed?: FeedLike;
  replyPollMs?: number;
}

const IDLE_HANGUP_MS = 4 * 60 * 1000;
/** A reply still awaited after this long no longer keeps a silent call open. */
const MAX_AWAIT_MS = 15 * 60 * 1000;
const AUTOSAVE_MS = 30_000;
const PAGE = 100;
const MAX_PAGES = 10;

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const errorText = (err: unknown) => (err instanceof Error && err.message ? clip(err.message, 160) : "unknown error");

export class DirectSession {
  private mic: MicCapture | null = null;
  private readonly player: Player;
  private readonly chat: AgentChat;
  private readonly feed: FeedLike;
  private readonly endpointer = new Endpointer();
  private readonly barge = new BargeInDetector();
  private state: DirectState = "starting";
  private closed = false;
  private fellBackSaid = false;
  private ended = false;
  private provider: SpeakProvider;
  private fallbackNoticed = false;

  /** Recent frames before speech was detected, and the utterance being heard. */
  private preroll: ArrayBuffer[] = [];
  private prerollMs = 0;
  private utterance: ArrayBuffer[] | null = null;
  private pendingSends = 0;

  private target: ChatTarget | null = null;
  /** The first comment this call posted: replies are read from there on. */
  private anchorId: string | null = null;
  private anchorAt: number | null = null;
  private readonly seen = new Set<string>();
  private awaitingSince: number | null = null;
  /** When the latest turn was posted; the fast reply poll runs for DIRECT_AWAIT_FAST_MS after it. */
  private lastTurnPostedAt: number | null = null;
  private fetching: Promise<number> | null = null;
  private fetchAgain = false;
  private readVia: ReplyVia = "poll";
  private readFails = 0;
  /** Why the last chunk could not be voiced: the provider's outcome or the call's error. Shown in the transcript. */
  private speakFailure = "";

  private replyQueue: ReplyItem[] = [];
  private readonly clock = new TurnClock();
  private utteranceStartAt: number | undefined;
  private speakingLoop = false;
  /** Bumped by barge-in: audio fetched or queued for an older value is dropped. */
  private speakGen = 0;
  private voiceLevel = 0;

  private pollTimer: number | null = null;
  private autosaveTimer: number | null = null;
  private idleTimer: number | null = null;
  private lastBump = 0;
  private readonly timers = new Set<number>();
  private unsubscribeFeed: (() => void) | null = null;
  private unsaved = false;
  private readonly startedAt = Date.now();
  private transcript: TranscriptEntry[] = [];
  private readonly fullLog = new Map<string, LogEntry>();

  constructor(private readonly opts: DirectSessionOptions) {
    this.provider = opts.provider;
    this.player = new Player(opts.audioContext);
    this.player.onLevel = (lvl) => {
      this.voiceLevel = lvl;
    };
    this.chat = new AgentChat({ api: opts.api, companyId: opts.companyId, agentRef: opts.agentRef, context: opts.context, direct: true });
    this.feed = opts.feed ?? new ReplyFeed({ companyId: opts.companyId });
    pruneBuffers();
  }

  get muted(): boolean {
    return this.mic?.muted ?? false;
  }

  setMuted(muted: boolean): void {
    if (this.mic) this.mic.muted = muted;
  }

  /** The engine replies are spoken with now (Gemini falls back to Grok for the rest of the call). */
  get currentProvider(): SpeakProvider {
    return this.provider;
  }

  async start(): Promise<void> {
    this.mic = new MicCapture(this.opts.audioContext, (pcm, lvl) => this.onFrame(pcm, lvl));
    this.unsubscribeFeed = this.feed.onComment((issueId) => this.onEvent(issueId));
    for (const note of this.opts.context.notes) this.addNote(note);
    void this.chat.resolve().then((target) => this.announceTarget(target), () => undefined);
    document.addEventListener("visibilitychange", this.onVisibility);
    try {
      await this.mic.start();
    } catch {
      this.fail("Microphone access was blocked. Allow the mic for this site and try again.");
      return;
    }
    if (this.closed) return;
    this.schedulePoll();
    if (this.opts.onAutosave) this.autosaveTimer = window.setInterval(() => this.autosave(), this.opts.autosaveMs ?? AUTOSAVE_MS);
    this.bumpIdle();
    this.refresh();
  }

  /** Next reply read: fast while inside the window after the latest turn post, slow otherwise. */
  private schedulePoll(): void {
    if (this.closed) return;
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    const slow = this.opts.replyPollMs ?? DIRECT_REPLY_POLL_MS;
    const fast = this.lastTurnPostedAt !== null && Date.now() - this.lastTurnPostedAt < DIRECT_AWAIT_FAST_MS;
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      void this.fetchNew("poll");
      this.schedulePoll();
    }, fast ? Math.min(DIRECT_AWAIT_POLL_MS, slow) : slow);
  }

  stop(): void {
    if (this.closed) return;
    this.teardown();
    this.setState("ended");
    this.finish();
  }

  /** Tap (or voice) barge-in: stop playback, drop what is queued, ignore any audio still being fetched. */
  interrupt(): void {
    if (this.closed || !this.speakingLoop) return;
    this.speakGen += 1;
    this.replyQueue = [];
    this.player.flush();
    this.barge.reset();
    this.endpointer.reset();
    this.refresh();
  }

  // -------------------------------------------------------------------------
  // Listening
  // -------------------------------------------------------------------------

  private onFrame(pcm: ArrayBuffer, lvl: number): void {
    if (this.closed) return;
    this.opts.onLevel(lvl, this.voiceLevel);
    if (lvl > 0.08) this.bumpIdle();
    const frameMs = (pcm.byteLength / 2 / TTS_SAMPLE_RATE) * 1000;
    this.preroll.push(pcm);
    this.prerollMs += frameMs;
    while (this.preroll.length > 1 && this.prerollMs - (this.preroll[0]!.byteLength / 2 / TTS_SAMPLE_RATE) * 1000 >= ENDPOINT_PREROLL_MS) {
      this.prerollMs -= (this.preroll.shift()!.byteLength / 2 / TTS_SAMPLE_RATE) * 1000;
    }
    if (this.speakingLoop) {
      // While the agent speaks only a clear barge-in counts; its own voice in the mic must not become a turn.
      if ((this.opts.interruptByTalking?.() ?? true) && this.barge.push(lvl, frameMs)) this.interrupt();
      return;
    }
    const event = this.endpointer.push(lvl, frameMs);
    if (event === "start") {
      this.utteranceStartAt = Date.now();
      this.utterance = [...this.preroll];
      this.refresh();
    } else if (this.utterance) this.utterance.push(pcm);
    if ((event === "end" || event === "cap") && this.utterance) {
      const frames = this.utterance;
      this.utterance = null;
      void this.sendUtterance(frames, { startAt: this.utteranceStartAt, endAt: Date.now(), endKind: event });
    }
  }

  private async sendUtterance(frames: ArrayBuffer[], ends: { startAt?: number; endAt: number; endKind: "end" | "cap" }): Promise<void> {
    this.pendingSends += 1;
    this.refresh();
    try {
      let text = "";
      try {
        const out = (await this.opts.transcribe({ audio: bytesToBase64(encodeWav(concatPcm16(frames))), mimeType: "audio/wav" })) as { text?: unknown };
        text = typeof out?.text === "string" ? out.text.trim() : "";
      } catch (err) {
        this.addNote(`Not heard: ${errorText(err)}`);
        return;
      }
      if (!text || this.closed) return;
      const turn = this.clock.addTurn({ ...ends, textAt: Date.now() });
      this.upsert(`you-${newUuid()}`, "you", text, true);
      await this.postTurn(text, turn);
    } finally {
      this.pendingSends -= 1;
      this.refresh();
    }
  }

  private async postTurn(text: string, turn: TurnRow): Promise<void> {
    const requestId = newUuid();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < DIRECT_SEND_ATTEMPTS; attempt += 1) {
      try {
        const postStartAt = Date.now();
        const posted = await this.chat.post(text, requestId);
        turn.postStartAt = postStartAt;
        turn.postedAt = Date.now();
        turn.serverPostedAt = parseServerTime(posted.createdAt);
        if (posted.commentId) turn.commentId = posted.commentId;
        this.unsaved = true;
        this.target = posted.target;
        this.announceTarget(posted.target);
        if (posted.commentId) this.seen.add(posted.commentId);
        if (!this.anchorId && posted.commentId) this.anchorId = posted.commentId;
        if (this.anchorAt === null) {
          const at = posted.createdAt ? Date.parse(posted.createdAt) : NaN;
          this.anchorAt = Number.isFinite(at) ? at : Date.now();
        }
        this.awaitingSince = Date.now();
        this.lastTurnPostedAt = this.awaitingSince;
        this.schedulePoll();
        this.feed.watch(posted.target.issueId);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    const reason = errorText(lastError);
    this.addNote(`Not sent: ${reason}`);
    this.opts.onNotice?.(`That did not reach the agent (${reason}). Say it again.`);
  }

  // -------------------------------------------------------------------------
  // Waiting for the reply
  // -------------------------------------------------------------------------

  private onEvent(issueId: string): void {
    if (this.closed || issueId !== this.target?.issueId) return;
    void (async () => {
      if ((await this.fetchNew("event")) > 0) return;
      // The event can land before the comment row is readable: look again shortly.
      let waited = 0;
      for (const at of DIRECT_REFETCH_MS) {
        await this.sleep(at - waited);
        waited = at;
        if (this.closed || (await this.fetchNew("event")) > 0) return;
      }
    })();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const id = window.setTimeout(() => {
        this.timers.delete(id);
        resolve();
      }, ms);
      this.timers.add(id);
    });
  }

  /** One read at a time; a read asked for while one runs runs once more after it. Resolves to new replies found. */
  private fetchNew(via: ReplyVia = "poll"): Promise<number> {
    if (this.closed || !this.target) return Promise.resolve(0);
    // A read already running re-runs for this caller, so the latest caller's route is the one recorded.
    this.readVia = via;
    if (this.fetching) {
      this.fetchAgain = true;
      return this.fetching;
    }
    const run = (async () => {
      let found = 0;
      do {
        this.fetchAgain = false;
        try {
          found += await this.readReplies(this.readVia);
          this.readFails = 0;
        } catch (err) {
          // A missed read is retried by the next poll; a read that keeps failing is said out loud.
          this.readFails += 1;
          if (this.readFails === READ_FAILS_BEFORE_NOTICE && !this.closed) {
            this.addNote(`Could not read the reply: ${errorText(err)}`);
            this.opts.onNotice?.(READ_FAILED_NOTICE);
          }
        }
      } while (this.fetchAgain && !this.closed);
      return found;
    })();
    this.fetching = run.finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  /** Everything after this call's first turn, so a row that commits late is still found; `seen` drops repeats. */
  private async readReplies(via: ReplyVia): Promise<number> {
    const target = this.target;
    if (!target) return 0;
    let after = this.anchorId;
    let found = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = after ? `after=${encodeURIComponent(after)}&order=asc&limit=${PAGE}` : `order=desc&limit=${PAGE}`;
      const rows = await this.opts.api.get<CommentRow[]>(`/issues/${target.issueId}/comments?${query}`);
      if (this.closed) return found;
      const ordered = after ? rows : [...rows].reverse();
      for (const row of ordered) {
        if (!row?.id || this.seen.has(row.id)) continue;
        this.seen.add(row.id);
        if (!this.isReply(row, target)) continue;
        found += 1;
        this.clock.noteReply({ id: row.id, runId: row.createdByRunId, createdAt: row.createdAt }, Date.now(), via);
        this.unsaved = true;
        this.awaitingSince = null;
        const body = String(row.body ?? "");
        this.upsert(`agent-${row.id}`, "voice", body.trim(), true);
        const speech = toSpeech(body);
        if (speech) {
          this.replyQueue.push({ text: speech, commentId: row.id });
          if (!this.speakingLoop) void this.runSpeaker();
        }
      }
      if (!after || rows.length < PAGE) break;
      after = rows[rows.length - 1]!.id;
    }
    if (found > 0) this.refresh();
    return found;
  }

  /** The reply: the chat agent's own comment, not the platform receipt, not deleted, written after the turn. */
  private isReply(row: CommentRow, target: ChatTarget): boolean {
    if (!row.authorAgentId) return false;
    if (target.agentId && row.authorAgentId !== target.agentId) return false;
    if (row.origin === "fast_response" || row.deletedAt) return false;
    const at = row.createdAt ? Date.parse(row.createdAt) : NaN;
    return this.anchorAt === null || !Number.isFinite(at) || at >= this.anchorAt;
  }

  // -------------------------------------------------------------------------
  // Speaking
  // -------------------------------------------------------------------------

  private async runSpeaker(): Promise<void> {
    this.speakingLoop = true;
    this.barge.reset();
    this.refresh();
    try {
      while (!this.closed && this.replyQueue.length > 0) {
        const item = this.replyQueue.shift()!;
        await this.speakReply(item, this.speakGen);
      }
    } finally {
      this.speakingLoop = false;
      this.endpointer.reset();
      this.bumpIdle();
      this.refresh();
    }
  }

  /** Chunks in order; a chunk that cannot be voiced ends the reply there, never a gap in the middle. */
  private async speakReply(item: ReplyItem, gen: number): Promise<void> {
    const marks = this.clock.speakMarks(item.commentId);
    marks.speakStartAt = Date.now();
    this.unsaved = true;
    const chunks = chunk(item.text);
    let prevEnd: number | null = null;
    let gap = 0;
    let next: Promise<{ pcm: ArrayBuffer; rate: number } | null> | null = null;
    for (let i = 0; i < chunks.length; i += 1) {
      const audio = await (next ?? this.chunkAudio(chunks[i]!, gen));
      next = null;
      if (gen !== this.speakGen || this.closed) return;
      if (!audio) {
        this.addNote(this.speakFailure ? `${REST_IN_CHAT} (voice failed: ${this.speakFailure})` : REST_IN_CHAT);
        this.opts.onNotice?.(REST_IN_CHAT);
        return;
      }
      if (i === 0) {
        marks.audioAt = Date.now();
        marks.provider = this.provider;
      }
      if (!(await this.soundReady())) {
        this.addNote(SOUND_BLOCKED_NOTICE);
        this.opts.onNotice?.(SOUND_BLOCKED_NOTICE);
        return;
      }
      const slot = this.player.enqueue(audio.pcm, audio.rate);
      if (slot) {
        const ctx = this.opts.audioContext as unknown as AudioClock;
        if (i === 0) {
          const latency = ctx.outputLatency || ctx.baseLatency || 0;
          marks.playAt = Math.round(Date.now() + (slot.startAt - (ctx.currentTime ?? 0) + latency) * 1000);
          marks.latencyKnown = typeof ctx.outputLatency === "number";
        } else if (prevEnd !== null) {
          gap += Math.max(0, slot.startAt - prevEnd);
          marks.gap = Math.round(gap * 1000);
        }
        prevEnd = slot.endAt;
      }
      this.bumpIdle();
      // Prefetch the next chunk while this one plays (Gemini too when GEMINI_PREFETCH; a non-ok falls back to Grok).
      if (i + 1 < chunks.length && (this.provider === "grok" || GEMINI_PREFETCH)) next = this.chunkAudio(chunks[i + 1]!, gen);
      await this.player.idle();
      if (gen !== this.speakGen || this.closed) return;
    }
  }

  /** Gemini first when chosen; any non-ok moves this chunk and the rest of the call to Grok, tried twice. */
  private async chunkAudio(text: string, gen: number): Promise<{ pcm: ArrayBuffer; rate: number } | null> {
    if (this.provider === "gemini") {
      const out = await this.callSpeak(text, "gemini");
      if (out) return out;
      this.provider = "grok";
      if (!this.fallbackNoticed) {
        this.fallbackNoticed = true;
        this.addNote(this.speakFailure ? `${GEMINI_FALLBACK_NOTICE} (${this.speakFailure})` : GEMINI_FALLBACK_NOTICE);
        this.opts.onNotice?.(GEMINI_FALLBACK_NOTICE);
      }
    }
    for (let attempt = 0; attempt < XAI_SPEAK_ATTEMPTS; attempt += 1) {
      if (gen !== this.speakGen || this.closed) return null;
      const out = await this.callSpeak(text, "grok");
      if (out) return out;
    }
    return null;
  }

  private async callSpeak(text: string, provider: SpeakProvider): Promise<{ pcm: ArrayBuffer; rate: number } | null> {
    const agentId = this.target?.agentId;
    if (!agentId) {
      this.speakFailure = "no agent on this chat";
      return null;
    }
    try {
      const out = (await this.opts.speak({ agentId, text, provider })) as { audio?: unknown; sampleRate?: unknown; error?: unknown } | null;
      if (typeof out?.audio !== "string" || !out.audio) {
        this.speakFailure = `${provider} ${typeof out?.error === "string" ? out.error : "returned no audio"}`;
        return null;
      }
      return { pcm: base64ToArrayBuffer(out.audio), rate: typeof out.sampleRate === "number" ? out.sampleRate : TTS_SAMPLE_RATE };
    } catch (err) {
      this.speakFailure = `${provider} ${errorText(err)}`;
      return null;
    }
  }

  /** A context the browser holds suspended plays nothing and never ends a buffer: try to wake it, else say so. */
  private async soundReady(): Promise<boolean> {
    const context = this.opts.audioContext;
    if (!context.state || context.state === "running") return true;
    try {
      // iOS can leave resume() pending outside a tap, so it gets a short time, not the whole call.
      await Promise.race([context.resume?.(), this.sleep(RESUME_WAIT_MS)]);
    } catch {
      // Judged by the state below.
    }
    return (context.state as string) === "running";
  }

  // -------------------------------------------------------------------------
  // Lifecycle, state and transcript
  // -------------------------------------------------------------------------

  private readonly onVisibility = (): void => {
    if (this.closed || document.visibilityState !== "visible") return;
    void this.opts.audioContext.resume?.()?.catch?.(() => undefined);
    void this.fetchNew();
  };

  private refresh(): void {
    if (this.closed) return;
    if (this.speakingLoop) this.setState("speaking");
    else if (this.utterance) this.setState("hearing");
    else if (this.pendingSends > 0) this.setState("sending");
    else if (this.awaitingSince !== null) this.setState("working");
    else this.setState("listening");
  }

  private setState(state: DirectState): void {
    if (this.state === state || this.state === "ended" || this.state === "error") return;
    this.state = state;
    this.opts.onState(state);
  }

  private bumpIdle(): void {
    if (this.closed) return;
    const now = Date.now();
    if (this.idleTimer !== null && now - this.lastBump < 1000) return;
    this.lastBump = now;
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      const waiting = this.awaitingSince !== null && Date.now() - this.awaitingSince < MAX_AWAIT_MS;
      if (waiting || this.speakingLoop || this.pendingSends > 0) {
        this.bumpIdle();
        return;
      }
      this.addNote("Hung up after four quiet minutes.");
      this.stop();
    }, IDLE_HANGUP_MS);
  }

  private teardown(): void {
    this.closed = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.opts.wakeLock?.release();
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    this.unsubscribeFeed?.();
    this.feed.close();
    this.speakGen += 1;
    this.replyQueue = [];
    this.mic?.stop();
    this.player.flush();
    void this.opts.audioContext.close?.()?.catch?.(() => undefined);
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.opts.onError(message);
    this.teardown();
    this.state = "error";
    this.opts.onState("error");
    this.finish();
  }

  /** Hands the whole call to the host once. The chat already holds every turn, so it is not a recap target. */
  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.autosaveTimer !== null) window.clearInterval(this.autosaveTimer);
    try {
      this.opts.onEnd?.({ entries: [...this.fullLog.values()], startedAt: this.startedAt, endedAt: Date.now(), ...this.timing() }, []);
    } catch {
      // Saving the transcript must never break hanging up.
    }
  }

  /** The turn rows and their stamp for a saved record; nothing when the call had no turn. */
  private timing(): { turns?: TurnRow[]; timingStamp?: string } {
    if (this.clock.size === 0) return {};
    return { turns: this.clock.rows(), timingStamp: timingStamp(PLUGIN_VERSION, TIMING_CONSTANTS) };
  }

  private autosave(): void {
    if (this.closed || !this.unsaved) return;
    this.unsaved = false;
    const call: CallRecord = { entries: [...this.fullLog.values()].map((e) => ({ ...e })), startedAt: this.startedAt, endedAt: Date.now(), ...this.timing() };
    try {
      void Promise.resolve(this.opts.onAutosave?.(call)).catch(() => {
        this.unsaved = true;
      });
    } catch {
      this.unsaved = true;
    }
  }

  private upsert(id: string, who: TranscriptEntry["who"], text: string, final: boolean): void {
    const existing = this.transcript.find((e) => e.id === id);
    if (existing) {
      existing.text = text;
      existing.final = final || existing.final;
    } else this.transcript.push({ id, who, text, final });
    const logged = this.fullLog.get(id);
    if (logged) logged.text = text;
    else this.fullLog.set(id, { who, text, at: Date.now() });
    this.unsaved = true;
    const timing = this.timing();
    writeBuffer(this.startedAt, [...this.fullLog.values()], timing.turns ? { turns: timing.turns, timingStamp: timing.timingStamp! } : undefined);
    if (this.transcript.length > 60) this.transcript.splice(0, this.transcript.length - 60);
    this.opts.onTranscript([...this.transcript]);
  }

  /** Says once that the call is with the default agent because the asked-for one could not be reached. */
  private announceTarget(target: ChatTarget): void {
    if (!target.fellBack || this.fellBackSaid || this.closed) return;
    this.fellBackSaid = true;
    const message = `Could not reach ${target.fellBack.from}; talking with ${target.agentName} instead.`;
    this.addNote(message);
    this.opts.onNotice?.(message);
    this.opts.onAgentChange?.({ id: target.agentId, name: target.agentName });
  }

  private addNote(text: string): void {
    this.upsert(`note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, "note", text, true);
  }
}
