import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { planningCanvases, planningCanvasItems, planningCanvasOpBatches, type Db } from "@paperclipai/db";
import {
  isKnownPlanningCanvasNodeKind,
  PLANNING_CANVAS_GEOMETRY_FIELDS,
  PLANNING_CANVAS_ITEM_TYPES,
  PLANNING_CANVAS_LIMITS,
  planningCanvasCapExceeded,
  planningCanvasConnectorFieldsSchema,
  planningCanvasNodeFieldsSchema,
  planningCanvasOpBatchSchema,
  planningCanvasStrokeFieldsSchema,
  type PlanningCanvasConnectorFields,
  type PlanningCanvasItem,
  type PlanningCanvasItemFields,
  type PlanningCanvasItemType,
  type PlanningCanvasNodeFields,
  type PlanningCanvasOp,
  type PlanningCanvasOpBatchResponse,
  type PlanningCanvasOpRejectReason,
  type PlanningCanvasOpResult,
  type PlanningCanvasTableData,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound } from "../errors.js";
import {
  publishPlanningCanvasEvent,
  type PlanningCanvasEventActor,
  type PlanningCanvasOpsAppliedEvent,
} from "./planning-canvas-events.js";
import { catchUpLegacyBlobInTx, upsertPlanningCanvasItemRows } from "./planning-canvas-legacy.js";

/**
 * Planning Canvas ops engine (plan PAR-13925 B.2-B.4, C ops, J.5).
 *
 * One batch runs in one transaction under `SELECT ... FOR UPDATE` on the board
 * row, so batches on a board are serialized and the board revision goes up by
 * exactly 1 per batch that applies anything. Geometry is last writer wins and
 * never bumps `version`; content fields bump `version` and `field_versions`
 * and conflict only when a field the op sets changed after `baseVersion`.
 * Table cell ops are last writer wins per cell; only an op on a missing row or
 * column conflicts. Deletes are tombstones. Events go out after commit.
 *
 * Access is not checked here: callers (C3 routes, MCP) resolve it first.
 */

type ItemRow = typeof planningCanvasItems.$inferSelect;
type BoardRow = typeof planningCanvases.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Counts = Record<PlanningCanvasItemType, number>;

export type PlanningCanvasOpsActor = PlanningCanvasEventActor;

export interface ApplyPlanningCanvasOpsInput {
  companyId: string;
  boardId: string;
  actor: PlanningCanvasOpsActor;
  batch: unknown;
  /** Clock override for tests (tombstone and batch retention). */
  now?: Date;
}

const GEOMETRY = new Set<string>(PLANNING_CANVAS_GEOMETRY_FIELDS);
const TOMBSTONE_RETENTION_MS = PLANNING_CANVAS_LIMITS.tombstoneRetentionDays * 24 * 60 * 60 * 1000;
const OP_BATCH_RETENTION_MS = PLANNING_CANVAS_LIMITS.opBatchRetentionHours * 60 * 60 * 1000;
const FIELD_SCHEMAS = {
  node: planningCanvasNodeFieldsSchema,
  connector: planningCanvasConnectorFieldsSchema,
  stroke: planningCanvasStrokeFieldsSchema,
} as const;

export function planningCanvasActorKey(actor: PlanningCanvasOpsActor) {
  return `${actor.type}:${actor.id}`;
}

export function serializePlanningCanvasItem(row: ItemRow): PlanningCanvasItem {
  return {
    key: row.itemKey,
    itemType: row.itemType,
    kind: row.kind ?? null,
    data: row.data,
    zIndex: row.zIndex ?? null,
    version: row.version,
    fieldVersions: row.fieldVersions ?? {},
    revision: row.revision,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    deletedWithKey: row.deletedWithKey ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    updatedByAgentId: row.updatedByAgentId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rejected(key: string, reason: PlanningCanvasOpRejectReason): PlanningCanvasOpResult {
  return { status: "rejected", key, reason };
}

/** Validates merged item fields with the stored-fields schema of its type. */
function checkFields(itemType: PlanningCanvasItemType, fields: unknown): PlanningCanvasOpRejectReason | null {
  const parsed = FIELD_SCHEMAS[itemType].safeParse(fields);
  if (parsed.success) return null;
  return parsed.error.issues.some((issue) => issue.message === "item_too_large") ? "item_too_large" : "invalid_item";
}

function emptyTable(): PlanningCanvasTableData {
  return { columns: [], rows: [] };
}

function clampIndex(index: number | undefined, length: number) {
  if (index === undefined) return length;
  return Math.max(0, Math.min(index, length));
}

type OpOutcome = { result: PlanningCanvasOpResult; changes?: ItemRow[] };

/** One batch: the working set of item rows, the live counts and the pending writes. */
class BatchState {
  readonly items = new Map<string, ItemRow>();
  private readonly attempted = new Set<string>();
  readonly dirty = new Set<string>();
  counts: Counts = { node: 0, connector: 0, stroke: 0 };
  private nextZ: Partial<Record<PlanningCanvasItemType, number>> = {};

  constructor(
    private readonly tx: Tx,
    readonly board: BoardRow,
    readonly revision: number,
    readonly actor: PlanningCanvasOpsActor,
    readonly now: Date,
  ) {}

  async loadCounts() {
    const rows = await this.tx
      .select({ itemType: planningCanvasItems.itemType, count: sql<number>`count(*)::int` })
      .from(planningCanvasItems)
      .where(and(eq(planningCanvasItems.boardId, this.board.id), isNull(planningCanvasItems.deletedAt)))
      .groupBy(planningCanvasItems.itemType);
    for (const row of rows) this.counts[row.itemType] = Number(row.count);
  }

  /** Loads rows for keys not yet in the working set. Missing keys stay absent. */
  async ensureLoaded(keys: Iterable<string>) {
    const wanted = [...new Set(keys)].filter((key) => !this.attempted.has(key));
    if (wanted.length === 0) return;
    for (const key of wanted) this.attempted.add(key);
    const rows = await this.tx
      .select()
      .from(planningCanvasItems)
      .where(and(eq(planningCanvasItems.boardId, this.board.id), inArray(planningCanvasItems.itemKey, wanted)));
    for (const row of rows) if (!this.items.has(row.itemKey)) this.items.set(row.itemKey, row);
  }

  /** Loads every connector that names `key` as an endpoint or as `deleted_with_key`. */
  async loadConnectorsOf(key: string) {
    const rows = await this.tx
      .select()
      .from(planningCanvasItems)
      .where(
        and(
          eq(planningCanvasItems.boardId, this.board.id),
          eq(planningCanvasItems.itemType, "connector"),
          or(
            sql`${planningCanvasItems.data}->>'fromKey' = ${key}`,
            sql`${planningCanvasItems.data}->>'toKey' = ${key}`,
            eq(planningCanvasItems.deletedWithKey, key),
          ),
        ),
      );
    for (const row of rows) {
      this.attempted.add(row.itemKey);
      if (!this.items.has(row.itemKey)) this.items.set(row.itemKey, row);
    }
    return [...this.items.values()].filter((row) => row.itemType === "connector");
  }

  async nextZIndex(itemType: PlanningCanvasItemType) {
    if (this.nextZ[itemType] === undefined) {
      const [row] = await this.tx
        .select({ max: sql<number | null>`max(${planningCanvasItems.zIndex})` })
        .from(planningCanvasItems)
        .where(and(eq(planningCanvasItems.boardId, this.board.id), eq(planningCanvasItems.itemType, itemType)));
      this.nextZ[itemType] = Number(row?.max ?? 0) + 1;
    }
    const value = this.nextZ[itemType]!;
    this.nextZ[itemType] = value + 1;
    return value;
  }

  isLiveNode(key: string) {
    const row = this.items.get(key);
    return Boolean(row && row.itemType === "node" && !row.deletedAt);
  }

  /** Copies a row with this batch's revision and writer. */
  stamp(row: ItemRow, patch: Partial<ItemRow>): ItemRow {
    return {
      ...row,
      ...patch,
      revision: this.revision,
      updatedAt: this.now,
      updatedByUserId: this.actor.type === "user" ? this.actor.id : null,
      updatedByAgentId: this.actor.type === "agent" ? this.actor.id : null,
    };
  }

  /** Commits an op's changes to the working set unless they pass a board cap. */
  commit(changes: ItemRow[]): PlanningCanvasOpRejectReason | null {
    const delta: Counts = { node: 0, connector: 0, stroke: 0 };
    for (const next of changes) {
      const before = this.items.get(next.itemKey);
      const wasLive = Boolean(before && !before.deletedAt);
      const isLive = !next.deletedAt;
      if (wasLive !== isLive) delta[next.itemType] += isLive ? 1 : -1;
    }
    const grown: Partial<Counts> = {};
    for (const itemType of PLANNING_CANVAS_ITEM_TYPES) {
      if (delta[itemType] > 0) grown[itemType] = this.counts[itemType] + delta[itemType];
    }
    if (planningCanvasCapExceeded(grown)) return "cap_exceeded";
    for (const itemType of PLANNING_CANVAS_ITEM_TYPES) this.counts[itemType] += delta[itemType];
    for (const next of changes) {
      this.items.set(next.itemKey, next);
      this.dirty.add(next.itemKey);
    }
    return null;
  }
}

function contentFieldsChangedAfter(row: ItemRow, baseVersion: number, fields?: Iterable<string>) {
  const versions = row.fieldVersions ?? {};
  const names = fields ? [...fields] : Object.keys(versions);
  return names.filter((field) => (versions[field] ?? 0) > baseVersion).sort();
}

function bumpContent(row: ItemRow, fields: string[]) {
  const version = row.version + 1;
  const fieldVersions = { ...(row.fieldVersions ?? {}) };
  for (const field of fields) fieldVersions[field] = version;
  return { version, fieldVersions };
}

function conflictResult(row: ItemRow, conflictingFields: string[]): OpOutcome {
  return {
    result: { status: "conflict", key: row.itemKey, current: serializePlanningCanvasItem(row), conflictingFields },
  };
}

async function applyAdd(state: BatchState, op: Extract<PlanningCanvasOp, { op: "add" }>): Promise<OpOutcome> {
  const { itemType, key, ...fields } = op.item;
  if (state.items.has(key)) return { result: rejected(key, "already_exists") };
  if (itemType === "connector") {
    const connector = fields as PlanningCanvasConnectorFields;
    if (!state.isLiveNode(connector.fromKey) || !state.isLiveNode(connector.toKey)) {
      return { result: rejected(key, "missing_endpoint") };
    }
  }
  const node = itemType === "node" ? (fields as PlanningCanvasNodeFields) : null;
  const row: ItemRow = state.stamp(
    {
      id: randomUUID(),
      companyId: state.board.companyId,
      boardId: state.board.id,
      itemKey: key,
      itemType,
      kind: node?.kind ?? null,
      data: fields as PlanningCanvasItemFields,
      zIndex: node ? node.zIndex : await state.nextZIndex(itemType),
      version: 1,
      fieldVersions: {},
      revision: state.revision,
      deletedAt: null,
      deletedWithKey: null,
      updatedByUserId: null,
      updatedByAgentId: null,
      createdAt: state.now,
      updatedAt: state.now,
    },
    {},
  );
  return { result: { status: "applied", key, version: 1, revision: state.revision }, changes: [row] };
}

async function applyUpdate(state: BatchState, op: Extract<PlanningCanvasOp, { op: "update" }>): Promise<OpOutcome> {
  const row = state.items.get(op.key);
  if (!row) return { result: rejected(op.key, "not_found") };
  if (row.deletedAt) return { result: rejected(op.key, "deleted") };
  const setFields = Object.keys(op.set);
  // A node of a kind this build does not know: geometry only (move, resize); no kind or data change.
  if (row.itemType === "node" && !isKnownPlanningCanvasNodeKind(row.kind)) {
    if (setFields.some((field) => !GEOMETRY.has(field))) return { result: rejected(op.key, "unknown_kind") };
    const merged = { ...(row.data as unknown as Record<string, unknown>), ...op.set };
    const next = state.stamp(row, {
      data: merged as unknown as PlanningCanvasItemFields,
      zIndex: typeof merged.zIndex === "number" ? merged.zIndex : row.zIndex,
    });
    return { result: { status: "applied", key: op.key, version: next.version, revision: state.revision }, changes: [next] };
  }
  const contentFields = setFields.filter((field) => !GEOMETRY.has(field));
  if (contentFields.length > 0) {
    if (op.baseVersion === undefined) return { result: rejected(op.key, "base_version_required") };
    const conflicting = contentFieldsChangedAfter(row, op.baseVersion, contentFields);
    if (conflicting.length > 0) return conflictResult(row, conflicting);
  }
  const merged = { ...(row.data as unknown as Record<string, unknown>), ...op.set };
  const invalid = checkFields(row.itemType, merged);
  if (invalid) return { result: rejected(op.key, invalid) };
  if (row.itemType === "connector") {
    const connector = merged as unknown as PlanningCanvasConnectorFields;
    if (
      ("fromKey" in op.set || "toKey" in op.set) &&
      (!state.isLiveNode(connector.fromKey) || !state.isLiveNode(connector.toKey))
    ) {
      return { result: rejected(op.key, "missing_endpoint") };
    }
  }
  const versioning = contentFields.length > 0 ? bumpContent(row, contentFields) : {};
  const node = row.itemType === "node" ? (merged as unknown as PlanningCanvasNodeFields) : null;
  const next = state.stamp(row, {
    ...versioning,
    data: merged as unknown as PlanningCanvasItemFields,
    kind: node ? node.kind : row.kind,
    zIndex: node ? node.zIndex : row.zIndex,
  });
  return { result: { status: "applied", key: op.key, version: next.version, revision: state.revision }, changes: [next] };
}

async function applyDelete(state: BatchState, op: Extract<PlanningCanvasOp, { op: "delete" }>): Promise<OpOutcome> {
  const row = state.items.get(op.key);
  if (!row) return { result: rejected(op.key, "not_found") };
  if (row.deletedAt) return { result: rejected(op.key, "deleted") };
  if (op.baseVersion !== undefined && row.version > op.baseVersion) {
    const changed = contentFieldsChangedAfter(row, op.baseVersion);
    return conflictResult(row, changed.length > 0 ? changed : ["version"]);
  }
  const changes = [state.stamp(row, { deletedAt: state.now, deletedWithKey: null })];
  if (row.itemType === "node") {
    for (const connector of await state.loadConnectorsOf(op.key)) {
      const fields = connector.data as PlanningCanvasConnectorFields;
      if (connector.deletedAt || (fields.fromKey !== op.key && fields.toKey !== op.key)) continue;
      changes.push(state.stamp(connector, { deletedAt: state.now, deletedWithKey: op.key }));
    }
  }
  return { result: { status: "applied", key: op.key, version: row.version, revision: state.revision }, changes };
}

async function applyRestore(state: BatchState, op: Extract<PlanningCanvasOp, { op: "restore" }>): Promise<OpOutcome> {
  const row = state.items.get(op.key);
  if (!row) return { result: rejected(op.key, "not_found") };
  if (!row.deletedAt) return { result: rejected(op.key, "not_deleted") };
  if (row.itemType === "connector") {
    const fields = row.data as PlanningCanvasConnectorFields;
    await state.ensureLoaded([fields.fromKey, fields.toKey]);
    if (!state.isLiveNode(fields.fromKey) || !state.isLiveNode(fields.toKey)) {
      return { result: rejected(op.key, "missing_endpoint") };
    }
  }
  const changes = [state.stamp(row, { deletedAt: null, deletedWithKey: null })];
  if (row.itemType === "node") {
    const takenAlong = (await state.loadConnectorsOf(op.key)).filter(
      (connector) => connector.deletedAt && connector.deletedWithKey === op.key,
    );
    await state.ensureLoaded(
      takenAlong.flatMap((connector) => {
        const fields = connector.data as PlanningCanvasConnectorFields;
        return [fields.fromKey, fields.toKey];
      }),
    );
    for (const connector of takenAlong) {
      const fields = connector.data as PlanningCanvasConnectorFields;
      const other = fields.fromKey === op.key ? fields.toKey : fields.fromKey;
      if (other !== op.key && !state.isLiveNode(other)) continue;
      changes.push(state.stamp(connector, { deletedAt: null, deletedWithKey: null }));
    }
  }
  return { result: { status: "applied", key: op.key, version: row.version, revision: state.revision }, changes };
}

type TableOp = Extract<PlanningCanvasOp, { op: `table.${string}` }>;

/** Table cell ops: per-cell last writer wins; an op on a missing row or column conflicts. */
async function applyTableOp(state: BatchState, op: TableOp): Promise<OpOutcome> {
  const row = state.items.get(op.key);
  if (!row) return { result: rejected(op.key, "not_found") };
  if (row.deletedAt) return { result: rejected(op.key, "deleted") };
  if (row.itemType !== "node" || row.kind !== "table") return { result: rejected(op.key, "wrong_item_type") };
  const node = row.data as PlanningCanvasNodeFields;
  const table = structuredClone((node.data as PlanningCanvasTableData | undefined) ?? emptyTable());
  const columnIds = new Set(table.columns.map((column) => column.id));
  const rowIndex = (rowId: string) => table.rows.findIndex((candidate) => candidate.id === rowId);
  const gone = () => conflictResult(row, ["data"]);

  switch (op.op) {
    case "table.setCell": {
      const index = rowIndex(op.rowId);
      if (index < 0 || !columnIds.has(op.colId)) return gone();
      table.rows[index]!.cells[op.colId] = op.value;
      break;
    }
    case "table.addRow": {
      if (rowIndex(op.row.id) >= 0) return { result: rejected(op.key, "table_row_exists") };
      if (Object.keys(op.row.cells).some((colId) => !columnIds.has(colId))) return gone();
      if (table.rows.length >= PLANNING_CANVAS_LIMITS.tableRowsMax) return { result: rejected(op.key, "table_cap_exceeded") };
      table.rows.splice(clampIndex(op.index, table.rows.length), 0, structuredClone(op.row));
      break;
    }
    case "table.removeRow": {
      const index = rowIndex(op.rowId);
      if (index < 0) return gone();
      table.rows.splice(index, 1);
      break;
    }
    case "table.moveRow": {
      const index = rowIndex(op.rowId);
      if (index < 0) return gone();
      const [moved] = table.rows.splice(index, 1);
      table.rows.splice(clampIndex(op.toIndex, table.rows.length), 0, moved!);
      break;
    }
    case "table.addColumn": {
      if (columnIds.has(op.column.id)) return { result: rejected(op.key, "table_column_exists") };
      if (table.columns.length >= PLANNING_CANVAS_LIMITS.tableColumnsMax) {
        return { result: rejected(op.key, "table_cap_exceeded") };
      }
      table.columns.splice(clampIndex(op.index, table.columns.length), 0, structuredClone(op.column));
      break;
    }
    case "table.removeColumn": {
      if (!columnIds.has(op.colId)) return gone();
      table.columns = table.columns.filter((column) => column.id !== op.colId);
      for (const tableRow of table.rows) delete tableRow.cells[op.colId];
      break;
    }
  }

  const merged = { ...node, data: table };
  const invalid = checkFields("node", merged);
  if (invalid) return { result: rejected(op.key, invalid) };
  const next = state.stamp(row, { ...bumpContent(row, ["data"]), data: merged });
  return { result: { status: "applied", key: op.key, version: next.version, revision: state.revision }, changes: [next] };
}

function applyOne(state: BatchState, op: PlanningCanvasOp): Promise<OpOutcome> {
  switch (op.op) {
    case "add":
      return applyAdd(state, op);
    case "update":
      return applyUpdate(state, op);
    case "delete":
      return applyDelete(state, op);
    case "restore":
      return applyRestore(state, op);
    default:
      return applyTableOp(state, op);
  }
}

/** Keys an op reads up front: its own key and any connector endpoints it names. */
function referencedKeys(op: PlanningCanvasOp): string[] {
  if (op.op === "add") {
    const item = op.item;
    return item.itemType === "connector" ? [item.key, item.fromKey, item.toKey] : [item.key];
  }
  if (op.op === "update") {
    const set = op.set as Partial<PlanningCanvasConnectorFields>;
    return [op.key, set.fromKey, set.toKey].filter((key): key is string => typeof key === "string");
  }
  return [op.key];
}

async function purgeTombstones(tx: Tx, board: BoardRow, now: Date) {
  const cutoff = new Date(now.getTime() - TOMBSTONE_RETENTION_MS);
  const expired = tx
    .select({ id: planningCanvasItems.id })
    .from(planningCanvasItems)
    .where(
      and(
        eq(planningCanvasItems.boardId, board.id),
        isNotNull(planningCanvasItems.deletedAt),
        lt(planningCanvasItems.deletedAt, cutoff),
      ),
    )
    .orderBy(planningCanvasItems.deletedAt)
    .limit(PLANNING_CANVAS_LIMITS.tombstonePurgePerBatchMax);
  const purged = await tx
    .delete(planningCanvasItems)
    .where(inArray(planningCanvasItems.id, expired))
    .returning({ revision: planningCanvasItems.revision });
  return purged.reduce((max, row) => Math.max(max, Number(row.revision)), board.purgedThroughRevision);
}

/** Writes every changed row (new and existing). */
async function writeChanges(tx: Tx, state: BatchState) {
  await upsertPlanningCanvasItemRows(tx, [...state.dirty].map((key) => state.items.get(key)!));
}

export function planningCanvasOpsService(db: Db) {
  return {
    /**
     * Applies one batch. Returns the per-op results; a replayed
     * `clientBatchId` (same board and actor, within 24 h) returns the stored
     * results and applies nothing.
     */
    async applyOps(input: ApplyPlanningCanvasOpsInput): Promise<PlanningCanvasOpBatchResponse> {
      const parsed = planningCanvasOpBatchSchema.safeParse(input.batch);
      if (!parsed.success) throw badRequest("Invalid planning canvas op batch", parsed.error.issues);
      const batch = parsed.data;
      const now = input.now ?? new Date();
      const actorKey = planningCanvasActorKey(input.actor);

      const outcome = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(planningCanvases)
          .where(and(eq(planningCanvases.id, input.boardId), eq(planningCanvases.companyId, input.companyId)))
          .for("update");
        if (!locked) throw notFound("Planning canvas board not found");
        if (locked.archivedAt) throw conflict("Planning canvas board is archived");
        let board = locked;

        await tx
          .delete(planningCanvasOpBatches)
          .where(
            and(
              eq(planningCanvasOpBatches.boardId, board.id),
              lt(planningCanvasOpBatches.createdAt, new Date(now.getTime() - OP_BATCH_RETENTION_MS)),
            ),
          );
        if (batch.clientBatchId) {
          const [stored] = await tx
            .select({ results: planningCanvasOpBatches.results })
            .from(planningCanvasOpBatches)
            .where(
              and(
                eq(planningCanvasOpBatches.boardId, board.id),
                eq(planningCanvasOpBatches.actorKey, actorKey),
                eq(planningCanvasOpBatches.clientBatchId, batch.clientBatchId),
              ),
            );
          if (stored) {
            return { replayed: true as const, revision: board.revision, results: stored.results, event: null, catchUpEvent: null };
          }
        }

        // J.2 catch-up: a blob written by old code since the last sync is applied first.
        const caughtUp = await catchUpLegacyBlobInTx(tx, board, now);
        let catchUpEvent: PlanningCanvasOpsAppliedEvent | null = null;
        if (caughtUp) {
          board = caughtUp.board;
          if (caughtUp.changed.length > 0 && board.userId) {
            catchUpEvent = {
              type: "ops.applied",
              companyId: board.companyId,
              boardId: board.id,
              revision: board.revision,
              actor: { type: "user", id: board.userId },
              items: caughtUp.changed.map(serializePlanningCanvasItem),
              purgedThroughRevision: board.purgedThroughRevision,
            };
          }
        }

        const purgedThroughRevision = await purgeTombstones(tx, board, now);
        const state = new BatchState(tx, board, board.revision + 1, input.actor, now);
        await state.loadCounts();
        await state.ensureLoaded(batch.ops.flatMap((op) => referencedKeys(op as PlanningCanvasOp)));

        let results: PlanningCanvasOpResult[] = [];
        for (const op of batch.ops as PlanningCanvasOp[]) {
          const { result, changes } = await applyOne(state, op);
          if (result.status === "applied" && changes) {
            const capReason = state.commit(changes);
            results.push(capReason ? rejected(result.key, capReason) : result);
          } else {
            results.push(result);
          }
        }

        const failed = results.some((result) => result.status !== "applied");
        if (batch.atomic && failed) {
          results = results.map((result) =>
            result.status === "applied" ? rejected(result.key, "atomic_aborted") : result,
          );
          state.dirty.clear();
        }
        const applied = state.dirty.size > 0;
        if (applied) await writeChanges(tx, state);

        const revision = applied ? state.revision : board.revision;
        if (applied || purgedThroughRevision !== board.purgedThroughRevision) {
          await tx
            .update(planningCanvases)
            .set(applied ? { revision, purgedThroughRevision, updatedAt: now } : { purgedThroughRevision })
            .where(eq(planningCanvases.id, board.id));
        }
        if (batch.clientBatchId) {
          await tx
            .insert(planningCanvasOpBatches)
            .values({ boardId: board.id, actorKey, clientBatchId: batch.clientBatchId, results, createdAt: now })
            .onConflictDoNothing();
        }
        const event = applied
          ? {
              type: "ops.applied" as const,
              companyId: board.companyId,
              boardId: board.id,
              revision,
              actor: input.actor,
              items: [...state.dirty].map((key) => serializePlanningCanvasItem(state.items.get(key)!)),
              purgedThroughRevision,
            }
          : null;
        return { replayed: false as const, revision, results, event, catchUpEvent };
      });

      // After commit only: a rolled-back transaction throws above and emits nothing.
      if (outcome.catchUpEvent) publishPlanningCanvasEvent(outcome.catchUpEvent);
      if (outcome.event) publishPlanningCanvasEvent(outcome.event);
      return { revision: outcome.revision, results: outcome.results, replayed: outcome.replayed };
    },
  };
}
