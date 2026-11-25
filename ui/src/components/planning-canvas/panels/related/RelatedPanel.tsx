import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link2, X } from "lucide-react";
import { CANVAS_CARDS_LIMITS, CANVAS_CARDS_RELATED_ACTION, canvasCardsRelatedResultSchema } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { pluginsApi } from "@/api/plugins";
import { usePluginSlots } from "@/plugins/slots";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { PLACE_RELATED_MAX, placeRelated, type RelatedRecord } from "@/components/planning-canvas/state/placeRelated";
import { canEditBoard, placementNodes, relatedSourceOf, type RelatedSource } from "@/components/planning-canvas/panels/related/related-source";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface RelatedCard {
  id: string;
  title: string;
  subtitle?: string;
}
interface RelatedGroup {
  id: string;
  label: string;
  cards: RelatedCard[];
  more: boolean;
  /** The record each card becomes when added. */
  record: (card: RelatedCard) => RelatedRecord;
}
interface RelatedResult {
  groups: RelatedGroup[];
  /** One line per plugin that failed or refused. */
  notes: string[];
}

/** "Related" on a selected entity card or issue card (menu item or toolbar button). Hidden without edit access. */
export function RelatedButton({ c, nodeId, variant = "toolbar", onPick }: { c: CanvasController; nodeId: string; variant?: "toolbar" | "menu"; onPick?: () => void }) {
  const source = relatedSourceOf(c.nodeById.get(nodeId), c.opStore);
  if (!source || !canEditBoard(c.activeBoard)) return null;
  const open = () => {
    onPick?.();
    c.setRelatedFor(nodeId);
  };
  if (variant === "menu") {
    return (
      <button
        type="button"
        role="menuitem"
        onClick={open}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-foreground outline-none hover:bg-accent focus-visible:bg-accent"
      >
        <Link2 className="size-4" /> Related…
      </button>
    );
  }
  return (
    <Button type="button" size="xs" variant="outline" onClick={open}>
      <Link2 className="size-3" />
      Related…
    </Button>
  );
}

/** Ask every plugin that offers `entityCard.related`, in parallel; a failing or refusing one becomes a note. */
function useRelated(c: CanvasController, source: RelatedSource | null): { data: RelatedResult | undefined; loading: boolean } {
  const companyId = c.selectedCompanyId;
  const { slots } = usePluginSlots({ slotTypes: ["canvasNode"], companyId });
  const askable = useMemo(() => {
    const byPlugin = new Map<string, (typeof slots)[number]>();
    for (const slot of slots) if (slot.entityCard?.related && !byPlugin.has(slot.pluginKey)) byPlugin.set(slot.pluginKey, slot);
    return [...byPlugin.values()];
  }, [slots]);
  const sourceId = source ? (source.kind === "embed" ? `${source.plugin}:${source.type}:${source.assetId}` : source.issueId) : "";
  const query = useQuery({
    queryKey: ["planning-canvas", "related", companyId, source?.kind, sourceId, askable.map((s) => s.pluginKey).join(",")],
    enabled: !!companyId && !!source,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async (): Promise<RelatedResult> => {
      if (!source) return { groups: [], notes: [] };
      if (source.kind === "issue") {
        const subtasks = await issuesApi.list(companyId!, { parentIds: [source.issueId], limit: CANVAS_CARDS_LIMITS.relatedLimitMax });
        const group: RelatedGroup = {
          id: "core:subtask",
          label: "Subtasks",
          more: subtasks.length >= CANVAS_CARDS_LIMITS.relatedLimitMax,
          cards: subtasks.map((i) => ({ id: i.id, title: i.title, subtitle: i.identifier ?? undefined })),
          record: (card) => ({ relation: "subtask", refKind: "issue", refId: card.id }),
        };
        return { groups: subtasks.length > 0 ? [group] : [], notes: [] };
      }
      const settled = await Promise.allSettled(
        askable.map(async (slot) => {
          const res = await pluginsApi.bridgePerformAction(
            slot.pluginId,
            CANVAS_CARDS_RELATED_ACTION,
            { of: { plugin: source.plugin, type: source.type, id: source.assetId } },
            companyId,
          );
          return { slot, result: canvasCardsRelatedResultSchema.parse(res.data) };
        }),
      );
      const groups: RelatedGroup[] = [];
      const notes: string[] = [];
      settled.forEach((outcome, index) => {
        if (outcome.status === "rejected") {
          notes.push(`${askable[index]!.pluginDisplayName} could not be asked.`);
          return;
        }
        const { slot, result } = outcome.value;
        for (const group of result.groups) {
          if (group.cards.length === 0) continue;
          groups.push({
            id: `${slot.pluginKey}:${group.relation}:${group.type}`,
            label: `${group.label} · ${slot.pluginDisplayName}`,
            more: group.more,
            cards: group.cards.map((card) => ({ id: card.id, title: card.title, subtitle: card.subtitle })),
            record: (card) => ({ relation: group.relation, plugin: slot.pluginKey, type: group.type, assetId: card.id }),
          });
        }
      });
      return { groups, notes };
    },
  });
  return { data: query.data, loading: query.isLoading };
}

/** One panel per source card: ticks and the "Added" line never carry over to the next card. */
export function RelatedPanel({ c }: { c: CanvasController }) {
  return c.relatedFor ? <RelatedPanelBody key={c.relatedFor} c={c} /> : null;
}

/**
 * Related panel (PAR-14389 C.3): tick groups or single records of the selected card and add them as
 * a column beside it, each joined by a labelled connector. Nodes written hold plugin, type and assetId only.
 */
function RelatedPanelBody({ c }: { c: CanvasController }) {
  const { relatedFor, setRelatedFor, nodeById, opStore, nodes, connectors } = c;
  const node = relatedFor ? nodeById.get(relatedFor) : null;
  const source = relatedSourceOf(node, opStore);
  const { data, loading } = useRelated(c, canEditBoard(c.activeBoard) ? source : null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);

  if (!relatedFor || !source || !canEditBoard(c.activeBoard)) return null;

  const idOf = (group: RelatedGroup, card: RelatedCard) => `${group.id}|${card.id}`;
  const groups = data?.groups ?? [];
  const toggle = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const pickedRecords = groups.flatMap((g) => g.cards.filter((card) => picked.has(idOf(g, card))).map((card) => g.record(card)));

  const add = () => {
    const placement = placementNodes(nodes, opStore);
    const sourceNode = placement.find((n) => n.key === source.key);
    if (!sourceNode || pickedRecords.length === 0) return;
    const result = placeRelated({
      source: sourceNode,
      nodes: placement,
      connectors: connectors.map((k) => ({ fromKey: k.fromNodeId, toKey: k.toNodeId })),
      records: pickedRecords,
      max: PLACE_RELATED_MAX,
    });
    opStore.addItems(result.items);
    setPicked(new Set());
    const parts = [`Added ${result.addedNodes}`];
    if (result.connectedExisting > 0) parts.push(`joined ${result.connectedExisting} already on the board`);
    if (result.skipped.length > 0) parts.push(`${result.skipped.length} left out (${PLACE_RELATED_MAX} per add)`);
    setStatus(`${parts.join(", ")}.`);
  };

  return (
    <aside
      aria-label="Related records"
      data-testid="canvas-related-panel"
      className={cn(
        "pointer-events-auto z-30 flex flex-col border-border bg-background shadow-xl",
        "absolute inset-x-0 bottom-0 max-h-1/2 border-t md:static md:max-h-none md:w-72 md:shrink-0 md:border-l md:border-t-0",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="text-xs font-semibold text-foreground">Related</div>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Close related" onClick={() => setRelatedFor(null)}>
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {data?.notes.map((note) => (
          <p key={note} role="status" className="mb-1.5 break-words text-xs text-muted-foreground">
            {note}
          </p>
        ))}
        {loading ? <p className="p-3 text-center text-xs text-muted-foreground">Looking…</p> : null}
        {!loading && groups.length === 0 ? <p className="p-3 text-center text-xs text-muted-foreground">Nothing related found.</p> : null}
        <div className="flex flex-col gap-2">
          {groups.map((group) => {
            const ids = group.cards.map((card) => idOf(group, card));
            const all = ids.every((id) => picked.has(id));
            return (
              <fieldset key={group.id} className="min-w-0 rounded-lg border border-border p-2">
                <legend className="sr-only">{group.label}</legend>
                <label className="flex min-w-0 items-center gap-2 text-xs font-semibold text-foreground">
                  <input type="checkbox" checked={all} onChange={(e) => toggle(ids, e.target.checked)} aria-label={`All ${group.label}`} />
                  <span className="min-w-0 truncate">{group.label}</span>
                  <span className="shrink-0 text-muted-foreground">{group.cards.length}</span>
                </label>
                <div className="mt-1.5 flex flex-col gap-1">
                  {group.cards.map((card) => (
                    <label key={card.id} className="flex min-w-0 items-start gap-2 text-xs text-foreground">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={picked.has(idOf(group, card))}
                        onChange={(e) => toggle([idOf(group, card)], e.target.checked)}
                      />
                      <span className="min-w-0 break-words">
                        {card.subtitle ? <span className="block truncate text-muted-foreground">{card.subtitle}</span> : null}
                        <span className="line-clamp-2">{card.title}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {group.more ? <p className="mt-1.5 text-xs text-muted-foreground">More exist than shown.</p> : null}
              </fieldset>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col gap-1.5 border-t border-border p-2">
        {status ? (
          <p role="status" className="break-words text-xs text-muted-foreground">
            {status}
          </p>
        ) : null}
        {pickedRecords.length > PLACE_RELATED_MAX ? (
          <p className="text-xs text-muted-foreground">Only the first {PLACE_RELATED_MAX} are added at a time.</p>
        ) : null}
        <Button type="button" size="sm" disabled={pickedRecords.length === 0} onClick={add}>
          Add {Math.min(pickedRecords.length, PLACE_RELATED_MAX)} to board
        </Button>
      </div>
    </aside>
  );
}
