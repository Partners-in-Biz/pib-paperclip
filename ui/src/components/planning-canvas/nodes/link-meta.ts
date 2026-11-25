import {
  PLANNING_CANVAS_REF_NODE_KINDS,
  type PlanningCanvasIssueLink,
  type PlanningCanvasRefNodeKind,
} from "@paperclipai/shared";
import type { StoreItem } from "@/components/planning-canvas/store/canvas-op-store";

/**
 * What the page's legacy node shape cannot carry: which entity a node points at (`ref`) and
 * every issue it is linked to (`links`). Item data stores ids only; the live summaries come from
 * the per-reader refs read (see `useCanvasRefs`).
 */
export interface NodeLinkMeta {
  /** Set for issue, agent, project and goal nodes. */
  refKind: PlanningCanvasRefNodeKind | null;
  refId: string | null;
  /** Issue ids from `links`, in order. */
  links: string[];
}

const REF_KINDS = new Set<string>(PLANNING_CANVAS_REF_NODE_KINDS);

/** Link meta of a store item; null for anything that is neither a ref node nor linked. */
export function linkMetaOf(item: StoreItem | undefined | null): NodeLinkMeta | null {
  if (!item || item.itemType !== "node") return null;
  const kind = item.fields.kind as string | undefined;
  const refKind = kind && REF_KINDS.has(kind) ? (kind as PlanningCanvasRefNodeKind) : null;
  const refId = refKind ? ((item.fields.ref as { id?: string } | undefined)?.id ?? null) : null;
  const links = ((item.fields.links as PlanningCanvasIssueLink[] | undefined) ?? []).map((link) => link.issueId);
  if (!refKind && links.length === 0) return null;
  return { refKind, refId, links };
}

export function sameLinkMeta(a: NodeLinkMeta | null | undefined, b: NodeLinkMeta | null | undefined) {
  if (!a || !b) return !a && !b;
  return a.refKind === b.refKind && a.refId === b.refId && a.links.length === b.links.length && a.links.every((id, i) => id === b.links[i]);
}

/** Next map after `keys` changed; untouched entries keep their identity so memoized nodes stay put. */
export function patchLinkMeta(
  prev: ReadonlyMap<string, NodeLinkMeta>,
  keys: Iterable<string>,
  getItem: (key: string) => StoreItem | undefined,
): ReadonlyMap<string, NodeLinkMeta> {
  let next: Map<string, NodeLinkMeta> | null = null;
  for (const key of keys) {
    const before = prev.get(key) ?? null;
    const after = linkMetaOf(getItem(key));
    if (sameLinkMeta(before, after)) continue;
    next ??= new Map(prev);
    if (after) next.set(key, after);
    else next.delete(key);
  }
  return next ?? prev;
}

/** Every distinct entity id a board names, sorted (it is part of the refs query key). */
export function linkedEntityIds(meta: ReadonlyMap<string, NodeLinkMeta>): string[] {
  const ids = new Set<string>();
  for (const entry of meta.values()) {
    if (entry.refId) ids.add(entry.refId);
    for (const id of entry.links) ids.add(id);
  }
  return [...ids].sort();
}
