import { PLANNING_CANVAS_LIMITS, type PlanningCanvasTableCellValue, type PlanningCanvasTableData } from "@paperclipai/shared";
import { createCanvasId } from "@/lib/planning-canvas-helpers";

/** Pure edits of a table node's data. Each returns `data` itself when the edit is refused (cap reached, unknown id). */

export const CELL_MAX_LENGTH = 10_000;
export const COLUMN_NAME_MAX_LENGTH = 200;

export function newTable(): PlanningCanvasTableData {
  const columns = ["Item", "Owner", "Status"].map((name) => ({ id: createCanvasId("col"), name, type: "text" as const }));
  return { columns, rows: [{ id: createCanvasId("row"), cells: {} }, { id: createCanvasId("row"), cells: {} }] };
}

export function canAddRow(data: PlanningCanvasTableData) {
  return data.rows.length < PLANNING_CANVAS_LIMITS.tableRowsMax;
}

export function canAddColumn(data: PlanningCanvasTableData) {
  return data.columns.length < PLANNING_CANVAS_LIMITS.tableColumnsMax;
}

export function addRow(data: PlanningCanvasTableData): PlanningCanvasTableData {
  if (!canAddRow(data)) return data;
  return { ...data, rows: [...data.rows, { id: createCanvasId("row"), cells: {} }] };
}

export function removeRow(data: PlanningCanvasTableData, rowId: string): PlanningCanvasTableData {
  if (!data.rows.some((row) => row.id === rowId)) return data;
  return { ...data, rows: data.rows.filter((row) => row.id !== rowId) };
}

export function addColumn(data: PlanningCanvasTableData): PlanningCanvasTableData {
  if (!canAddColumn(data)) return data;
  return { ...data, columns: [...data.columns, { id: createCanvasId("col"), name: `Column ${data.columns.length + 1}`, type: "text" }] };
}

export function removeColumn(data: PlanningCanvasTableData, colId: string): PlanningCanvasTableData {
  if (!data.columns.some((column) => column.id === colId)) return data;
  return {
    columns: data.columns.filter((column) => column.id !== colId),
    rows: data.rows.map((row) => {
      const { [colId]: _gone, ...cells } = row.cells;
      return { ...row, cells };
    }),
  };
}

export function renameColumn(data: PlanningCanvasTableData, colId: string, name: string): PlanningCanvasTableData {
  return { ...data, columns: data.columns.map((column) => (column.id === colId ? { ...column, name: name.slice(0, COLUMN_NAME_MAX_LENGTH) } : column)) };
}

/** A number column keeps a finite number (or text while it is not one); an empty cell is null. */
export function parseCell(type: string, raw: string): PlanningCanvasTableCellValue {
  const text = raw.slice(0, CELL_MAX_LENGTH);
  if (text === "") return null;
  if (type === "number") {
    const value = Number(text);
    return Number.isFinite(value) && text.trim() !== "" ? value : text;
  }
  return text;
}

export function setCell(data: PlanningCanvasTableData, rowId: string, colId: string, raw: string): PlanningCanvasTableData {
  const column = data.columns.find((c) => c.id === colId);
  if (!column) return data;
  const value = parseCell(column.type, raw);
  return { ...data, rows: data.rows.map((row) => (row.id === rowId ? { ...row, cells: { ...row.cells, [colId]: value } } : row)) };
}
