/**
 * What a generating card (image or video) sends to the engine: the prompt from its connected prompt cards plus its
 * own extra direction, and reference images from connected source, output and image cards. Also which output cards
 * its result fills, and which models it may pick. No Node or database imports: the page bundle uses this, and the
 * worker checks every value again through the same estimate and generate actions as the Generate tab.
 */
import type { NodeType } from "./canvas-rules.js";

interface InputNode { id: string; type?: string; data?: Record<string, string | undefined> }
interface InputEdge { source: string; target: string }

export interface CardInputs {
  prompt: string;
  referenceAssetIds: string[];
  /** Connected source cards still waiting for a file, or inputs that are videos: named so the person can fix them. */
  missing: string[];
  /** Output cards this card feeds; each one shows the result. */
  outputIds: string[];
}

const REFERENCE_TYPES: readonly string[] = ["source", "output", "image"] satisfies NodeType[];

function name(node: InputNode): string {
  const label = node.data?.label?.trim();
  return label ? `"${label}"` : `the ${node.type} card`;
}

/**
 * Inputs for one card, in a stable order: incoming cards sorted top to bottom, then left to right, so the prompt reads
 * the way the board does. `isVideo` says which library assets are videos (they can't be reference images).
 */
export function cardInputs(nodes: readonly InputNode[], edges: readonly InputEdge[], cardId: string, isVideo: (assetId: string) => boolean = () => false): CardInputs {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const card = byId.get(cardId);
  const pos = (n: InputNode) => (n as { position?: { x: number; y: number } }).position ?? { x: 0, y: 0 };
  const incoming = [...new Set(edges.filter((e) => e.target === cardId).map((e) => e.source))]
    .map((id) => byId.get(id))
    .filter((n): n is InputNode => Boolean(n))
    .sort((a, b) => pos(a).y - pos(b).y || pos(a).x - pos(b).x);
  const texts: string[] = [];
  const refs: string[] = [];
  const missing: string[] = [];
  for (const node of incoming) {
    if (node.type === "prompt") {
      const text = node.data?.text?.trim();
      if (text) texts.push(text);
      else missing.push(`${name(node)} has no prompt yet`);
    } else if (REFERENCE_TYPES.includes(node.type ?? "")) {
      const assetId = node.data?.assetId;
      if (!assetId) missing.push(node.type === "source" ? `${name(node)} has no file picked` : `${name(node)} has no result yet`);
      else if (isVideo(assetId)) missing.push(`${name(node)} is a video, and only images can be references`);
      else if (!refs.includes(assetId)) refs.push(assetId);
    }
  }
  const own = card?.data?.prompt?.trim();
  if (own) texts.push(own);
  const outputIds = edges.filter((e) => e.source === cardId && byId.get(e.target)?.type === "output").map((e) => e.target);
  return { prompt: texts.join("\n\n"), referenceAssetIds: refs, missing, outputIds: [...new Set(outputIds)] };
}

export interface ModelChoice { id: string; label: string; kind: "image" | "video"; minRefs?: number; maxRefs?: number }
export interface ModelOption { id: string; label: string; disabled: string | null }

/** Every model of the card's kind: the ones that fit the connected references can be picked, the rest say why not. */
export function modelOptions(kind: "image" | "video", refCount: number, models: readonly ModelChoice[], unavailable: ReadonlyArray<{ id: string; label: string; kind: "image" | "video"; note: string }>): ModelOption[] {
  const options: ModelOption[] = models
    .filter((m) => m.kind === kind)
    .map((m) => {
      const min = m.minRefs ?? 0;
      const max = m.maxRefs ?? 0;
      let disabled: string | null = null;
      if (refCount < min) disabled = `needs ${min === max ? "" : "at least "}${min} reference image${min === 1 ? "" : "s"} connected`;
      else if (refCount > max) disabled = max === 0 ? "takes no reference images" : `takes at most ${max} reference image${max === 1 ? "" : "s"}`;
      return { id: m.id, label: m.label, disabled };
    });
  for (const m of unavailable) if (m.kind === kind) options.push({ id: `na-${m.id}`, label: m.label, disabled: m.note });
  return options;
}
