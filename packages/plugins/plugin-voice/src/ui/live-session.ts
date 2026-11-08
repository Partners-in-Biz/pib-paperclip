import { base64ToArrayBuffer, LIVE_SAMPLE_RATE, MicCapture, Player } from "./audio.js";
import { AgentChat, clip, type ApiClient } from "./agent-chat.js";
import { pruneBuffers, readBuffer, writeBuffer } from "./transcript-buffer.js";
import type { CallRecord, LogEntry, SaveTarget } from "./transcript-report.js";
import { newUuid } from "./uuid.js";
import type { WakeGuard } from "./wake-lock.js";

/** `disconnected` and `reconnecting` are recoverable; `ended` and `error` are final. */
export type LiveState = "connecting" | "listening" | "thinking" | "speaking" | "reconnecting" | "disconnected" | "ended" | "error";

export interface TranscriptEntry {
  id: string;
  who: "you" | "voice" | "note";
  text: string;
  final: boolean;
}

export interface LiveSessionInfo {
  token: string;
  url: string;
  voice: string;
  language: string;
  keyterms: string[];
}

export interface LiveSessionOptions {
  info: LiveSessionInfo;
  instructions: string;
  api: ApiClient;
  companyId: string;
  userId: string | null;
  pageIssueRef: string | null;
  /** Agent whose Agent Chat gets every turn (id, url key or name). Null: the company's CEO. */
  agentRef?: string | null;
  /** Created inside the tap handler so iOS lets it play. */
  audioContext: AudioContext;
  onState: (state: LiveState) => void;
  onTranscript: (entries: TranscriptEntry[]) => void;
  onLevel: (mic: number, voice: number) => void;
  onError: (message: string) => void;
  /** Once, when the call ends for any reason, with the whole call (the panel keeps only the last 60 lines). */
  onEnd?: (call: CallRecord, targets: SaveTarget[]) => void;
  /** Screen lock started in the opening tap; released when the call ends or fails. */
  wakeLock?: WakeGuard;
  /**
   * Mints a fresh secret for a reconnect (the first one is single-use and short-lived). Without it a dropped
   * socket ends the call, as before.
   */
  refreshInfo?: () => Promise<LiveSessionInfo>;
  /** How often watched tasks are checked for agent replies. */
  replyPollMs?: number;
  /** Quiet time after a finished utterance before it is sent, so one request split by a pause is one message. */
  sendDelayMs?: number;
  /** With no reply after this long, the voice says once that the agent is still working on it. */
  workingNoticeMs?: number;
  /**
   * Called about every `autosaveMs` while the call has new lines, with the call so far. The host writes the
   * document only (never a comment); `onEnd` stays the one place the recap comment is posted.
   */
  onAutosave?: (call: CallRecord) => void | Promise<void>;
  autosaveMs?: number;
}

interface Turn {
  itemId: string;
  text: string;
}

interface Watched {
  ref: string;
  lastSeenId: string | null;
  lastSeenAt: string;
}

/** Hang up after this much silence on both sides, so a pocketed phone does not run up a bill. */
const IDLE_HANGUP_MS = 4 * 60 * 1000;
/** Earlier turns replayed into a new session after a drop. */
const REPLAY_TURNS = 20;
/** A connection that lived this long counts as healthy, so its next drop gets a fresh automatic attempt. */
const STABLE_MS = 10_000;
/** How often the call so far is written to the task document. */
const AUTOSAVE_MS = 30_000;
const SEND_DELAY_MS = 1_200;
const WORKING_NOTICE_MS = 40_000;
const SEND_ATTEMPTS = 3;

export class LiveSession {
  private ws: WebSocket | null = null;
  private mic: MicCapture | null = null;
  private player: Player;
  private chat: AgentChat;
  private transcript: TranscriptEntry[] = [];
  private state: LiveState = "connecting";
  /** Finished utterances not yet sent to the agent. */
  private turns: Turn[] = [];
  private sendTimer: number | null = null;
  /** Agent Chat issues this call posted to: their replies are spoken, but the recap is not posted there. */
  private chatIssues = new Set<string>();
  /** When the oldest unanswered send went out; null when the agent has replied since. */
  private awaitingSince: number | null = null;
  private workingSaid = false;
  private responseActive = false;
  private queuedUpdates: string[] = [];
  private watched = new Map<string, Watched>();
  private pollTimer: number | null = null;
  private autosaveTimer: number | null = null;
  /** Lines changed since the last autosave started. */
  private unsaved = false;
  private idleTimer: number | null = null;
  private voiceLevel = 0;
  private closed = false;
  private readonly startedAt = Date.now();
  private readonly fullLog = new Map<string, LogEntry>();
  private ended = false;
  private info: LiveSessionInfo;
  /** The socket dropped and nothing has replaced it yet. */
  private dropped = false;
  private reconnecting = false;
  /** The automatic attempt of this outage was used; only Retry (or a healthy connection) re-arms it. */
  private autoTried = false;
  private droppedHidden = false;
  private replayOnOpen = false;
  private connectedAt = 0;

  constructor(private readonly opts: LiveSessionOptions) {
    this.info = opts.info;
    this.player = new Player(opts.audioContext);
    pruneBuffers();
    this.player.onLevel = (lvl) => {
      this.voiceLevel = lvl;
      if (lvl === 0 && this.state === "speaking" && !this.responseActive) this.setState("listening");
    };
    this.chat = new AgentChat({ api: opts.api, companyId: opts.companyId, agentRef: opts.agentRef ?? null, pageIssueRef: opts.pageIssueRef });
  }

  get muted(): boolean {
    return this.mic?.muted ?? false;
  }

  setMuted(muted: boolean): void {
    if (this.mic) this.mic.muted = muted;
  }

  async start(): Promise<void> {
    // Mic and socket start together; frames before `open` are dropped, which is fine
    // because the first thing that happens is the voice greeting.
    this.mic = this.makeMic();
    const micReady = this.mic.start();
    this.openSocket(this.info);
    // Warm the chat issue so the first turn goes out at once; a failure is retried on that send.
    void this.chat.resolve().catch(() => undefined);
    if (this.opts.refreshInfo) document.addEventListener("visibilitychange", this.onVisibility);

    try {
      await micReady;
    } catch {
      this.fail("Microphone access was blocked. Allow the mic for this site and try again.");
      return;
    }
    if (this.closed) return;
    this.pollTimer = window.setInterval(() => void this.pollReplies(), this.opts.replyPollMs ?? 10_000);
    if (this.opts.onAutosave) {
      this.autosaveTimer = window.setInterval(() => this.autosave(), this.opts.autosaveMs ?? AUTOSAVE_MS);
    }
    this.bumpIdle();
  }

  /** Document only, and only when something was said since the last one; a failure is left for the final save. */
  private autosave(): void {
    if (this.closed || !this.unsaved) return;
    this.unsaved = false;
    const call: CallRecord = { entries: [...this.fullLog.values()].map((e) => ({ ...e })), startedAt: this.startedAt, endedAt: Date.now() };
    try {
      void Promise.resolve(this.opts.onAutosave?.(call)).catch(() => {
        this.unsaved = true;
      });
    } catch {
      this.unsaved = true;
    }
  }

  private makeMic(): MicCapture {
    return new MicCapture(this.opts.audioContext, (pcm, lvl) => {
      this.opts.onLevel(lvl, this.voiceLevel);
      if (lvl > 0.08) this.bumpIdle();
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm);
    });
  }

  /** Handlers ignore a socket that is no longer `this.ws`, so a replaced socket cannot end the call. */
  private openSocket(info: LiveSessionInfo): void {
    const ws = new WebSocket(info.url, [`xai-client-secret.${info.token}`]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.dropped = false;
    ws.addEventListener("open", () => {
      if (ws !== this.ws) return;
      this.connectedAt = Date.now();
      this.reconnecting = false;
      this.configure();
    });
    ws.addEventListener("message", (event) => {
      if (ws === this.ws) this.onMessage(event);
    });
    ws.addEventListener("error", () => {
      if (ws === this.ws && !this.closed) this.onDrop("The voice connection dropped.");
    });
    ws.addEventListener("close", (event) => {
      console.warn("[pib-voice] socket closed", { code: event.code, reason: event.reason, wasClean: event.wasClean, ending: this.closed });
      if (ws !== this.ws || this.closed) return;
      this.onDrop(event.code === 1008 || event.code === 4001 ? "The voice pass expired or was refused." : "The voice connection closed.");
    });
  }

  /**
   * The socket is gone while the call is still wanted: a screen lock, a network blip or the provider's own
   * session limit. One automatic attempt while the page is visible (or when it becomes visible again), then
   * the Retry button. No backoff loop: timers do not run while a phone is locked.
   */
  private onDrop(message: string): void {
    if (this.closed || this.dropped) return;
    if (!this.opts.refreshInfo) {
      this.fail(`${message} Try again.`);
      return;
    }
    this.dropped = true;
    this.reconnecting = false;
    if (this.connectedAt > 0 && Date.now() - this.connectedAt > STABLE_MS) this.autoTried = false;
    this.connectedAt = 0;
    this.droppedHidden = this.droppedHidden || document.visibilityState === "hidden";
    this.responseActive = false;
    this.player.flush();
    try {
      this.ws?.close();
    } catch {
      // Already closed.
    }
    this.setState("disconnected");
    this.opts.onError(message);
    this.bumpIdle();
    if (document.visibilityState === "visible" && !this.autoTried) void this.reconnect(true);
  }

  private readonly onVisibility = (): void => {
    if (this.closed || document.visibilityState !== "visible") return;
    void this.opts.audioContext.resume?.()?.catch?.(() => undefined);
    if (!this.dropped) {
      // A frozen page can miss the close event: a socket that is not open is a drop.
      const ready = this.ws?.readyState;
      if (!this.reconnecting && ready !== undefined && ready !== WebSocket.OPEN && ready !== WebSocket.CONNECTING) {
        this.droppedHidden = true;
        this.onDrop("The voice connection closed.");
      }
      return;
    }
    if (this.state === "disconnected" && !this.autoTried) void this.reconnect(true);
  };

  /** The Retry button. */
  retry(): void {
    if (this.state === "disconnected") void this.reconnect(false);
  }

  private async reconnect(auto: boolean): Promise<void> {
    const refresh = this.opts.refreshInfo;
    if (this.closed || this.reconnecting || !refresh) return;
    this.reconnecting = true;
    if (auto) this.autoTried = true;
    this.setState("reconnecting");
    try {
      const info = await refresh();
      if (this.closed) return;
      if (this.droppedHidden) {
        // A locked phone can leave the mic track ended; start it again now that the page is back.
        const muted = this.mic?.muted ?? false;
        this.mic?.stop();
        this.mic = this.makeMic();
        this.mic.muted = muted;
        await this.mic.start();
        if (this.closed) return;
        this.droppedHidden = false;
      }
      this.info = info;
      this.replayOnOpen = true;
      this.openSocket(info);
    } catch (err) {
      this.reconnecting = false;
      if (this.closed) return;
      this.setState("disconnected");
      this.opts.onError(err instanceof Error && err.message ? `Could not reconnect: ${clip(err.message, 160)}` : "Could not reconnect.");
    }
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.opts.wakeLock?.release();
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.flushTurns();
    this.mic?.stop();
    this.player.flush();
    try {
      this.ws?.close(1000, "done");
    } catch {
      // Already closed.
    }
    void this.opts.audioContext.close().catch(() => undefined);
    this.setState("ended");
    this.finish();
  }

  /** Hands the whole call to the host once, however the call ended. */
  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.autosaveTimer !== null) window.clearInterval(this.autosaveTimer);
    // The turns are already in the agent chat; a recap comment there would wake the agent again.
    const targets: SaveTarget[] = [...this.watched]
      .filter(([issueId]) => !this.chatIssues.has(issueId))
      .map(([issueId, w]) => ({ issueId, ref: w.ref }));
    try {
      this.opts.onEnd?.({ entries: [...this.fullLog.values()], startedAt: this.startedAt, endedAt: Date.now() }, targets);
    } catch {
      // Saving the transcript must never break hanging up.
    }
  }

  private setState(state: LiveState): void {
    if (this.state === state || this.state === "ended" || this.state === "error") return;
    this.state = state;
    this.opts.onState(state);
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.opts.onError(message);
    this.closed = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.opts.wakeLock?.release();
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.flushTurns();
    this.mic?.stop();
    this.player.flush();
    try {
      this.ws?.close();
    } catch {
      // Already closed.
    }
    this.state = "error";
    this.opts.onState("error");
    this.finish();
  }

  private lastBump = 0;

  /** Called on every audio frame, so it re-arms the timer at most once a second. */
  private bumpIdle(): void {
    if (this.closed) return;
    const now = Date.now();
    if (this.idleTimer !== null && now - this.lastBump < 1000) return;
    this.lastBump = now;
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      this.addNote("Hung up after four quiet minutes.");
      this.stop();
    }, IDLE_HANGUP_MS);
  }

  private send(event: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  private configure(): void {
    const info = this.info;
    const transcription: Record<string, unknown> = {};
    if (info.keyterms.length > 0) transcription.keyterms = info.keyterms.slice(0, 100);
    if (info.language) transcription.language_hint = info.language;
    this.send({
      type: "session.update",
      session: {
        voice: info.voice,
        instructions: this.opts.instructions,
        turn_detection: { type: "server_vad" },
        audio: {
          input: {
            format: { type: "audio/pcm", rate: LIVE_SAMPLE_RATE },
            transport: "binary",
            ...(Object.keys(transcription).length > 0 ? { transcription } : {}),
          },
          output: { format: { type: "audio/pcm", rate: LIVE_SAMPLE_RATE }, transport: "binary" },
        },
      },
    });
    const replay = this.replayOnOpen ? this.replayText() : null;
    this.replayOnOpen = false;
    if (replay) {
      // One context message instead of re-created turns: no guessing the provider's assistant item shape.
      this.send({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: replay }] },
      });
      this.addNote("Reconnected.");
      this.send({
        type: "response.create",
        response: {
          instructions:
            "The connection dropped and is back. Say in a few words that you are back. Do not repeat earlier answers.",
        },
      });
    } else {
      // Open with a one-line greeting so the person knows it is listening.
      this.send({
        type: "response.create",
        response: { instructions: "Greet them in one short sentence and ask what they need." },
      });
    }
    this.setState("thinking");
  }

  /** The last turns of this call, from the localStorage copy (falls back to memory when storage is blocked). */
  private replayText(): string | null {
    const stored = readBuffer(this.startedAt)?.entries;
    const entries = stored && stored.length > 0 ? stored : [...this.fullLog.values()];
    const turns = entries.filter((e) => e.who !== "note" && e.text.trim()).slice(-REPLAY_TURNS);
    if (turns.length === 0) return null;
    const lines = turns.map((e) => `${e.who === "you" ? "Person" : "You"}: ${clip(e.text, 600)}`);
    return `[Context] Earlier in this same call, before the connection dropped:\n${lines.join("\n")}`;
  }

  private onMessage(event: MessageEvent): void {
    if (this.closed) return;
    if (event.data instanceof ArrayBuffer) {
      this.player.enqueue(event.data);
      this.setState("speaking");
      this.bumpIdle();
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(msg.type ?? "");
    switch (type) {
      case "input_audio_buffer.speech_started":
        // Barge-in: the person talks over the voice, so it stops at once.
        this.player.flush();
        this.setState("listening");
        this.bumpIdle();
        // They are still talking: hold what they said so far and send it with the rest.
        if (this.sendTimer !== null) window.clearTimeout(this.sendTimer);
        this.sendTimer = null;
        break;
      case "input_audio_buffer.speech_stopped":
        this.setState("thinking");
        // Noise can start speech without a transcript; held words still go out once it is quiet again.
        if (this.turns.length > 0 && this.sendTimer === null) {
          this.sendTimer = window.setTimeout(() => this.flushTurns(), 3 * (this.opts.sendDelayMs ?? SEND_DELAY_MS));
        }
        break;
      case "conversation.item.input_audio_transcription.completed":
      case "conversation.item.input_audio_transcription.updated": {
        const text = typeof msg.transcript === "string" ? msg.transcript : "";
        const itemId = typeof msg.item_id === "string" ? msg.item_id : `you-${Date.now()}`;
        if (text.trim()) this.upsert(itemId, "you", text, type.endsWith("completed"));
        if (type.endsWith("completed") && text.trim()) this.queueTurn(itemId, text.trim());
        break;
      }
      case "response.created":
        this.responseActive = true;
        this.setState("thinking");
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
        // JSON audio (if the server ignores the binary transport).
        if (typeof msg.delta === "string") {
          this.player.enqueue(base64ToArrayBuffer(msg.delta));
          this.setState("speaking");
        }
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        const id = `voice-${String(msg.response_id ?? msg.item_id ?? "")}`;
        const existing = this.transcript.find((e) => e.id === id);
        this.upsert(id, "voice", `${existing?.text ?? ""}${String(msg.delta ?? "")}`, false);
        break;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        const id = `voice-${String(msg.response_id ?? msg.item_id ?? "")}`;
        if (typeof msg.transcript === "string") this.upsert(id, "voice", msg.transcript, true);
        break;
      }
      case "response.done":
        this.responseActive = false;
        void this.afterResponse();
        break;
      case "error": {
        const err = (msg.error ?? {}) as { message?: unknown; code?: unknown };
        const text = typeof err.message === "string" ? err.message : "The voice service reported an error.";
        // Config errors leave the session running on the previous settings; show, do not hang up.
        this.addNote(`Voice service: ${clip(text, 200)}`);
        break;
      }
      default:
        break;
    }
  }

  /** Speaks replies that arrived while the voice was talking. */
  private async afterResponse(): Promise<void> {
    if (this.queuedUpdates.length > 0) {
      await this.player.idle();
      this.deliverUpdates();
      return;
    }
    if (!this.player.playing) this.setState("listening");
  }

  /** Code, not the model, sends every finished utterance; a short quiet window joins a sentence split by a pause. */
  private queueTurn(itemId: string, text: string): void {
    if (this.closed) return;
    const existing = this.turns.find((t) => t.itemId === itemId);
    if (existing) existing.text = text;
    else this.turns.push({ itemId, text });
    if (this.sendTimer !== null) window.clearTimeout(this.sendTimer);
    this.sendTimer = window.setTimeout(() => this.flushTurns(), this.opts.sendDelayMs ?? SEND_DELAY_MS);
  }

  /** Sends what is queued as one message. Also runs on hang-up, so the last thing said is never lost. */
  private flushTurns(): void {
    if (this.sendTimer !== null) window.clearTimeout(this.sendTimer);
    this.sendTimer = null;
    const turns = this.turns.splice(0);
    if (turns.length === 0) return;
    void this.sendTurn(turns.map((t) => t.text).join(" "));
  }

  private async sendTurn(text: string): Promise<void> {
    const requestId = newUuid();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt++) {
      try {
        const target = await this.chat.submit(text, requestId);
        this.chatIssues.add(target.issueId);
        this.watch(target.issueId, target.ref);
        if (this.awaitingSince === null) {
          this.awaitingSince = Date.now();
          this.workingSaid = false;
        }
        this.addNote(`Sent to ${target.agentName}.`);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    const reason = lastError instanceof Error && lastError.message ? clip(lastError.message, 160) : "unknown error";
    this.addNote(`Not sent: ${reason}`);
    if (this.closed) return;
    this.queuedUpdates.push(`[Status] That last request did not reach the agent (${reason}). Tell the person in one sentence and ask them to say it again.`);
    if (!this.responseActive && !this.player.playing) this.deliverUpdates();
  }

  private watch(issueId: string, ref: string): void {
    if (this.watched.has(issueId)) return;
    this.watched.set(issueId, { ref, lastSeenId: null, lastSeenAt: new Date().toISOString() });
  }

  /** New agent comments on watched tasks since the last check. */
  private async collectReplies(): Promise<Array<{ ref: string; from: string; text: string }>> {
    const found: Array<{ ref: string; from: string; text: string }> = [];
    for (const [issueId, w] of this.watched) {
      const query = w.lastSeenId ? `after=${encodeURIComponent(w.lastSeenId)}&order=asc&limit=10` : "order=desc&limit=10";
      const rows = await this.opts.api.get<Array<{ id: string; body: string; authorAgentId?: string | null; createdAt?: string | null }>>(
        `/issues/${issueId}/comments?${query}`,
      );
      const ordered = w.lastSeenId ? rows : [...rows].reverse();
      for (const row of ordered) {
        const isNew = w.lastSeenId !== null || (row.createdAt ?? "") > w.lastSeenAt;
        if (isNew && row.authorAgentId) {
          found.push({ ref: w.ref, from: await this.agentNameFor(row.authorAgentId), text: clip(row.body, 800) });
        }
      }
      const last = ordered[ordered.length - 1];
      if (last) w.lastSeenId = last.id;
    }
    return found;
  }

  private agentNames: Map<string, string> | null = null;

  private async agentNameFor(agentId: string): Promise<string> {
    if (!this.agentNames) {
      const agents = await this.opts.api.get<Array<{ id: string; name: string }>>(`/companies/${this.opts.companyId}/agents`);
      this.agentNames = new Map(agents.map((a) => [a.id, a.name]));
    }
    return this.agentNames.get(agentId) ?? "An agent";
  }

  private async pollReplies(): Promise<void> {
    if (this.closed || this.watched.size === 0) return;
    let replies: Array<{ ref: string; from: string; text: string }>;
    try {
      replies = await this.collectReplies();
    } catch {
      return; // A missed poll is retried on the next tick.
    }
    if (replies.length === 0) {
      this.noteStillWorking();
      return;
    }
    this.awaitingSince = null;
    for (const r of replies) {
      this.queuedUpdates.push(`[Update] ${r.from} replied on ${r.ref}: ${r.text}`);
      this.addNote(`${r.from} replied on ${r.ref}.`);
    }
    if (!this.responseActive && !this.player.playing) this.deliverUpdates();
  }

  /** Long runs: once per wait, the voice says the agent is still on it (the reply is spoken when it lands). */
  private noteStillWorking(): void {
    if (this.awaitingSince === null || this.workingSaid) return;
    if (Date.now() - this.awaitingSince < (this.opts.workingNoticeMs ?? WORKING_NOTICE_MS)) return;
    this.workingSaid = true;
    this.queuedUpdates.push("[Status] The agent is still working on it. Say so in a few words; you will tell them when it replies.");
    if (!this.responseActive && !this.player.playing) this.deliverUpdates();
  }

  private deliverUpdates(): void {
    // While the socket is down the queue stays: `send` drops frames, and the greeting after a reconnect
    // ends in `afterResponse`, which delivers what was kept.
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return;
    const updates = this.queuedUpdates.splice(0);
    if (updates.length === 0) return;
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: updates.join("\n\n") }] },
    });
    this.send({ type: "response.create" });
  }

  private upsert(id: string, who: TranscriptEntry["who"], text: string, final: boolean): void {
    const existing = this.transcript.find((e) => e.id === id);
    if (existing) {
      existing.text = text;
      existing.final = final || existing.final;
    } else {
      this.transcript.push({ id, who, text, final });
    }
    const logged = this.fullLog.get(id);
    if (logged) logged.text = text;
    else this.fullLog.set(id, { who, text, at: Date.now() });
    this.unsaved = true;
    writeBuffer(this.startedAt, [...this.fullLog.values()]);
    // Keep the panel light on a long call.
    if (this.transcript.length > 60) this.transcript.splice(0, this.transcript.length - 60);
    this.opts.onTranscript([...this.transcript]);
  }

  private addNote(text: string): void {
    this.upsert(`note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, "note", text, true);
  }
}
