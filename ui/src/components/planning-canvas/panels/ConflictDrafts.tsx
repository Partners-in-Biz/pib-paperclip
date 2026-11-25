import { CopyPlus, GitMerge } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

const FIELD_LABEL = { title: "title", content: "text", label: "arrow label", markdown: "markdown" } as const;

/**
 * Text conflicts (plan B.3, C5): someone else changed the same text, or deleted
 * the item, while this tab was typing. The board shows their version; this
 * tab's text is kept here until the person picks what to do with it.
 */
export function ConflictDrafts({ c }: { c: CanvasController }) {
  const { drafts, resolveDraft } = c.opStore;
  const draft = drafts[0];
  if (!draft) return null;
  // Name the item as it is now (their title when the title is what conflicted).
  const where = (draft.field === "title" && draft.theirs ? draft.theirs : String(draft.snapshot.fields.title ?? "")).trim() || "an item";
  return (
    <section
      aria-label="Edit conflict"
      data-testid="planning-canvas-conflict"
      // Fixed above the mobile nav on small screens (the canvas area can be very short there); in the canvas corner from `sm`.
      className="pointer-events-auto fixed inset-x-3 bottom-20 z-40 flex flex-col gap-2 rounded-xl border border-border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur-xs sm:absolute sm:inset-x-auto sm:bottom-3 sm:left-3 sm:w-96"
    >
      <header className="flex items-start gap-2">
        <GitMerge className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {draft.reason === "deleted" ? "This item was deleted while you edited it" : "Someone else changed this too"}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            Your {FIELD_LABEL[draft.field]} on “{where}” is kept below.{drafts.length > 1 ? ` 1 of ${drafts.length}.` : ""}
          </p>
        </div>
      </header>
      <p data-testid="planning-canvas-conflict-mine" className="line-clamp-4 whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs text-foreground">
        {draft.mine || "(empty)"}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={() => resolveDraft(draft.id, "theirs")}>
          {draft.reason === "deleted" ? "Discard mine" : "Keep theirs"}
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={() => resolveDraft(draft.id, "copy")}>
          <CopyPlus className="size-3" />
          Copy to new node
        </Button>
        <Button type="button" size="xs" onClick={() => resolveDraft(draft.id, "mine")}>
          {draft.reason === "deleted" ? "Restore mine" : "Keep mine"}
        </Button>
      </div>
    </section>
  );
}
