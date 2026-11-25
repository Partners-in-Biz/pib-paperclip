import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  planningCanvasAgentGrants,
  planningCanvasComments,
  planningCanvases,
  planningCanvasItems,
  planningCanvasOpBatches,
} from "./schema/index.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

const MIGRATION_URL = new URL("./migrations/0456_planning_canvas_items.sql", import.meta.url);

function node(id: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    ...(id === undefined ? {} : { id }),
    kind: "sticky",
    x: 10,
    y: 20,
    width: 200,
    height: 120,
    zIndex: 3,
    color: "yellow",
    title: `Node ${id ?? "no-id"}`,
    content: "",
    ...extra,
  };
}

const viewport = { x: 0, y: 0, zoom: 1 };

describePostgres("planning canvas items migration (0456)", () => {
  it("backfills item rows from legacy blobs, idempotently, and keeps the old insert working", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-planning-canvas-items-");
    const notices: string[] = [];
    const sql = postgres(database.connectionString, {
      max: 1,
      onnotice: (notice) => notices.push(String(notice.message)),
    });
    const replayMigration = async () => {
      const source = await readFile(MIGRATION_URL, "utf8");
      for (const statement of source.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
        await sql.unsafe(statement);
      }
    };

    try {
      const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Canvas migration', 'PCM') RETURNING id`;
      const companyId = company.id as string;
      const ownerA = `user-${randomUUID()}`;
      const ownerB = `user-${randomUUID()}`;
      const ownerC = `user-${randomUUID()}`;
      const ownerD = `user-${randomUUID()}`;
      const issueId = randomUUID();

      // Board 1: a handed-off node, a connector and one stroke.
      const board1 = {
        nodes: [
          node("sticky_a1", { handedOffIssueId: issueId, handedOffIssueIdentifier: "PCM-1" }),
          node("frame_b2", { kind: "frame", zIndex: 0 }),
        ],
        connectors: [{ id: "conn_1", fromNodeId: "sticky_a1", toNodeId: "frame_b2", label: "next" }],
        strokes: [{ id: "stroke_1", points: [{ x: 1, y: 2 }], color: "slate", width: 3 }],
        viewport,
      };
      // Board 2: node id "dup_1" twice; the first by array position wins.
      const board2 = {
        nodes: [node("dup_1", { title: "first" }), node("dup_1", { title: "second" }), node("solo_2")],
        connectors: [],
        strokes: [{ id: "stroke_2", points: [{ x: 0, y: 0 }], color: "rose", width: 2 }],
        viewport,
      };
      // Board 3: empty strokes array.
      const board3 = { nodes: [node("only_3")], connectors: [], strokes: [], viewport };
      // Board 4: ids missing or outside 1-100 get a legacy_<md5> key.
      const longId = "x".repeat(101);
      const board4 = { nodes: [node(undefined), node(longId), node("")], connectors: [], viewport };

      // Old insert (company_id, user_id, title, description, data) still works
      // on the new schema (rule PAR-4100). Rows written this way have not been
      // backfilled, exactly like rows that existed before the migration.
      const insertOld = async (userId: string, title: string, data: unknown) => {
        const [row] = await sql`
          INSERT INTO planning_canvases (company_id, user_id, title, description, data)
          VALUES (${companyId}, ${userId}, ${title}, '', ${sql.json(data as never)})
          RETURNING id, scope, member_access, revision, legacy_data_md5
        `;
        expect(row).toMatchObject({ scope: "personal", member_access: "view", revision: "0", legacy_data_md5: null });
        return row.id as string;
      };
      const b1 = await insertOld(ownerA, "Handoff board", board1);
      const b2 = await insertOld(ownerB, "Duplicate board", board2);
      const b3 = await insertOld(ownerC, "Empty strokes board", board3);
      const b4 = await insertOld(ownerD, "Legacy id board", board4);
      const owners: Record<string, string> = { [b1]: ownerA, [b2]: ownerB, [b3]: ownerC, [b4]: ownerD };

      notices.length = 0;
      await replayMigration();

      const duplicateNotice = notices.find((message) => message.includes("duplicate item key"));
      expect(duplicateNotice).toBeDefined();
      const reportedDuplicates = Number(duplicateNotice!.match(/skipped (\d+) duplicate/)![1]);
      expect(reportedDuplicates).toBe(1);

      const counts = await sql`
        SELECT board_id, count(*)::int AS n FROM planning_canvas_items
        WHERE board_id IN (${b1}, ${b2}, ${b3}, ${b4}) GROUP BY board_id
      `;
      const countOf = (boardId: string) => counts.find((row) => row.board_id === boardId)?.n ?? 0;
      const total = (blob: { nodes: unknown[]; connectors: unknown[]; strokes?: unknown[] }) =>
        blob.nodes.length + blob.connectors.length + (blob.strokes?.length ?? 0);
      expect(countOf(b1)).toBe(total(board1));
      expect(countOf(b2)).toBe(total(board2) - reportedDuplicates);
      expect(countOf(b3)).toBe(total(board3));
      expect(countOf(b4)).toBe(total(board4));

      const items = await sql`
        SELECT board_id, item_key, item_type, kind, data, z_index, version, field_versions,
               revision, deleted_at, updated_by_user_id
        FROM planning_canvas_items WHERE board_id IN (${b1}, ${b2}, ${b3}, ${b4})
      `;
      for (const item of items) {
        expect(item.updated_by_user_id).toBe(owners[item.board_id as string]);
        expect(item.version).toBe(1);
        expect(item.revision).toBe("1");
        expect(item.field_versions).toEqual({});
        expect(item.deleted_at).toBeNull();
        expect(item.data).not.toHaveProperty("id");
      }

      const byKey = (boardId: string, key: string) =>
        items.find((item) => item.board_id === boardId && item.item_key === key);
      const handedOff = byKey(b1, "sticky_a1")!;
      expect(handedOff).toMatchObject({ item_type: "node", kind: "sticky", z_index: 3 });
      expect(handedOff.data.links).toEqual([{ type: "issue", issueId }]);
      expect(handedOff.data).not.toHaveProperty("handedOffIssueId");
      expect(handedOff.data).not.toHaveProperty("handedOffIssueIdentifier");
      expect(byKey(b1, "frame_b2")!.data).not.toHaveProperty("links");
      expect(byKey(b1, "conn_1")).toMatchObject({
        item_type: "connector",
        kind: null,
        z_index: 1,
        data: { fromKey: "sticky_a1", toKey: "frame_b2", label: "next" },
      });
      expect(byKey(b1, "stroke_1")).toMatchObject({ item_type: "stroke", z_index: 1 });
      expect(byKey(b2, "dup_1")!.data.title).toBe("first");

      const legacyItems = items.filter((item) => item.board_id === b4);
      for (const item of legacyItems) expect(item.item_key).toMatch(/^legacy_[0-9a-f]{32}$/);
      const legacyIds = legacyItems.map((item) => item.data.legacyId ?? "(missing)").sort();
      expect(legacyIds).toEqual(["", "(missing)", longId].sort());

      const boards = await sql`
        SELECT id, data::text AS data_text, revision, legacy_data_md5 FROM planning_canvases
        WHERE id IN (${b1}, ${b2}, ${b3}, ${b4})
      `;
      for (const board of boards) {
        expect(board.revision).toBe("1");
        expect(board.legacy_data_md5).toBe(createHash("md5").update(board.data_text as string).digest("hex"));
      }

      // A re-run adds nothing and touches no board.
      notices.length = 0;
      await replayMigration();
      const [{ n: afterReplay }] = await sql`
        SELECT count(*)::int AS n FROM planning_canvas_items WHERE board_id IN (${b1}, ${b2}, ${b3}, ${b4})
      `;
      expect(afterReplay).toBe(items.length);
      expect(notices.some((message) => message.includes("duplicate item key"))).toBe(false);
      expect(notices).toContain("planning_canvas_items backfill inserted 0 item row(s)");

      // Personal boards need an owner; shared boards may have none.
      await expect(sql`
        INSERT INTO planning_canvases (company_id, user_id, title) VALUES (${companyId}, NULL, 'Ownerless')
      `).rejects.toMatchObject({ code: "23514", constraint_name: "planning_canvases_personal_owner_check" });
      await sql`
        INSERT INTO planning_canvases (company_id, user_id, title, scope, member_access)
        VALUES (${companyId}, NULL, 'Company board', 'company', 'edit')
      `;
      await expect(sql`
        INSERT INTO planning_canvases (company_id, user_id, title, member_access) VALUES (${companyId}, ${ownerA}, 'Bad', 'owner')
      `).rejects.toMatchObject({ code: "23514", constraint_name: "planning_canvases_member_access_check" });
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("matches the Drizzle schema for every new table", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-planning-canvas-schema-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    const db = drizzle(sql);
    try {
      const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Canvas schema', 'PCS') RETURNING id`;
      const [agent] = await sql`INSERT INTO agents (company_id, name) VALUES (${company.id}, 'Canvas agent') RETURNING id`;
      const [issue] = await sql`INSERT INTO issues (company_id, title) VALUES (${company.id}, 'Canvas issue') RETURNING id`;
      const companyId = company.id as string;

      const [board] = await db.insert(planningCanvases).values({
        companyId,
        userId: null,
        title: "Shared board",
        scope: "company",
        memberAccess: "edit",
        createdByAgentId: agent.id,
      }).returning();
      expect(board).toMatchObject({ scope: "company", memberAccess: "edit", revision: 0, purgedThroughRevision: 0 });

      const [item] = await db.insert(planningCanvasItems).values({
        companyId,
        boardId: board!.id,
        itemKey: "markdown_1",
        itemType: "node",
        kind: "markdown",
        data: {
          kind: "markdown", x: 0, y: 0, width: 200, height: 100, zIndex: 1, color: "blue",
          title: "", content: "", data: { markdown: "# Hi" },
        },
        zIndex: 1,
        revision: 1,
        updatedByAgentId: agent.id,
      }).returning();
      expect(item).toMatchObject({ version: 1, fieldVersions: {}, deletedWithKey: null, revision: 1 });

      const [comment] = await db.insert(planningCanvasComments).values({
        companyId,
        boardId: board!.id,
        itemKey: "markdown_1",
        body: "@agent please",
        authorUserId: "user-1",
        linkedIssueId: issue.id,
        mentionState: { [agent.id]: "sent" },
      }).returning();
      await db.insert(planningCanvasComments).values({ companyId, boardId: board!.id, parentId: comment!.id, body: "reply" });

      await db.insert(planningCanvasAgentGrants).values({
        companyId, boardId: board!.id, agentId: agent.id, issueId: issue.id, grantedByUserId: "user-1", source: "mention",
      });
      await expect(db.insert(planningCanvasAgentGrants).values({
        companyId, boardId: board!.id, agentId: agent.id, issueId: issue.id, grantedByUserId: "user-1", source: "handoff",
      })).rejects.toMatchObject({ cause: { constraint_name: "planning_canvas_agent_grants_board_agent_issue_uq" } });

      await db.insert(planningCanvasOpBatches).values({
        boardId: board!.id, actorKey: `agent:${agent.id}`, clientBatchId: "b-1", results: [],
      });
      await expect(db.insert(planningCanvasOpBatches).values({
        boardId: board!.id, actorKey: `agent:${agent.id}`, clientBatchId: "b-1", results: [],
      })).rejects.toMatchObject({ cause: { constraint_name: "planning_canvas_op_batches_pk" } });

      await expect(db.insert(planningCanvasItems).values({
        companyId, boardId: board!.id, itemKey: "markdown_1", itemType: "node", data: item!.data, revision: 2,
      })).rejects.toMatchObject({ cause: { constraint_name: "planning_canvas_items_board_key_uq" } });

      // Deleting the board cascades to every child table.
      await db.delete(planningCanvases).where(eq(planningCanvases.id, board!.id));
      for (const table of ["planning_canvas_items", "planning_canvas_comments", "planning_canvas_agent_grants", "planning_canvas_op_batches"]) {
        const [{ n }] = await sql`SELECT count(*)::int AS n FROM ${sql(table)} WHERE board_id = ${board!.id}`;
        expect(n, table).toBe(0);
      }
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
