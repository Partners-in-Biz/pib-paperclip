import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  issues,
  planningCanvases,
  planningCanvasItems,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { planningCanvasDataSchema, type PlanningCanvasData, type PlanningCanvasOp } from "@paperclipai/shared";
import { planningCanvasOpsService, type PlanningCanvasOpsActor } from "./planning-canvas-ops.js";
import { planningCanvasService, rebuildPlanningCanvasLegacyBlobs } from "./planning-canvases.js";
import type { AuthorizationActor } from "./authorization.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const databaseSuite = support.supported ? describe : describe.skip;

/** The C1 backfill block of migration 0456, run as-is to migrate boards written by old code. */
const BACKFILL = (() => {
  const file = readFileSync(
    fileURLToPath(new URL("../../../packages/db/src/migrations/0456_planning_canvas_items.sql", import.meta.url)),
    "utf8",
  );
  return file.slice(file.lastIndexOf("DO $$"));
})();

const OWNER = "user-owner";
const reader: AuthorizationActor = { type: "board", userId: OWNER, source: "local_implicit" } as AuthorizationActor;

function legacyNode(id: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "sticky", x: 0, y: 0, width: 200, height: 120, zIndex: 1, color: "yellow", title: id, content: "", ...extra };
}
function addNode(key: string, extra: Record<string, unknown> = {}): PlanningCanvasOp {
  const { id: _id, ...fields } = legacyNode(key, extra);
  return { op: "add", item: { itemType: "node", key, ...fields } as never };
}
function blob(nodes: unknown[], connectors: unknown[] = [], strokes?: unknown[]): PlanningCanvasData {
  return { nodes, connectors, ...(strokes ? { strokes } : {}), viewport: { x: 0, y: 0, zoom: 1 } } as PlanningCanvasData;
}

databaseSuite("planning canvas boards on items (real PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const agent: PlanningCanvasOpsActor = { type: "agent", id: randomUUID() };

  beforeAll(async () => {
    const url = external ?? (temporary = await startEmbeddedPostgresTestDatabase("planning-canvas-boards-")).connectionString;
    db = createDb(url);
    const agentCompanyId = randomUUID();
    await db.insert(companies).values({ id: agentCompanyId, name: "Canvas agents", issuePrefix: `A${agentCompanyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agent.id, companyId: agentCompanyId, name: "Canvas agent" });
  }, 120_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  const svc = () => planningCanvasService(db);
  const ops = (target: { companyId: string; boardId: string }, list: PlanningCanvasOp[], actor: PlanningCanvasOpsActor = agent) =>
    planningCanvasOpsService(db).applyOps({ ...target, actor, batch: { ops: list } });

  async function company() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Canvas boards", issuePrefix: `C${companyId.slice(0, 7)}` });
    return companyId;
  }

  /** A board written by the e33502365 service `create`, then migrated by the C1 backfill. */
  async function migratedBoard(data: PlanningCanvasData) {
    const companyId = await company();
    const [row] = await db
      .insert(planningCanvases)
      .values({ companyId, userId: OWNER, title: "Old board", description: "", data })
      .returning();
    await db.execute(sql.raw(BACKFILL));
    return { companyId, boardId: row!.id };
  }

  /** The e33502365 service `update`: writes the blob whole. */
  async function oldServiceUpdate(target: { companyId: string; boardId: string }, data: PlanningCanvasData) {
    await db
      .update(planningCanvases)
      .set({ data, updatedAt: new Date() })
      .where(
        and(
          eq(planningCanvases.id, target.boardId),
          eq(planningCanvases.companyId, target.companyId),
          eq(planningCanvases.userId, OWNER),
        ),
      );
  }

  async function item(boardId: string, key: string) {
    const [row] = await db
      .select()
      .from(planningCanvasItems)
      .where(and(eq(planningCanvasItems.boardId, boardId), eq(planningCanvasItems.itemKey, key)));
    return row;
  }
  async function boardState(boardId: string) {
    const [row] = await db
      .select({
        data: planningCanvases.data,
        revision: planningCanvases.revision,
        legacyDataMd5: planningCanvases.legacyDataMd5,
        md5: sql<string>`md5(${planningCanvases.data}::text)`,
      })
      .from(planningCanvases)
      .where(eq(planningCanvases.id, boardId));
    return row!;
  }
  const legacyPatch = (target: { companyId: string; boardId: string }, data: PlanningCanvasData) =>
    svc().update(target.companyId, OWNER, target.boardId, { data });

  describe("legacy PATCH {data} (J.2)", () => {
    it("edits a migrated node, and the edit lands without writing data", async () => {
      const target = await migratedBoard(blob([legacyNode("n1", { title: "Before" })]));
      const before = await boardState(target.boardId);
      expect((await item(target.boardId, "n1"))!.updatedByUserId).toBe(OWNER);

      const answer = await legacyPatch(target, blob([legacyNode("n1", { title: "After", x: 50 })]));

      expect(answer.legacyPatch).toEqual({ added: 0, updated: 1, unchanged: 0, skipped: 0 });
      expect(answer.data.nodes.find((node) => node.id === "n1")).toMatchObject({ title: "After", x: 50 });
      const row = (await item(target.boardId, "n1"))!;
      expect(row.data).toMatchObject({ title: "After", x: 50 });
      expect(row.version).toBe(2);
      expect(row.fieldVersions).toEqual({ title: 2 });
      const after = await boardState(target.boardId);
      expect(after.data).toEqual(before.data);
      expect(after.legacyDataMd5).toBe(after.md5);
      expect(after.revision).toBe(before.revision + 1);
    });

    it("keeps an agent-added node when a stale body lacks it", async () => {
      const target = await migratedBoard(blob([legacyNode("n1")]));
      const added = await ops(target, [addNode("agent_n")]);
      expect(added.results[0]!.status).toBe("applied");

      await legacyPatch(target, blob([legacyNode("n1", { x: 10 })]));

      expect((await item(target.boardId, "agent_n"))!.deletedAt).toBeNull();
      expect((await item(target.boardId, "n1"))!.data).toMatchObject({ x: 10 });
    });

    it("keeps an agent edit to node X against a stale body holding the old X", async () => {
      const target = await migratedBoard(blob([legacyNode("x1", { title: "Old" })]));
      await ops(target, [{ op: "update", key: "x1", baseVersion: 1, set: { title: "Agent edit" } }]);

      const answer = await legacyPatch(target, blob([legacyNode("x1", { title: "Old", x: 99 })]));

      expect(answer.legacyPatch).toMatchObject({ updated: 0, skipped: 1 });
      const row = (await item(target.boardId, "x1"))!;
      expect(row.data).toMatchObject({ title: "Agent edit", x: 0 });
      expect(row.updatedByAgentId).toBe(agent.id);
    });

    it("leaves a node in place when an old tab deletes it", async () => {
      const target = await migratedBoard(blob([legacyNode("keep"), legacyNode("gone")]));

      const answer = await legacyPatch(target, blob([legacyNode("keep")]));

      expect((await item(target.boardId, "gone"))!.deletedAt).toBeNull();
      expect(answer.data.nodes.map((node) => node.id).sort()).toEqual(["gone", "keep"]);
    });

    it("adds new items, skips another user's items and tombstones, and does not bump an unchanged body", async () => {
      const target = await migratedBoard(blob([legacyNode("a"), legacyNode("b")]));
      await ops(target, [{ op: "delete", key: "b" }], { type: "user", id: OWNER });
      await ops(target, [addNode("theirs", { title: "t" })], { type: "user", id: "user-other" });

      const first = await legacyPatch(
        target,
        blob([legacyNode("a"), legacyNode("b"), legacyNode("theirs", { title: "mine now" }), legacyNode("c")], [
          { id: "e1", fromNodeId: "a", toNodeId: "c" },
          { id: "e2", fromNodeId: "a", toNodeId: "missing" },
        ]),
      );
      expect(first.legacyPatch).toEqual({ added: 2, updated: 0, unchanged: 1, skipped: 3 });
      expect((await item(target.boardId, "b"))!.deletedAt).not.toBeNull();
      expect((await item(target.boardId, "theirs"))!.data).toMatchObject({ title: "t" });
      expect((await item(target.boardId, "e1"))!.data).toEqual({ fromKey: "a", toKey: "c" });

      const revision = (await boardState(target.boardId)).revision;
      const second = await legacyPatch(target, blob([legacyNode("a"), legacyNode("c")], [{ id: "e1", fromNodeId: "a", toNodeId: "c" }]));
      expect(second.legacyPatch).toEqual({ added: 0, updated: 0, unchanged: 3, skipped: 0 });
      expect((await boardState(target.boardId)).revision).toBe(revision);
    });

    it("creates a board from data as items and leaves the data column at its default", async () => {
      const companyId = await company();
      const created = await svc().create(companyId, OWNER, { title: "New", description: "", data: blob([legacyNode("n1")]) });
      expect(created.items.map((entry) => entry.key)).toEqual(["n1"]);
      const state = await boardState(created.id);
      expect(state.data.nodes).toEqual([]);
      expect(state.legacyDataMd5).toBe(state.md5);
    });
  });

  describe("catch-up sync (J.2, Q18)", () => {
    it("shows a blob written by the old service function after backfill on the new read", async () => {
      const target = await migratedBoard(blob([legacyNode("n1", { title: "Before" })]));
      await oldServiceUpdate(target, blob([legacyNode("n1", { title: "Old code edit" }), legacyNode("n2")]));
      expect((await boardState(target.boardId)).legacyDataMd5).not.toBe((await boardState(target.boardId)).md5);

      const read = await svc().getById(target.companyId, OWNER, target.boardId);

      expect(read.items.map((entry) => entry.key).sort()).toEqual(["n1", "n2"]);
      expect(read.data.nodes.find((node) => node.id === "n1")!.title).toBe("Old code edit");
      expect((await item(target.boardId, "n2"))!.updatedByUserId).toBe(OWNER);
      const state = await boardState(target.boardId);
      expect(state.legacyDataMd5).toBe(state.md5);
      const again = await svc().getById(target.companyId, OWNER, target.boardId);
      expect(again.revision).toBe(read.revision);
    });

    it("catches up before an op batch, so the batch sees the old-code node", async () => {
      const target = await migratedBoard(blob([legacyNode("n1")]));
      await oldServiceUpdate(target, blob([legacyNode("n1"), legacyNode("late")]));

      const result = await ops(target, [{ op: "update", key: "late", baseVersion: 1, set: { title: "agent" } }]);

      expect(result.results[0]!.status).toBe("applied");
      const state = await boardState(target.boardId);
      expect(state.legacyDataMd5).toBe(state.md5);
      expect(result.revision).toBe(3);
    });

    it("never replays the blob over newer agent edits", async () => {
      const target = await migratedBoard(blob([legacyNode("n1", { title: "Old" })]));
      await ops(target, [{ op: "update", key: "n1", baseVersion: 1, set: { title: "Agent" } }]);
      await oldServiceUpdate(target, blob([legacyNode("n1", { title: "Stale old code" })]));

      await svc().getById(target.companyId, OWNER, target.boardId);

      expect((await item(target.boardId, "n1"))!.data).toMatchObject({ title: "Agent" });
    });
  });

  describe("reads (B.5)", () => {
    async function readBoard() {
      const companyId = await company();
      const created = await svc().create(companyId, OWNER, { title: "Reads", description: "" });
      const target = { companyId, boardId: created.id, identifier: `R${companyId.slice(0, 6)}-1` };
      const prefix = `R${companyId.slice(0, 6)}`;
      const [visible] = await db
        .insert(issues)
        .values({ companyId, title: "Ship login", status: "todo", identifier: `${prefix}-1` })
        .returning();
      const [hidden] = await db
        .insert(issues)
        .values({ companyId, title: "Secret plan", status: "todo", identifier: `${prefix}-2`, hiddenAt: new Date() })
        .returning();
      await ops(
        target,
        [
          addNode("a", { title: "Alpha roadmap", links: [{ type: "issue", issueId: visible!.id }] }),
          addNode("b", { x: 1000, y: 1000, title: "Beta" }),
          addNode("h", { kind: "issue", x: 2000, title: "Secret plan", ref: { id: hidden!.id } }),
          addNode("md", { kind: "markdown", x: 3000, data: { markdown: "find the needle" } }),
          { op: "add", item: { itemType: "connector", key: "ab", fromKey: "a", toKey: "b", label: "next" } },
        ],
        { type: "user", id: OWNER },
      );
      return target;
    }

    it("serves keys, area and q, alone and combined", async () => {
      const target = await readBoard();
      const read = (query: Record<string, unknown>) => svc().read(target.companyId, OWNER, target.boardId, query);
      const keysOf = (result: Awaited<ReturnType<typeof read>>) =>
        result.kind === "items" && !result.body.resync ? result.body.items.map((entry) => entry.key).sort() : null;

      expect(keysOf(await read({ keys: ["b", "zz"] }))).toEqual(["b"]);
      expect(keysOf(await read({ area: { x: -10, y: -10, width: 500, height: 500 } }))).toEqual(["a", "ab"]);
      expect(keysOf(await read({ q: "NEEDLE" }))).toEqual(["md"]);
      expect(keysOf(await read({ q: "next" }))).toEqual(["ab"]);
      expect(keysOf(await read({ q: "beta", keys: ["a"] }))).toEqual([]);
    });

    it("returns deltas with tombstones since a revision, and resync below purged_through_revision", async () => {
      const target = await readBoard();
      const base = await svc().getById(target.companyId, OWNER, target.boardId);
      await ops(target, [{ op: "delete", key: "a" }], { type: "user", id: OWNER });

      const delta = await svc().read(target.companyId, OWNER, target.boardId, { since: base.revision });
      expect(delta.kind).toBe("items");
      const body = delta.body as { items: Array<{ key: string; deletedAt: string | null }>; revision: number };
      expect(body.revision).toBe(base.revision + 1);
      expect(body.items.map((entry) => [entry.key, entry.deletedAt !== null]).sort()).toEqual([
        ["a", true],
        ["ab", true],
      ]);

      await db.update(planningCanvases).set({ purgedThroughRevision: base.revision }).where(eq(planningCanvases.id, target.boardId));
      const stale = await svc().read(target.companyId, OWNER, target.boardId, { since: base.revision - 1 });
      expect(stale.body).toEqual({ resync: true, revision: base.revision + 1, purgedThroughRevision: base.revision });
    });

    it("emits handedOffIssueId always and the identifier only for a reader with issue:read", async () => {
      const target = await readBoard();
      const anonymous = await svc().getById(target.companyId, OWNER, target.boardId);
      const withReader = await svc().getById(target.companyId, OWNER, target.boardId, { actor: reader });
      const nodeA = (board: typeof anonymous) => board.data.nodes.find((node) => node.id === "a")!;
      expect(nodeA(anonymous).handedOffIssueId).toBeTruthy();
      expect(nodeA(anonymous)).not.toHaveProperty("handedOffIssueIdentifier");
      expect(nodeA(withReader).handedOffIssueIdentifier).toBe(target.identifier);
      expect(planningCanvasDataSchema.safeParse(withReader.data).success).toBe(true);
    });

    it("hides a private issue the reader cannot read (issue:read is applied, not just company scope)", async () => {
      const target = await readBoard();
      const [secret] = await db
        .insert(issues)
        .values({ companyId: target.companyId, title: "Private roadmap", status: "todo", identifier: `${target.identifier}0`, visibility: "private" })
        .returning();
      await ops(target, [addNode("p", { kind: "issue", x: 4000, ref: { id: secret!.id }, links: [{ type: "issue", issueId: secret!.id }] })], {
        type: "user",
        id: OWNER,
      });
      const sessionReader = { type: "board", userId: OWNER, source: "session" } as AuthorizationActor;

      const board = await svc().getById(target.companyId, OWNER, target.boardId, { actor: sessionReader });
      const markdown = await svc().read(target.companyId, OWNER, target.boardId, { format: "markdown" }, { actor: sessionReader });

      const node = board.data.nodes.find((entry) => entry.id === "p")!;
      expect(node.handedOffIssueId).toBe(secret!.id);
      expect(node).not.toHaveProperty("handedOffIssueIdentifier");
      expect((markdown as { body: string }).body).toContain("- [issue] No access `p`");
      expect((markdown as { body: string }).body).not.toContain("Private roadmap");
      // The same reader still sees the open issue.
      expect(board.data.nodes.find((entry) => entry.id === "a")!.handedOffIssueIdentifier).toBe(target.identifier);
    });

    it("serves markdown and Mermaid with hydrated refs; a hidden ref shows no title", async () => {
      const target = await readBoard();
      const markdown = await svc().read(target.companyId, OWNER, target.boardId, { format: "markdown" }, { actor: reader });
      const mermaid = await svc().read(target.companyId, OWNER, target.boardId, { format: "mermaid" }, { actor: reader });
      expect(markdown.kind).toBe("text");
      const text = (markdown as { body: string }).body;
      expect(text).toContain(`- [sticky] Alpha roadmap \`a\` → ${target.identifier} Ship login (todo)`);
      expect(text).toContain("- [issue] No access `h`");
      expect(text).toContain("a -->|next| b");
      const flow = (mermaid as { body: string }).body;
      expect(flow).toContain('h["No access"]');
      for (const output of [text, flow]) expect(output).not.toContain("Secret plan");
      await expect(svc().read(target.companyId, OWNER, target.boardId, { format: "markdown", since: 1 })).rejects.toThrow();
    });
  });

  describe("rebuild-blob script (J.7)", () => {
    it("rebuilds a blob that passes the e33502365 validator and stores its md5 in the same transaction", async () => {
      const companyId = await company();
      const created = await svc().create(companyId, OWNER, { title: "Rebuild", description: "", data: blob([legacyNode("n1")]) });
      const target = { companyId, boardId: created.id };
      const [issue] = await db.insert(issues).values({ companyId, title: "Linked", status: "todo", identifier: `B${companyId.slice(0, 6)}-1` }).returning();
      await ops(target, [
        addNode("md", { kind: "markdown", title: "Plan", data: { markdown: "# Plan" } }),
        { op: "update", key: "n1", baseVersion: 1, set: { links: [{ type: "issue", issueId: issue!.id }] } },
        { op: "add", item: { itemType: "connector", key: "e", fromKey: "n1", toKey: "md" } },
      ]);

      const report = await rebuildPlanningCanvasLegacyBlobs(db, { companyId });

      expect(report).toEqual({ rebuilt: [created.id], overOldCaps: [], invalid: [] });
      const state = await boardState(created.id);
      expect(planningCanvasDataSchema.safeParse(state.data).success).toBe(true);
      expect(state.legacyDataMd5).toBe(state.md5);
      expect(state.data.nodes.find((node) => node.id === "md")).toMatchObject({ kind: "note", title: "Plan", content: "# Plan" });
      expect(state.data.nodes.find((node) => node.id === "n1")).toMatchObject({
        handedOffIssueId: issue!.id,
        handedOffIssueIdentifier: `B${companyId.slice(0, 6)}-1`,
      });
      expect(state.data.connectors).toEqual([{ id: "e", fromNodeId: "n1", toNodeId: "md" }]);
      const revision = state.revision;
      await svc().getById(companyId, OWNER, created.id);
      expect((await boardState(created.id)).revision).toBe(revision);
    });

    it("lists boards over the old caps and leaves them unchanged", async () => {
      const companyId = await company();
      const created = await svc().create(companyId, OWNER, { title: "Big", description: "" });
      const target = { companyId, boardId: created.id };
      for (let start = 0; start < 501; start += 250) {
        const batch = Array.from({ length: Math.min(250, 501 - start) }, (_, index) => addNode(`n${start + index}`));
        await ops(target, batch, { type: "user", id: OWNER });
      }
      const before = await boardState(created.id);

      const report = await rebuildPlanningCanvasLegacyBlobs(db, { companyId: "all" });

      expect(report.overOldCaps).toContainEqual({ boardId: created.id, companyId, nodes: 501, connectors: 0, strokes: 0 });
      expect(report.rebuilt).not.toContain(created.id);
      const after = await boardState(created.id);
      expect(after.data).toEqual(before.data);
      expect(after.legacyDataMd5).toBe(before.legacyDataMd5);
    });
  });
});
