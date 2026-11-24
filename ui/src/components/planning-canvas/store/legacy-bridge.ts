import {
  isKnownPlanningCanvasNodeKind,
  isLegacyPlanningCanvasNodeKind,
  planningCanvasItemsToLegacyBlob,
  planningCanvasLegacyElementFields,
  type CanvasConnector,
  type CanvasNode,
  type CanvasStroke,
  type PlanningCanvasIssueLink,
  type PlanningCanvasItemType,
  type PlanningCanvasRefMap,
} from "@paperclipai/shared";
import type { ItemFields, StoreItem } from "@/components/planning-canvas/store/canvas-op-store";

/**
 * The page still draws `nodes`, `connectors` and `strokes` in the legacy blob
 * shape (C4 renderers). These helpers turn those elements into item fields for
 * the op store and back. Typed kinds (table, markdown, issue, ...) show as a
 * read-only `note` projection until C16 draws them, so only their geometry and
 * colour come back from the page; nothing else of theirs is ever rewritten.
 */

export type CanvasElement = CanvasNode | CanvasConnector | CanvasStroke;

const TYPED_NODE_EDITABLE = ["x", "y", "width", "height", "zIndex", "color"] as const;

const UNKNOWN_NODE_EDITABLE = ["x", "y", "width", "height", "zIndex"] as const;

function defined(fields: Record<string, unknown>): ItemFields {
  const out: ItemFields = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return out;
}

/** Item fields for a page element; `prev` keeps what the legacy shape cannot carry (links, ref, data). */
export function elementToItem(itemType: PlanningCanvasItemType, element: CanvasElement, prev?: StoreItem): StoreItem {
  const prevFields = prev?.fields ?? {};
  if (itemType === "node" && prev && !isLegacyPlanningCanvasNodeKind(prevFields.kind as string)) {
    const fields = { ...prevFields };
    // An unknown kind takes geometry only; the server refuses any other change to it.
    const editable = isKnownPlanningCanvasNodeKind(prevFields.kind) ? TYPED_NODE_EDITABLE : UNKNOWN_NODE_EDITABLE;
    for (const field of editable) fields[field] = (element as CanvasNode)[field];
    return { itemType, fields };
  }
  const mapped = planningCanvasLegacyElementFields(itemType, element, prevFields.links as PlanningCanvasIssueLink[] | undefined);
  return { itemType, fields: defined({ ...prevFields, ...mapped }) };
}

/** The page element for an item. `identifiers` maps a linked issue id to the identifier the reader may see. */
export function itemToElement(key: string, item: StoreItem, identifiers: ReadonlyMap<string, string>): CanvasElement {
  if (item.itemType === "connector") {
    const { fromKey, toKey, label, color, dashed } = item.fields as {
      fromKey: string;
      toKey: string;
      label?: string;
      color?: CanvasConnector["color"];
      dashed?: boolean;
    };
    return defined({ id: key, fromNodeId: fromKey, toNodeId: toKey, label, color, dashed }) as unknown as CanvasConnector;
  }
  const refs: PlanningCanvasRefMap = {};
  for (const link of (item.fields.links as PlanningCanvasIssueLink[] | undefined) ?? []) {
    const identifier = identifiers.get(link.issueId);
    if (identifier) refs[link.issueId] = { label: identifier, identifier };
  }
  const blob = planningCanvasItemsToLegacyBlob(
    [{ key, itemType: item.itemType, data: item.fields as never, zIndex: (item.fields.zIndex as number | undefined) ?? null }],
    { refs },
  );
  return (item.itemType === "node" ? blob.nodes[0] : blob.strokes[0])!;
}

/** Elements that are new or changed (by reference) and ids that are gone. */
export function diffElements<T extends { id: string }>(prev: readonly T[], next: readonly T[]) {
  if (prev === next) return { changed: [] as T[], removed: [] as string[] };
  const before = new Map(prev.map((element) => [element.id, element]));
  const changed: T[] = [];
  const seen = new Set<string>();
  for (const element of next) {
    seen.add(element.id);
    if (before.get(element.id) !== element) changed.push(element);
  }
  return { changed, removed: prev.filter((element) => !seen.has(element.id)).map((element) => element.id) };
}

/** Replace, remove (null) or append elements by id, keeping the order of the rest. */
export function patchElements<T extends { id: string }>(elements: readonly T[], updates: ReadonlyMap<string, T | null>): T[] {
  if (updates.size === 0) return elements as T[];
  const pending = new Map(updates);
  const out: T[] = [];
  for (const element of elements) {
    if (!pending.has(element.id)) {
      out.push(element);
      continue;
    }
    const replacement = pending.get(element.id);
    pending.delete(element.id);
    if (replacement) out.push(replacement);
  }
  for (const replacement of pending.values()) if (replacement) out.push(replacement);
  return out;
}
