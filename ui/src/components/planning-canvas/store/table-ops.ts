import type { PlanningCanvasOp, PlanningCanvasTableData, PlanningCanvasTableRow } from "@paperclipai/shared";

/**
 * Table edits as cell ops (plan B.3): rows and columns have stable ids and a
 * cell is last writer wins, so people and agents editing one table at once do
 * not conflict. There is no op for renaming, retyping or reordering columns;
 * such a change returns `null` and the caller sends the whole `data` as a
 * content update (with `baseVersion`, so it can conflict).
 */
export type PlanningCanvasTableOp = Extract<PlanningCanvasOp, { op: `table.${string}` }>;

function same(a: unknown, b: unknown) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function isTableData(value: unknown): value is PlanningCanvasTableData {
  const table = value as PlanningCanvasTableData | null | undefined;
  return !!table && Array.isArray(table.columns) && Array.isArray(table.rows);
}

/** The ops that turn `prev` into `next`, applied in order with the server's semantics; null when ops cannot say it. */
export function diffTableOps(key: string, prev: PlanningCanvasTableData, next: PlanningCanvasTableData): PlanningCanvasTableOp[] | null {
  const ops: PlanningCanvasTableOp[] = [];
  const nextColIds = new Set(next.columns.map((column) => column.id));
  const prevColIds = new Set(prev.columns.map((column) => column.id));
  const keptPrev = prev.columns.filter((column) => nextColIds.has(column.id));
  const keptNext = next.columns.filter((column) => prevColIds.has(column.id));
  if (keptPrev.length !== keptNext.length || keptPrev.some((column, index) => !same(column, keptNext[index]))) return null;

  for (const column of prev.columns) {
    if (!nextColIds.has(column.id)) ops.push({ op: "table.removeColumn", key, colId: column.id });
  }
  next.columns.forEach((column, index) => {
    if (!prevColIds.has(column.id)) ops.push({ op: "table.addColumn", key, column, index });
  });

  const nextRowIds = new Set(next.rows.map((row) => row.id));
  const prevRows = new Map(prev.rows.map((row) => [row.id, row]));
  for (const row of prev.rows) {
    if (!nextRowIds.has(row.id)) ops.push({ op: "table.removeRow", key, rowId: row.id });
  }
  // Simulate the server: splice out removed rows, insert new ones, then move rows into place.
  const order = prev.rows.filter((row) => nextRowIds.has(row.id)).map((row) => row.id);
  next.rows.forEach((row: PlanningCanvasTableRow, index) => {
    if (prevRows.has(row.id)) return;
    ops.push({ op: "table.addRow", key, row, index });
    order.splice(Math.min(index, order.length), 0, row.id);
  });
  next.rows.forEach((row, index) => {
    const at = order.indexOf(row.id);
    if (at === index) return;
    order.splice(at, 1);
    order.splice(index, 0, row.id);
    ops.push({ op: "table.moveRow", key, rowId: row.id, toIndex: index });
  });

  for (const row of next.rows) {
    const before = prevRows.get(row.id);
    if (!before) continue;
    for (const column of next.columns) {
      const value = row.cells[column.id] ?? null;
      const old = prevColIds.has(column.id) ? (before.cells[column.id] ?? null) : null;
      if (!same(value, old)) ops.push({ op: "table.setCell", key, rowId: row.id, colId: column.id, value });
    }
  }
  return ops;
}
