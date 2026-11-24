import type {
  CanvasNodeColor,
  PlanningCanvasConnectorFields,
  PlanningCanvasItemInput,
  PlanningCanvasRefNodeKind,
} from "@paperclipai/shared";

/** Pure placement for the "Related" add (plan PAR-14389 C.3, row A5a). No store, no network, no DOM. */

export const PLACE_RELATED_MAX = 50;
export const PLACE_RELATED_LABEL_MAX = 120;
export const PLACE_RELATED_GAP = 40;

const EMBED_SIZE = { width: 280, height: 160 };
const REF_SIZE = { width: 230, height: 150 };
const NODE_COLOR: CanvasNodeColor = "slate";
const NODE_Z = 2;

export type RelatedRelation = "contact" | "invoice" | "email" | "post" | "campaign" | "subtask";

/** One related record the person ticked. It is an embed card (plugin record) or a ref card (core entity). */
export type RelatedRecord =
  | { relation: RelatedRelation | string; plugin: string; type: string; assetId: string }
  | { relation: RelatedRelation | string; refKind: PlanningCanvasRefNodeKind; refId: string };

/** The part of a board node this helper reads. A store item or a flattened node both fit. */
export interface PlaceRelatedNode {
  key: string;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  ref?: { id: string } | null;
  data?: unknown;
}

export interface PlaceRelatedConnector {
  fromKey: string;
  toKey: string;
}

export interface PlaceRelatedInput {
  source: PlaceRelatedNode;
  nodes: readonly PlaceRelatedNode[];
  /** Existing connectors, so a pair already joined is not joined twice. */
  connectors?: readonly PlaceRelatedConnector[];
  records: readonly RelatedRecord[];
  /** Key for a new item. Defaults to `crypto.randomUUID()`. */
  newKey?: () => string;
  max?: number;
}

export interface PlaceRelatedResult {
  /** Items to send as `add` ops: new nodes first, then connectors. */
  items: PlanningCanvasItemInput[];
  addedNodes: number;
  /** Records already on the board that were joined to the source instead of added. */
  connectedExisting: number;
  /** Records already joined to the source: nothing to do. */
  alreadyConnected: number;
  /** Records past the cap, returned in order so the caller can say how many were left out. */
  skipped: RelatedRecord[];
}

function clipLabel(relation: string): string {
  return relation.length > PLACE_RELATED_LABEL_MAX ? relation.slice(0, PLACE_RELATED_LABEL_MAX) : relation;
}

function embedData(node: PlaceRelatedNode): { plugin: string; type: string; assetId?: string } | null {
  if (node.kind !== "embed" || !node.data || typeof node.data !== "object") return null;
  const d = node.data as { plugin?: unknown; type?: unknown; assetId?: unknown };
  if (typeof d.plugin !== "string" || typeof d.type !== "string") return null;
  return { plugin: d.plugin, type: d.type, assetId: typeof d.assetId === "string" ? d.assetId : undefined };
}

function recordId(record: RelatedRecord): string {
  return "refId" in record
    ? `ref:${record.refKind}:${record.refId}`
    : `embed:${record.plugin}:${record.type}:${record.assetId}`;
}

function nodeId(node: PlaceRelatedNode): string | null {
  const embed = embedData(node);
  if (embed) return embed.assetId ? `embed:${embed.plugin}:${embed.type}:${embed.assetId}` : null;
  return node.ref?.id ? `ref:${node.kind}:${node.ref.id}` : null;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
type Rect = { x: number; y: number; width: number; height: number };

export function placeRelated(input: PlaceRelatedInput): PlaceRelatedResult {
  const { source, nodes, records } = input;
  const max = Math.max(0, input.max ?? PLACE_RELATED_MAX);
  const newKey = input.newKey ?? (() => crypto.randomUUID());

  const onBoard = new Map<string, string>();
  for (const node of nodes) {
    const id = nodeId(node);
    if (id && !onBoard.has(id)) onBoard.set(id, node.key);
  }
  const joined = new Set<string>();
  for (const c of input.connectors ?? []) {
    if (c.fromKey === source.key) joined.add(c.toKey);
    else if (c.toKey === source.key) joined.add(c.fromKey);
  }

  const taken: Rect[] = [source, ...nodes.filter((n) => n.key !== source.key)];
  const columnX = source.x + source.width + PLACE_RELATED_GAP;
  let cursorY = source.y;

  const newNodes: PlanningCanvasItemInput[] = [];
  const connectors: PlanningCanvasItemInput[] = [];
  const skipped: RelatedRecord[] = [];
  const seen = new Set<string>();
  let connectedExisting = 0;
  let alreadyConnected = 0;
  let handled = 0;

  const connect = (toKey: string, relation: string) => {
    const fields: PlanningCanvasConnectorFields = { fromKey: source.key, toKey, label: clipLabel(relation) };
    connectors.push({ itemType: "connector", key: newKey(), ...fields });
    joined.add(toKey);
  };

  for (const record of records) {
    const id = recordId(record);
    if (seen.has(id)) continue; // the same record ticked twice
    seen.add(id);
    if (handled >= max) {
      skipped.push(record);
      continue;
    }
    handled += 1;

    const existingKey = onBoard.get(id);
    if (existingKey !== undefined) {
      if (existingKey === source.key || joined.has(existingKey)) alreadyConnected += 1;
      else {
        connect(existingKey, record.relation);
        connectedExisting += 1;
      }
      continue;
    }

    const size = "refId" in record ? REF_SIZE : EMBED_SIZE;
    let y = cursorY;
    // Walk down past anything in the way, source and existing nodes included.
    for (let guard = 0; guard <= taken.length + 1; guard += 1) {
      const hit = taken.find((r) => overlaps({ x: columnX, y, ...size }, r));
      if (!hit) break;
      y = hit.y + hit.height + PLACE_RELATED_GAP;
    }
    const rect = { x: columnX, y, ...size };
    taken.push(rect);
    cursorY = y + size.height + PLACE_RELATED_GAP;

    const key = newKey();
    const base = { itemType: "node" as const, key, ...rect, zIndex: NODE_Z, color: NODE_COLOR, title: "", content: "" };
    newNodes.push(
      "refId" in record
        ? { ...base, kind: record.refKind, ref: { id: record.refId } }
        : {
            ...base,
            kind: "embed",
            data: { plugin: record.plugin, type: record.type, assetId: record.assetId, props: {} },
          },
    );
    onBoard.set(id, key);
    connect(key, record.relation);
  }

  return {
    items: [...newNodes, ...connectors],
    addedNodes: newNodes.length,
    connectedExisting,
    alreadyConnected,
    skipped,
  };
}
