// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mics: [] as Array<{ onFrame: (pcm: ArrayBuffer, lvl: number) => void; muted: boolean }>,
  players: [] as Array<{ enqueue: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> }>,
  playMs: 500,
}));

vi.mock("../src/ui/audio.js", () => ({
  LIVE_SAMPLE_RATE: 24000,
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

import { DirectSession, GEMINI_FALLBACK_NOTICE, READ_FAILED_NOTICE, SOUND_BLOCKED_NOTICE, type SpeakProvider } from "../src/ui/direct-session.js";
import { chunk, REST_IN_CHAT, toSpeech } from "../src/ui/speech-text.js";

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

async function make(
  opts: { provider?: SpeakProvider; speak?: SpeakImpl; interrupt?: () => boolean; onEnd?: () => void; chatIssue?: Record<string, unknown>; audioContext?: unknown } = {},
) {
  const fake = fakeApi(opts.chatIssue);
  const feed = fakeFeed();
  const speak = vi.fn(opts.speak ?? okSpeak);
  const transcribe = vi.fn(async (_p: { audio: string; mimeType: string }) => ({ text: "What is the status?" }));
  const onNotice = vi.fn();
  const onTranscript = vi.fn();
  const session = new DirectSession({
    api: fake.api as never,
    companyId: "c1",
    pageIssueRef: null,
    agentRef: "a-ren",
    provider: opts.provider ?? "grok",
    audioContext: (opts.audioContext ?? { close: vi.fn(async () => undefined), resume: vi.fn(async () => undefined) }) as never,
    speak,
    transcribe,
    interruptByTalking: opts.interrupt,
    onState: vi.fn(),
    onTranscript,
    onLevel: vi.fn(),
    onError: vi.fn(),
    onNotice,
    onEnd: opts.onEnd,
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
const played = (player: { enqueue: ReturnType<typeof vi.fn> }) => player.enqueue.mock.calls.map(([buf]) => (buf as { tag: string }).tag);

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

  it("Gemini: no prefetch, the next chunk is asked for only after the last one played", async () => {
    const ctx = await make({ provider: "gemini" });
    await turn(ctx);
    ctx.fake.add(LONG_REPLY);
    ctx.feed.emit("chat-1");
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.speak).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(h.playMs);
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
    const notes = (ctx.onTranscript.mock.calls.at(-1)![0] as Array<{ who: string; text: string }>).filter((e) => e.who === "note").map((e) => e.text);
    expect(notes).toContain(`${GEMINI_FALLBACK_NOTICE} (gemini auth_failed)`);
    expect(notes).toContain(`${REST_IN_CHAT} (voice failed: grok not_configured)`);
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
});
