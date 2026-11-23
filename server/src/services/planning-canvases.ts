import { and, desc, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { agents, goals, issues, planningCanvases, planningCanvasItems, projects, type Db } from "@paperclipai/db";
import {
  canvasViewportSchema,
  planningCanvasDataSchema,
  planningCanvasItemsToLegacyBlob,
  planningCanvasToMarkdown,
  planningCanvasToMermaid,
  type CreatePlanningCanvas,
  type PlanningCanvasBoardRead,
  type PlanningCanvasBoardSharing,
  type PlanningCanvasConnectorFields,
  type PlanningCanvasItemsRead,
  type PlanningCanvasNodeFields,
  type PlanningCanvasReadQuery,
  type PlanningCanvasRefMap,
  type PlanningCanvasStrokeFields,
  type UpdatePlanningCanvas,
} from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { issueReadSqlCondition, projectReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { publishPlanningCanvasEvent } from "./planning-canvas-events.js";
import {
  applyLegacyBlobInTx,
  catchUpLegacyBlobInTx,
  planningCanvasBlobIsStale,
  planningCanvasLiveItems,
  type PlanningCanvasBoardRow,
  type PlanningCanvasItemRow,
  type PlanningCanvasLegacyCounts,
  type PlanningCanvasLegacyOutcome,
} from "./planning-canvas-legacy.js";
import { serializePlanningCanvasItem } from "./planning-canvas-ops.js";

/**
 * Planning Canvas boards on item rows (plan PAR-13925 B.1, B.5, J.2, J.7).
 * Reads come from the items; the legacy `data` field of a board read is built
 * from them. Board reads and writes run the J.2 catch-up first. Access here is
 * still owner only; C3 replaces it with the access resolver.
 */

/** Who reads: refs and `handedOffIssueIdentifier` are hydrated with this actor's read access. */
export interface PlanningCanvasReader {
  actor?: AuthorizationActor | null;
}

export type PlanningCanvasBoardSummary = Omit<PlanningCanvasBoardRead, "items">;

export type PlanningCanvasReadResult =
  | { kind: "board"; body: PlanningCanvasBoardRead }
  | { kind: "items"; body: PlanningCanvasItemsRead }
  | { kind: "text"; format: "markdown" | "mermaid"; contentType: string; revision: number; body: string };

const OLD_BLOB_CAP = 500;
const LOOKUP_CHUNK = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Area = NonNullable<PlanningCanvasReadQuery["area"]>;

function sharingOf(row: PlanningCanvasBoardRow): PlanningCanvasBoardSharing {
  return {
    scope: row.scope,
    projectId: row.projectId ?? null,
    memberAccess: row.memberAccess,
    revision: row.revision,
    purgedThroughRevision: row.purgedThroughRevision,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdByAgentId: row.createdByAgentId ?? null,
  };
}

function viewportOf(row: PlanningCanvasBoardRow) {
  const parsed = canvasViewportSchema.safeParse((row.data as { viewport?: unknown } | null)?.viewport);
  return parsed.success ? parsed.data : { x: 0, y: 0, zoom: 1 };
}

function boardSummary(row: PlanningCanvasBoardRow, items: PlanningCanvasItemRow[], refs: PlanningCanvasRefMap): PlanningCanvasBoardSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    title: row.title,
    description: row.description ?? "",
    data: planningCanvasItemsToLegacyBlob(items.map(serializePlanningCanvasItem), { viewport: viewportOf(row), refs }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...sharingOf(row),
  };
}

function publishItemsEvent(board: PlanningCanvasBoardRow, changed: PlanningCanvasItemRow[], userId: string | null) {
  if (changed.length === 0 || !userId) return;
  publishPlanningCanvasEvent({
    type: "ops.applied",
    companyId: board.companyId,
    boardId: board.id,
    revision: board.revision,
    actor: { type: "user", id: userId },
    items: changed.map(serializePlanningCanvasItem),
    purgedThroughRevision: board.purgedThroughRevision,
  });
}

function chunks<T>(values: T[]) {
  const out: T[][] = [];
  for (let start = 0; start < values.length; start += LOOKUP_CHUNK) out.push(values.slice(start, start + LOOKUP_CHUNK));
  return out;
}

/**
 * Refs of ref nodes and node links, as `actor` may see them (Q17). Issues pass
 * `issueReadSqlCondition`, projects `projectReadSqlCondition`; agents and goals
 * are company-scoped. Without an actor, or for anything unreadable: hidden.
 */
async function hydrateRefs(
  db: Db,
  companyId: string,
  actor: AuthorizationActor | null | undefined,
  items: PlanningCanvasItemRow[],
): Promise<PlanningCanvasRefMap> {
  const wanted = { issue: new Set<string>(), project: new Set<string>(), agent: new Set<string>(), goal: new Set<string>() };
  for (const row of items) {
    if (row.itemType !== "node") continue;
    const node = row.data as PlanningCanvasNodeFields;
    if (node.ref && node.kind in wanted) wanted[node.kind as keyof typeof wanted].add(node.ref.id);
    for (const link of node.links ?? []) wanted.issue.add(link.issueId);
  }
  const refs: PlanningCanvasRefMap = {};
  for (const ids of Object.values(wanted)) for (const id of ids) refs[id] = { hidden: true };
  if (!actor) return refs;

  type Found = { id: string; label: string; identifier?: string | null; status?: string | null };
  const lookup = async (ids: Set<string>, query: (ids: string[]) => Promise<Found[]>) => {
    for (const part of chunks([...ids].filter((id) => UUID.test(id)))) {
      for (const row of await query(part)) {
        refs[row.id] = { label: row.label, identifier: row.identifier ?? null, status: row.status ?? null };
      }
    }
  };
  const issueRead = wanted.issue.size > 0 ? await issueReadSqlCondition(db, actor) : null;
  const projectRead = wanted.project.size > 0 ? await projectReadSqlCondition(db, actor) : null;
  await lookup(wanted.issue, (ids) =>
    db
      .select({ id: issues.id, label: issues.title, identifier: issues.identifier, status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids), isNull(issues.hiddenAt), issueRead!)),
  );
  await lookup(wanted.project, (ids) =>
    db
      .select({ id: projects.id, label: projects.name, status: projects.status })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), inArray(projects.id, ids), projectRead!)),
  );
  await lookup(wanted.agent, (ids) =>
    db
      .select({ id: agents.id, label: agents.name, status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, ids))),
  );
  await lookup(wanted.goal, (ids) =>
    db
      .select({ id: goals.id, label: goals.title, status: goals.status })
      .from(goals)
      .where(and(eq(goals.companyId, companyId), inArray(goals.id, ids))),
  );
  return refs;
}

function rectsMeet(a: Area, b: Area) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function strokeBox(stroke: PlanningCanvasStrokeFields): Area {
  const xs = stroke.points.map((point) => point.x);
  const ys = stroke.points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(Math.max(...xs) - x, 1), height: Math.max(Math.max(...ys) - y, 1) };
}

/** Text a `q` search looks at: titles, content, labels, markdown and table text. */
function searchText(row: PlanningCanvasItemRow) {
  if (row.itemType === "connector") return (row.data as PlanningCanvasConnectorFields).label ?? "";
  if (row.itemType !== "node") return "";
  const node = row.data as PlanningCanvasNodeFields;
  const parts: unknown[] = [node.title, node.content];
  const typed = node.data as Record<string, unknown> | undefined;
  if (typed && typeof typed.markdown === "string") parts.push(typed.markdown);
  if (typed && Array.isArray(typed.columns) && Array.isArray(typed.rows)) {
    for (const column of typed.columns as Array<{ name: string }>) parts.push(column.name);
    for (const tableRow of typed.rows as Array<{ cells: Record<string, unknown> }>) parts.push(...Object.values(tableRow.cells));
  }
  return parts.filter((part) => typeof part === "string").join("\n");
}

export function planningCanvasService(db: Db) {
  async function loadOwned(companyId: string, userId: string, boardId: string) {
    const [row] = await db
      .select()
      .from(planningCanvases)
      .where(and(eq(planningCanvases.id, boardId), eq(planningCanvases.companyId, companyId), eq(planningCanvases.userId, userId)))
      .limit(1);
    if (!row) throw notFound("Planning canvas board not found");
    return row;
  }

  /** J.2 catch-up on read: only when the blob changed, under the board row lock. */
  async function syncIfStale(row: PlanningCanvasBoardRow, knownStale?: boolean): Promise<PlanningCanvasBoardRow> {
    if (!(knownStale ?? (await planningCanvasBlobIsStale(db, row.id)))) return row;
    const now = new Date();
    const outcome = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(planningCanvases).where(eq(planningCanvases.id, row.id)).for("update");
      if (!locked) throw notFound("Planning canvas board not found");
      return (await catchUpLegacyBlobInTx(tx, locked, now)) ?? { board: locked, changed: [] };
    });
    publishItemsEvent(outcome.board, outcome.changed, outcome.board.userId);
    return outcome.board;
  }

  /** Keeps items in `area`: nodes by box, strokes by point box, connectors by either endpoint. */
  async function filterArea(boardId: string, rows: PlanningCanvasItemRow[], area: Area) {
    const nodeBoxes = new Map<string, Area>();
    for (const row of rows) if (row.itemType === "node") nodeBoxes.set(row.itemKey, row.data as PlanningCanvasNodeFields);
    const endpoints = rows.flatMap((row) => {
      if (row.itemType !== "connector") return [];
      const { fromKey, toKey } = row.data as PlanningCanvasConnectorFields;
      return [fromKey, toKey].filter((key) => !nodeBoxes.has(key));
    });
    for (const part of chunks([...new Set(endpoints)])) {
      const found = await db
        .select({ key: planningCanvasItems.itemKey, data: planningCanvasItems.data })
        .from(planningCanvasItems)
        .where(and(eq(planningCanvasItems.boardId, boardId), eq(planningCanvasItems.itemType, "node"), inArray(planningCanvasItems.itemKey, part)));
      for (const row of found) nodeBoxes.set(row.key, row.data as PlanningCanvasNodeFields);
    }
    const nodeIn = (key: string) => {
      const box = nodeBoxes.get(key);
      return Boolean(box && rectsMeet(box, area));
    };
    return rows.filter((row) => {
      if (row.itemType === "node") return nodeIn(row.itemKey);
      if (row.itemType === "stroke") return rectsMeet(strokeBox(row.data as PlanningCanvasStrokeFields), area);
      const { fromKey, toKey } = row.data as PlanningCanvasConnectorFields;
      return nodeIn(fromKey) || nodeIn(toKey);
    });
  }

  /**
   * Board read (B.5). No filters: the full board (legacy `data` plus items).
   * `since` (with tombstones; `resync` below `purged_through_revision`),
   * `keys`, `area` and `q` narrow the items; `format` serializes live items.
   */
  async function read(
    companyId: string,
    userId: string,
    boardId: string,
    query: PlanningCanvasReadQuery = {},
    reader: PlanningCanvasReader = {},
  ): Promise<PlanningCanvasReadResult> {
    const format = query.format ?? "json";
    if (query.since !== undefined && format !== "json") throw badRequest("since is only for JSON reads");
    const row = await syncIfStale(await loadOwned(companyId, userId, boardId));
    if (query.since !== undefined && query.since < row.purgedThroughRevision) {
      return { kind: "items", body: { resync: true, revision: row.revision, purgedThroughRevision: row.purgedThroughRevision } };
    }
    const conditions: SQL[] = [eq(planningCanvasItems.boardId, row.id)];
    conditions.push(query.since !== undefined ? gt(planningCanvasItems.revision, query.since) : isNull(planningCanvasItems.deletedAt));
    if (query.keys) conditions.push(inArray(planningCanvasItems.itemKey, query.keys));
    let rows = await db
      .select()
      .from(planningCanvasItems)
      .where(and(...conditions))
      .orderBy(planningCanvasItems.itemType, planningCanvasItems.zIndex, planningCanvasItems.itemKey);
    if (query.area) rows = await filterArea(row.id, rows, query.area);
    if (query.q) {
      const needle = query.q.toLowerCase();
      rows = rows.filter((item) => searchText(item).toLowerCase().includes(needle));
    }

    if (format !== "json") {
      const refs = await hydrateRefs(db, companyId, reader.actor, rows);
      const items = rows.map(serializePlanningCanvasItem);
      return format === "markdown"
        ? { kind: "text", format, contentType: "text/markdown; charset=utf-8", revision: row.revision, body: planningCanvasToMarkdown(row, items, refs) }
        : { kind: "text", format, contentType: "text/plain; charset=utf-8", revision: row.revision, body: planningCanvasToMermaid(items, refs) };
    }
    if (query.since === undefined && !query.keys && !query.area && !query.q) {
      const refs = await hydrateRefs(db, companyId, reader.actor, rows);
      return { kind: "board", body: { ...boardSummary(row, rows, refs), items: rows.map(serializePlanningCanvasItem) } };
    }
    return {
      kind: "items",
      body: { revision: row.revision, purgedThroughRevision: row.purgedThroughRevision, items: rows.map(serializePlanningCanvasItem) },
    };
  }

  async function getById(companyId: string, userId: string, boardId: string, reader: PlanningCanvasReader = {}) {
    const result = await read(companyId, userId, boardId, {}, reader);
    return (result as Extract<PlanningCanvasReadResult, { kind: "board" }>).body;
  }

  return {
    read,
    getById,

    async list(companyId: string, userId: string, reader: PlanningCanvasReader = {}): Promise<PlanningCanvasBoardSummary[]> {
      const found = await db
        .select({
          board: planningCanvases,
          stale: sql<boolean>`md5(${planningCanvases.data}::text) is distinct from ${planningCanvases.legacyDataMd5}`,
        })
        .from(planningCanvases)
        .where(and(eq(planningCanvases.companyId, companyId), eq(planningCanvases.userId, userId)))
        .orderBy(desc(planningCanvases.updatedAt));
      const boards: PlanningCanvasBoardRow[] = [];
      for (const entry of found) boards.push(await syncIfStale(entry.board, Boolean(entry.stale)));
      if (boards.length === 0) return [];
      const items = await db
        .select()
        .from(planningCanvasItems)
        .where(and(inArray(planningCanvasItems.boardId, boards.map((board) => board.id)), isNull(planningCanvasItems.deletedAt)))
        .orderBy(planningCanvasItems.itemType, planningCanvasItems.zIndex, planningCanvasItems.itemKey);
      const refs = await hydrateRefs(db, companyId, reader.actor, items);
      return boards.map((board) => boardSummary(board, items.filter((item) => item.boardId === board.id), refs));
    },

    /** Creates the board and writes `input.data` as items; the `data` column keeps its default. */
    async create(companyId: string, userId: string, input: CreatePlanningCanvas, reader: PlanningCanvasReader = {}) {
      const now = new Date();
      const outcome = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(planningCanvases)
          .values({ companyId, userId, title: input.title, description: input.description ?? "", createdAt: now, updatedAt: now })
          .returning();
        const [synced] = await tx
          .update(planningCanvases)
          .set({ legacyDataMd5: sql`md5(${planningCanvases.data}::text)` })
          .where(eq(planningCanvases.id, inserted!.id))
          .returning();
        return input.data ? applyLegacyBlobInTx(tx, synced!, input.data, userId, now) : { board: synced!, changed: [] };
      });
      publishItemsEvent(outcome.board, outcome.changed, userId);
      return getById(companyId, userId, outcome.board.id, reader);
    },

    /**
     * Legacy whole-board PATCH (J.2): `data` is applied upsert-only as this
     * user, after the catch-up; it never tombstones and never writes `data`.
     * Answers the current board plus the counts.
     */
    async update(
      companyId: string,
      userId: string,
      boardId: string,
      patch: UpdatePlanningCanvas,
      reader: PlanningCanvasReader = {},
    ): Promise<PlanningCanvasBoardRead & { legacyPatch: PlanningCanvasLegacyCounts | null }> {
      const now = new Date();
      const writes: Array<{ outcome: PlanningCanvasLegacyOutcome; writer: string | null }> = [];
      const legacyPatch = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(planningCanvases)
          .where(and(eq(planningCanvases.id, boardId), eq(planningCanvases.companyId, companyId), eq(planningCanvases.userId, userId)))
          .for("update");
        if (!locked) throw notFound("Planning canvas board not found");
        let board = locked;
        const caughtUp = await catchUpLegacyBlobInTx(tx, board, now);
        if (caughtUp) {
          board = caughtUp.board;
          writes.push({ outcome: caughtUp, writer: board.userId });
        }
        let counts: PlanningCanvasLegacyCounts | null = null;
        if (patch.data !== undefined) {
          const applied = await applyLegacyBlobInTx(tx, board, patch.data, userId, now);
          board = applied.board;
          counts = applied.counts;
          writes.push({ outcome: applied, writer: userId });
        }
        const values: Partial<typeof planningCanvases.$inferInsert> = {};
        if (patch.title !== undefined) values.title = patch.title;
        if (patch.description !== undefined) values.description = patch.description;
        if (Object.keys(values).length > 0) {
          await tx.update(planningCanvases).set({ ...values, updatedAt: now }).where(eq(planningCanvases.id, board.id));
        }
        return counts;
      });
      for (const { outcome, writer } of writes) publishItemsEvent(outcome.board, outcome.changed, writer);
      return { ...(await getById(companyId, userId, boardId, reader)), legacyPatch };
    },

    async remove(companyId: string, userId: string, boardId: string): Promise<{ deleted: true }> {
      const deleted = await db
        .delete(planningCanvases)
        .where(and(eq(planningCanvases.id, boardId), eq(planningCanvases.companyId, companyId), eq(planningCanvases.userId, userId)))
        .returning({ id: planningCanvases.id });
      if (!deleted[0]) throw notFound("Planning canvas board not found");
      return { deleted: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Rollback: rebuild the legacy blob from live items (J.7)
// ---------------------------------------------------------------------------

export interface PlanningCanvasRebuildReport {
  rebuilt: string[];
  /** Boards over the old 500 caps: listed and left unchanged, for a person to decide. */
  overOldCaps: Array<{ boardId: string; companyId: string; nodes: number; connectors: number; strokes: number }>;
  /** Boards whose rebuilt blob failed the old validator: left unchanged. */
  invalid: Array<{ boardId: string; companyId: string; error: string }>;
}

/**
 * Writes `data` from live items in the old shape and sets `legacy_data_md5`
 * in the same transaction, so the catch-up never replays it. New kinds become
 * `note` nodes with a text summary; `links[0]` becomes `handedOffIssueId` plus
 * the identifier. Issue titles, project names and other ref text are not
 * written (the blob reader is the owner, whose access the script cannot check).
 */
export async function rebuildPlanningCanvasLegacyBlobs(
  db: Db,
  options: { companyId: string | "all" },
): Promise<PlanningCanvasRebuildReport> {
  const report: PlanningCanvasRebuildReport = { rebuilt: [], overOldCaps: [], invalid: [] };
  const boards = await db
    .select({ id: planningCanvases.id })
    .from(planningCanvases)
    .where(options.companyId === "all" ? undefined : eq(planningCanvases.companyId, options.companyId))
    .orderBy(planningCanvases.createdAt, planningCanvases.id);
  for (const { id } of boards) {
    await db.transaction(async (tx) => {
      const [board] = await tx.select().from(planningCanvases).where(eq(planningCanvases.id, id)).for("update");
      if (!board) return;
      const items = await planningCanvasLiveItems(tx, board.id);
      const count = (itemType: string) => items.filter((item) => item.itemType === itemType).length;
      const counts = { nodes: count("node"), connectors: count("connector"), strokes: count("stroke") };
      if (counts.nodes > OLD_BLOB_CAP || counts.connectors > OLD_BLOB_CAP || counts.strokes > OLD_BLOB_CAP) {
        report.overOldCaps.push({ boardId: board.id, companyId: board.companyId, ...counts });
        return;
      }
      const issueIds = new Set<string>();
      for (const item of items) {
        if (item.itemType !== "node") continue;
        const node = item.data as PlanningCanvasNodeFields;
        if (node.kind === "issue" && node.ref) issueIds.add(node.ref.id);
        for (const link of node.links ?? []) issueIds.add(link.issueId);
      }
      const refs: PlanningCanvasRefMap = {};
      for (const part of chunks([...issueIds].filter((issueId) => UUID.test(issueId)))) {
        const found = await tx
          .select({ id: issues.id, identifier: issues.identifier })
          .from(issues)
          .where(and(eq(issues.companyId, board.companyId), inArray(issues.id, part)));
        for (const row of found) refs[row.id] = row.identifier ? { label: "", identifier: row.identifier } : { hidden: true };
      }
      const blob = planningCanvasItemsToLegacyBlob(items.map(serializePlanningCanvasItem), { viewport: viewportOf(board), refs });
      const checked = planningCanvasDataSchema.safeParse(blob);
      if (!checked.success) {
        report.invalid.push({ boardId: board.id, companyId: board.companyId, error: checked.error.issues[0]?.message ?? "invalid" });
        return;
      }
      await tx.update(planningCanvases).set({ data: blob }).where(eq(planningCanvases.id, board.id));
      await tx
        .update(planningCanvases)
        .set({ legacyDataMd5: sql`md5(${planningCanvases.data}::text)` })
        .where(eq(planningCanvases.id, board.id));
      report.rebuilt.push(board.id);
    });
  }
  return report;
}
