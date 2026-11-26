import { cardTitle } from "@/components/planning-canvas/nodes/typed-meta";
import { useMemo, useState } from "react";
import { ListTree, Search, X } from "lucide-react";
import { focusNodeElement } from "@/components/planning-canvas/keyboard/useCanvasKeyboard";
import { buildOutline, nodeAriaLabel } from "@/components/planning-canvas/panels/outline/outline-order";
import { type CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Rows drawn before "Show all": a 5,000-node board must not mount 5,000 buttons. */
const PAGE = 300;

/**
 * Outline (C19): every node in frame and reading order. It is the screen-reader list view and the
 * way to reach nodes on a phone; activating a row selects the node, centres it and moves focus to it.
 */
export function OutlinePanel({ c }: { c: CanvasController }) {
  const { outlineOpen, setOutlineOpen, nodes, selectedNodeIds, focusNodeOnBoard } = c;
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);
  const entries = useMemo(() => (outlineOpen ? buildOutline(nodes) : []), [outlineOpen, nodes]);
  if (!outlineOpen) return null;
  const q = filter.trim().toLowerCase();
  const matches = q ? entries.filter((e) => `${e.node.title} ${e.node.content}`.toLowerCase().includes(q)) : entries;
  const shown = showAll ? matches : matches.slice(0, PAGE);
  return (
    <aside
      aria-label="Outline"
      data-testid="planning-canvas-outline"
      className="pointer-events-auto z-30 flex w-72 shrink-0 flex-col border-l border-border bg-background/95 shadow-xl backdrop-blur-xs max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:h-1/2 max-md:w-full max-md:border-l-0 max-md:border-t"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <ListTree className="size-3.5" />
          Outline
          <span className="font-normal text-muted-foreground">({nodes.length})</span>
        </div>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Close Outline" onClick={() => setOutlineOpen(false)}>
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            aria-label="Filter nodes"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter nodes…"
            className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs text-foreground outline-none focus-visible:border-ring"
          />
        </div>
      </div>
      {matches.length === 0 ? (
        <p className="p-4 text-center text-xs text-muted-foreground">{nodes.length === 0 ? "The board is empty." : "No node matches."}</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-1">
          {shown.map(({ node, depth }) => {
            const selected = selectedNodeIds.includes(node.id);
            return (
              <li key={node.id}>
                <button
                  type="button"
                  aria-label={nodeAriaLabel(node)}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => {
                    focusNodeOnBoard(node);
                    focusNodeElement(node.id);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                    depth === 1 && "pl-6",
                    selected && "bg-accent",
                  )}
                >
                  <span className="truncate font-medium text-foreground">{cardTitle(node.title) || node.content || "(Untitled)"}</span>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs capitalize text-muted-foreground">{node.kind}</span>
                </button>
              </li>
            );
          })}
          {matches.length > shown.length ? (
            <li className="p-2">
              <Button type="button" size="xs" variant="outline" className="w-full" onClick={() => setShowAll(true)}>
                Show all {matches.length}
              </Button>
            </li>
          ) : null}
        </ul>
      )}
    </aside>
  );
}
