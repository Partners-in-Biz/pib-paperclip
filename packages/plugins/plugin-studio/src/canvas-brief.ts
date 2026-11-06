/**
 * `canvas-create-from-brief` (PAR-8093): an agent's brief becomes a board of prompt cards, each wired to an image or
 * video card, with optional library assets as source cards feeding every one. It only lays out cards: nothing is
 * generated or charged until a person opens the board and presses Generate.
 */
import { MAX_LABEL, MAX_TEXT, type CanvasDoc, type CanvasEdge, type CanvasNode } from "./canvas-rules.js";
import { StudioError } from "./errors.js";

export const MAX_BRIEF_PROMPTS = 12;
export const MAX_BRIEF_ASSETS = 10;
const COL = 380;
const ROW = 260;

function bad(message: string): never {
  throw new StudioError(message, "bad_brief");
}

function short(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** Builds the board for a brief. Throws a message the agent can act on. */
export function briefDoc(params: Record<string, unknown>): CanvasDoc {
  const prompts = Array.isArray(params.prompts) ? params.prompts : [];
  if (!prompts.length) bad("prompts is required: one or more { text, kind } to put on the board.");
  if (prompts.length > MAX_BRIEF_PROMPTS) bad(`A brief holds at most ${MAX_BRIEF_PROMPTS} prompts.`);
  const rawAssets = params.assetIds === undefined ? [] : params.assetIds;
  if (!Array.isArray(rawAssets) || rawAssets.some((id) => typeof id !== "string" || !id.trim())) bad("assetIds must be a list of Studio library asset ids.");
  const assetIds = [...new Set((rawAssets as string[]).map((id) => id.trim()))];
  if (assetIds.length > MAX_BRIEF_ASSETS) bad(`A brief uses at most ${MAX_BRIEF_ASSETS} library assets.`);

  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const media: string[] = [];
  prompts.forEach((item, i) => {
    const p = typeof item === "string" ? { text: item } : item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const text = typeof p.text === "string" ? p.text.trim() : "";
    if (!text) bad(`Prompt ${i + 1} has no text.`);
    if (text.length > MAX_TEXT) bad(`Prompt ${i + 1} is longer than ${MAX_TEXT} characters.`);
    const kind = p.kind === undefined ? "image" : p.kind;
    if (kind !== "image" && kind !== "video") bad(`Prompt ${i + 1}: kind must be "image" or "video".`);
    const label = short(p.label, MAX_LABEL);
    const data: Record<string, string> = { label: label ?? (kind === "video" ? `Video ${i + 1}` : `Image ${i + 1}`) };
    const model = short(p.model, MAX_LABEL);
    const ratio = short(p.ratio, MAX_LABEL);
    if (model) data.model = model;
    if (ratio) data.ratio = ratio;
    const y = i * ROW;
    nodes.push({ id: `p${i + 1}`, type: "prompt", position: { x: 0, y }, data: { label: label ?? `Prompt ${i + 1}`, text } });
    nodes.push({ id: `m${i + 1}`, type: kind, position: { x: COL, y }, data });
    edges.push({ id: `e-p${i + 1}-m${i + 1}`, source: `p${i + 1}`, target: `m${i + 1}` });
    media.push(`m${i + 1}`);
  });
  assetIds.forEach((assetId, i) => {
    const id = `s${i + 1}`;
    // Under the prompts, in their column: a connection then never runs behind another card.
    nodes.push({ id, type: "source", position: { x: 0, y: (prompts.length + i) * ROW }, data: { label: `Reference ${i + 1}`, assetId } });
    for (const target of media) edges.push({ id: `e-${id}-${target}`, source: id, target });
  });
  return { nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}
