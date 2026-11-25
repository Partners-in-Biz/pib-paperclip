import {
  PLANNING_CANVAS_GEOMETRY_FIELDS,
  type PlanningCanvasItem,
  type PlanningCanvasItemType,
  type PlanningCanvasItemsRead,
  type PlanningCanvasOp,
  type PlanningCanvasOpBatch,
  type PlanningCanvasOpBatchResponse,
  type PlanningCanvasOpResult,
  type PlanningCanvasTableData,
} from "@paperclipai/shared";
import type { OpStoreTransport } from "@/components/planning-canvas/store/canvas-op-store";

/**
 * Test double for `POST .../ops` and `GET ...?since=` with the C2 rules
 * (server/src/services/planning-canvas-ops.ts): geometry is last writer wins,
 * content conflicts per field after `baseVersion`, cell ops per cell, replays
 * by (actor, clientBatchId), tombstones, revision +1 per batch that applied.
 */
const GEOMETRY = new Set<string>(PLANNING_CANVAS_GEOMETRY_FIELDS);

export class FakeCanvasServer {
  revision = 1;
  items = new Map<string, PlanningCanvasItem>();
  private batches = new Map<string, PlanningCanvasOpResult[]>();
  calls: Array<{ actor: string; batch: PlanningCanvasOpBatch }> = [];

  seed(key: string, itemType: PlanningCanvasItemType, data: Record<string, unknown>) {
    this.items.set(key, this.row(key, itemType, data, 1, {}, 1));
    return this;
  }

  private row(key: string, itemType: PlanningCanvasItemType, data: Record<string, unknown>, version: number, fieldVersions: Record<string, number>, revision: number): PlanningCanvasItem {
    return {
      key,
      itemType,
      kind: itemType === "node" ? (data.kind as never) : null,
      data: structuredClone(data) as never,
      zIndex: (data.zIndex as number | undefined) ?? null,
      version,
      fieldVersions,
      revision,
      deletedAt: null,
      deletedWithKey: null,
      updatedByUserId: null,
      updatedByAgentId: null,
      createdAt: "2026-11-23T00:00:00.000Z",
      updatedAt: "2026-11-23T00:00:00.000Z",
    };
  }

  fields(key: string) {
    return this.items.get(key)?.data as unknown as Record<string, unknown> | undefined;
  }

  read(): { revision: number; items: PlanningCanvasItem[] } {
    return { revision: this.revision, items: [...this.items.values()].filter((item) => !item.deletedAt).map((item) => structuredClone(item)) };
  }

  readSince(since: number): PlanningCanvasItemsRead {
    return {
      revision: this.revision,
      purgedThroughRevision: 0,
      items: [...this.items.values()].filter((item) => item.revision > since).map((item) => structuredClone(item)),
    };
  }

  apply(actor: string, batch: PlanningCanvasOpBatch): PlanningCanvasOpBatchResponse {
    this.calls.push({ actor, batch: structuredClone(batch) });
    const id = batch.clientBatchId ? `${actor}:${batch.clientBatchId}` : null;
    if (id && this.batches.has(id)) return { revision: this.revision, results: this.batches.get(id)!, replayed: true };
    const rev = this.revision + 1;
    let applied = false;
    const results = batch.ops.map((op) => {
      const result = this.applyOne(op, rev);
      if (result.status === "applied") applied = true;
      return result;
    });
    if (applied) this.revision = rev;
    if (id) this.batches.set(id, results);
    return { revision: this.revision, results, replayed: false };
  }

  private applyOne(op: PlanningCanvasOp, rev: number): PlanningCanvasOpResult {
    if (op.op === "add") {
      const { itemType, key, ...data } = op.item as unknown as { itemType: PlanningCanvasItemType; key: string } & Record<string, unknown>;
      if (this.items.has(key)) return { status: "rejected", key, reason: "already_exists" };
      if (itemType === "connector") {
        const { fromKey, toKey } = data as { fromKey: string; toKey: string };
        if (!this.live(fromKey) || !this.live(toKey)) return { status: "rejected", key, reason: "missing_endpoint" };
      }
      this.items.set(key, this.row(key, itemType, data, 1, {}, rev));
      return { status: "applied", key, version: 1, revision: rev };
    }
    const row = this.items.get(op.key);
    const conflict = (fields: string[]): PlanningCanvasOpResult => ({ status: "conflict", key: op.key, current: structuredClone(row!), conflictingFields: fields });
    switch (op.op) {
      case "update": {
        if (!row) return { status: "rejected", key: op.key, reason: "not_found" };
        if (row.deletedAt) return { status: "rejected", key: op.key, reason: "deleted" };
        const content = Object.keys(op.set).filter((field) => !GEOMETRY.has(field));
        if (content.length > 0) {
          if (op.baseVersion === undefined) return { status: "rejected", key: op.key, reason: "base_version_required" };
          const changed = content.filter((field) => (row.fieldVersions[field] ?? 0) > op.baseVersion!).sort();
          if (changed.length > 0) return conflict(changed);
          row.version += 1;
          for (const field of content) row.fieldVersions[field] = row.version;
        }
        row.data = { ...(row.data as object), ...op.set } as never;
        row.revision = rev;
        return { status: "applied", key: op.key, version: row.version, revision: rev };
      }
      case "delete": {
        if (!row) return { status: "rejected", key: op.key, reason: "not_found" };
        if (row.deletedAt) return { status: "rejected", key: op.key, reason: "deleted" };
        row.deletedAt = "2026-11-23T00:00:01.000Z";
        row.revision = rev;
        if (row.itemType === "node") {
          for (const other of this.items.values()) {
            const { fromKey, toKey } = other.data as { fromKey?: string; toKey?: string };
            if (other.itemType === "connector" && !other.deletedAt && (fromKey === op.key || toKey === op.key)) {
              other.deletedAt = row.deletedAt;
              other.deletedWithKey = op.key;
              other.revision = rev;
            }
          }
        }
        return { status: "applied", key: op.key, version: row.version, revision: rev };
      }
      case "restore": {
        if (!row) return { status: "rejected", key: op.key, reason: "not_found" };
        if (!row.deletedAt) return { status: "rejected", key: op.key, reason: "not_deleted" };
        row.deletedAt = null;
        row.deletedWithKey = null;
        row.revision = rev;
        for (const other of this.items.values()) {
          if (other.deletedWithKey === op.key) {
            other.deletedAt = null;
            other.deletedWithKey = null;
            other.revision = rev;
          }
        }
        return { status: "applied", key: op.key, version: row.version, revision: rev };
      }
      default: {
        if (!row) return { status: "rejected", key: op.key, reason: "not_found" };
        if (row.deletedAt) return { status: "rejected", key: op.key, reason: "deleted" };
        const node = row.data as unknown as { data: PlanningCanvasTableData };
        const table = structuredClone(node.data);
        if (!applyTableOp(table, op)) return conflict(["data"]);
        row.version += 1;
        row.fieldVersions.data = row.version;
        row.data = { ...(row.data as object), data: table } as never;
        row.revision = rev;
        return { status: "applied", key: op.key, version: row.version, revision: rev };
      }
    }
  }

  private live(key: string) {
    const row = this.items.get(key);
    return !!row && row.itemType === "node" && !row.deletedAt;
  }

  transport(actor: string): OpStoreTransport {
    return {
      send: async (batch) => this.apply(actor, batch),
      readSince: async (since) => this.readSince(since),
    };
  }
}

/** The server's table op semantics; false when the row or column is gone (a conflict). */
export function applyTableOp(table: PlanningCanvasTableData, op: PlanningCanvasOp): boolean {
  const clamp = (index: number | undefined, length: number) => Math.max(0, Math.min(index ?? length, length));
  const rowIndex = (rowId: string) => table.rows.findIndex((row) => row.id === rowId);
  const hasColumn = (colId: string) => table.columns.some((column) => column.id === colId);
  switch (op.op) {
    case "table.setCell": {
      const index = rowIndex(op.rowId);
      if (index < 0 || !hasColumn(op.colId)) return false;
      table.rows[index]!.cells[op.colId] = op.value;
      return true;
    }
    case "table.addRow":
      table.rows.splice(clamp(op.index, table.rows.length), 0, structuredClone(op.row));
      return true;
    case "table.removeRow": {
      const index = rowIndex(op.rowId);
      if (index < 0) return false;
      table.rows.splice(index, 1);
      return true;
    }
    case "table.moveRow": {
      const index = rowIndex(op.rowId);
      if (index < 0) return false;
      const [moved] = table.rows.splice(index, 1);
      table.rows.splice(clamp(op.toIndex, table.rows.length), 0, moved!);
      return true;
    }
    case "table.addColumn":
      table.columns.splice(clamp(op.index, table.columns.length), 0, structuredClone(op.column));
      return true;
    case "table.removeColumn":
      if (!hasColumn(op.colId)) return false;
      table.columns = table.columns.filter((column) => column.id !== op.colId);
      for (const row of table.rows) delete row.cells[op.colId];
      return true;
    default:
      return false;
  }
}
