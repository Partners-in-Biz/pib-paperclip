import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CanvasRealtimeClient,
  presenceFrame,
  reconnectDelayMs,
  type RealtimeSocket,
  type RealtimeStatus,
} from "@/components/planning-canvas/realtime/canvas-realtime-client";
import { CLOSE_REVOKED, parseServerMessage, type ServerMessage } from "@/components/planning-canvas/realtime/realtime-protocol";

class FakeSocket implements RealtimeSocket {
  readyState = 0;
  sent: string[] = [];
  closedWith: number | null = null;
  onopen: RealtimeSocket["onopen"] = null;
  onmessage: RealtimeSocket["onmessage"] = null;
  onclose: RealtimeSocket["onclose"] = null;
  onerror: RealtimeSocket["onerror"] = null;
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  presence() {
    return this.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === "presence");
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const messages: ServerMessage[] = [];
  const statuses: RealtimeStatus[] = [];
  const client = new CanvasRealtimeClient({
    url: "ws://test/api/companies/c/planning-canvases/b/ws",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
    random: () => 0,
  });
  client.start();
  return { client, sockets, messages, statuses, last: () => sockets[sockets.length - 1]! };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("presence", () => {
  it("sends at most 20 presence frames a second, the last one carrying the latest cursor", async () => {
    const { client, last } = setup();
    last().open();
    for (let i = 0; i < 200; i += 1) {
      client.setPresence({ cursor: { x: i, y: i } });
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(100);
    const frames = last().presence();
    expect(frames.length).toBeGreaterThanOrEqual(19);
    expect(frames.length).toBeLessThanOrEqual(21);
    expect(frames[frames.length - 1].cursor).toEqual({ x: 199, y: 199 });
  });

  it("waits for the socket, then sends the presence it holds", async () => {
    const { client, last } = setup();
    client.setPresence({ selection: ["a"], cursor: { x: 1.234, y: 2 } });
    expect(last().sent).toHaveLength(0);
    last().open();
    expect(last().presence()).toEqual([{ type: "presence", cursor: { x: 1.2, y: 2 }, selection: ["a"], viewport: null }]);
  });

  it("trims a huge selection so the frame stays under the 16 KB payload cap", () => {
    const frame = presenceFrame({ cursor: null, selection: Array.from({ length: 500 }, (_, i) => `k${i}`.padEnd(100, "x")), viewport: null });
    expect(frame.length).toBeLessThan(16 * 1024);
    expect(JSON.parse(frame).selection.length).toBeGreaterThan(0);
  });
});

describe("reconnect", () => {
  it("reconnects with backoff after a drop and sends its presence again", async () => {
    const { client, sockets, statuses, last } = setup();
    last().open();
    client.setPresence({ selection: ["n1"] });
    sockets[0]!.drop();
    expect(statuses).toEqual(["live", "reconnecting"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    last().open();
    expect(statuses).toEqual(["live", "reconnecting", "live"]);
    expect(last().presence()[0].selection).toEqual(["n1"]);
  });

  it("doubles the wait to a 30 s cap", () => {
    expect([1, 2, 3, 6, 9].map((attempt) => reconnectDelayMs(attempt, () => 0))).toEqual([1000, 2000, 4000, 30_000, 30_000]);
  });

  it("reconnectNow skips the rest of the wait", () => {
    const { client, sockets, last } = setup();
    last().open();
    last().drop();
    client.reconnectNow();
    expect(sockets).toHaveLength(2);
  });

  it("stop closes the socket and never reconnects", async () => {
    const { client, sockets, statuses } = setup();
    sockets[0]!.open();
    client.stop();
    expect(sockets[0]!.closedWith).toBe(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(statuses[statuses.length - 1]).toBe("closed");
  });
});

describe("access.revoked", () => {
  it("passes the message on and never reconnects", async () => {
    const { sockets, messages, statuses, last } = setup();
    last().open();
    last().receive({ type: "access.revoked", boardId: "b" });
    expect(messages.map((m) => m.type)).toEqual(["access.revoked"]);
    expect(statuses[statuses.length - 1]).toBe("revoked");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("treats a 4403 close as revoked even if the message was lost", async () => {
    const { sockets, statuses, last } = setup();
    last().open();
    last().drop(CLOSE_REVOKED);
    expect(statuses[statuses.length - 1]).toBe("revoked");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });
});

describe("parseServerMessage", () => {
  it("keeps well-formed frames and drops the rest", () => {
    const actor = { type: "agent", id: "a1" };
    expect(parseServerMessage(JSON.stringify({ type: "ops.applied", revision: 3, actor, keys: ["n"], truncated: true }))).toMatchObject({ truncated: true });
    expect(parseServerMessage(JSON.stringify({ type: "ops.applied", revision: 3, actor, items: [] }))).toMatchObject({ revision: 3 });
    expect(parseServerMessage(JSON.stringify({ type: "ops.applied", revision: 3, actor, truncated: true }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "presence.update", clientId: "c" }))).toBeNull();
    expect(parseServerMessage("{nope")).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "mystery" }))).toBeNull();
  });
});
