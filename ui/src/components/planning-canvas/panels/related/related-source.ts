import type { CanvasNode } from "@paperclipai/shared";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import type { PlaceRelatedNode } from "@/components/planning-canvas/state/placeRelated";

/** What "Related" asks about: a plugin record (embed card) or a core issue (its subtasks). */
export type RelatedSource =
  | { kind: "embed"; key: string; plugin: string; type: string; assetId: string }
  | { kind: "issue"; key: string; issueId: string };

/** Edit access may write; comment and view read. A personal board is its owner's, so edit. */
export function canEditBoard(board: CanvasController["activeBoard"]): boolean {
  if (!board) return false;
  const level = board.scope && board.scope !== "personal" ? (board.memberAccess ?? "view") : "edit";
  return level === "edit";
}

type OpStoreMeta = Pick<CanvasController["opStore"], "typedMeta" | "linkMeta">;

/** The source a node offers "Related" for, or null (any other node kind, or a card with no record id). */
export function relatedSourceOf(node: CanvasNode | null | undefined, store: OpStoreMeta): RelatedSource | null {
  if (!node) return null;
  // The page's legacy node type predates embed and ref kinds; the store holds the real kind.
  const kind: string = node.kind;
  if (kind === "embed") {
    const meta = store.typedMeta.get(node.id);
    if (meta?.kind !== "embed" || !meta.data.assetId) return null;
    return { kind: "embed", key: node.id, plugin: meta.data.plugin, type: meta.data.type, assetId: meta.data.assetId };
  }
  const link = store.linkMeta.get(node.id);
  if (kind === "issue" && link?.refKind === "issue" && link.refId) return { kind: "issue", key: node.id, issueId: link.refId };
  return null;
}

/** Every board node in the shape `placeRelated` reads. */
export function placementNodes(nodes: readonly CanvasNode[], store: OpStoreMeta): PlaceRelatedNode[] {
  return nodes.map((n) => {
    const typed = store.typedMeta.get(n.id);
    const refId = store.linkMeta.get(n.id)?.refId;
    return {
      key: n.id,
      kind: n.kind,
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
      ref: refId ? { id: refId } : null,
      data: typed?.kind === "embed" ? typed.data : undefined,
    };
  });
}
