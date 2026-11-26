import { useState } from "react";
import { ArrowRight, Frame, Globe, Hand, Keyboard, Link2, ListTree, MessageSquare, MousePointer2, FileText, Table2, Columns3, CalendarRange, NotebookPen, Pen, Shapes, StickyNote, Type, X } from "lucide-react";
import { type CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The tool-rail URL field: an `https://` link becomes a web link card (PAR-14389 C.5). */
function WebLinkField({ insertWebLinkNode, onClose }: { insertWebLinkNode: CanvasController["insertWebLinkNode"]; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      role="dialog"
      aria-label="Add web link"
      data-testid="planning-canvas-weblink-field"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const problem = insertWebLinkNode(url);
        setError(problem);
        if (!problem) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className={cn(
        "pointer-events-auto absolute left-16 top-1/2 z-30 flex w-80 -translate-y-1/2 flex-col gap-2 rounded-xl border border-border bg-popover p-3 shadow-lg",
        "max-md:inset-x-2 max-md:bottom-20 max-md:left-2 max-md:top-auto max-md:w-auto max-md:translate-y-0",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="planning-canvas-weblink-url" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Web link or YouTube video
        </label>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex gap-2">
        <input
          id="planning-canvas-weblink-url"
          autoFocus
          type="url"
          inputMode="url"
          placeholder="https://"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "planning-canvas-weblink-error" : undefined}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" size="sm" disabled={!url.trim()}>
          Add
        </Button>
      </div>
      {error ? (
        <p id="planning-canvas-weblink-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

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
    outlineOpen,
    setOutlineOpen,
    setCheatSheetOpen,
    insertWebLinkNode,
  } = c;
  const [webLinkOpen, setWebLinkOpen] = useState(false);
  // Under 768 px the rail is a bottom sheet (C19): a horizontal strip pinned to the bottom edge.
  // The URL field sits outside the rail: the strip scrolls sideways there and would clip it.
  return (
    <>
    {webLinkOpen ? <WebLinkField insertWebLinkNode={insertWebLinkNode} onClose={() => setWebLinkOpen(false)} /> : null}
    <div
      role="toolbar"
      aria-label="Canvas tools"
      data-testid="planning-canvas-tool-rail"
      className={cn(
        "pointer-events-auto absolute left-3 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-1 rounded-xl border border-border bg-popover/95 p-1.5 shadow-lg backdrop-blur-xs",
        "max-md:inset-x-0 max-md:bottom-0 max-md:left-0 max-md:top-auto max-md:translate-y-0 max-md:flex-row max-md:items-center max-md:overflow-x-auto max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0 max-md:pb-3",
      )}
    >
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
          { id: "comment", icon: MessageSquare, label: "Comment (C)" },
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
              "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
              active
                ? "bg-foreground text-background shadow-xs"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
          </button>
        );
      })}
      <div className="my-0.5 h-px bg-border max-md:mx-0.5 max-md:h-6 max-md:w-px max-md:shrink-0" />
      {(
        [
          { kind: "table", icon: Table2, label: "Add table" },
          { kind: "markdown", icon: FileText, label: "Add markdown / Mermaid" },
          { kind: "kanban", icon: Columns3, label: "Add kanban from issues" },
          { kind: "timeline", icon: CalendarRange, label: "Add timeline from issues" },
        ] as const
      ).map(({ kind, icon: Icon, label }) => (
        <button
          key={kind}
          type="button"
          title={label}
          aria-label={label}
          onClick={() => insertTypedNode(kind)}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Icon className="size-4" />
        </button>
      ))}
      <button
        type="button"
        title="Add web link or YouTube video"
        aria-label="Add web link"
        aria-pressed={webLinkOpen}
        onClick={() => setWebLinkOpen((o) => !o)}
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
          webLinkOpen ? "bg-foreground text-background shadow-xs" : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Globe className="size-4" />
      </button>
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
          "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
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
          "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
          notesDrawerOpen
            ? "bg-blue-500 text-white shadow-xs"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <NotebookPen className="size-4" />
      </button>
      <button
        type="button"
        title="Outline (O)"
        aria-label="Outline"
        aria-pressed={outlineOpen}
        onClick={() => setOutlineOpen((o) => !o)}
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
          outlineOpen ? "bg-foreground text-background shadow-xs" : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <ListTree className="size-4" />
      </button>
      <button
        type="button"
        title="Keyboard shortcuts (?)"
        aria-label="Keyboard shortcuts"
        onClick={() => setCheatSheetOpen(true)}
        className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-md:hidden"
      >
        <Keyboard className="size-4" />
      </button>
    </div>
    </>
  );
}
