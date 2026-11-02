// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/ui/audio.js", () => ({
  LIVE_SAMPLE_RATE: 24000,
  base64ToArrayBuffer: () => new ArrayBuffer(0),
  MicCapture: class {
    muted = false;
    start = vi.fn(async () => undefined);
    stop = vi.fn();
  },
  Player: class {
    onLevel: ((l: number) => void) | null = null;
    playing = false;
    flush = vi.fn();
    enqueue = vi.fn();
  },
}));

import { LiveSession } from "../src/ui/live-session.js";
import { bufferKey, readBuffer } from "../src/ui/transcript-buffer.js";

class FakeSocket {
  static last: FakeSocket;
  static OPEN = 1;
  readyState = 0;
  binaryType = "";
  listeners = new Map<string, Array<(e: unknown) => void>>();
  close = vi.fn();
  send = vi.fn();
  constructor() {
    FakeSocket.last = this;
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, event: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

function make(wakeLock = { release: vi.fn() }, extra: Record<string, unknown> = {}) {
  const onError = vi.fn();
  const onEnd = vi.fn();
  const session = new LiveSession({
    info: { token: "t", url: "wss://example.test", voice: "eve", language: "en", keyterms: [] },
    instructions: "",
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } as never,
    companyId: "c1",
    userId: null,
    pageIssueRef: null,
    audioContext: { close: vi.fn(async () => undefined) } as never,
    wakeLock,
    onState: vi.fn(),
    onTranscript: vi.fn(),
    onLevel: vi.fn(),
    onError,
    onEnd,
    ...extra,
  });
  return { session, wakeLock, onError, onEnd };
}

describe("LiveSession resilience", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("logs the close code and reason and releases the wake lock on a failed close", async () => {
    const { session, wakeLock, onError } = make();
    await session.start();
    FakeSocket.last.emit("close", { code: 1008, reason: "policy", wasClean: false });
    expect(console.warn).toHaveBeenCalledWith("[pib-voice] socket closed", expect.objectContaining({ code: 1008, reason: "policy", wasClean: false }));
    expect(onError).toHaveBeenCalled();
    expect(wakeLock.release).toHaveBeenCalledTimes(1);
  });

  it("releases the wake lock on stop() and logs the clean close", async () => {
    const { session, wakeLock } = make();
    await session.start();
    session.stop();
    expect(wakeLock.release).toHaveBeenCalledTimes(1);
    FakeSocket.last.emit("close", { code: 1000, reason: "done", wasClean: true });
    expect(console.warn).toHaveBeenCalledWith("[pib-voice] socket closed", expect.objectContaining({ code: 1000, reason: "done" }));
  });

  it("writes localStorage on every transcript update, including in-progress ones", async () => {
    const { session, onEnd } = make();
    await session.start();
    const send = (msg: unknown) => FakeSocket.last.emit("message", { data: JSON.stringify(msg) });
    send({ type: "conversation.item.input_audio_transcription.updated", item_id: "u1", transcript: "hello" });
    const key = Object.keys(localStorage).find((k) => k.startsWith("pib-voice:transcript:"))!;
    expect(key).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(key)!).entries).toEqual([expect.objectContaining({ who: "you", text: "hello" })]);
    send({ type: "response.output_audio_transcript.delta", response_id: "r1", delta: "Hi" });
    send({ type: "response.output_audio_transcript.delta", response_id: "r1", delta: " there" });
    const stored = JSON.parse(localStorage.getItem(key)!);
    expect(stored.entries.map((e: { text: string }) => e.text)).toEqual(["hello", "Hi there"]);
    // Survives the page: readable by key with no live session.
    const startedAt = stored.startedAt as number;
    expect(bufferKey(startedAt)).toBe(key);
    expect(readBuffer(startedAt)?.entries).toHaveLength(2);
    session.stop();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("never throws when localStorage refuses the write", async () => {
    const { session } = make();
    await session.start();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() =>
      FakeSocket.last.emit("message", { data: JSON.stringify({ type: "conversation.item.input_audio_transcription.updated", item_id: "u1", transcript: "x" }) }),
    ).not.toThrow();
  });

  describe("autosave", () => {
    const say = (id: string, transcript: string) =>
      FakeSocket.last.emit("message", { data: JSON.stringify({ type: "conversation.item.input_audio_transcription.updated", item_id: id, transcript }) });

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("autosaves about every 30 s, only when there is something new, and leaves the comment to onEnd", async () => {
      const onAutosave = vi.fn();
      const { session, onEnd } = make(undefined, { onAutosave });
      await session.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onAutosave).not.toHaveBeenCalled();
      say("u1", "hello");
      await vi.advanceTimersByTimeAsync(29_000);
      expect(onAutosave).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onAutosave).toHaveBeenCalledTimes(1);
      expect(onAutosave.mock.calls[0]![0].entries).toEqual([expect.objectContaining({ text: "hello" })]);
      // Nothing new: no second write.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onAutosave).toHaveBeenCalledTimes(1);
      expect(onEnd).not.toHaveBeenCalled();
      session.stop();
      expect(onEnd).toHaveBeenCalledTimes(1);
      say("u2", "late");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onAutosave).toHaveBeenCalledTimes(1);
    });

    it("does about six autosaves over a 3-minute call that talks throughout", async () => {
      const onAutosave = vi.fn();
      const { session, onEnd } = make(undefined, { onAutosave, replyPollMs: 1_000_000 });
      await session.start();
      for (let i = 0; i < 18; i++) {
        say(`u${i}`, `line ${i}`);
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(onAutosave).toHaveBeenCalledTimes(6);
      session.stop();
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it("retries on the next tick when the autosave fails", async () => {
      const onAutosave = vi.fn().mockRejectedValueOnce(new Error("500")).mockResolvedValue(undefined);
      const { session } = make(undefined, { onAutosave });
      await session.start();
      say("u1", "hello");
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onAutosave).toHaveBeenCalledTimes(2);
      session.stop();
    });
  });
});
