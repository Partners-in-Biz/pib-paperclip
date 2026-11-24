import { ArrowRight, Frame, Hand, Link2, MousePointer2, FileText, Table2, NotebookPen, Pen, Shapes, StickyNote, Type } from "lucide-react";
import { type CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { cn } from "@/lib/utils";

export function ToolRail({ c }: { c: CanvasController }) {
  const {
    tool,
    setTool,
    setConnectFromId,
    notesDrawerOpen,
    setNotesDrawerOpen,
    insertPanelOpen,
    setInsertPanelOpen,
    insertTypedNode,
  } = c;
  return (
    <div className="pointer-events-auto absolute left-3 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-1 rounded-xl border border-border bg-popover/95 p-1.5 shadow-lg backdrop-blur-xs">
      {(
        [
          { id: "select", icon: MousePointer2, label: "Select (V)" },
          { id: "hand", icon: Hand, label: "Pan (H / Space)" },
          { id: "sticky", icon: StickyNote, label: "Sticky Note (N)" },
          { id: "frame", icon: Frame, label: "Frame / Section (F)" },
          { id: "shape", icon: Shapes, label: "Shape (S)" },
          { id: "text", icon: Type, label: "Text (T)" },
          { id: "connect", icon: ArrowRight, label: "Connector Arrow (L)" },
          { id: "pen", icon: Pen, label: "Freehand Pen (D)" },
        ] as const
      ).map((item) => {
        const Icon = item.icon;
        const active = tool === item.id;
        return (
          <button
            key={item.id}
            type="button"
            title={item.label}
            aria-label={item.label}
            aria-pressed={active}
            onClick={() => {
              setTool(item.id);
              setConnectFromId(null);
            }}
            className={cn(
              "flex size-9 items-center justify-center rounded-lg transition-colors",
              active
                ? "bg-foreground text-background shadow-xs"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
          </button>
        );
      })}
      <div className="my-0.5 h-px bg-border" />
      {(
        [
          { kind: "table", icon: Table2, label: "Add table" },
          { kind: "markdown", icon: FileText, label: "Add markdown / Mermaid" },
        ] as const
      ).map(({ kind, icon: Icon, label }) => (
        <button
          key={kind}
          type="button"
          title={label}
          aria-label={label}
          onClick={() => insertTypedNode(kind)}
          className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Icon className="size-4" />
        </button>
      ))}
      <button
        type="button"
        title="Add live issue, agent, project or goal card"
        aria-label="Add live card"
        aria-pressed={insertPanelOpen}
        onClick={() => {
          setInsertPanelOpen((o) => !o);
          setNotesDrawerOpen(false);
        }}
        className={cn(
          "flex size-9 items-center justify-center rounded-lg transition-colors",
          insertPanelOpen
            ? "bg-foreground text-background shadow-xs"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Link2 className="size-4" />
      </button>
      <button
        type="button"
        title="Drop Personal Notes onto board (P)"
        aria-label="Personal Notes drawer"
        aria-pressed={notesDrawerOpen}
        onClick={() => {
          setNotesDrawerOpen((o) => !o);
          setInsertPanelOpen(false);
        }}
        className={cn(
          "flex size-9 items-center justify-center rounded-lg transition-colors",
          notesDrawerOpen
            ? "bg-blue-500 text-white shadow-xs"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <NotebookPen className="size-4" />
      </button>
    </div>
  );
}
