import { Check, CloudOff, FileDown, Grid2x2, LayoutTemplate, Loader2, NotebookPen, Plus, Redo2, Search, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import { PresenceAvatars } from "@/components/planning-canvas/realtime/PresenceAvatars";
import { type CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { Button } from "@/components/ui/button";
import { CANVAS_BOARD_TEMPLATES } from "@/lib/planning-canvas-helpers";

/** Save state (plan F): Saved, Saving…, Offline, retrying, or Not saved after a refusal. */
function SaveStatus({ state, titlePending }: { state: CanvasController["opStore"]["saveState"]; titlePending: boolean }) {
  const shown = state === "saved" && titlePending ? "saving" : state;
  return (
    <span role="status" aria-live="polite" data-testid="planning-canvas-save-state" data-state={shown} className="ml-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
      {shown === "saving" ? (
        <>
          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
          Saving…
        </>
      ) : shown === "offline" ? (
        <>
          <CloudOff className="size-3 text-amber-500" />
          Offline, retrying
        </>
      ) : shown === "failed" ? (
        <>
          <TriangleAlert className="size-3 text-destructive" />
          Not saved
        </>
      ) : (
        <>
          <Check className="size-3 text-emerald-500" />
          Saved
        </>
      )}
    </span>
  );
}

export function BoardBar({ c }: { c: CanvasController }) {
  const {
    pushToast,
    boards,
    personalNotes,
    setActiveBoardId,
    activeBoard,
    boardTitle,
    setBoardTitle,
    nodes,
    setViewport,
    dirty,
    setDirty,
    snapEnabled,
    setSnapEnabled,
    notesDrawerOpen,
    setNotesDrawerOpen,
    templatesOpen,
    setTemplatesOpen,
    setBlueprintsOpen,
    boardSearch,
    setBoardSearch,
    createBoardMutation,
    saveTitleMutation,
    opStore,
    deleteBoardMutation,
    exportBoardAsNoteMutation,
    focusNodeOnBoard,
    commitCanvasChange,
    handleUndo,
    handleRedo,
  } = c;
  return (
    <div className="z-20 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur-xs">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Select canvas board"
          value={activeBoard?.id ?? ""}
          onChange={(e) => setActiveBoardId(e.target.value)}
          className="h-7 rounded-md border border-border bg-muted/40 px-2 text-xs font-medium text-foreground outline-none focus:border-ring"
        >
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>

        <input
          type="text"
          aria-label="Board title"
          value={boardTitle}
          onChange={(e) => {
            setBoardTitle(e.target.value);
            setDirty(true);
          }}
          className="h-7 w-44 rounded-md border border-transparent bg-transparent px-2 text-sm font-semibold text-foreground outline-none hover:border-border focus:border-ring"
        />

        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() =>
            createBoardMutation.mutate({
              title: `Board ${boards.length + 1}`,
              data: { nodes: [], connectors: [], viewport: { x: 40, y: 40, zoom: 1 } },
            })
          }
        >
          <Plus className="size-3" />
          New board
        </Button>

        <Button type="button" size="xs" variant="outline" onClick={() => setBlueprintsOpen(true)}>
          <LayoutTemplate className="size-3" />
          Blueprints
        </Button>

        {boards.length > 1 && activeBoard ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            title="Delete board"
            aria-label="Delete board"
            onClick={() => deleteBoardMutation.mutate(activeBoard.id)}
          >
            <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {/* Quick Search & Jump on Board */}
        <div className="relative hidden sm:block">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            data-canvas-find
            value={boardSearch}
            onChange={(e) => setBoardSearch(e.target.value)}
            placeholder="Find on board…"
            className="h-7 w-36 rounded-md border border-border bg-background pl-7 pr-2 text-xs text-foreground outline-none focus:w-44 focus:border-ring transition-all"
          />
          {boardSearch.trim() ? (
            <div className="absolute right-0 top-8 z-40 max-h-56 w-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg">
              {nodes
                .filter((n) => {
                  const q = boardSearch.trim().toLowerCase();
                  return `${n.title} ${n.content}`.toLowerCase().includes(q);
                })
                .slice(0, 8)
                .map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    onClick={() => focusNodeOnBoard(hit)}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                  >
                    <span className="truncate font-medium text-foreground">
                      {hit.title || hit.content || "(Untitled)"}
                    </span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
                      {hit.kind}
                    </span>
                  </button>
                ))}
            </div>
          ) : null}
        </div>

        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={nodes.length === 0 || exportBoardAsNoteMutation.isPending}
          onClick={() => exportBoardAsNoteMutation.mutate()}
          title="Export this entire canvas board into a structured Personal Note"
        >
          <FileDown className="size-3.5 text-emerald-500" />
          {exportBoardAsNoteMutation.isPending ? "Exporting…" : "Save as Note"}
        </Button>

        <div className="relative">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => setTemplatesOpen((v) => !v)}
          >
            <LayoutTemplate className="size-3.5 text-violet-500" />
            Templates
          </Button>
          {templatesOpen ? (
            <div className="absolute right-0 top-9 z-40 w-64 rounded-xl border border-border bg-popover p-1.5 shadow-lg">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Insert Miro-style template
              </div>
              {CANVAS_BOARD_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => {
                    const built = tpl.build();
                    commitCanvasChange(built.nodes, built.connectors);
                    setViewport(built.viewport);
                    setTemplatesOpen(false);
                    pushToast({ title: `Applied “${tpl.label}” template`, tone: "success" });
                  }}
                  className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent"
                >
                  <span className="text-xs font-medium text-foreground">{tpl.label}</span>
                  <span className="text-[11px] text-muted-foreground">{tpl.description}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <Button
          type="button"
          size="xs"
          variant={notesDrawerOpen ? "secondary" : "outline"}
          onClick={() => setNotesDrawerOpen((v) => !v)}
        >
          <NotebookPen className="size-3.5 text-blue-500" />
          My Notes ({personalNotes.filter((n) => !n.archived).length})
        </Button>

        <div className="mx-1 h-4 w-px bg-border" />

        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={!opStore.canUndo}
          title="Undo (⌘Z)"
          aria-label="Undo"
          onClick={handleUndo}
        >
          <Undo2 className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={!opStore.canRedo}
          title="Redo (⇧⌘Z)"
          aria-label="Redo"
          onClick={handleRedo}
        >
          <Redo2 className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant={snapEnabled ? "secondary" : "ghost"}
          title={snapEnabled ? "Snap to grid: ON" : "Snap to grid: OFF"}
          aria-label="Toggle snap to grid"
          onClick={() => setSnapEnabled((s) => !s)}
        >
          <Grid2x2 className="size-3.5" />
        </Button>

        <SaveStatus state={opStore.saveState} titlePending={dirty || saveTitleMutation.isPending} />
        <PresenceAvatars c={c} />
      </div>
    </div>
  );
}
