import { type CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { KEY_BINDINGS, KEY_GROUPS } from "@/components/planning-canvas/keyboard/canvas-keymap";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const cap = (k: string) => (k === "Mod" ? (isMac ? "⌘" : "Ctrl") : k);

/** `?` opens it (C19). Rendered from KEY_BINDINGS, the same list the no-clash test checks. */
export function CheatSheet({ c }: { c: CanvasController }) {
  return (
    <Dialog open={c.cheatSheetOpen} onOpenChange={c.setCheatSheetOpen}>
      <DialogContent className="max-h-3/4 overflow-y-auto sm:max-w-2xl" data-testid="planning-canvas-cheat-sheet">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Press ? any time on the board to open this list.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          {KEY_GROUPS.map((group) => (
            <section key={group} aria-label={group}>
              <h3 className="mb-1.5 text-xs font-semibold uppercase text-muted-foreground">{group}</h3>
              <dl className="space-y-1">
                {KEY_BINDINGS.filter((b) => b.group === group).map((b) => (
                  <div key={b.id} className="flex items-center justify-between gap-3 text-sm">
                    <dt className="min-w-0 truncate text-foreground">{b.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {b.keys.map((k) => (
                        <kbd key={k} className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                          {cap(k)}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
