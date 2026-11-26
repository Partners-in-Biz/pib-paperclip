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
    idle = vi.fn(async () => undefined);
  },
}));

import { LiveSession } from "../src/ui/live-session.js";

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  binaryType = "";
  listeners = new Map<string, Array<(e: unknown) => void>>();
  close = vi.fn();
  send = vi.fn();
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, event: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  voices(): string[] {
    return this.send.mock.calls
      .map(([m]) => JSON.parse(String(m)))
      .filter((m) => m.type === "session.update")
      .map((m) => m.session.voice);
  }
}

async function make(voice: string, companyVoice?: string) {
  const session = new LiveSession({
    info: { token: "t", url: "wss://example.test/v1", voice, language: "en", keyterms: [], companyVoice },
    instructions: "",
    api: { get: vi.fn(async () => []), post: vi.fn() } as never,
    companyId: "c1",
    userId: "u1",
    pageIssueRef: null,
    audioContext: { close: vi.fn(async () => undefined) } as never,
    onState: vi.fn(),
    onTranscript: vi.fn(),
    onLevel: vi.fn(),
    onError: vi.fn(),
  });
  await session.start();
  const socket = FakeSocket.all[0]!;
  socket.readyState = 1;
  socket.emit("open");
  return socket;
}

const voiceError = (socket: FakeSocket) =>
  socket.emit("message", { data: JSON.stringify({ type: "error", error: { message: "Invalid voice: carina" } }) });

describe("classic live call: a voice the realtime socket refuses", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries once with the company voice", async () => {
    const socket = await make("carina", "eve");
    voiceError(socket);
    voiceError(socket);
    expect(socket.voices()).toEqual(["carina", "eve"]);
  });

  it("does nothing extra when there is no other voice to try", async () => {
    const socket = await make("eve", "eve");
    voiceError(socket);
    expect(socket.voices()).toEqual(["eve"]);
  });
});
