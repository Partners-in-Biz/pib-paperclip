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
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  binaryType = "";
  listeners = new Map<string, Array<(e: unknown) => void>>();
  close = vi.fn();
  send = vi.fn();
  constructor(public url: string, public protocols: string[]) {
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
  texts(): string[] {
    return this.sent()
      .filter((m) => m.type === "conversation.item.create" && m.item?.type === "message")
      .map((m) => String(m.item.content[0].text));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeApi(opts: { failComments?: number } = {}) {
  let failures = opts.failComments ?? 0;
  const replies: Array<{ id: string; body: string; authorAgentId: string; createdAt: string }> = [];
  const get = vi.fn(async (path: string) => {
    if (path === "/companies/c1/agents") return [{ id: "a-ceo", name: "PiB", role: "ceo", status: "idle" }];
    if (path.startsWith("/issues/chat-1/comments")) return path.includes("after=") ? [] : [...replies].reverse();
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn(async (path: string, _body: any) => {
    if (path === "/companies/c1/chats/a-ceo") return { id: "chat-1", identifier: "PAR-1558", assigneeAgentId: "a-ceo" };
    if (path === "/issues/chat-1/comments") {
      if (failures > 0) {
        failures--;
        throw new Error("Paperclip answered 502");
      }
      return { id: `c${post.mock.calls.length}` };
    }
    throw new Error(`unexpected POST ${path}`);
  });
  const comments = () => post.mock.calls.filter(([p]) => p === "/issues/chat-1/comments").map(([, b]) => b);
  const reply = (body: string) => replies.push({ id: `r${replies.length}`, body, authorAgentId: "a-ceo", createdAt: new Date(Date.now() + 1000).toISOString() });
  return { api: { get, post }, comments, reply };
}

async function make(api: ReturnType<typeof fakeApi>["api"], extra: Record<string, unknown> = {}) {
  const onEnd = vi.fn();
  const session = new LiveSession({
    info: { token: "t", url: "wss://example.test/v1", voice: "eve", language: "en", keyterms: [] },
    instructions: "",
    api: api as never,
    companyId: "c1",
    userId: "u1",
    pageIssueRef: null,
    audioContext: { close: vi.fn(async () => undefined), resume: vi.fn(async () => undefined) } as never,
    onState: vi.fn(),
    onTranscript: vi.fn(),
    onLevel: vi.fn(),
    onError: vi.fn(),
    onEnd,
    ...extra,
  });
  await session.start();
  const socket = FakeSocket.all[0]!;
  socket.open();
  return { session, socket, onEnd };
}

const say = (socket: FakeSocket, msg: unknown) => socket.emit("message", { data: JSON.stringify(msg) });
const heard = (socket: FakeSocket, itemId: string, transcript: string) =>
  say(socket, { type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript });

describe("LiveSession routes every turn to Agent Chat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("gives the realtime model no tools", async () => {
    const { socket } = await make(fakeApi().api);
    const update = socket.sent().find((m) => m.type === "session.update")!;
    expect(update.session.tools).toBeUndefined();
  });

  it("posts what was said, joined across a pause, as one chat comment with a UUID clientRequestId", async () => {
    const fake = fakeApi();
    const { socket } = await make(fake.api);
    heard(socket, "i1", "Create a task for the Developer");
    await vi.advanceTimersByTimeAsync(500);
    say(socket, { type: "input_audio_buffer.speech_started" });
    heard(socket, "i2", "to fix the login page.");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fake.comments()).toHaveLength(1);
    expect(fake.comments()[0].body).toBe("Create a task for the Developer to fix the login page.\n\n_Sent by voice._");
    expect(fake.comments()[0].clientRequestId).toMatch(UUID);
  });

  it("speaks the agent's reply, and says once that a long run is still going", async () => {
    const fake = fakeApi();
    const { socket } = await make(fake.api);
    heard(socket, "i1", "Run the full SEO audit");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.comments()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50_000);
    const status = socket.texts().filter((t) => t.startsWith("[Status] The agent is still working"));
    expect(status).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.texts().filter((t) => t.startsWith("[Status] The agent is still working"))).toHaveLength(1);
    fake.reply("Audit done: 3 issues found.");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.texts().some((t) => t.startsWith("[Update] PiB replied on PAR-1558: Audit done"))).toBe(true);
  });

  it("retries a failed send with the same clientRequestId, then tells the person", async () => {
    const fake = fakeApi({ failComments: 5 });
    const { socket } = await make(fake.api);
    heard(socket, "i1", "Spawn a subagent to check the logs");
    await vi.advanceTimersByTimeAsync(2_000);
    const ids = new Set(fake.comments().map((b) => b.clientRequestId));
    expect(fake.comments()).toHaveLength(3);
    expect(ids.size).toBe(1);
    expect(socket.texts().some((t) => t.startsWith("[Status] That last request did not reach the agent"))).toBe(true);
  });

  it("sends a held turn on hang-up and keeps the chat issue out of the recap targets", async () => {
    const fake = fakeApi();
    const { session, socket, onEnd } = await make(fake.api, { pageIssueRef: null });
    heard(socket, "i1", "First thing");
    await vi.advanceTimersByTimeAsync(2_000);
    heard(socket, "i2", "and one last thing");
    session.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.comments().map((b) => b.body)).toEqual(["First thing\n\n_Sent by voice._", "and one last thing\n\n_Sent by voice._"]);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0]![1]).toEqual([]);
  });

  it("does not send partial transcripts", async () => {
    const fake = fakeApi();
    const { socket } = await make(fake.api);
    say(socket, { type: "conversation.item.input_audio_transcription.updated", item_id: "i1", transcript: "Crea" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.comments()).toHaveLength(0);
  });
});
