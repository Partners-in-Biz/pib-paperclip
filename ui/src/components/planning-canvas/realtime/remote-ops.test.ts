import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanningCanvasItem } from "@paperclipai/shared";
import { CanvasOpStore, type ItemFields } from "@/components/planning-canvas/store/canvas-op-store";
import { FakeCanvasServer } from "@/components/planning-canvas/store/fake-canvas-server";

const sticky = (over: ItemFields = {}): ItemFields => ({
  kind: "sticky", x: 0, y: 0, width: 200, height: 120, zIndex: 1, color: "yellow", title: "Idea", content: "Body", ...over,
});

let ids = 0;
function makeStore(server: FakeCanvasServer, actor: string) {
  const transport = server.transport(actor);
  const readSince = vi.fn(transport.readSince);
  const store = new CanvasOpStore({ transport: { ...transport, readSince }, newId: () => `id-${++ids}` });
  store.load(server.read());
  return { store, readSince };
}

/** What the hub fans out after `actor` applied an update to `key` on the server. */
function remoteUpdate(server: FakeCanvasServer, actor: string, key: string, set: ItemFields) {
  const before = server.revision;
  const version = server.items.get(key)!.version;
  server.apply(actor, { clientBatchId: `b-${++ids}`, ops: [{ op: "update", key, baseVersion: version, set }] });
  const read = server.readSince(before);
  return { revision: server.revision, items: "items" in read ? read.items : ([] as PlanningCanvasItem[]) };
}

function edit(store: CanvasOpStore, key: string, set: ItemFields) {
  const item = store.getItem(key)!;
  store.applyLocal([{ key, item: { itemType: item.itemType, fields: { ...item.fields, ...set } } }]);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("applyRemote (ops.applied over the board socket)", () => {
  it("merges the next revision in place, without a read", () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky());
    const { store, readSince } = makeStore(server, "u1");
    const event = remoteUpdate(server, "u2", "a", { title: "From u2" });
    store.applyRemote(event.revision, event.items);
    expect(store.getItem("a")!.fields.title).toBe("From u2");
    expect(store.getRevision()).toBe(event.revision);
    expect(readSince).not.toHaveBeenCalled();
  });

  it("a truncated message (keys only) reads ?since", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky());
    const { store, readSince } = makeStore(server, "u1");
    const start = store.getRevision();
    const event = remoteUpdate(server, "u2", "a", { title: "Big" });
    store.applyRemote(event.revision);
    await vi.advanceTimersByTimeAsync(0);
    expect(readSince).toHaveBeenCalledWith(start);
    expect(store.getItem("a")!.fields.title).toBe("Big");
  });

  it("a gap in revisions reads ?since instead of applying out of order", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky()).seed("b", "node", sticky());
    const { store, readSince } = makeStore(server, "u1");
    remoteUpdate(server, "u2", "a", { title: "Missed" });
    const second = remoteUpdate(server, "u2", "b", { title: "Seen" });
    store.applyRemote(second.revision, second.items);
    await vi.advanceTimersByTimeAsync(0);
    expect(readSince).toHaveBeenCalledTimes(1);
    expect(store.getItem("a")!.fields.title).toBe("Missed");
    expect(store.getItem("b")!.fields.title).toBe("Seen");
  });

  it("ignores revisions it already has (its own echo, duplicates)", () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky());
    const { store, readSince } = makeStore(server, "u1");
    const event = remoteUpdate(server, "u2", "a", { title: "Once" });
    store.applyRemote(event.revision, event.items);
    store.applyRemote(event.revision, event.items);
    expect(readSince).not.toHaveBeenCalled();
  });

  it("an op announced while our batch is in flight is read once the batch lands", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky()).seed("b", "node", sticky());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const transport = server.transport("u1");
    const readSince = vi.fn(transport.readSince);
    const store = new CanvasOpStore({
      transport: {
        readSince,
        send: async (batch) => {
          const response = await transport.send(batch);
          await gate;
          return response;
        },
      },
    });
    store.load(server.read());
    edit(store, "a", { x: 50 });
    const flushing = store.flush();
    await vi.advanceTimersByTimeAsync(0);
    // Ours committed first (revision +1), then u2's edit (+2) is fanned out while our response is still out.
    const event = remoteUpdate(server, "u2", "b", { title: "During" });
    store.applyRemote(event.revision, event.items);
    expect(store.getItem("b")!.fields.title).toBe("Idea");
    release();
    await flushing;
    await vi.advanceTimersByTimeAsync(0);
    expect(readSince).toHaveBeenCalled();
    expect(store.getItem("b")!.fields.title).toBe("During");
    expect(store.getRevision()).toBe(server.revision);
  });

  it("a resync below the purge line reloads the board", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky());
    const onResync = vi.fn();
    const store = new CanvasOpStore({
      transport: { ...server.transport("u1"), readSince: async () => ({ revision: 9, purgedThroughRevision: 9, resync: true as const }) },
      onResync,
    });
    store.load(server.read());
    store.applyRemote(9);
    await vi.advanceTimersByTimeAsync(0);
    expect(onResync).toHaveBeenCalledTimes(1);
  });
});
