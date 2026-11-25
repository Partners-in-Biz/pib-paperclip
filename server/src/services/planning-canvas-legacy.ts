import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { planningCanvases, planningCanvasItems, type Db } from "@paperclipai/db";
import {
  canvasConnectorSchema,
  canvasNodeSchema,
  canvasStrokeSchema,
  isLegacyPlanningCanvasNodeKind,
  PLANNING_CANVAS_BOARD_CAPS,
  PLANNING_CANVAS_GEOMETRY_FIELDS,
  planningCanvasConnectorFieldsSchema,
  planningCanvasLegacyElementFields,
  planningCanvasNodeFieldsSchema,
  planningCanvasStrokeFieldsSchema,
  type PlanningCanvasIssueLink,
  type PlanningCanvasItemFields,
  type PlanningCanvasItemType,
  type PlanningCanvasNodeFields,
} from "@paperclipai/shared";

/**
 * Legacy blob writers after the item cutover (plan PAR-13925 J.2, Q18).
 *
 * The legacy whole-board `PATCH {data}` and the catch-up sync both go through
 * `applyLegacyBlobInTx`, which is upsert only:
 * - it adds items the board lacks (within the live caps);
 * - it updates a live item only when its last writer is `writerUserId` with no
 *   agent writer after it, and only for the five legacy node kinds;
 * - it never tombstones, never restores, and never writes the board's `data`.
 * Everything else is skipped and counted.
 *
 * Callers hold `SELECT ... FOR UPDATE` on the board row.
 */

export type PlanningCanvasItemRow = typeof planningCanvasItems.$inferSelect;
export type PlanningCanvasBoardRow = typeof planningCanvases.$inferSelect;
export type PlanningCanvasTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface PlanningCanvasLegacyCounts {
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

export interface PlanningCanvasLegacyOutcome {
  board: PlanningCanvasBoardRow;
  changed: PlanningCanvasItemRow[];
  counts: PlanningCanvasLegacyCounts;
}

const ITEM_TYPES = [
  { itemType: "node", array: "nodes", element: canvasNodeSchema, fields: planningCanvasNodeFieldsSchema },
  { itemType: "connector", array: "connectors", element: canvasConnectorSchema, fields: planningCanvasConnectorFieldsSchema },
  { itemType: "stroke", array: "strokes", element: canvasStrokeSchema, fields: planningCanvasStrokeFieldsSchema },
] as const;
const GEOMETRY = new Set<string>(PLANNING_CANVAS_GEOMETRY_FIELDS);
const KEY_CHUNK = 1000;

// ---------------------------------------------------------------------------
// Row writes shared with the ops engine
// ---------------------------------------------------------------------------

const UPSERT_COLUMNS = [
  "kind",
  "data",
  "z_index",
  "version",
  "field_versions",
  "revision",
  "deleted_at",
  "deleted_with_key",
  "updated_by_user_id",
  "updated_by_agent_id",
  "updated_at",
] as const;
const upsertSet = Object.fromEntries(
  UPSERT_COLUMNS.map((column) => [
    column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
    sql.raw(`excluded."${column}"`),
  ]),
);

/** Writes item rows (new and existing) with one upsert per 1,000 rows. */
export async function upsertPlanningCanvasItemRows(tx: PlanningCanvasTx, rows: PlanningCanvasItemRow[]) {
  for (let start = 0; start < rows.length; start += KEY_CHUNK) {
    await tx
      .insert(planningCanvasItems)
      .values(rows.slice(start, start + KEY_CHUNK))
      .onConflictDoUpdate({ target: [planningCanvasItems.boardId, planningCanvasItems.itemKey], set: upsertSet });
  }
}

// ---------------------------------------------------------------------------
// Legacy upsert
// ---------------------------------------------------------------------------

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function changedFieldNames(before: Record<string, unknown>, after: Record<string, unknown>) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => stableJson(before[name]) !== stableJson(after[name])).sort();
}

type LegacyElement = { itemType: PlanningCanvasItemType; key: string; element: unknown };

/** Valid elements of the blob, first per key; invalid and duplicate ones are counted. */
function legacyElements(blob: unknown, counts: PlanningCanvasLegacyCounts): LegacyElement[] {
  const source = blob && typeof blob === "object" ? (blob as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const out: LegacyElement[] = [];
  for (const spec of ITEM_TYPES) {
    const list = source[spec.array];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const parsed = spec.element.safeParse(raw);
      if (!parsed.success || seen.has(parsed.data.id)) {
        counts.skipped += 1;
        continue;
      }
      seen.add(parsed.data.id);
      out.push({ itemType: spec.itemType, key: parsed.data.id, element: parsed.data });
    }
  }
  return out;
}

async function loadRows(tx: PlanningCanvasTx, boardId: string, keys: string[]) {
  const rows = new Map<string, PlanningCanvasItemRow>();
  for (let start = 0; start < keys.length; start += KEY_CHUNK) {
    const found = await tx
      .select()
      .from(planningCanvasItems)
      .where(and(eq(planningCanvasItems.boardId, boardId), inArray(planningCanvasItems.itemKey, keys.slice(start, start + KEY_CHUNK))));
    for (const row of found) rows.set(row.itemKey, row);
  }
  return rows;
}

async function liveCountsAndZ(tx: PlanningCanvasTx, boardId: string) {
  const found = await tx
    .select({
      itemType: planningCanvasItems.itemType,
      live: sql<number>`count(*) filter (where ${planningCanvasItems.deletedAt} is null)::int`,
      maxZ: sql<number | null>`max(${planningCanvasItems.zIndex})`,
    })
    .from(planningCanvasItems)
    .where(eq(planningCanvasItems.boardId, boardId))
    .groupBy(planningCanvasItems.itemType);
  const live: Record<PlanningCanvasItemType, number> = { node: 0, connector: 0, stroke: 0 };
  const nextZ: Record<PlanningCanvasItemType, number> = { node: 1, connector: 1, stroke: 1 };
  for (const row of found) {
    live[row.itemType] = Number(row.live);
    nextZ[row.itemType] = Number(row.maxZ ?? 0) + 1;
  }
  return { live, nextZ };
}

/**
 * Applies a legacy blob to the item rows under the upsert-only rules above.
 * Writes at `board.revision + 1` when anything changed and returns the board
 * row with that revision.
 */
export async function applyLegacyBlobInTx(
  tx: PlanningCanvasTx,
  board: PlanningCanvasBoardRow,
  blob: unknown,
  writerUserId: string,
  now: Date,
): Promise<PlanningCanvasLegacyOutcome> {
  const counts: PlanningCanvasLegacyCounts = { added: 0, updated: 0, unchanged: 0, skipped: 0 };
  const elements = legacyElements(blob, counts);
  if (elements.length === 0) return { board, changed: [], counts };

  const endpointKeys = elements.flatMap(({ itemType, element }) =>
    itemType === "connector" ? [(element as { fromNodeId: string }).fromNodeId, (element as { toNodeId: string }).toNodeId] : [],
  );
  const rows = await loadRows(tx, board.id, [...new Set([...elements.map((entry) => entry.key), ...endpointKeys])]);
  const { live, nextZ } = await liveCountsAndZ(tx, board.id);
  const revision = board.revision + 1;
  const changed = new Map<string, PlanningCanvasItemRow>();
  const isLiveNode = (key: string) => {
    const row = rows.get(key);
    return Boolean(row && row.itemType === "node" && !row.deletedAt);
  };
  const stamp = (row: PlanningCanvasItemRow, patch: Partial<PlanningCanvasItemRow>): PlanningCanvasItemRow => ({
    ...row,
    ...patch,
    revision,
    updatedAt: now,
    updatedByUserId: writerUserId,
    updatedByAgentId: null,
  });
  const fieldsValid = (itemType: PlanningCanvasItemType, fields: unknown) =>
    ITEM_TYPES.find((spec) => spec.itemType === itemType)!.fields.safeParse(fields).success;
  const endpointsLive = (fields: Record<string, unknown>) =>
    isLiveNode(fields.fromKey as string) && isLiveNode(fields.toKey as string);

  for (const { itemType, key, element } of elements) {
    const existing = rows.get(key);
    if (!existing) {
      const fields = planningCanvasLegacyElementFields(itemType, element as never);
      const capReached = live[itemType] + 1 > PLANNING_CANVAS_BOARD_CAPS[itemType];
      if (capReached || !fieldsValid(itemType, fields) || (itemType === "connector" && !endpointsLive(fields))) {
        counts.skipped += 1;
        continue;
      }
      const node = itemType === "node" ? (fields as unknown as PlanningCanvasNodeFields) : null;
      const row = stamp(
        {
          id: randomUUID(),
          companyId: board.companyId,
          boardId: board.id,
          itemKey: key,
          itemType,
          kind: node?.kind ?? null,
          data: fields as unknown as PlanningCanvasItemFields,
          zIndex: node ? node.zIndex : nextZ[itemType]++,
          version: 1,
          fieldVersions: {},
          revision,
          deletedAt: null,
          deletedWithKey: null,
          updatedByUserId: null,
          updatedByAgentId: null,
          createdAt: now,
          updatedAt: now,
        },
        {},
      );
      rows.set(key, row);
      changed.set(key, row);
      live[itemType] += 1;
      counts.added += 1;
      continue;
    }

    const sameWriter = existing.updatedByUserId === writerUserId && !existing.updatedByAgentId;
    const legacyKind = itemType !== "node" || isLegacyPlanningCanvasNodeKind(existing.kind);
    if (existing.itemType !== itemType || existing.deletedAt || !sameWriter || !legacyKind) {
      counts.skipped += 1;
      continue;
    }
    const before = existing.data as unknown as Record<string, unknown>;
    const fields = planningCanvasLegacyElementFields(
      itemType,
      element as never,
      itemType === "node" ? (before.links as PlanningCanvasIssueLink[] | undefined) : undefined,
    );
    if (before.legacyId !== undefined) fields.legacyId = before.legacyId;
    const fieldNames = changedFieldNames(before, fields);
    if (fieldNames.length === 0) {
      counts.unchanged += 1;
      continue;
    }
    const endpointMoved = itemType === "connector" && (fieldNames.includes("fromKey") || fieldNames.includes("toKey"));
    if (!fieldsValid(itemType, fields) || (endpointMoved && !endpointsLive(fields))) {
      counts.skipped += 1;
      continue;
    }
    const content = fieldNames.filter((name) => !GEOMETRY.has(name));
    const version = content.length > 0 ? existing.version + 1 : existing.version;
    const fieldVersions = { ...(existing.fieldVersions ?? {}) };
    for (const name of content) fieldVersions[name] = version;
    const node = itemType === "node" ? (fields as unknown as PlanningCanvasNodeFields) : null;
    const row = stamp(existing, {
      data: fields as unknown as PlanningCanvasItemFields,
      kind: node ? node.kind : existing.kind,
      zIndex: node ? node.zIndex : existing.zIndex,
      version,
      fieldVersions,
    });
    rows.set(key, row);
    changed.set(key, row);
    counts.updated += 1;
  }

  if (changed.size === 0) return { board, changed: [], counts };
  await upsertPlanningCanvasItemRows(tx, [...changed.values()]);
  await tx.update(planningCanvases).set({ revision, updatedAt: now }).where(eq(planningCanvases.id, board.id));
  return { board: { ...board, revision, updatedAt: now }, changed: [...changed.values()], counts };
}

// ---------------------------------------------------------------------------
// Catch-up sync (J.2, Q18)
// ---------------------------------------------------------------------------

/** True when old code wrote the blob after the last item sync. Cheap: no lock, no blob read. */
export async function planningCanvasBlobIsStale(db: Db | PlanningCanvasTx, boardId: string) {
  const [row] = await db
    .select({ stale: sql<boolean>`md5(${planningCanvases.data}::text) is distinct from ${planningCanvases.legacyDataMd5}` })
    .from(planningCanvases)
    .where(eq(planningCanvases.id, boardId));
  return Boolean(row?.stale);
}

/**
 * Inside a transaction that holds the board row lock: if `md5(data::text)`
 * differs from `legacy_data_md5`, applies the blob with the upsert-only rules
 * and the board owner as writer (old code only writes personal boards as their
 * owner), then stores the md5. Returns null when the blob was already synced.
 */
export async function catchUpLegacyBlobInTx(
  tx: PlanningCanvasTx,
  board: PlanningCanvasBoardRow,
  now: Date,
): Promise<PlanningCanvasLegacyOutcome | null> {
  if (!(await planningCanvasBlobIsStale(tx, board.id))) return null;
  const [current] = await tx
    .select({ data: planningCanvases.data })
    .from(planningCanvases)
    .where(eq(planningCanvases.id, board.id));
  const outcome = board.userId
    ? await applyLegacyBlobInTx(tx, board, current?.data, board.userId, now)
    : { board, changed: [], counts: { added: 0, updated: 0, unchanged: 0, skipped: 0 } };
  const [synced] = await tx
    .update(planningCanvases)
    .set({ legacyDataMd5: sql`md5(${planningCanvases.data}::text)` })
    .where(eq(planningCanvases.id, board.id))
    .returning({ legacyDataMd5: planningCanvases.legacyDataMd5 });
  return { ...outcome, board: { ...outcome.board, legacyDataMd5: synced?.legacyDataMd5 ?? null } };
}

/** Live items of a board in draw order (rebuild script and reads). */
export async function planningCanvasLiveItems(tx: PlanningCanvasTx | Db, boardId: string) {
  return tx
    .select()
    .from(planningCanvasItems)
    .where(and(eq(planningCanvasItems.boardId, boardId), isNull(planningCanvasItems.deletedAt)))
    .orderBy(planningCanvasItems.itemType, planningCanvasItems.zIndex, planningCanvasItems.itemKey);
}

