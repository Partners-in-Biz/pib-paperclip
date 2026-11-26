import { useState } from "react";
import { Library, X } from "lucide-react";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { useCanvasPluginProps } from "@/components/planning-canvas/nodes/useCanvasPluginProps";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Plugin `canvasPanel` slots, mounted in the board's side area. Nothing renders without one.
 * From md up it is a side column; below md it is a bottom sheet opened by a "Library" button, so
 * a phone can reach the same panels (e.g. Studio's Place on board).
 */
export function PluginCanvasPanels({ c }: { c: CanvasController }) {
  const { slots } = usePluginSlots({ slotTypes: ["canvasPanel"], companyId: c.selectedCompanyId });
  const board = useCanvasPluginProps(c);
  const [sheetOpen, setSheetOpen] = useState(false);
  if (slots.length === 0 || !board.boardId) return null;
  return (
    <>
      {sheetOpen ? null : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Open plugin panels"
          data-testid="canvas-plugin-panels-open"
          className="pointer-events-auto absolute right-3 bottom-28 z-30 bg-background shadow-md md:hidden"
          onClick={() => setSheetOpen(true)}
        >
          <Library className="size-3.5" />
          Library
        </Button>
      )}
      <aside
        aria-label="Plugin panels"
        data-testid="canvas-plugin-panels"
        className={cn(
          "pointer-events-auto z-30 flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-background/95",
          sheetOpen
            ? "max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:z-40 max-md:h-1/2 max-md:w-full max-md:border-l-0 max-md:border-t max-md:shadow-xl"
            : "max-md:hidden",
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2 md:hidden">
          <div className="text-xs font-semibold text-foreground">Library</div>
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Close plugin panels" onClick={() => setSheetOpen(false)}>
            <X className="size-3.5" />
          </Button>
        </div>
        {slots.map((slot) => (
          <PluginSlotMount
            key={`${slot.pluginKey}:${slot.id}`}
            slot={slot}
            context={{ companyId: c.selectedCompanyId, projectId: board.boardProjectId, entityId: board.boardId }}
            componentProps={{ ...board }}
          />
        ))}
      </aside>
    </>
  );
}
