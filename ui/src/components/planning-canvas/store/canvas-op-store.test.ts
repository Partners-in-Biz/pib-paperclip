import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanningCanvasOpBatch, PlanningCanvasTableData } from "@paperclipai/shared";
import { CanvasOpStore, backoffMs, isRetryableError, keyOf, type ItemFields, type OpStoreOptions } from "@/components/planning-canvas/store/canvas-op-store";
import { FakeCanvasServer, applyTableOp } from "@/components/planning-canvas/store/fake-canvas-server";
import { diffTableOps } from "@/components/planning-canvas/store/table-ops";

const sticky = (over: ItemFields = {}): ItemFields => ({
  kind: "sticky",
  x: 0,
  y: 0,
  width: 200,
  height: 120,
  zIndex: 1,
  color: "yellow",
  title: "Idea",
  content: "Body",
  ...over,
});

let ids = 0;
const newId = () => `id-${++ids}`;

function makeStore(server: FakeCanvasServer, actor: string, extra: Partial<OpStoreOptions> = {}) {
  const store = new CanvasOpStore({ transport: server.transport(actor), newId, ...extra });
  store.load(server.read());
  return store;
}

function edit(store: CanvasOpStore, key: string, set: ItemFields) {
  const item = store.getItem(key)!;
  store.applyLocal([{ key, item: { itemType: item.itemType, fields: { ...item.fields, ...set } } }]);
}

async function settle(ms = 300) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  ids = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("batching", () => {
  it("sends one batch at most 250 ms after the first edit, with a clientBatchId", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky());
    const store = makeStore(server, "u1");
    edit(store, "a", { x: 10 });
    await vi.advanceTimersByTimeAsync(100);
    edit(store, "a", { x: 20 });
    await vi.advanceTimersByTimeAsync(100);
    expect(server.calls).toHaveLength(0);
    expect(store.getSnapshot().saveState).toBe("saving");
    await vi.advanceTimersByTimeAsync(50);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.batch.clientBatchId).toBeTruthy();
    expect(server.calls[0]!.batch.ops).toEqual([{ op: "update", key: "a", baseVersion: 1, set: { x: 20 } }]);
    expect(store.getSnapshot().saveState).toBe("saved");
  });

  it("orders node adds before connectors and connector deletes before node deletes", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky()).seed("b", "node", sticky()).seed("c", "connector", { fromKey: "a", toKey: "b" });
    const store = makeStore(server, "u1");
    store.applyLocal([
      { key: "c2", item: { itemType: "connector", fields: { fromKey: "a", toKey: "n" } } },
      { key: "n", item: { itemType: "node", fields: sticky() } },
      { key: "a", item: null },
      { key: "c", item: null },
    ]);
    await settle();
    expect(server.calls[0]!.batch.ops.map((op) => `${op.op}:${keyOf(op)}`)).toEqual(["add:n", "add:c2", "delete:c", "delete:a"]);
  });

  it("retries a lost response with the same clientBatchId, and the replay does not conflict with itself", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky());
    const sent: PlanningCanvasOpBatch[] = [];
    let drop = true;
    const store = makeStore(server, "u1", {
      transport: {
        send: async (batch) => {
          sent.push(structuredClone(batch));
          const response = server.apply("u1", batch);
          if (drop) {
            drop = false;
            throw new TypeError("Failed to fetch");
          }
          return response;
        },
        readSince: async (since) => server.readSince(since),
      },
    });
    edit(store, "a", { title: "Typed" });
    await settle();
    expect(store.getSnapshot().saveState).toBe("offline");
    await vi.advanceTimersByTimeAsync(backoffMs(1) + 300);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(store.getSnapshot()).toMatchObject({ saveState: "saved", drafts: [] });
    expect(server.fields("a")!.title).toBe("Typed");
    expect(server.items.get("a")!.version).toBe(2);
  });

  it("backs off exponentially and keeps state as offline until a send succeeds", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky());
    let fails = 3;
    const send = vi.fn(async (batch: PlanningCanvasOpBatch) => {
      if (fails-- > 0) throw Object.assign(new Error("Bad gateway"), { status: 502 });
      return server.apply("u1", batch);
    });
    const store = makeStore(server, "u1", { transport: { send, readSince: async (s) => server.readSince(s) } });
    edit(store, "a", { x: 5 });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().saveState).toBe("offline");
    await vi.advanceTimersByTimeAsync(4_300);
    expect(send).toHaveBeenCalledTimes(4);
    expect(store.getSnapshot().saveState).toBe("saved");
    expect([backoffMs(1), backoffMs(2), backoffMs(3), backoffMs(10)]).toEqual([1_000, 2_000, 4_000, 30_000]);
  });

  it("does not retry a refusal; it reports it", async () => {
    const onFatal = vi.fn();
    const server = new FakeCanvasServer().seed("a", "node", sticky());
    const send = vi.fn(async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    });
    const store = makeStore(server, "u1", { transport: { send, readSince: async (s) => server.readSince(s) }, onFatal });
    edit(store, "a", { x: 5 });
    await settle(5_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().saveState).toBe("failed");
    expect(isRetryableError({ status: 429 })).toBe(true);
    expect(isRetryableError({ status: 409 })).toBe(false);
  });

  it("flushKeepalive sends the in-flight batch with its id and everything unsent", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky()).seed("b", "node", sticky());
    const keepalive: PlanningCanvasOpBatch[] = [];
    const store = makeStore(server, "u1", {
      transport: { send: () => new Promise(() => undefined), readSince: async (s) => server.readSince(s), sendKeepalive: (b) => keepalive.push(b) },
    });
    edit(store, "a", { x: 1 });
    await settle();
    edit(store, "b", { x: 2 });
    store.flushKeepalive();
    expect(keepalive).toHaveLength(2);
    expect(keepalive[0]!.clientBatchId).toBe("id-1");
    expect(keepalive[1]!.ops).toEqual([{ op: "update", key: "b", baseVersion: 1, set: { x: 2 } }]);
  });
});

describe("conflicts", () => {
  it("two tabs editing different fields of one node both survive", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky());
    const one = makeStore(server, "u1");
    const two = makeStore(server, "u2");
    edit(one, "a", { title: "Title from tab one" });
    edit(two, "a", { content: "Body from tab two" });
    await settle();
    await settle();
    expect(server.fields("a")).toMatchObject({ title: "Title from tab one", content: "Body from tab two" });
    expect(one.getSnapshot().drafts).toEqual([]);
    expect(two.getSnapshot().drafts).toEqual([]);
    await one.catchUp();
    expect(one.getItem("a")!.fields).toMatchObject({ title: "Title from tab one", content: "Body from tab two" });
  });

  it("a conflict on the same text keeps the user's text as a draft; no typed text is lost", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky({ content: "start" }));
    const one = makeStore(server, "u1");
    const two = makeStore(server, "u2");
    edit(one, "a", { content: "Mine, carefully typed", color: "blue" });
    edit(two, "a", { content: "Theirs" });
    await one.flush();
    await two.flush();
    expect(server.fields("a")!.content).toBe("Mine, carefully typed");
    const [draft] = two.getSnapshot().drafts;
    expect(draft).toMatchObject({ key: "a", field: "content", mine: "Theirs", theirs: "Mine, carefully typed", reason: "conflict" });
    expect(two.getItem("a")!.fields.content).toBe("Mine, carefully typed");
    expect(two.getItem("a")!.fields.color).toBe("blue");

    two.resolveDraft(draft!.id, "mine");
    await settle();
    expect(server.fields("a")!.content).toBe("Theirs");
    expect(two.getSnapshot().drafts).toEqual([]);
  });

  it("Copy to new node puts the user's text on a new sticky and leaves theirs", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky({ title: "Plan" }));
    const one = makeStore(server, "u1");
    const two = makeStore(server, "u2");
    edit(one, "a", { content: "Theirs" });
    edit(two, "a", { content: "Mine" });
    await one.flush();
    await two.flush();
    const newKey = two.resolveDraft(two.getSnapshot().drafts[0]!.id, "copy");
    await settle();
    expect(server.fields("a")!.content).toBe("Theirs");
    expect(server.fields(newKey!)).toMatchObject({ kind: "sticky", content: "Mine", title: "Plan (my version)", x: 224 });
  });

  it("Keep theirs drops the draft and sends nothing", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky());
    const one = makeStore(server, "u1");
    const two = makeStore(server, "u2");
    edit(one, "a", { title: "Theirs" });
    edit(two, "a", { title: "Mine" });
    await one.flush();
    await two.flush();
    const calls = server.calls.length;
    two.resolveDraft(two.getSnapshot().drafts[0]!.id, "theirs");
    await settle();
    expect(server.calls.length).toBe(calls);
    expect(two.getItem("a")!.fields.title).toBe("Theirs");
  });

  it("a non-text conflict auto-merges: ours is resent on the new base", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky());
    const one = makeStore(server, "u1");
    const two = makeStore(server, "u2");
    edit(one, "a", { color: "rose" });
    edit(two, "a", { color: "blue", title: "Mine" });
    await one.flush();
    await two.flush();
    await settle();
    expect(two.getSnapshot().drafts).toEqual([]);
    expect(server.fields("a")).toMatchObject({ color: "blue", title: "Mine" });
  });

  it("an edit to an item someone deleted keeps the text as a draft that can be restored", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky());
    const one = makeStore(server, "u1");
    const two = makeStore(server, "u2", { onNotice: vi.fn() });
    one.applyLocal([{ key: "a", item: null }]);
    edit(two, "a", { content: "Do not lose me" });
    await one.flush();
    await two.flush();
    expect(two.getItem("a")).toBeUndefined();
    const [draft] = two.getSnapshot().drafts;
    expect(draft).toMatchObject({ reason: "deleted", mine: "Do not lose me" });
    two.resolveDraft(draft!.id, "mine");
    await settle();
    expect(server.items.get("a")!.deletedAt).toBeNull();
    expect(server.fields("a")!.content).toBe("Do not lose me");
  });

  it("remote changes merge under unsent local edits, and ours goes against the version we edited", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky());
    const one = makeStore(server, "u1");
    const two = makeStore(server, "u2");
    edit(two, "a", { title: "Mine" });
    edit(one, "a", { title: "Theirs", x: 500 });
    await one.flush();
    await two.catchUp();
    expect(two.getItem("a")!.fields).toMatchObject({ title: "Mine", x: 500 });
    await settle();
    expect(two.getSnapshot().drafts[0]).toMatchObject({ field: "title", mine: "Mine", theirs: "Theirs" });
  });
});

describe("tables", () => {
  const table = (): PlanningCanvasTableData => ({
    columns: [{ id: "c1", name: "Name", type: "text" }, { id: "c2", name: "Points", type: "number" }],
    rows: [{ id: "r1", cells: { c1: "one", c2: 0 } }, { id: "r2", cells: { c1: "two", c2: 0 } }],
  });

  it("table edits go out as cell ops, so two people editing different cells both win", async () => {
    const server = new FakeCanvasServer().seed("t", "node", { kind: "table", x: 0, y: 0, width: 400, height: 200, zIndex: 1, color: "slate", title: "T", data: table() });
    const one = makeStore(server, "u1");
    const two = makeStore(server, "u2");
    const t1 = table();
    t1.rows[0]!.cells.c1 = "ONE";
    const t2 = table();
    t2.rows[1]!.cells.c2 = 5;
    edit(one, "t", { data: t1 });
    edit(two, "t", { data: t2 });
    await one.flush();
    await two.flush();
    expect(server.calls[0]!.batch.ops).toEqual([{ op: "table.setCell", key: "t", rowId: "r1", colId: "c1", value: "ONE" }]);
    const data = server.fields("t")!.data as PlanningCanvasTableData;
    expect(data.rows.map((row) => row.cells)).toEqual([{ c1: "ONE", c2: 0 }, { c1: "two", c2: 5 }]);
  });

  it("diffTableOps reproduces adds, removes, moves and cell edits", () => {
    const prev = table();
    const next: PlanningCanvasTableData = {
      columns: [{ id: "c1", name: "Name", type: "text" }, { id: "c3", name: "Owner", type: "text" }],
      rows: [{ id: "r3", cells: { c1: "new", c3: "me" } }, { id: "r2", cells: { c1: "TWO" } }, { id: "r1", cells: { c1: "one", c3: "x" } }],
    };
    const ops = diffTableOps("t", prev, next)!;
    const replay = structuredClone(prev);
    for (const op of ops) expect(applyTableOp(replay, op)).toBe(true);
    expect(replay).toEqual(next);
  });

  it("a column rename is not a cell op; the whole table goes with baseVersion", () => {
    const next = table();
    next.columns[0]!.name = "Title";
    expect(diffTableOps("t", table(), next)).toBeNull();
  });
});

describe("undo and redo", () => {
  it("undoes and redoes own edits as groups", async () => {
    const server = new FakeCanvasServer().seed("a", "node", sticky());
    const store = makeStore(server, "u1");
    edit(store, "a", { x: 10 });
    edit(store, "a", { x: 20 });
    store.checkpoint();
    edit(store, "a", { title: "New" });
    store.checkpoint();
    store.undo();
    expect(store.getItem("a")!.fields).toMatchObject({ x: 20, title: "Idea" });
    store.undo();
    expect(store.getItem("a")!.fields.x).toBe(0);
    expect(store.getSnapshot().canUndo).toBe(false);
    store.redo();
    expect(store.getItem("a")!.fields.x).toBe(20);
    await settle();
    expect(server.fields("a")).toMatchObject({ x: 20, title: "Idea" });
  });

  it("undo of an add deletes it and redo restores it", async () => {
    const server = new FakeCanvasServer();
    const store = makeStore(server, "u1");
    store.applyLocal([{ key: "n", item: { itemType: "node", fields: sticky() } }]);
    store.checkpoint();
    await settle();
    store.undo();
    await settle();
    expect(server.items.get("n")!.deletedAt).not.toBeNull();
    store.redo();
    await settle();
    expect(server.items.get("n")!.deletedAt).toBeNull();
  });

  it("skips foreign changes with a notice and keeps the rest of the group", async () => {
    const onNotice = vi.fn();
    const server = new FakeCanvasServer().seed("a", "node", sticky()).seed("b", "node", sticky());
    const mine = makeStore(server, "u1", { onNotice });
    const theirs = makeStore(server, "u2");
    edit(mine, "a", { title: "Mine A" });
    edit(mine, "b", { title: "Mine B" });
    mine.checkpoint();
    await settle();
    await theirs.catchUp();
    edit(theirs, "a", { title: "Theirs A" });
    await theirs.flush();
    await mine.catchUp();
    expect(mine.undo()).toEqual({ applied: 1, skipped: 1 });
    expect(onNotice).toHaveBeenCalledWith("Undo skipped 1 item someone else changed since.");
    expect(mine.getItem("a")!.fields.title).toBe("Theirs A");
    expect(mine.getItem("b")!.fields.title).toBe("Idea");
  });

  it("keeps 200 groups and survives a reload through storage", () => {
    const storage = new Map<string, string>();
    const sessionLike = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) };
    const server = new FakeCanvasServer().seed("a", "node", sticky());
    const store = makeStore(server, "u1", { storage: sessionLike, storageKey: "undo:board" });
    for (let i = 1; i <= 205; i++) {
      edit(store, "a", { x: i });
      store.checkpoint();
    }
    const again = makeStore(server, "u1", { storage: sessionLike, storageKey: "undo:board" });
    again.load({ revision: server.revision, items: [{ ...server.items.get("a")!, data: { ...sticky(), x: 205 } as never }] });
    let steps = 0;
    while (again.getSnapshot().canUndo) {
      again.undo();
      steps += 1;
    }
    expect(steps).toBe(200);
    expect(again.getItem("a")!.fields.x).toBe(5);
  });
});
