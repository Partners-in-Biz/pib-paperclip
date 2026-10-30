import { base64ToArrayBuffer, LIVE_SAMPLE_RATE, MicCapture, Player } from "./audio.js";
import { clip, LiveTools, TOOL_DEFINITIONS, type ApiClient } from "./live-tools.js";
import { pruneBuffers, writeBuffer } from "./transcript-buffer.js";
import type { CallRecord, LogEntry, SaveTarget } from "./transcript-report.js";
import type { WakeGuard } from "./wake-lock.js";

export type LiveState = "connecting" | "listening" | "thinking" | "speaking" | "ended" | "error";

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
  /** How often watched tasks are checked for agent replies. */
  replyPollMs?: number;
}

interface PendingCall {
  callId: string;
  name: string;
  args: string;
}

interface Watched {
  ref: string;
  lastSeenId: string | null;
  lastSeenAt: string;
}

/** Hang up after this much silence on both sides, so a pocketed phone does not run up a bill. */
const IDLE_HANGUP_MS = 4 * 60 * 1000;

export class LiveSession {
  private ws: WebSocket | null = null;
  private mic: MicCapture | null = null;
  private player: Player;
  private tools: LiveTools;
  private transcript: TranscriptEntry[] = [];
  private state: LiveState = "connecting";
  private pendingCalls: PendingCall[] = [];
  private responseActive = false;
  private queuedUpdates: string[] = [];
  private watched = new Map<string, Watched>();
  private pollTimer: number | null = null;
  private idleTimer: number | null = null;
  private voiceLevel = 0;
  private closed = false;
  private userTurns = 0;
  private readonly startedAt = Date.now();
  private readonly fullLog = new Map<string, LogEntry>();
  private ended = false;

  constructor(private readonly opts: LiveSessionOptions) {
    this.player = new Player(opts.audioContext);
    pruneBuffers();
    this.player.onLevel = (lvl) => {
      this.voiceLevel = lvl;
      if (lvl === 0 && this.state === "speaking" && !this.responseActive) this.setState("listening");
    };
    this.tools = new LiveTools({
      api: opts.api,
      companyId: opts.companyId,
      userId: opts.userId,
      pageIssueRef: opts.pageIssueRef,
      watch: (issueId, ref) => this.watch(issueId, ref),
      userTurn: () => this.userTurns,
    });
  }

  get muted(): boolean {
    return this.mic?.muted ?? false;
  }

  setMuted(muted: boolean): void {
    if (this.mic) this.mic.muted = muted;
  }

  async start(): Promise<void> {
    const { info } = this.opts;
    // Mic and socket start together; frames before `open` are dropped, which is fine
    // because the first thing that happens is the voice greeting.
    this.mic = new MicCapture(this.opts.audioContext, (pcm, lvl) => {
      this.opts.onLevel(lvl, this.voiceLevel);
      if (lvl > 0.08) this.bumpIdle();
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm);
    });
    const micReady = this.mic.start();

    const ws = new WebSocket(info.url, [`xai-client-secret.${info.token}`]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.addEventListener("open", () => this.configure());
    ws.addEventListener("message", (event) => this.onMessage(event));
    ws.addEventListener("error", () => {
      if (!this.closed) this.fail("The voice connection dropped.");
    });
    ws.addEventListener("close", (event) => {
      console.warn("[pib-voice] socket closed", { code: event.code, reason: event.reason, wasClean: event.wasClean, ending: this.closed });
      if (this.closed) return;
      this.fail(event.code === 1008 || event.code === 4001 ? "The voice pass expired or was refused. Try again." : "The voice connection closed.");
    });

    try {
      await micReady;
    } catch {
      this.fail("Microphone access was blocked. Allow the mic for this site and try again.");
      return;
    }
    if (this.closed) return;
    this.pollTimer = window.setInterval(() => void this.pollReplies(), this.opts.replyPollMs ?? 10_000);
    this.bumpIdle();
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.opts.wakeLock?.release();
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
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
    const targets: SaveTarget[] = [...this.watched].map(([issueId, w]) => ({ issueId, ref: w.ref }));
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
    this.opts.wakeLock?.release();
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
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
    const { info } = this.opts;
    const transcription: Record<string, unknown> = {};
    if (info.keyterms.length > 0) transcription.keyterms = info.keyterms.slice(0, 100);
    if (info.language) transcription.language_hint = info.language;
    this.send({
      type: "session.update",
      session: {
        voice: info.voice,
        instructions: this.opts.instructions,
        turn_detection: { type: "server_vad" },
        tools: TOOL_DEFINITIONS,
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
    // Open with a one-line greeting so the person knows it is listening.
    this.send({
      type: "response.create",
      response: { instructions: "Greet them in one short sentence and ask what they need. Do not call tools yet." },
    });
    this.setState("thinking");
  }

  private onMessage(event: MessageEvent): void {
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
        break;
      case "input_audio_buffer.speech_stopped":
        this.setState("thinking");
        break;
      case "conversation.item.input_audio_transcription.completed":
      case "conversation.item.input_audio_transcription.updated": {
        const text = typeof msg.transcript === "string" ? msg.transcript : "";
        const itemId = typeof msg.item_id === "string" ? msg.item_id : `you-${Date.now()}`;
        if (text.trim()) this.upsert(itemId, "you", text, type.endsWith("completed"));
        if (type.endsWith("completed") && text.trim()) this.userTurns++;
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
      case "response.function_call_arguments.done":
        this.pendingCalls.push({
          callId: String(msg.call_id ?? ""),
          name: String(msg.name ?? ""),
          args: typeof msg.arguments === "string" ? msg.arguments : "{}",
        });
        break;
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

  /** Runs every tool call of the turn, then asks for one follow-up response. */
  private async afterResponse(): Promise<void> {
    if (this.pendingCalls.length > 0) {
      const calls = this.pendingCalls.splice(0);
      this.setState("thinking");
      const outputs = await Promise.all(calls.map((call) => this.runTool(call)));
      calls.forEach((call, i) => {
        this.send({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: call.callId, output: JSON.stringify(outputs[i]) },
        });
      });
      // Avoid talking over itself: let the current sentence finish first.
      await this.player.idle();
      if (!this.closed) this.send({ type: "response.create" });
      return;
    }
    if (this.queuedUpdates.length > 0) {
      await this.player.idle();
      this.deliverUpdates();
      return;
    }
    if (!this.player.playing) this.setState("listening");
  }

  private async runTool(call: PendingCall): Promise<unknown> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.args || "{}") as Record<string, unknown>;
    } catch {
      return { error: "The tool arguments were not valid JSON." };
    }
    try {
      if (call.name === "check_replies") return await this.checkReplies();
      const result = await this.tools.run(call.name, args);
      if (call.name === "post_message" && (result as { posted?: boolean }).posted) this.addNote(`Posted to ${(result as { task?: string }).task}.`);
      if (call.name === "create_task" && (result as { created?: boolean }).created) this.addNote(`Created ${(result as { task?: string }).task}.`);
      return result;
    } catch (err) {
      return { error: err instanceof Error ? clip(err.message, 240) : "The tool failed." };
    }
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

  private async checkReplies(): Promise<unknown> {
    if (this.watched.size === 0) return { replies: [], note: "Nothing posted in this conversation yet." };
    const replies = await this.collectReplies();
    return { replies };
  }

  private async pollReplies(): Promise<void> {
    if (this.closed || this.watched.size === 0) return;
    let replies: Array<{ ref: string; from: string; text: string }>;
    try {
      replies = await this.collectReplies();
    } catch {
      return; // A missed poll is retried on the next tick.
    }
    if (replies.length === 0) return;
    for (const r of replies) {
      this.queuedUpdates.push(`[Update] ${r.from} replied on ${r.ref}: ${r.text}`);
      this.addNote(`${r.from} replied on ${r.ref}.`);
    }
    if (!this.responseActive && !this.player.playing) this.deliverUpdates();
  }

  private deliverUpdates(): void {
    const updates = this.queuedUpdates.splice(0);
    if (updates.length === 0 || this.closed) return;
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
    writeBuffer(this.startedAt, [...this.fullLog.values()]);
    // Keep the panel light on a long call.
    if (this.transcript.length > 60) this.transcript.splice(0, this.transcript.length - 60);
    this.opts.onTranscript([...this.transcript]);
  }

  private addNote(text: string): void {
    this.upsert(`note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, "note", text, true);
  }
}
