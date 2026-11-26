import { describe, expect, it } from "vitest";
import { ReplyFeed } from "../src/ui/reply-feed.js";

class FakeSocket {
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close() { this.closed = true; }
  send(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

function setup(protocol = "https:") {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const feed = new ReplyFeed({
    companyId: "co 1",
    location: { protocol, host: "app.example.com" },
    createSocket: url => { const s = new FakeSocket(url); sockets.push(s); return s; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  const seen: string[] = [];
  feed.onComment(id => seen.push(id));
  return { feed, sockets, timers, seen };
}
const comment = (entityId: string, over: Record<string, unknown> = {}) => ({
  type: "activity.logged",
  payload: { action: "issue.comment_added", entityType: "issue", entityId, ...over },
});

describe("ReplyFeed", () => {
  it("connects to the company events socket (wss on https, ws on http)", () => {
    const a = setup("https:");
    a.feed.watch("chat-1");
    expect(a.sockets[0]!.url).toBe("wss://app.example.com/api/companies/co%201/events/ws");
    const b = setup("http:");
    b.feed.watch("chat-1");
    expect(b.sockets[0]!.url).toBe("ws://app.example.com/api/companies/co%201/events/ws");
  });

  it("fires once for a matching comment and reports connected", () => {
    const { feed, sockets, seen } = setup();
    feed.watch("chat-1");
    expect(feed.connected).toBe(false);
    sockets[0]!.onopen?.({});
    expect(feed.connected).toBe(true);
    sockets[0]!.send(comment("chat-1"));
    expect(seen).toEqual(["chat-1"]);
  });

  it("ignores other actions, other issues, other event types and junk", () => {
    const { feed, sockets, seen } = setup();
    feed.watch("chat-1");
    const s = sockets[0]!;
    s.onopen?.({});
    s.send(comment("chat-2"));
    s.send(comment("chat-1", { action: "issue.updated" }));
    s.send(comment("chat-1", { entityType: "project" }));
    s.send({ type: "heartbeat.run.queued", payload: comment("chat-1").payload });
    s.onmessage?.({ data: "not json" });
    s.onmessage?.({ data: new ArrayBuffer(2) });
    expect(seen).toEqual([]);
  });

  it("follows a new watched issue without a new socket", () => {
    const { feed, sockets, seen } = setup();
    feed.watch("chat-1");
    feed.watch("chat-2");
    expect(sockets).toHaveLength(1);
    sockets[0]!.send(comment("chat-1"));
    sockets[0]!.send(comment("chat-2"));
    expect(seen).toEqual(["chat-2"]);
  });

  it("reconnects with 1, 2, 5, 10, 10 s backoff and resets after an open", () => {
    const { feed, sockets, timers } = setup();
    feed.watch("chat-1");
    const drop = () => sockets[sockets.length - 1]!.onclose?.({});
    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      drop();
      delays.push(timers[timers.length - 1]!.ms);
      timers[timers.length - 1]!.fn();
    }
    expect(delays).toEqual([1000, 2000, 5000, 10000, 10000]);
    expect(sockets).toHaveLength(6);
    sockets[5]!.onopen?.({});
    expect(feed.connected).toBe(true);
    drop();
    expect(feed.connected).toBe(false);
    expect(timers[timers.length - 1]!.ms).toBe(1000);
  });

  it("does not reconnect after close()", () => {
    const { feed, sockets, timers } = setup();
    feed.watch("chat-1");
    feed.close();
    expect(sockets[0]!.closed).toBe(true);
    expect(timers).toHaveLength(0);
  });
});
