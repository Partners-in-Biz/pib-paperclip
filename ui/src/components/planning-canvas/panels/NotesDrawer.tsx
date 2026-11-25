import { NotebookPen, Search, X } from "lucide-react";
import { type CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { Button } from "@/components/ui/button";

export function NotesDrawer({ c }: { c: CanvasController }) {
  const {
    nodes,
    notesDrawerOpen,
    setNotesDrawerOpen,
    notesSearch,
    setNotesSearch,
    dropPersonalNoteOnCanvas,
    filteredDrawerNotes,
  } = c;
  return (
    notesDrawerOpen ? (
      <div className="z-30 flex w-72 shrink-0 flex-col border-l border-border bg-background/95 shadow-xl backdrop-blur-xs">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <NotebookPen className="size-3.5 text-blue-500" />
            Personal Notes
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Close notes drawer"
            onClick={() => setNotesDrawerOpen(false)}
          >
            <X className="size-3.5" />
          </Button>
        </div>
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={notesSearch}
              onChange={(e) => setNotesSearch(e.target.value)}
              placeholder="Filter notes to add…"
              className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs outline-none focus:border-ring"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {filteredDrawerNotes.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted-foreground">
              No personal notes found.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {filteredDrawerNotes.map((note) => {
                const alreadyOnBoard = nodes.some((n) => n.noteId === note.id);
                return (
                  <button
                    key={note.id}
                    type="button"
                    onClick={() => dropPersonalNoteOnCanvas(note)}
                    className="flex flex-col gap-1 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:border-blue-500/50 hover:bg-accent/40"
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="truncate text-xs font-semibold text-foreground">
                        {note.title}
                      </span>
                      <span className="shrink-0 text-[10px] text-blue-500">
                        {alreadyOnBoard ? "+ Add copy" : "+ Place"}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-[11px] text-muted-foreground">
                      {note.body.trim() || "Empty note"}
                    </p>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    ) : null
  );
}
