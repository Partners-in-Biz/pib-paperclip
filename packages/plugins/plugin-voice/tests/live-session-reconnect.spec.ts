// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/ui/audio.js", () => ({
  LIVE_SAMPLE_RATE: 24000,
  base64ToArrayBuffer: () => new ArrayBuffer(0),
  MicCapture: class {
    static instances = 0;
    muted = false;
    start = vi.fn(async () => undefined);
    stop = vi.fn();
    constructor() {
      (this.constructor as unknown as { instances: number }).instances += 1;
    }
  },
  Player: class {
    onLevel: ((l: number) => void) | null = null;
    playing = false;
    flush = vi.fn();
    enqueue = vi.fn();
  },
}));

import { MicCapture } from "../src/ui/audio.js";
import { LiveSession, type LiveSessionInfo, type LiveState } from "../src/ui/live-session.js";

class FakeSocket {
  static all: FakeSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  binaryType = "";
  listeners = new Map<string, Array<(e: unknown) => void>>();
  close = vi.fn();
  send = vi.fn();
  constructor(
    public url: string,
    public protocols: string[],
  ) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, event: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  sent(): Array<Record<string, any>> {
    return this.send.mock.calls.filter(([m]) => typeof m === "string").map(([m]) => JSON.parse(m as string));
  }
}

let visibility: "visible" | "hidden" = "visible";
const setVisibility = (value: "visible" | "hidden") => {
  visibility = value;
  if (value === "visible") document.dispatchEvent(new Event("visibilitychange"));
};

function info(n: number): LiveSessionInfo {
  return { token: `secret-${n}`, url: "wss://example.test/v1", voice: "eve", language: "en", keyterms: [] };
}

async function make(overrides: { refreshInfo?: (() => Promise<LiveSessionInfo>) | null } = {}) {
  let minted = 1;
  const refreshInfo = overrides.refreshInfo === null ? undefined : (overrides.refreshInfo ?? vi.fn(async () => info(++minted)));
  const states: LiveState[] = [];
  const onError = vi.fn();
  const session = new LiveSession({
    info: info(1),
    instructions: "",
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } as never,
    companyId: "c1",
    userId: null,
    pageIssueRef: null,
    audioContext: { close: vi.fn(async () => undefined), resume: vi.fn(async () => undefined) } as never,
    refreshInfo,
    onState: (s) => states.push(s),
    onTranscript: vi.fn(),
    onLevel: vi.fn(),
    onError,
  });
  await session.start();
  FakeSocket.all[0]!.open();
  return { session, refreshInfo, states, onError };
}

const say = (socket: FakeSocket, msg: unknown) => socket.emit("message", { data: JSON.stringify(msg) });
const last = <T,>(items: T[]): T => items[items.length - 1]!;

describe("LiveSession reconnect", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    (MicCapture as unknown as { instances: number }).instances = 0;
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("provider session-limit close while the screen is awake: one attempt, fresh secret, replay of the last 20 turns", async () => {
    const { session, refreshInfo, states } = await make();
    const first = FakeSocket.all[0]!;
    for (let n = 0; n < 25; n += 1) {
      say(first, { type: "conversation.item.input_audio_transcription.completed", item_id: `u${n}`, transcript: `turn ${String(n).padStart(2, "0")}` });
    }
    const clearPending = vi.spyOn((session as unknown as { tools: { clearPending(): void } }).tools, "clearPending");

    first.emit("close", { code: 1000, reason: "session time limit", wasClean: true });
    expect(states).toContain("disconnected");
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));

    expect(refreshInfo).toHaveBeenCalledTimes(1);
    expect(clearPending).toHaveBeenCalled();
    const second = FakeSocket.all[1]!;
    expect(second.protocols).toEqual(["xai-client-secret.secret-2"]);
    second.open();
    const replay = second.sent().find((m) => m.type === "conversation.item.create");
    const text: string = replay!.item.content[0].text;
    expect(text).toContain("turn 24");
    expect(text).toContain("turn 05");
    expect(text).not.toContain("turn 04");
    expect(text.split("\n").length).toBe(21);
    expect(last(second.sent()).type).toBe("response.create");
    expect(last(states)).toBe("thinking");
    session.stop();
  });

  it("an expired or refused pass (1008) reconnects with a fresh secret", async () => {
    const { session, refreshInfo } = await make();
    FakeSocket.all[0]!.emit("close", { code: 1008, reason: "expired", wasClean: false });
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    expect(refreshInfo).toHaveBeenCalledTimes(1);
    expect(FakeSocket.all[1]!.protocols[0]).toBe("xai-client-secret.secret-2");
    session.stop();
  });

  it("a socket error followed by a close makes one attempt, not two", async () => {
    const { session, refreshInfo } = await make();
    const first = FakeSocket.all[0]!;
    first.emit("error");
    first.emit("close", { code: 1006, reason: "", wasClean: false });
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    expect(refreshInfo).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it("a drop while the page is hidden waits, then makes one attempt when it becomes visible and restarts the mic", async () => {
    const { session, refreshInfo, states } = await make();
    setVisibility("hidden");
    FakeSocket.all[0]!.emit("close", { code: 1006, reason: "", wasClean: false });
    expect(states).toContain("disconnected");
    expect(refreshInfo).not.toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(1);

    setVisibility("visible");
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    expect(refreshInfo).toHaveBeenCalledTimes(1);
    expect((MicCapture as unknown as { instances: number }).instances).toBe(2);
    // A second visibility event is not a second attempt.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refreshInfo).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it("a frozen page that never saw the close event still reconnects once it is visible", async () => {
    const { session, refreshInfo } = await make();
    setVisibility("hidden");
    FakeSocket.all[0]!.readyState = FakeSocket.CLOSED;
    setVisibility("visible");
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    expect(refreshInfo).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it("a failed attempt shows Disconnected; Retry mints another secret and replays", async () => {
    const refreshInfo = vi.fn<() => Promise<LiveSessionInfo>>().mockRejectedValueOnce(new Error("mint failed")).mockResolvedValue(info(3));
    const { session, states, onError } = await make({ refreshInfo });
    say(FakeSocket.all[0]!, { type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "hello there" });
    FakeSocket.all[0]!.emit("close", { code: 1006, reason: "", wasClean: false });
    await vi.waitFor(() => expect(refreshInfo).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onError).toHaveBeenLastCalledWith(expect.stringContaining("mint failed")));
    expect(last(states)).toBe("disconnected");
    expect(FakeSocket.all).toHaveLength(1);

    session.retry();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    expect(refreshInfo).toHaveBeenCalledTimes(2);
    FakeSocket.all[1]!.open();
    expect(FakeSocket.all[1]!.sent().some((m) => m.type === "conversation.item.create" && m.item.content[0].text.includes("hello there"))).toBe(true);
    session.stop();
  });

  it("a connection that drops again at once is not retried in a loop; Retry stays available", async () => {
    const { session, refreshInfo, states } = await make();
    FakeSocket.all[0]!.emit("close", { code: 1006, reason: "", wasClean: false });
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    FakeSocket.all[1]!.open();
    FakeSocket.all[1]!.emit("close", { code: 1000, reason: "limit", wasClean: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(refreshInfo).toHaveBeenCalledTimes(1);
    expect(last(states)).toBe("disconnected");
    session.retry();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(3));
    session.stop();
  });

  it("a healthy connection that later drops gets a fresh automatic attempt", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    const { session, refreshInfo } = await make();
    FakeSocket.all[0]!.emit("close", { code: 1006, reason: "", wasClean: false });
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    FakeSocket.all[1]!.open();
    now.mockReturnValue(1_000_000 + 60_000);
    FakeSocket.all[1]!.emit("close", { code: 1000, reason: "limit", wasClean: true });
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(3));
    expect(refreshInfo).toHaveBeenCalledTimes(2);
    session.stop();
  });

  it("hanging up never reconnects", async () => {
    const { session, refreshInfo } = await make();
    session.stop();
    FakeSocket.all[0]!.emit("close", { code: 1000, reason: "done", wasClean: true });
    setVisibility("visible");
    await Promise.resolve();
    expect(refreshInfo).not.toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("without a way to mint a new secret, a drop still ends the call", async () => {
    const { session, onError, states } = await make({ refreshInfo: null });
    FakeSocket.all[0]!.emit("close", { code: 1006, reason: "", wasClean: false });
    expect(onError).toHaveBeenCalled();
    expect(last(states)).toBe("error");
    session.stop();
  });
});
