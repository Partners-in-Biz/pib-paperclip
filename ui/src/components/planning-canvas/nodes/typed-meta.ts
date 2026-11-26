import type { PlanningCanvasEmbedData, PlanningCanvasKanbanData, PlanningCanvasMarkdownData, PlanningCanvasTableData, PlanningCanvasTimelineData, PlanningCanvasWebLinkData } from "@paperclipai/shared";
import type { StoreItem } from "@/components/planning-canvas/store/canvas-op-store";
import { isKanbanData, isTimelineData } from "@/components/planning-canvas/nodes/issue-board";
import { isTableData } from "@/components/planning-canvas/store/table-ops";

/**
 * What the page's legacy node shape cannot carry for a table or markdown node: its typed `data`
 * (plan C, `table.data` and `markdown.data`). The store item is the truth; this is the read model
 * the memoized node renders from.
 */
export type TypedNodeMeta =
  | { kind: "table"; data: PlanningCanvasTableData }
  | { kind: "markdown"; data: PlanningCanvasMarkdownData }
  | { kind: "kanban"; data: PlanningCanvasKanbanData }
  | { kind: "timeline"; data: PlanningCanvasTimelineData }
  | { kind: "embed"; data: PlanningCanvasEmbedData }
  | { kind: "weblink"; data: PlanningCanvasWebLinkData };

function isEmbedData(data: unknown): data is PlanningCanvasEmbedData {
  const d = data as Partial<PlanningCanvasEmbedData> | null | undefined;
  return !!d && typeof d.plugin === "string" && typeof d.type === "string" && !!d.props && typeof d.props === "object";
}

/** Shape only: the card checks the url itself on every render (PAR-14389 C.5). */
function isWebLinkData(data: unknown): data is PlanningCanvasWebLinkData {
  return typeof (data as Partial<PlanningCanvasWebLinkData> | null | undefined)?.url === "string";
}

export function typedMetaOf(item: StoreItem | undefined | null): TypedNodeMeta | null {
  if (!item || item.itemType !== "node") return null;
  const { kind, data } = item.fields as { kind?: string; data?: unknown };
  if (kind === "table" && isTableData(data)) return { kind, data };
  if (kind === "markdown" && typeof (data as PlanningCanvasMarkdownData | undefined)?.markdown === "string") {
    return { kind, data: data as PlanningCanvasMarkdownData };
  }
  if (kind === "kanban" && isKanbanData(data)) return { kind, data };
  if (kind === "timeline" && isTimelineData(data)) return { kind, data };
  if (kind === "embed" && isEmbedData(data)) return { kind, data };
  if (kind === "weblink" && isWebLinkData(data)) return { kind, data };
  return null;
}

/** Next map after `keys` changed; untouched entries keep their identity so memoized nodes stay put. */
export function patchTypedMeta(
  prev: ReadonlyMap<string, TypedNodeMeta>,
  keys: Iterable<string>,
  getItem: (key: string) => StoreItem | undefined,
): ReadonlyMap<string, TypedNodeMeta> {
  let next: Map<string, TypedNodeMeta> | null = null;
  for (const key of keys) {
    const before = prev.get(key);
    const after = typedMetaOf(getItem(key));
    if (before?.data === after?.data && before?.kind === after?.kind) continue;
    next ??= new Map(prev);
    if (after) next.set(key, after);
    else next.delete(key);
  }
  return next ?? prev;
}
