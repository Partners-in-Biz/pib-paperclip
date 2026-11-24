import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { useCanvasPluginProps } from "@/components/planning-canvas/nodes/useCanvasPluginProps";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

/** Plugin `canvasPanel` slots, mounted in the board's side area. Nothing renders without one. */
export function PluginCanvasPanels({ c }: { c: CanvasController }) {
  const { slots } = usePluginSlots({ slotTypes: ["canvasPanel"], companyId: c.selectedCompanyId });
  const board = useCanvasPluginProps(c);
  if (slots.length === 0 || !board.boardId) return null;
  return (
    <aside aria-label="Plugin panels" className="pointer-events-auto z-30 flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-background/95 max-md:hidden">
      {slots.map((slot) => (
        <PluginSlotMount
          key={`${slot.pluginKey}:${slot.id}`}
          slot={slot}
          context={{ companyId: c.selectedCompanyId, projectId: board.boardProjectId, entityId: board.boardId }}
          componentProps={{ ...board }}
        />
      ))}
    </aside>
  );
}
