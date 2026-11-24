import { memo } from "react";
import { Plus, Send, Table2, X } from "lucide-react";
import type { PlanningCanvasTableData } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { useLatestCanvas } from "@/components/planning-canvas/nodes/canvas-context";
import {
  addColumn,
  addRow,
  canAddColumn,
  canAddRow,
  CELL_MAX_LENGTH,
  COLUMN_NAME_MAX_LENGTH,
  removeColumn,
  removeRow,
  renameColumn,
  setCell,
} from "@/components/planning-canvas/nodes/table-edit";
import { RefCard } from "@/components/planning-canvas/nodes/RefCard";

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const INPUT = "w-full min-w-0 bg-transparent px-1.5 py-1 text-xs text-foreground outline-none focus:bg-accent/40";

/**
 * A table node. Cells, rows and columns edit through the op store; it sends a cell edit as
 * `table.setCell` and a row or column edit as the matching `table.*` op, so people and agents
 * editing one table do not conflict. Cell text is rendered as input values, never as HTML.
 */
export const TableNode = memo(function TableNode({ nodeKey, data, title }: { nodeKey: string; data: PlanningCanvasTableData; title: string }) {
  const latest = useLatestCanvas();
  const edit = (next: PlanningCanvasTableData) => {
    if (next !== data) latest.current.opStore.setNodeData(nodeKey, next);
  };
  const convert = () => {
    const c = latest.current;
    c.setSelectedNodeIds([nodeKey]);
    c.setHandoffOpen(true);
  };

  return (
    <RefCard label={title || "Table"} icon={<Table2 className="size-3.5" />}>
      <div className="min-h-0 flex-1 overflow-auto" onPointerDown={stop} onDoubleClick={stop} data-canvas-scroll="">
        <table className="w-full border-collapse text-left" aria-label={title || "Table"}>
          <thead>
            <tr>
              {data.columns.map((column) => (
                <th key={column.id} scope="col" className="group/col border border-border bg-muted/50 p-0 font-semibold">
                  <div className="flex items-center">
                    <input
                      aria-label="Column name"
                      className={INPUT}
                      value={column.name}
                      maxLength={COLUMN_NAME_MAX_LENGTH}
                      onChange={(e) => edit(renameColumn(data, column.id, e.target.value))}
                    />
                    <button type="button" aria-label={`Remove column ${column.name}`} className="px-1 text-muted-foreground hover:text-foreground" onClick={() => edit(removeColumn(data, column.id))}>
                      <X className="size-3" />
                    </button>
                  </div>
                </th>
              ))}
              <th className="w-6 border border-border bg-muted/50 p-0">
                <button type="button" aria-label="Add column" disabled={!canAddColumn(data)} className="flex w-full justify-center py-1 text-muted-foreground hover:text-foreground disabled:opacity-40" onClick={() => edit(addColumn(data))}>
                  <Plus className="size-3" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.id}>
                {data.columns.map((column) => {
                  const value = row.cells[column.id];
                  return (
                    <td key={column.id} className="border border-border p-0">
                      <input
                        aria-label={`${column.name} cell`}
                        className={INPUT}
                        inputMode={column.type === "number" ? "decimal" : undefined}
                        value={value === null || value === undefined ? "" : String(value)}
                        maxLength={CELL_MAX_LENGTH}
                        onChange={(e) => edit(setCell(data, row.id, column.id, e.target.value))}
                      />
                    </td>
                  );
                })}
                <td className="border border-border p-0 text-center">
                  <button type="button" aria-label="Remove row" className="px-1 text-muted-foreground hover:text-foreground" onClick={() => edit(removeRow(data, row.id))}>
                    <X className="size-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-1 pt-1" onPointerDown={stop}>
        <Button type="button" size="xs" variant="ghost" disabled={!canAddRow(data)} onClick={() => edit(addRow(data))}>
          <Plus className="size-3" /> Row
        </Button>
        <Button type="button" size="xs" variant="ghost" className="ml-auto" onClick={convert}>
          <Send className="size-3" /> Convert rows to issues
        </Button>
      </div>
    </RefCard>
  );
});
