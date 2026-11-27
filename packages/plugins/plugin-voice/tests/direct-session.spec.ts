// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mics: [] as Array<{ onFrame: (pcm: ArrayBuffer, lvl: number) => void; muted: boolean }>,
  players: [] as Array<{ enqueue: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> }>,
  playMs: 500,
}));

vi.mock("../src/ui/audio.js", () => ({
  LIVE_SAMPLE_RATE: 24000,
  // The decoded "One moment" clip plays as this tag.
  floatToPcm16: () => ({ tag: "filler" }) as unknown as ArrayBuffer,
  // The fake speak answers a readable tag instead of base64, so the test sees which chunk was played.
  base64ToArrayBuffer: (tag: string) => ({ tag }) as unknown as ArrayBuffer,
  MicCapture: class {
    muted = false;
    start = vi.fn(async () => undefined);
    stop = vi.fn();
    constructor(_ctx: unknown, public onFrame: (pcm: ArrayBuffer, lvl: number) => void) {
      h.mics.push(this);
    }
  },
  Player: class {
    onLevel: ((l: number) => void) | null = null;
    private waiters: Array<() => void> = [];
    enqueue = vi.fn();
    flush = vi.fn(() => {
      for (const resolve of this.waiters.splice(0)) resolve();
    });
    get playing() {
      return this.waiters.length > 0;
    }
    idle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          this.waiters.push(resolve);
          setTimeout(() => {
            this.waiters = this.waiters.filter((w) => w !== resolve);
            resolve();
          }, h.playMs);
        }),
    );
    constructor() {
      h.players.push(this as never);
    }
  },
}));

import { DirectSession, FILLER_UNAVAILABLE_NOTICE, GEMINI_FALLBACK_NOTICE, READ_FAILED_NOTICE, SOUND_BLOCKED_NOTICE, type SpeakProvider } from "../src/ui/direct-session.js";
import type { CallRecord } from "../src/ui/transcript-report.js";
import { rowSteps } from "../src/ui/turn-timing.js";
import { readBuffer } from "../src/ui/transcript-buffer.js";
import { chunk, REST_IN_CHAT, toSpeech } from "../src/ui/speech-text.js";
import { plainChatContext } from "../src/ui/call-context.js";
import { ONE_MOMENT_MP3_BASE64 } from "../src/ui/assets/one-moment.js";

interface Row {
  id: string;
  body: string;
  authorAgentId: string | null;
  authorUserId?: string | null;
  origin: string;
  deletedAt: string | null;
  createdAt: string;
  hidden?: boolean;
}

function fakeApi(chatIssue: Record<string, unknown> = { assigneeAgentId: "a-ren" }) {
  const rows: Row[] = [];
  let n = 0;
  const get = vi.fn(async (path: string) => {
    if (path === "/companies/c1/agents") return [{ id: "a-ren", name: "Ren", role: "ceo", status: "idle" }];
    const m = /^\/issues\/chat-1\/comments\?(.*)$/.exec(path);
    if (!m) throw new Error(`unexpected GET ${path}`);
    const q = new URLSearchParams(m[1]);
    const visible = rows.filter((r) => !r.hidden);
    const after = q.get("after");
    if (after) {
      const i = visible.findIndex((r) => r.id === after);
      return visible.slice(i + 1, i + 1 + Number(q.get("limit") ?? 100)).map((r) => ({ ...r }));
    }
    return [...visible].reverse().slice(0, Number(q.get("limit") ?? 100)).map((r) => ({ ...r }));
  });
  const post = vi.fn(async (path: string, body: { body: string; clientRequestId: string }) => {
    if (path === "/companies/c1/chats/a-ren") return { id: "chat-1", identifier: "PAR-1", ...chatIssue };
    if (path === "/issues/chat-1/comments") {
      const row: Row = { id: `u${++n}`, body: body.body, authorAgentId: null, authorUserId: "u1", origin: "comment", deletedAt: null, createdAt: new Date().toISOString() };
      rows.push(row);
      return row;
    }
    throw new Error(`unexpected POST ${path}`);
  });
  const add = (body: string, over: Partial<Row> = {}) => {
    const row: Row = { id: `r${++n}`, body, authorAgentId: "a-ren", origin: "comment", deletedAt: null, createdAt: new Date(Date.now() + 5).toISOString(), ...over };
    rows.push(row);
    return row;
  };
  const comments = () => post.mock.calls.filter(([p]) => p === "/issues/chat-1/comments").map(([, b]) => b);
  return { api: { get, post }, rows, add, comments };
}

function fakeFeed() {
  let cb: ((id: string) => void) | null = null;
  return {
    watch: vi.fn(),
    close: vi.fn(),
    onComment(fn: (id: string) => void) {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    emit(id: string) {
      cb?.(id);
    },
  };
}

type SpeakImpl = (p: { agentId: string; text: string; provider: SpeakProvider }) => Promise<unknown>;
const okSpeak: SpeakImpl = async ({ text, provider }) => ({ audio: `${provider}:${text}`, sampleRate: 24000, provider, voice: "eve" });

const decodeOk = () => vi.fn(async () => ({ sampleRate: 24000, getChannelData: () => new Float32Array(8) }));

async function make(
  opts: {
    provider?: SpeakProvider;
    speak?: SpeakImpl;
    interrupt?: () => boolean;
    onEnd?: (call: CallRecord, targets: unknown[]) => void;
    onAutosave?: (call: CallRecord) => void;
    chatIssue?: Record<string, unknown>;
    audioContext?: unknown;
    transcribe?: (p: { audio: string; mimeType: string }) => Promise<unknown>;
    onTarget?: (t: unknown) => void;
    onVoicing?: (since: number | null) => void;
  } = {},
) {
  const fake = fakeApi(opts.chatIssue);
  const feed = fakeFeed();
  const speak = vi.fn(opts.speak ?? okSpeak);
  const transcribe = vi.fn(opts.transcribe ?? (async (_p: { audio: string; mimeType: string }) => ({ text: "What is the status?" })));
  const onNotice = vi.fn();
  const onTranscript = vi.fn();
  const session = new DirectSession({
    api: fake.api as never,
    companyId: "c1",
    context: plainChatContext(),
    agentRef: "a-ren",
    provider: opts.provider ?? "grok",
    audioContext: (opts.audioContext ?? { close: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), decodeAudioData: decodeOk() }) as never,
    speak,
    transcribe,
    interruptByTalking: opts.interrupt,
    onState: vi.fn(),
    onTranscript,
    onLevel: vi.fn(),
    onError: vi.fn(),
    onNotice,
    onEnd: opts.onEnd,
    onAutosave: opts.onAutosave,
    onTarget: opts.onTarget,
    onVoicing: opts.onVoicing,
    autosaveMs: 1_000,
    feed,
  });
  await session.start();
  const mic = h.mics[h.mics.length - 1]!;
  const player = h.players[h.players.length - 1]!;
  return { session, fake, feed, speak, transcribe, onNotice, onTranscript, mic, player };
}

/** 100 ms frames at 24 kHz: `loudMs` of speech, then enough quiet to end the utterance. */
function talk(mic: { onFrame: (pcm: ArrayBuffer, lvl: number) => void }, loudMs = 600, quietMs = 1_300) {
  for (let t = 0; t < loudMs; t += 100) mic.onFrame(new ArrayBuffer(4_800), 0.5);
  for (let t = 0; t < quietMs; t += 100) mic.onFrame(new ArrayBuffer(4_800), 0);
}

const LONG_REPLY = [
  "## Status",
  "",
  "The deploy finished at noon and **all checks** passed on the first try, which is a good sign for the release later this week.",
  "",
  "- The login page now loads in under a second on a phone.",
  "- The billing export runs every night and the numbers match the bank file.",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "Next I will tidy the old branches and close the three stale tickets that nobody has touched since October.",
  "",
  "After that I will write the release notes, ask the reviewer for a final look, and tell you when the build is live on the board so you can try it yourself.",
].join("\n");

const spokenTexts = (speak: ReturnType<typeof vi.fn>) => speak.mock.calls.map(([p]) => `${p.provider}:${p.text}`);
/** Reply chunks played; the "One moment" filler is counted apart by `fillers`. */
const played = (player: { enqueue: ReturnType<typeof vi.fn> }) => player.enqueue.mock.calls.map(([buf]) => (buf as { tag: string }).tag).filter((t) => t !== "filler");
const fillers = (player: { enqueue: ReturnType<typeof vi.fn> }) => player.enqueue.mock.calls.filter(([buf]) => (buf as { tag: string }).tag === "filler").length;
const notes = (ctx: { onTranscript: ReturnType<typeof vi.fn> }) =>
  (ctx.onTranscript.mock.calls.at(-1)![0] as Array<{ id: string; who: string; text: string }>).filter((e) => e.who === "note");

async function turn(ctx: Awaited<ReturnType<typeof make>>) {
  talk(ctx.mic);
  await vi.advanceTimersByTimeAsync(0);
}

describe("DirectSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.mics.length = 0;
    h.players.length = 0;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("posts one utterance as one comment with the spoken-reply hint, as WAV", async () => {
    const ctx = await make();
    await turn(ctx);
    expect(ctx.transcribe).toHaveBeenCalledTimes(1);
    const sent = ctx.transcribe.mock.calls[0]![0];
    expect(sent.mimeType).toBe("audio/wav");
    expect(atob(sent.audio).slice(0, 4)).toBe("RIFF");
    expect(ctx.fake.comments()).toHaveLength(1);
    expect(ctx.fake.comments()[0]!.body).toBe("What is the status?\n\n_Sent by voice: reply in short spoken sentences._");
    expect(ctx.feed.watch).toHaveBeenCalledWith("chat-1");
  });

  it("speaks the agent's reply word for word, chunk by chunk in order, at 24 kHz", async () => {
    const ctx = await make();
    await turn(ctx);
    const reply = ctx.fake.add(LONG_REPLY);
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(10_000);
    const expected = chunk(toSpeech(LONG_REPLY));
    expect(expected.length).toBeGreaterThan(2);
    expect(spokenTexts(ctx.speak)).toEqual(expected.map((t) => `grok:${t}`));
    expect(played(ctx.player)).toEqual(expected.map((t) => `grok:${t}`));
    expect(ctx.player.enqueue.mock.calls.every(([, rate]) => rate === 24000)).toBe(true);
    expect(ctx.speak.mock.calls.every(([p]) => p.agentId === "a-ren")).toBe(true);
    // The transcript shows the agent's real reply text.
    const last = ctx.onTranscript.mock.calls.at(-1)![0] as Array<{ who: string; text: string }>;
    expect(last.find((e) => e.who === "voice")?.text).toBe(reply.body);
  });

  it("speaks a comment once when the event and the poll both deliver it", async () => {
    const ctx = await make();
    await turn(ctx);
    ctx.fake.add("Done. All green.");
    ctx.feed.emit("chat-1");
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(25_000);
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spokenTexts(ctx.speak)).toEqual(["grok:Done. All green."]);
  });

  it("does not speak the platform receipt, another agent, a deleted comment or one older than the turn", async () => {
    const ctx = await make();
    ctx.fake.add("An old reply from before the call.", { createdAt: new Date(Date.now() - 60_000).toISOString() });
    await turn(ctx);
    ctx.fake.add("Got it, working on it.", { origin: "fast_response" });
    ctx.fake.add("I am a different agent.", { authorAgentId: "a-other" });
    ctx.fake.add("This was deleted.", { deletedAt: new Date().toISOString() });
    ctx.fake.add("The real answer.");
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(spokenTexts(ctx.speak)).toEqual(["grok:The real answer."]);
  });

  it("speaks several comments from one run in creation order, progress notes included", async () => {
    const ctx = await make();
    await turn(ctx);
    ctx.fake.add("On it, checking the logs.");
    ctx.fake.add("Found it: a stale cache.");
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spokenTexts(ctx.speak)).toEqual(["grok:On it, checking the logs.", "grok:Found it: a stale cache."]);
  });

  it("re-reads 1 s after an event that landed before the row was readable", async () => {
    const ctx = await make();
    await turn(ctx);
    const row = ctx.fake.add("Here you go.", { hidden: true });
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(500);
    expect(ctx.speak).not.toHaveBeenCalled();
    row.hidden = false;
    await vi.advanceTimersByTimeAsync(600);
    expect(spokenTexts(ctx.speak)).toEqual(["grok:Here you go."]);
  });

  it("still delivers by poll within 10 s when the live feed is down", async () => {
    const ctx = await make();
    await turn(ctx);
    ctx.fake.add("Polled reply.");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spokenTexts(ctx.speak)).toEqual(["grok:Polled reply."]);
  });

  it("reads the reply within 2 s of the post (fast window), also after an interim reply", async () => {
    const ctx = await make();
    await turn(ctx);
    ctx.fake.add("On it, checking.");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spokenTexts(ctx.speak)).toEqual(["grok:On it, checking."]);
    await vi.advanceTimersByTimeAsync(5_000);
    ctx.fake.add("Found it.");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spokenTexts(ctx.speak)).toEqual(["grok:On it, checking.", "grok:Found it."]);
  });

  it("outside the 90 s fast window the reply is read every 10 s, not 2 s", async () => {
    const ctx = await make();
    await turn(ctx);
    await vi.advanceTimersByTimeAsync(101_000);
    ctx.fake.add("Late reply.");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(ctx.speak).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spokenTexts(ctx.speak)).toEqual(["grok:Late reply."]);
  });

  it("Gemini barge-in drops the prefetched chunk: two calls, no third", async () => {
    const ctx = await make({ provider: "gemini" });
    await turn(ctx);
    ctx.fake.add(LONG_REPLY);
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(100);
    expect(played(ctx.player)).toHaveLength(1);
    expect(ctx.speak).toHaveBeenCalledTimes(2);
    for (let t = 0; t < 300; t += 100) ctx.mic.onFrame(new ArrayBuffer(4_800), 0.5);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(played(ctx.player)).toHaveLength(1);
    expect(ctx.speak).toHaveBeenCalledTimes(2);
  });

  it("Gemini prefetch non-ok: Grok takes that chunk, one notice, no chunk lost or repeated", async () => {
    const ctx = await make({ provider: "gemini", speak: async (p) => (p.provider === "gemini" ? { error: "provider_error" } : okSpeak(p)) });
    await turn(ctx);
    ctx.fake.add(LONG_REPLY);
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(10_000);
    const expected = chunk(toSpeech(LONG_REPLY));
    expect(played(ctx.player)).toEqual(expected.map((t) => `grok:${t}`));
    expect(ctx.onNotice.mock.calls.filter(([m]) => m === GEMINI_FALLBACK_NOTICE)).toHaveLength(1);
  });

  it("barge-in by voice stops playback, drops the queue and the prefetched chunk", async () => {
    const ctx = await make();
    await turn(ctx);
    ctx.fake.add(LONG_REPLY);
    ctx.fake.add("A second reply that must not be spoken.");
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(100);
    // First chunk playing, the second already fetched (Grok prefetch).
    expect(played(ctx.player)).toHaveLength(1);
    expect(ctx.speak).toHaveBeenCalledTimes(2);
    for (let t = 0; t < 300; t += 100) ctx.mic.onFrame(new ArrayBuffer(4_800), 0.5);
    expect(ctx.player.flush).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(played(ctx.player)).toHaveLength(1);
    expect(ctx.speak).toHaveBeenCalledTimes(2);
    // Talking on starts a new turn.
    await vi.advanceTimersByTimeAsync(0);
    talk(ctx.mic);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.fake.comments()).toHaveLength(2);
  });

  it("with Interrupt by talking off, the voice does not stop it but a tap does", async () => {
    const ctx = await make({ interrupt: () => false });
    await turn(ctx);
    ctx.fake.add(LONG_REPLY);
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(100);
    for (let t = 0; t < 1_000; t += 100) ctx.mic.onFrame(new ArrayBuffer(4_800), 0.9);
    expect(ctx.player.flush).not.toHaveBeenCalled();
    ctx.session.interrupt();
    expect(ctx.player.flush).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(played(ctx.player)).toHaveLength(1);
    expect(ctx.fake.comments()).toHaveLength(1);
  });

  it.each(["not_configured", "auth_failed", "rate_limited", "provider_error", "timeout", "daily_limit", "thrown"])(
    "Gemini %s: the same chunk and the rest of the call go to Grok, none skipped",
    async (outcome) => {
      const ctx = await make({
        provider: "gemini",
        speak: async (p) => {
          if (p.provider === "gemini") {
            if (outcome === "thrown") throw new Error("network");
            return { error: outcome };
          }
          return okSpeak(p);
        },
      });
      await turn(ctx);
      ctx.fake.add(LONG_REPLY);
      ctx.feed.emit("chat-1");
      await vi.advanceTimersByTimeAsync(10_000);
      const expected = chunk(toSpeech(LONG_REPLY));
      expect(spokenTexts(ctx.speak)).toEqual([`gemini:${expected[0]}`, ...expected.map((t) => `grok:${t}`)]);
      expect(played(ctx.player)).toEqual(expected.map((t) => `grok:${t}`));
      expect(ctx.onNotice.mock.calls.filter(([m]) => m === GEMINI_FALLBACK_NOTICE)).toHaveLength(1);
      expect(ctx.session.currentProvider).toBe("grok");
    },
  );

  it("Gemini prefetches: the next chunk is asked for while the first one plays", async () => {
    const ctx = await make({ provider: "gemini" });
    await turn(ctx);
    ctx.fake.add(LONG_REPLY);
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.speak).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    const expected = chunk(toSpeech(LONG_REPLY));
    expect(spokenTexts(ctx.speak)).toEqual(expected.map((t) => `gemini:${t}`));
  });

  it("Grok failing twice on a chunk stops that reply there: no later chunk, the rest is in the chat", async () => {
    const expected = chunk(toSpeech(LONG_REPLY));
    const ctx = await make({
      speak: async (p) => (p.text === expected[1] ? { error: "provider_error" } : okSpeak(p)),
    });
    await turn(ctx);
    ctx.fake.add(LONG_REPLY);
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spokenTexts(ctx.speak)).toEqual([`grok:${expected[0]}`, `grok:${expected[1]}`, `grok:${expected[1]}`]);
    expect(played(ctx.player)).toEqual([`grok:${expected[0]}`]);
    expect(ctx.onNotice).toHaveBeenCalledWith(REST_IN_CHAT);
  });

  it("Grok failing once is retried and the reply goes on", async () => {
    let failed = false;
    const ctx = await make({
      speak: async (p) => {
        if (!failed) {
          failed = true;
          return { error: "timeout" };
        }
        return okSpeak(p);
      },
    });
    await turn(ctx);
    ctx.fake.add("One. Two.");
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(played(ctx.player)).toEqual(["grok:One. Two."]);
  });

  it("an empty assignee on the chat issue does not silence it: the conversation agent is the reply's author and voice", async () => {
    const ctx = await make({ chatIssue: { assigneeAgentId: null, conversationAgentId: "a-ren" } });
    await turn(ctx);
    ctx.fake.add("Hello Peet.");
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spokenTexts(ctx.speak)).toEqual(["grok:Hello Peet."]);
    expect(ctx.speak.mock.calls[0]![0].agentId).toBe("a-ren");
  });

  it("with no agent on the chat issue at all, the agent the call asked for speaks", async () => {
    const ctx = await make({ chatIssue: { assigneeAgentId: null } });
    await turn(ctx);
    ctx.fake.add("Still here.");
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spokenTexts(ctx.speak)).toEqual(["grok:Still here."]);
  });

  it("says why the voice failed in the transcript, not only that it did", async () => {
    const ctx = await make({ provider: "gemini", speak: async (p) => (p.provider === "gemini" ? { error: "auth_failed" } : { error: "not_configured" }) });
    await turn(ctx);
    ctx.fake.add("Anyone there?");
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(5_000);
    const texts = notes(ctx).map((e) => e.text);
    expect(texts).toContain(`${GEMINI_FALLBACK_NOTICE} (gemini auth_failed)`);
    expect(texts).toContain(`Turn 1: the reply could not be voiced (grok not_configured). ${REST_IN_CHAT}`);
  });

  it("a suspended audio context that will not wake is said out loud, and nothing is queued", async () => {
    const audioContext = { state: "suspended", close: vi.fn(async () => undefined), resume: vi.fn(async () => undefined) };
    const ctx = await make({ audioContext });
    await turn(ctx);
    ctx.fake.add("Can you hear me?");
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(audioContext.resume).toHaveBeenCalled();
    expect(ctx.player.enqueue).not.toHaveBeenCalled();
    expect(ctx.onNotice).toHaveBeenCalledWith(SOUND_BLOCKED_NOTICE);
  });

  it("a suspended audio context that resumes plays the reply", async () => {
    const audioContext = {
      state: "suspended",
      close: vi.fn(async () => undefined),
      resume: vi.fn(async () => {
        audioContext.state = "running";
      }),
    };
    const ctx = await make({ audioContext });
    await turn(ctx);
    ctx.fake.add("Can you hear me?");
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(played(ctx.player)).toEqual(["grok:Can you hear me?"]);
  });

  it("a read of the chat that keeps failing is shown once, then reading goes on", async () => {
    const ctx = await make();
    await turn(ctx);
    const get = ctx.fake.api.get;
    const original = get.getMockImplementation()!;
    get.mockImplementation(async (path: string) => {
      if (path.startsWith("/issues/chat-1/comments")) throw new Error("Paperclip answered 500 for /issues/chat-1/comments");
      return original(path);
    });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(ctx.onNotice.mock.calls.filter(([m]) => m === READ_FAILED_NOTICE)).toHaveLength(1);
    get.mockImplementation(original);
    ctx.fake.add("Back again.");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spokenTexts(ctx.speak)).toEqual(["grok:Back again."]);
  });

  it("stop closes the feed and the mic and hands the call over once", async () => {
    const onEnd = vi.fn();
    const ctx = await make({ onEnd });
    await turn(ctx);
    ctx.session.stop();
    ctx.session.stop();
    expect(ctx.feed.close).toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0]![1]).toEqual([]);
    ctx.fake.add("Too late.");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctx.speak).not.toHaveBeenCalled();
  });
  describe("turn timing", () => {
    const audioContext = () => ({ close: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), currentTime: 0, outputLatency: 0.05 });

    it("marks every step of a turn with a fake clock and saves the rows with a stamp", async () => {
      vi.setSystemTime(new Date(2026, 10, 27, 10, 0, 0));
      const onEnd = vi.fn();
      const onAutosave = vi.fn();
      const ctx = await make({ onEnd, onAutosave, audioContext: audioContext() });
      ctx.player.enqueue.mockImplementation(() => ({ startAt: 0.4, endAt: 1.4 }));
      talk(ctx.mic);
      await vi.advanceTimersByTimeAsync(0);
      ctx.fake.add("Done.", { createdByRunId: "run-1" } as never);
      ctx.feed.emit("chat-1");
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onAutosave).toHaveBeenCalled();
      expect((onAutosave.mock.calls.at(-1)![0] as CallRecord).turns).toHaveLength(1);
      ctx.session.stop();
      const call = onEnd.mock.calls[0]![0] as CallRecord;
      expect(call.turns).toHaveLength(1);
      const row = call.turns![0]!;
      expect(row).toMatchObject({ n: 1, endKind: "end", provider: "grok", latencyKnown: true, via: "event", replyComments: 1 });
      for (const k of ["startAt", "endAt", "textAt", "postStartAt", "postedAt", "serverPostedAt", "replyServerAt", "seenAt", "speakStartAt", "audioAt", "playAt"] as const) {
        expect(typeof row[k], k).toBe("number");
      }
      expect(row.startAt!).toBeLessThanOrEqual(row.endAt);
      expect(row.endAt).toBeLessThanOrEqual(row.textAt!);
      expect(row.speakStartAt!).toBeGreaterThanOrEqual(row.seenAt!);
      // playAt = now + (startAt - currentTime + outputLatency) = audioAt + 450 ms.
      expect(row.playAt! - row.audioAt!).toBe(450);
      expect(call.timingStamp).toMatch(/^plugin-voice \d+\.\d+\.\d+, quiet 900 ms, first chunk 90 chars, await poll 2000 ms, fast window 90000 ms, Gemini prefetch on$/);
      const buffered = readBuffer(call.startedAt)!;
      expect(buffered.turns).toHaveLength(1);
      expect(buffered.timingStamp).toBe(call.timingStamp);
    });

    const slots = (...pairs: Array<[number, number]>) => {
      let i = 0;
      return () => {
        const [startAt, endAt] = pairs[Math.min(i, pairs.length - 1)]!;
        i += 1;
        return { startAt, endAt };
      };
    };
    const endRows = (onEnd: ReturnType<typeof vi.fn>, session: { stop(): void }) => {
      session.stop();
      return (onEnd.mock.calls[0]![0] as CallRecord).turns!;
    };

    it("a reply found by the poll records via poll", async () => {
      const onEnd = vi.fn();
      const ctx = await make({ onEnd });
      await turn(ctx);
      ctx.fake.add("Done.");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(endRows(onEnd, ctx.session)[0]!.via).toBe("poll");
    });

    it("two replies queued: the second's queue is the first's playback, its tts excludes it", async () => {
      const onEnd = vi.fn();
      const speak: SpeakImpl = async (p) => {
        await new Promise((r) => setTimeout(r, 200));
        return okSpeak(p);
      };
      const ctx = await make({ onEnd, speak, audioContext: audioContext() });
      ctx.player.enqueue.mockImplementation(slots([0.4, 1.4]));
      await turn(ctx);
      await turn(ctx);
      ctx.fake.add("First.", { createdByRunId: "run-1" } as never);
      ctx.fake.add("Second.", { createdByRunId: "run-2" } as never);
      ctx.feed.emit("chat-1");
      await vi.advanceTimersByTimeAsync(3_000);
      const rows = endRows(onEnd, ctx.session);
      expect(rows).toHaveLength(2);
      const a = rowSteps(rows[0]!, 0);
      const b = rowSteps(rows[1]!, 0);
      expect(a.queue).toBeLessThan(50);
      // Waits behind the whole first reply: its 200 ms of speech fetch plus 500 ms of playback.
      expect(b.queue).toBe(700 + a.queue!);
      expect(a.tts).toBe(200);
      expect(b.tts).toBe(200);
    });

    it("a barge-in before the audio arrives leaves tts, start and silence empty", async () => {
      const onEnd = vi.fn();
      const speak: SpeakImpl = async (p) => {
        await new Promise((r) => setTimeout(r, 2_000));
        return okSpeak(p);
      };
      const ctx = await make({ onEnd, speak, audioContext: audioContext() });
      ctx.player.enqueue.mockImplementation(slots([0.4, 1.4]));
      await turn(ctx);
      ctx.fake.add("Long answer.");
      ctx.feed.emit("chat-1");
      await vi.advanceTimersByTimeAsync(100);
      ctx.session.interrupt();
      await vi.advanceTimersByTimeAsync(3_000);
      const row = endRows(onEnd, ctx.session)[0]!;
      const steps = rowSteps(row, 0);
      expect(row.speakStartAt).toBeTypeOf("number");
      expect(steps.tts).toBeUndefined();
      expect(steps.start).toBeUndefined();
      expect(steps.silence).toBeUndefined();
      expect(ctx.player.enqueue).not.toHaveBeenCalled();
    });

    it("a three-chunk reply records the silence between chunks as gap", async () => {
      const onEnd = vi.fn();
      const ctx = await make({ onEnd, audioContext: audioContext() });
      expect(chunk(toSpeech(LONG_REPLY)).length).toBeGreaterThanOrEqual(3);
      ctx.player.enqueue.mockImplementation(slots([0.4, 1.4], [1.9, 2.9], [3.0, 4.0]));
      await turn(ctx);
      ctx.fake.add(LONG_REPLY);
      ctx.feed.emit("chat-1");
      await vi.advanceTimersByTimeAsync(10_000);
      const row = endRows(onEnd, ctx.session)[0]!;
      expect(row.gap).toBe(600);
    });

    it("with only baseLatency the play time adds it and latencyKnown is false", async () => {
      const onEnd = vi.fn();
      const ctx = await make({ onEnd, audioContext: { close: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), currentTime: 0, baseLatency: 0.02 } });
      ctx.player.enqueue.mockImplementation(slots([0.4, 1.4]));
      await turn(ctx);
      ctx.fake.add("Done.");
      ctx.feed.emit("chat-1");
      await vi.advanceTimersByTimeAsync(2_000);
      const row = endRows(onEnd, ctx.session)[0]!;
      expect(row.latencyKnown).toBe(false);
      expect(row.playAt! - row.audioAt!).toBe(420);
    });

    it("a call with no turn carries no timing", async () => {
      const onEnd = vi.fn();
      const ctx = await make({ onEnd });
      ctx.session.stop();
      const call = onEnd.mock.calls[0]![0] as CallRecord;
      expect(call.turns).toBeUndefined();
      expect(call.timingStamp).toBeUndefined();
    });
  });

  describe("turn outcome (PAR-15051 T1a)", () => {
    const ac = () => ({ close: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), currentTime: 0, outputLatency: 0, decodeAudioData: decodeOk() });
    const endRows = (onEnd: ReturnType<typeof vi.fn>, session: { stop(): void }) => {
      session.stop();
      return (onEnd.mock.calls[0]![0] as CallRecord).turns!;
    };
    const turnNotes = (ctx: { onTranscript: ReturnType<typeof vi.fn> }) => notes(ctx).filter((e) => e.text.startsWith("Turn "));
    const slow = (ms: number): SpeakImpl => async (p) => {
      await new Promise((r) => setTimeout(r, ms));
      return okSpeak(p);
    };

    it("voiced needs playAt: a played reply is voiced once and a later hang-up adds nothing", async () => {
      const onEnd = vi.fn();
      const ctx = await make({ onEnd, audioContext: ac() });
      ctx.player.enqueue.mockImplementation(() => ({ startAt: 0.1, endAt: 1 }));
      await turn(ctx);
      ctx.fake.add("Done.");
      ctx.feed.emit("chat-1");
      await vi.advanceTimersByTimeAsync(2_000);
      const row = endRows(onEnd, ctx.session)[0]!;
      expect(row.outcome).toBe("voiced");
      expect(row.playAt).toBeTypeOf("number");
      expect(turnNotes(ctx)).toEqual([]);
    });

    it("a sound-blocked turn has audioAt but is not voiced", async () => {
      const onEnd = vi.fn();
      const ctx = await make({ onEnd, audioContext: { ...ac(), state: "suspended" } });
      await turn(ctx);
      ctx.fake.add("Hello?");
      ctx.feed.emit("chat-1");
      await vi.advanceTimersByTimeAsync(3_000);
      const row = endRows(onEnd, ctx.session)[0]!;
      expect(row.outcome).toBe("sound_blocked");
      expect(row.playAt).toBeUndefined();
      expect(row.audioAt).toBeTypeOf("number");
      expect(turnNotes(ctx).map((e) => e.text)).toEqual([`Turn 1: ${SOUND_BLOCKED_NOTICE}`]);
    });

    it("voice_failed when both engines fail; the Gemini-to-Grok note alone sets no outcome", async () => {
      const failedEnd = vi.fn();
      const a = await make({ onEnd: failedEnd, provider: "gemini", speak: async () => ({ error: "provider_error" }) });
      await turn(a);
      a.fake.add("Hi.");
      a.feed.emit("chat-1");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(endRows(failedEnd, a.session)[0]!.outcome).toBe("voice_failed");
      const okEnd = vi.fn();
      const b = await make({ onEnd: okEnd, provider: "gemini", audioContext: ac(), speak: async (p) => (p.provider === "gemini" ? { error: "timeout" } : okSpeak(p)) });
      b.player.enqueue.mockImplementation(() => ({ startAt: 0.1, endAt: 1 }));
      await turn(b);
      b.fake.add("Hi.");
      b.feed.emit("chat-1");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(notes(b).map((e) => e.text)).toContain(`${GEMINI_FALLBACK_NOTICE} (gemini timeout)`);
      expect(endRows(okEnd, b.session)[0]!.outcome).toBe("voiced");
      expect(turnNotes(b)).toEqual([]);
    });

    it("at hang-up: hung_up_voicing and no_reply, each with one Turn note that carries the turn in its id", async () => {
      const onEnd = vi.fn();
      const ctx = await make({ onEnd, speak: slow(5_000) });
      await turn(ctx);
      await turn(ctx);
      ctx.fake.add("Slow answer.");
      ctx.feed.emit("chat-1");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(endRows(onEnd, ctx.session).map((r) => r.outcome)).toEqual(["hung_up_voicing", "no_reply"]);
      const t = turnNotes(ctx);
      expect(t.map((e) => e.text)).toEqual(["Turn 1: hung up while the reply was being voiced (grok, 2.0 s).", "Turn 2: no reply before the call ended."]);
      expect(t[0]!.id).toMatch(/^note-t1-/);
      expect(t[1]!.id).toMatch(/^note-t2-/);
    });

    it("talked_over when a barge-in drops the reply before it played", async () => {
      const onEnd = vi.fn();
      const ctx = await make({ onEnd, speak: slow(1_000) });
      await turn(ctx);
      ctx.fake.add("Answer.");
      ctx.feed.emit("chat-1");
      await vi.advanceTimersByTimeAsync(100);
      ctx.session.interrupt();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(endRows(onEnd, ctx.session)[0]!.outcome).toBe("talked_over");
      expect(turnNotes(ctx).map((e) => e.text)).toEqual(["Turn 1: reply stopped, you spoke over it."]);
    });

    it("not_sent when every post fails", async () => {
      const onEnd = vi.fn();
      const ctx = await make({ onEnd });
      const original = ctx.fake.api.post.getMockImplementation()!;
      ctx.fake.api.post.mockImplementation(async (path: string, body: { body: string; clientRequestId: string }) => {
        if (path === "/issues/chat-1/comments") throw new Error("Paperclip answered 500");
        return original(path, body);
      });
      await turn(ctx);
      expect(endRows(onEnd, ctx.session)[0]!.outcome).toBe("not_sent");
      expect(turnNotes(ctx).map((e) => e.text)).toEqual(["Turn 1: not sent (Paperclip answered 500)."]);
    });

    it("not_heard keeps a row for a transcribe error and for empty text, and posts nothing", async () => {
      const onEnd = vi.fn();
      let calls = 0;
      const ctx = await make({
        onEnd,
        transcribe: async () => {
          calls += 1;
          if (calls === 1) throw new Error("xAI 503");
          return { text: "  " };
        },
      });
      await turn(ctx);
      await vi.advanceTimersByTimeAsync(2_000);
      await turn(ctx);
      const rows = endRows(onEnd, ctx.session);
      expect(rows.map((r) => r.outcome)).toEqual(["not_heard", "not_heard"]);
      expect(rows[0]!.textAt).toBeUndefined();
      expect(ctx.fake.comments()).toHaveLength(0);
      expect(turnNotes(ctx).map((e) => e.text)).toEqual(["Turn 1: not heard (xAI 503).", "Turn 2: not heard, nothing was transcribed."]);
    });

    it("records the worker's provider times for stt and tts", async () => {
      const onEnd = vi.fn();
      const ctx = await make({
        onEnd,
        audioContext: ac(),
        transcribe: async () => {
          await new Promise((r) => setTimeout(r, 1_000));
          return { text: "Hi", providerMs: 700 };
        },
        speak: async (p) => ({ ...((await okSpeak(p)) as object), providerMs: 300 }),
      });
      ctx.player.enqueue.mockImplementation(() => ({ startAt: 0.1, endAt: 1 }));
      await turn(ctx);
      await vi.advanceTimersByTimeAsync(1_000);
      ctx.fake.add("Done.");
      ctx.feed.emit("chat-1");
      await vi.advanceTimersByTimeAsync(1_000);
      const row = endRows(onEnd, ctx.session)[0]!;
      expect(row).toMatchObject({ sttProviderMs: 700, ttsProviderMs: 300, outcome: "voiced" });
      expect(rowSteps(row, 0)).toMatchObject({ stt: 1_000, sttProvider: 700, sttRest: 300, ttsProvider: 300 });
    });

    it("reports the chat target, and the wait for chunk 0 until its audio arrives", async () => {
      const onTarget = vi.fn();
      const onVoicing = vi.fn();
      const ctx = await make({ onTarget, onVoicing, speak: slow(1_000) });
      await turn(ctx);
      expect(onTarget).toHaveBeenCalledWith(expect.objectContaining({ issueId: "chat-1" }));
      ctx.fake.add("Answer.");
      ctx.feed.emit("chat-1");
      await vi.advanceTimersByTimeAsync(100);
      expect(onVoicing.mock.calls.at(-1)![0]).toBeTypeOf("number");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onVoicing.mock.calls.at(-1)![0]).toBeNull();
    });
  });

  describe("One moment filler (PAR-15051 T1a)", () => {
    it("is a bundled MP3 under 1 s and 20 KB", () => {
      const bytes = Buffer.from(ONE_MOMENT_MP3_BASE64, "base64");
      expect(bytes.length).toBeLessThan(20_000);
      // MPEG-2 layer III frame header; the bitrate index gives the (constant) bitrate.
      expect([bytes[0], bytes[1]! & 0xfe]).toEqual([0xff, 0xf2]);
      const kbps = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][bytes[2]! >> 4]!;
      expect((bytes.length * 8) / (kbps * 1000)).toBeLessThan(1);
    });

    it("plays once at end of speech + 4 s with no reply audio; not posted, not a provider call, not a reply", async () => {
      const onEnd = vi.fn();
      const ctx = await make({ onEnd });
      talk(ctx.mic);
      const endAt = Date.now();
      await vi.advanceTimersByTimeAsync(3_990);
      expect(fillers(ctx.player)).toBe(0);
      await vi.advanceTimersByTimeAsync(10);
      expect(fillers(ctx.player)).toBe(1);
      // The live buffer has it without any transcript line being added.
      const buffered = JSON.parse(localStorage.getItem(localStorage.key(0)!)!) as { turns: Array<{ fillerAt?: number }> };
      expect(buffered.turns[0]!.fillerAt).toBe(endAt + 4_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fillers(ctx.player)).toBe(1);
      expect(ctx.speak).not.toHaveBeenCalled();
      expect(ctx.fake.comments()).toHaveLength(1);
      ctx.session.stop();
      const call = onEnd.mock.calls[0]![0] as CallRecord;
      expect(call.turns![0]).toMatchObject({ fillerAt: endAt + 4_000, outcome: "no_reply" });
      expect(call.turns![0]!.playAt ?? call.turns![0]!.replyServerAt).toBeUndefined();
      expect(call.entries.some((e) => /one moment/i.test(e.text))).toBe(false);
    });

    it("does not fire while a reply is being voiced, or while the person is speaking", async () => {
      const a = await make({
        speak: async (p) => {
          await new Promise((r) => setTimeout(r, 3_000));
          return okSpeak(p);
        },
      });
      await turn(a);
      a.fake.add("Answer.");
      await vi.advanceTimersByTimeAsync(4_500);
      expect(fillers(a.player)).toBe(0);
      const b = await make();
      talk(b.mic);
      await vi.advanceTimersByTimeAsync(3_500);
      for (let t = 0; t < 1_000; t += 100) {
        b.mic.onFrame(new ArrayBuffer(4_800), 0.5);
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(fillers(b.player)).toBe(0);
    });

    it("plays in the speaker loop: talking over it makes no turn, and interrupt() stops it", async () => {
      const ctx = await make({ interrupt: () => false });
      await turn(ctx);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(fillers(ctx.player)).toBe(1);
      for (let t = 0; t < 400; t += 100) ctx.mic.onFrame(new ArrayBuffer(4_800), 0.9);
      ctx.session.interrupt();
      expect(ctx.player.flush).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ctx.transcribe).toHaveBeenCalledTimes(1);
      expect(fillers(ctx.player)).toBe(1);
    });

    it("a clip that cannot be decoded means no filler and one note", async () => {
      const decodeAudioData = vi.fn(async () => {
        throw new Error("bad mp3");
      });
      const ctx = await make({ audioContext: { close: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), decodeAudioData } });
      await turn(ctx);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fillers(ctx.player)).toBe(0);
      expect(notes(ctx).filter((e) => e.text === FILLER_UNAVAILABLE_NOTICE)).toHaveLength(1);
    });
  });
});
