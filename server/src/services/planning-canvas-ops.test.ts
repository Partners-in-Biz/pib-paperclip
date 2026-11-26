import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  planningCanvases,
  planningCanvasItems,
  planningCanvasOpBatches,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { PLANNING_CANVAS_NODE_KINDS, type PlanningCanvasOp, type PlanningCanvasOpResult } from "@paperclipai/shared";
import { planningCanvasOpsService, type PlanningCanvasOpsActor } from "./planning-canvas-ops.js";
import { subscribePlanningCanvasBoard, type PlanningCanvasOpsAppliedEvent } from "./planning-canvas-events.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const databaseSuite = support.supported ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;

databaseSuite("planning canvas ops engine (real PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let db2: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const unsubscribers: Array<() => void> = [];

  beforeAll(async () => {
    const url = external ?? (temporary = await startEmbeddedPostgresTestDatabase("planning-canvas-ops-")).connectionString;
    db = createDb(url);
    db2 = createDb(url);
    const agentCompanyId = randomUUID();
    await db.insert(companies).values({ id: agentCompanyId, name: "Canvas agents", issuePrefix: `A${agentCompanyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agent.id, companyId: agentCompanyId, name: "Canvas agent" });
  }, 120_000);
  afterEach(() => {
    while (unsubscribers.length) unsubscribers.pop()!();
  });
  afterAll(async () => {
    await db?.$client.end();
    await db2?.$client.end();
    await temporary?.cleanup();
  });

  const userA: PlanningCanvasOpsActor = { type: "user", id: "user-a" };
  const userB: PlanningCanvasOpsActor = { type: "user", id: "user-b" };
  const agent: PlanningCanvasOpsActor = { type: "agent", id: randomUUID() };

  async function board() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Canvas ops", issuePrefix: `C${companyId.slice(0, 7)}` });
    const [row] = await db
      .insert(planningCanvases)
      .values({ companyId, userId: userA.id, title: "Ops" })
      .returning();
    return { companyId, boardId: row!.id };
  }

  function apply(
    target: { companyId: string; boardId: string },
    ops: PlanningCanvasOp[],
    options: { actor?: PlanningCanvasOpsActor; atomic?: boolean; clientBatchId?: string; now?: Date; on?: typeof db } = {},
  ) {
    return planningCanvasOpsService(options.on ?? db).applyOps({
      ...target,
      actor: options.actor ?? userA,
      now: options.now,
      batch: { ops, atomic: options.atomic, clientBatchId: options.clientBatchId },
    });
  }

  const node = (key: string, extra: Record<string, unknown> = {}): PlanningCanvasOp => ({
    op: "add",
    item: {
      itemType: "node",
      key,
      kind: "sticky",
      x: 0,
      y: 0,
      width: 200,
      height: 120,
      zIndex: 1,
      color: "yellow",
      title: key,
      content: "",
      ...extra,
    } as never,
  });
  const connector = (key: string, fromKey: string, toKey: string): PlanningCanvasOp => ({
    op: "add",
    item: { itemType: "connector", key, fromKey, toKey },
  });
  const table = (key: string): PlanningCanvasOp =>
    node(key, {
      kind: "table",
      data: {
        columns: [
          { id: "c1", name: "Name", type: "text" },
          { id: "c2", name: "Owner", type: "person" },
        ],
        rows: [
          { id: "r1", cells: { c1: "a" } },
          { id: "r2", cells: { c1: "b" } },
        ],
      },
    });

  async function item(boardId: string, key: string) {
    const [row] = await db
      .select()
      .from(planningCanvasItems)
      .where(and(eq(planningCanvasItems.boardId, boardId), eq(planningCanvasItems.itemKey, key)));
    return row!;
  }
  async function boardRow(boardId: string) {
    const [row] = await db.select().from(planningCanvases).where(eq(planningCanvases.id, boardId));
    return row!;
  }
  const statuses = (results: PlanningCanvasOpResult[]) => results.map((result) => result.status);

  it("geometry is last writer wins and bumps the item revision, never the version", async () => {
    const b = await board();
    await apply(b, [node("n1")]);
    const moved = await apply(b, [{ op: "update", key: "n1", set: { x: 50, y: 60, zIndex: 7 } }]);
    const again = await apply(b, [{ op: "update", key: "n1", set: { width: 300 } }], { actor: userB });
    expect(statuses([...moved.results, ...again.results])).toEqual(["applied", "applied"]);
    const row = await item(b.boardId, "n1");
    expect(row.version).toBe(1);
    expect(row.fieldVersions).toEqual({});
    expect(row.revision).toBe(again.revision);
    expect(row.zIndex).toBe(7);
    expect(row.data).toMatchObject({ x: 50, y: 60, width: 300 });
    expect(row.updatedByUserId).toBe(userB.id);
  });

  it("content without baseVersion is rejected; stale fields conflict; different fields auto-merge", async () => {
    const b = await board();
    await apply(b, [node("n1")]);
    const missing = await apply(b, [{ op: "update", key: "n1", set: { title: "x" } }]);
    expect(missing.results[0]).toEqual({ status: "rejected", key: "n1", reason: "base_version_required" });

    const first = await apply(b, [{ op: "update", key: "n1", baseVersion: 1, set: { title: "Mine" } }]);
    expect(first.results[0]).toMatchObject({ status: "applied", version: 2 });
    // Another writer still on version 1 edits a different field: merges.
    const merged = await apply(b, [{ op: "update", key: "n1", baseVersion: 1, set: { content: "Body", x: 9 } }], {
      actor: agent,
    });
    expect(merged.results[0]).toMatchObject({ status: "applied", version: 3 });
    // ... and the same field: conflict listing only the changed field it sets.
    const stale = await apply(b, [{ op: "update", key: "n1", baseVersion: 1, set: { title: "Theirs", color: "blue" } }]);
    expect(stale.results[0]).toMatchObject({ status: "conflict", key: "n1", conflictingFields: ["title"] });
    const current = (stale.results[0] as Extract<PlanningCanvasOpResult, { status: "conflict" }>).current;
    expect(current).toMatchObject({ version: 3, fieldVersions: { title: 2, content: 3 } });

    const row = await item(b.boardId, "n1");
    expect(row.data).toMatchObject({ title: "Mine", content: "Body", x: 9, color: "yellow" });
    expect(row.version).toBe(3);
    expect(row.updatedByAgentId).toBe(agent.id);
    expect(row.updatedByUserId).toBeNull();
  });

  it("revision goes up by exactly 1 per batch and nothing moves when nothing applies", async () => {
    const b = await board();
    const before = (await boardRow(b.boardId)).revision;
    const one = await apply(b, [node("a"), node("b"), node("c"), connector("ab", "a", "b")]);
    expect(one.revision).toBe(before + 1);
    expect(new Set(one.results.map((result) => (result as { revision: number }).revision))).toEqual(
      new Set([before + 1]),
    );
    const none = await apply(b, [{ op: "update", key: "missing", set: { x: 1 } }]);
    expect(none.results[0]).toEqual({ status: "rejected", key: "missing", reason: "not_found" });
    expect(none.revision).toBe(before + 1);
    expect((await boardRow(b.boardId)).revision).toBe(before + 1);
  });

  it("atomic batches roll back every op when one fails", async () => {
    const b = await board();
    await apply(b, [node("n1")]);
    const before = (await boardRow(b.boardId)).revision;
    const result = await apply(
      b,
      [node("n2"), { op: "update", key: "n1", set: { x: 5 } }, { op: "update", key: "n1", set: { title: "x" } }],
      { atomic: true },
    );
    expect(result.results).toEqual([
      { status: "rejected", key: "n2", reason: "atomic_aborted" },
      { status: "rejected", key: "n1", reason: "atomic_aborted" },
      { status: "rejected", key: "n1", reason: "base_version_required" },
    ]);
    expect(result.revision).toBe(before);
    expect(
      await db.select().from(planningCanvasItems).where(eq(planningCanvasItems.itemKey, "n2")).then((rows) =>
        rows.filter((row) => row.boardId === b.boardId),
      ),
    ).toEqual([]);
    expect((await item(b.boardId, "n1")).data).toMatchObject({ x: 0 });
    // The same batch without `atomic` applies the ops that can apply.
    const partial = await apply(b, [node("n2"), { op: "update", key: "n1", set: { title: "x" } }]);
    expect(statuses(partial.results)).toEqual(["applied", "rejected"]);
  });

  it("a replayed clientBatchId returns the stored results and applies nothing", async () => {
    const b = await board();
    await apply(b, [node("n1")]);
    const ops: PlanningCanvasOp[] = [{ op: "update", key: "n1", baseVersion: 1, set: { title: "once" } }, node("n2")];
    const first = await apply(b, ops, { clientBatchId: "batch-1" });
    const replay = await apply(b, ops, { clientBatchId: "batch-1" });
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect((await item(b.boardId, "n1")).version).toBe(2);
    expect((await boardRow(b.boardId)).revision).toBe(first.revision);
    // Another actor with the same id is a different batch.
    const other = await apply(b, [node("n3")], { clientBatchId: "batch-1", actor: userB });
    expect(other.replayed).toBe(false);
    expect(statuses(other.results)).toEqual(["applied"]);
  });

  it("purges op batches older than 24 hours in the ops transaction", async () => {
    const b = await board();
    await db.insert(planningCanvasOpBatches).values({
      boardId: b.boardId,
      actorKey: "user:user-a",
      clientBatchId: "old",
      results: [],
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const fresh = await apply(b, [node("n1")], { clientBatchId: "old" });
    expect(fresh.replayed).toBe(false);
    expect(statuses(fresh.results)).toEqual(["applied"]);
  });

  it("table cell ops never conflict with each other; ops on a removed row or column conflict", async () => {
    const b = await board();
    await apply(b, [table("t")]);
    const people = await apply(b, [{ op: "table.setCell", key: "t", rowId: "r1", colId: "c2", value: "Peet" }], {
      actor: userB,
    });
    const agentEdit = await apply(
      b,
      [
        { op: "table.setCell", key: "t", rowId: "r2", colId: "c2", value: "Leo" },
        { op: "table.addColumn", key: "t", column: { id: "c3", name: "Est", type: "number" }, index: 1 },
        { op: "table.addRow", key: "t", row: { id: "r3", cells: { c3: 3 } }, index: 0 },
        { op: "table.moveRow", key: "t", rowId: "r3", toIndex: 9 },
      ],
      { actor: agent },
    );
    expect(statuses([...people.results, ...agentEdit.results])).toEqual(Array(5).fill("applied"));

    const removed = await apply(b, [
      { op: "table.removeRow", key: "t", rowId: "r1" },
      { op: "table.removeColumn", key: "t", colId: "c3" },
    ]);
    expect(statuses(removed.results)).toEqual(["applied", "applied"]);
    const late = await apply(b, [
      { op: "table.setCell", key: "t", rowId: "r1", colId: "c1", value: "late" },
      { op: "table.setCell", key: "t", rowId: "r2", colId: "c3", value: 1 },
      { op: "table.moveRow", key: "t", rowId: "r1", toIndex: 0 },
      { op: "table.addRow", key: "t", row: { id: "r2", cells: {} } },
    ]);
    expect(late.results.map((result) => (result.status === "conflict" ? result.conflictingFields : result))).toEqual([
      ["data"],
      ["data"],
      ["data"],
      { status: "rejected", key: "t", reason: "table_row_exists" },
    ]);

    const row = await item(b.boardId, "t");
    expect(row.data).toMatchObject({
      data: {
        columns: [
          { id: "c1", name: "Name", type: "text" },
          { id: "c2", name: "Owner", type: "person" },
        ],
        rows: [
          { id: "r2", cells: { c1: "b", c2: "Leo" } },
          { id: "r3", cells: {} },
        ],
      },
    });
    // Cell ops bump `data`, so a whole-`data` update from before them conflicts.
    const stale = await apply(b, [{ op: "update", key: "t", baseVersion: 1, set: { data: { columns: [], rows: [] } } }]);
    expect(stale.results[0]).toMatchObject({ status: "conflict", conflictingFields: ["data"] });
    const wrongType = await apply(b, [node("s"), { op: "table.removeRow", key: "s", rowId: "r1" }]);
    expect(wrongType.results[1]).toEqual({ status: "rejected", key: "s", reason: "wrong_item_type" });
  });

  it("delete tombstones attached connectors and restore brings back those whose other end exists", async () => {
    const b = await board();
    await apply(b, [node("a"), node("b"), node("c"), connector("ab", "a", "b"), connector("ac", "a", "c"), connector("bc", "b", "c")]);
    const del = await apply(b, [{ op: "delete", key: "a" }, { op: "delete", key: "c" }]);
    expect(statuses(del.results)).toEqual(["applied", "applied"]);
    expect(await item(b.boardId, "ab")).toMatchObject({ deletedWithKey: "a", revision: del.revision });
    expect((await item(b.boardId, "ac")).deletedWithKey).toBe("a");
    expect((await item(b.boardId, "bc")).deletedWithKey).toBe("c");
    expect((await item(b.boardId, "ab")).deletedAt).not.toBeNull();

    const updateDeleted = await apply(b, [{ op: "update", key: "a", set: { x: 1 } }, { op: "delete", key: "a" }]);
    expect(updateDeleted.results.map((result) => (result as { reason?: string }).reason)).toEqual(["deleted", "deleted"]);

    // c stays deleted, so only a-b comes back with a.
    const restored = await apply(b, [{ op: "restore", key: "a" }]);
    expect(statuses(restored.results)).toEqual(["applied"]);
    expect(await item(b.boardId, "ab")).toMatchObject({ deletedAt: null, deletedWithKey: null, revision: restored.revision });
    expect((await item(b.boardId, "ac")).deletedAt).not.toBeNull();
    const connectorRestore = await apply(b, [{ op: "restore", key: "bc" }, connector("ad", "a", "missing")]);
    expect(connectorRestore.results.map((result) => (result as { reason?: string }).reason)).toEqual([
      "missing_endpoint",
      "missing_endpoint",
    ]);
    // Stale delete conflicts.
    await apply(b, [{ op: "update", key: "b", baseVersion: 1, set: { title: "new" } }]);
    const staleDelete = await apply(b, [{ op: "delete", key: "b", baseVersion: 1 }]);
    expect(staleDelete.results[0]).toMatchObject({ status: "conflict", conflictingFields: ["title"] });
  });

  it("purges tombstones over 30 days (max 500 per batch) and raises purged_through_revision", async () => {
    const b = await board();
    const old = new Date(Date.now() - 31 * DAY);
    const recent = new Date(Date.now() - 2 * DAY);
    const rows = Array.from({ length: 502 }, (_, index) => ({
      companyId: b.companyId,
      boardId: b.boardId,
      itemKey: `old-${index}`,
      itemType: "stroke" as const,
      data: { points: [{ x: 0, y: 0 }], color: "slate" as const, width: 2 },
      revision: index === 0 ? 40 : 7,
      deletedAt: index === 501 ? recent : new Date(old.getTime() - (502 - index) * 1000),
    }));
    await db.insert(planningCanvasItems).values(rows);
    await apply(b, [node("n1")]);
    const left = await db.select().from(planningCanvasItems).where(eq(planningCanvasItems.boardId, b.boardId));
    expect(left.map((row) => row.itemKey).sort()).toEqual(["n1", "old-500", "old-501"]);
    expect((await boardRow(b.boardId)).purgedThroughRevision).toBe(40);
    await apply(b, [{ op: "update", key: "n1", set: { x: 1 } }]);
    expect((await db.select().from(planningCanvasItems).where(eq(planningCanvasItems.boardId, b.boardId))).map((row) => row.itemKey).sort()).toEqual(["n1", "old-501"]);
  });

  it("board caps count live items only", async () => {
    const b = await board();
    const strokes = Array.from({ length: 2_000 }, (_, index) => ({
      companyId: b.companyId,
      boardId: b.boardId,
      itemKey: `s-${index}`,
      itemType: "stroke" as const,
      data: { points: [{ x: 0, y: 0 }], color: "slate" as const, width: 2 },
      revision: 1,
    }));
    await db.insert(planningCanvasItems).values(strokes);
    const stroke = (key: string): PlanningCanvasOp => ({
      op: "add",
      item: { itemType: "stroke", key, points: [{ x: 1, y: 1 }], color: "slate", width: 2 },
    });
    const full = await apply(b, [stroke("extra")]);
    expect(full.results[0]).toEqual({ status: "rejected", key: "extra", reason: "cap_exceeded" });
    const freed = await apply(b, [{ op: "delete", key: "s-0" }, stroke("extra"), { op: "restore", key: "s-0" }]);
    expect(freed.results.map((result) => (result as { reason?: string }).reason ?? result.status)).toEqual([
      "applied",
      "applied",
      "cap_exceeded",
    ]);
  });

  it("rejects invalid merged items and oversize results per op", async () => {
    const b = await board();
    await apply(b, [node("n1"), node("m", { kind: "markdown", data: { markdown: "z".repeat(50_000) } })]);
    // Each set is under 64 KB; only the merged markdown item passes it.
    const result = await apply(b, [
      { op: "update", key: "n1", baseVersion: 1, set: { data: { markdown: "no" } } },
      { op: "update", key: "m", baseVersion: 1, set: { content: "y".repeat(16_000) } },
    ]);
    expect(result.results.map((entry) => (entry as { reason?: string }).reason)).toEqual(["invalid_item", "item_too_large"]);
  });

  it("emits ops.applied only after commit and never for a batch that applied nothing", async () => {
    const b = await board();
    const seen: Array<{ event: PlanningCanvasOpsAppliedEvent; committedRevision: Promise<number> }> = [];
    unsubscribers.push(
      subscribePlanningCanvasBoard(b.boardId, (event) => {
        // The ops engine emits only `ops.applied`; any other type throws into `applyOps` and fails the test.
        if (event.type !== "ops.applied") throw new Error(`unexpected ${event.type}`);
        // Read on the second pool: only committed rows are visible there.
        seen.push({ event, committedRevision: boardRowOn(db2, b.boardId) });
      }),
    );
    const applied = await apply(b, [node("a"), node("b"), connector("ab", "a", "b")]);
    await apply(b, [node("c"), { op: "update", key: "zz", set: { x: 1 } }], { atomic: true });
    await apply(b, [{ op: "delete", key: "a" }], { actor: agent });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.event).toMatchObject({ type: "ops.applied", revision: applied.revision, actor: userA });
    expect(seen[0]!.event.items.map((entry) => entry.key).sort()).toEqual(["a", "ab", "b"]);
    expect(await seen[0]!.committedRevision).toBeGreaterThanOrEqual(applied.revision);
    expect(seen[1]!.event.items.map((entry) => [entry.key, entry.deletedWithKey])).toEqual([
      ["a", null],
      ["ab", "a"],
    ]);
  });

  async function boardRowOn(target: typeof db, boardId: string) {
    const [row] = await target.select().from(planningCanvases).where(eq(planningCanvases.id, boardId));
    return row!.revision;
  }

  it("serializes concurrent batches on two connections (rule PAR-13458)", async () => {
    const b = await board();
    await apply(b, [table("t"), node("n1")]);
    const start = (await boardRow(b.boardId)).revision;

    // Concurrent cell edits on different connections both land.
    const [left, right] = await Promise.all([
      apply(b, [{ op: "table.setCell", key: "t", rowId: "r1", colId: "c2", value: "left" }], { on: db }),
      apply(b, [{ op: "table.setCell", key: "t", rowId: "r2", colId: "c2", value: "right" }], { on: db2, actor: agent }),
    ]);
    expect(statuses([...left.results, ...right.results])).toEqual(["applied", "applied"]);
    expect([left.revision, right.revision].sort()).toEqual([start + 1, start + 2]);
    expect((await item(b.boardId, "t")).data).toMatchObject({
      data: { rows: [{ id: "r1", cells: { c2: "left" } }, { id: "r2", cells: { c2: "right" } }] },
    });

    // Two writers on the same content field from the same base: one wins, one conflicts.
    const [x, y] = await Promise.all([
      apply(b, [{ op: "update", key: "n1", baseVersion: 1, set: { title: "x" } }], { on: db }),
      apply(b, [{ op: "update", key: "n1", baseVersion: 1, set: { title: "y" } }], { on: db2, actor: userB }),
    ]);
    expect(statuses([...x.results, ...y.results]).sort()).toEqual(["applied", "conflict"]);

    // The same clientBatchId sent twice at once applies once.
    const [p, q] = await Promise.all([
      apply(b, [node("once")], { on: db, clientBatchId: "dup" }),
      apply(b, [node("once")], { on: db2, clientBatchId: "dup" }),
    ]);
    expect([p.replayed, q.replayed].sort()).toEqual([false, true]);
    expect(p.results).toEqual(q.results);
    expect((await boardRow(b.boardId)).revision).toBe(start + 4);
  });

  it("refuses unknown, cross-company and archived boards, and malformed batches", async () => {
    const b = await board();
    const other = await board();
    await expect(apply({ companyId: other.companyId, boardId: b.boardId }, [node("n")])).rejects.toMatchObject({
      status: 404,
    });
    await expect(apply({ companyId: b.companyId, boardId: randomUUID() }, [node("n")])).rejects.toMatchObject({
      status: 404,
    });
    await expect(apply(b, [{ op: "nope" } as never])).rejects.toMatchObject({ status: 400 });
    await db.update(planningCanvases).set({ archivedAt: new Date() }).where(eq(planningCanvases.id, b.boardId));
    await expect(apply(b, [node("n")])).rejects.toMatchObject({ status: 409 });
  });

  describe("unknown node kinds (tolerant)", () => {
    async function seedUnknown(target: { companyId: string; boardId: string }, key: string, kind = "hologram") {
      await db.insert(planningCanvasItems).values({
        companyId: target.companyId,
        boardId: target.boardId,
        itemKey: key,
        itemType: "node",
        kind: kind as never,
        data: { kind, x: 0, y: 0, width: 200, height: 120, zIndex: 1, color: "yellow", title: key, content: "" } as never,
        zIndex: 1,
        version: 1,
        fieldVersions: {},
        revision: 1,
      });
    }

    async function exercise(target: { companyId: string; boardId: string }, key: string) {
      const moved = await apply(target, [{ op: "update", key, set: { x: 50, y: 60 } }]);
      expect(moved.results[0]).toMatchObject({ status: "applied" });
      const resized = await apply(target, [{ op: "update", key, set: { width: 300, height: 90 } }]);
      expect(resized.results[0]).toMatchObject({ status: "applied" });
      const content = await apply(target, [{ op: "update", key, baseVersion: 1, set: { title: "x" } }]);
      expect(content.results[0]).toMatchObject({ status: "rejected", reason: "unknown_kind" });
      const kind = await apply(target, [{ op: "update", key, baseVersion: 1, set: { kind: "sticky" } as never }]);
      expect(kind.results[0]).toMatchObject({ status: "rejected", reason: "unknown_kind" });
      const deleted = await apply(target, [{ op: "delete", key }]);
      expect(deleted.results[0]).toMatchObject({ status: "applied" });
      const restored = await apply(target, [{ op: "restore", key }]);
      expect(restored.results[0]).toMatchObject({ status: "applied" });
      const [row] = await db.select().from(planningCanvasItems).where(and(eq(planningCanvasItems.boardId, target.boardId), eq(planningCanvasItems.itemKey, key)));
      expect(row).toMatchObject({ kind: expect.any(String), deletedAt: null });
      expect(row!.data).toMatchObject({ x: 50, y: 60, width: 300, height: 90 });
    }

    it("moves, resizes, deletes and restores a seeded unknown kind; refuses content and kind changes", async () => {
      const b = await board();
      await seedUnknown(b, "u1");
      await exercise(b, "u1");
    });

    it("refuses points and out-of-range geometry on an unknown kind", async () => {
      const b = await board();
      await seedUnknown(b, "u3");
      const points = await apply(b, [{ op: "update", key: "u3", set: { points: [{ x: 1, y: 1 }] } as never }]);
      expect(points.results[0]).toMatchObject({ status: "rejected", reason: "unknown_kind" });
      const color = await apply(b, [{ op: "update", key: "u3", set: { color: "blue" } as never }]);
      expect(color.results[0]).toMatchObject({ status: "rejected", reason: "unknown_kind" });
      const narrow = await apply(b, [{ op: "update", key: "u3", set: { width: 10 } }]);
      expect(narrow.results[0]).toMatchObject({ status: "rejected", reason: "invalid_item" });
      const [row] = await db.select().from(planningCanvasItems).where(and(eq(planningCanvasItems.boardId, b.boardId), eq(planningCanvasItems.itemKey, "u3")));
      expect(row!.data).toMatchObject({ width: 200 });
      expect(row!.data).not.toHaveProperty("points");
    });

    it("refuses adding an unknown kind", async () => {
      const b = await board();
      await expect(apply(b, [node("u2", { kind: "hologram" })])).rejects.toMatchObject({ status: 400 });
    });

    it("rollback: a kind removed from the shared list with rows present behaves the same", async () => {
      const b = await board();
      await seedUnknown(b, "t1", "timeline");
      const index = PLANNING_CANVAS_NODE_KINDS.indexOf("timeline");
      const mutable = PLANNING_CANVAS_NODE_KINDS as unknown as string[];
      mutable.splice(index, 1);
      try {
        await exercise(b, "t1");
      } finally {
        mutable.splice(index, 0, "timeline");
      }
    });

    it("rollback (PAR-14389 D1a): weblink rows with weblink removed from the kinds list move, resize, delete and restore", async () => {
      const b = await board();
      await db.insert(planningCanvasItems).values({
        companyId: b.companyId,
        boardId: b.boardId,
        itemKey: "w1",
        itemType: "node",
        kind: "weblink",
        data: {
          kind: "weblink", x: 0, y: 0, width: 200, height: 120, zIndex: 1, color: "yellow", title: "w1", content: "",
          data: { url: "https://youtu.be/dQw4w9WgXcQ" },
        } as never,
        zIndex: 1,
        version: 1,
        fieldVersions: {},
        revision: 1,
      });
      const mutable = PLANNING_CANVAS_NODE_KINDS as unknown as string[];
      const index = mutable.indexOf("weblink");
      mutable.splice(index, 1);
      try {
        await exercise(b, "w1");
        const [row] = await db.select().from(planningCanvasItems).where(and(eq(planningCanvasItems.boardId, b.boardId), eq(planningCanvasItems.itemKey, "w1")));
        expect(row!.data).toMatchObject({ kind: "weblink", data: { url: "https://youtu.be/dQw4w9WgXcQ" } });
      } finally {
        mutable.splice(index, 0, "weblink");
      }
    });
  });

  describe("weblink nodes (PAR-14389 D1a)", () => {
    it("an agent writes an https link; http, javascript and userinfo are refused for every writer", async () => {
      const b = await board();
      const added = await apply(b, [node("w_ok", { kind: "weblink", data: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } })], { actor: agent });
      expect(added.results[0]).toMatchObject({ status: "applied" });
      for (const url of ["http://example.com/", "javascript:alert(1)", "https://user:pass@example.com/"]) {
        await expect(apply(b, [node("w_bad", { kind: "weblink", data: { url } })], { actor: agent })).rejects.toMatchObject({ status: 400 });
      }
      // An update to an http URL is refused when the batch is parsed, before any row is touched.
      await expect(
        apply(b, [{ op: "update", key: "w_ok", set: { data: { url: "http://example.com/" } } as never }], { actor: agent }),
      ).rejects.toMatchObject({ status: 400 });
      const stored = await item(b.boardId, "w_ok");
      expect(stored!.data).toMatchObject({ data: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    });
  });
});
