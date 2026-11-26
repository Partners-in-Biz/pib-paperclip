/**
 * The generate card on a Planning Canvas board (PAR-14281; plan PAR-14257 C, D 3c). No React here, so tests load it.
 *
 * The card keeps its settings in the embed node's flat props: `prompt`, `kind`, `model`, `inputKeys` (a JSON list of
 * at most 8 node keys) and `lastGenerationId`. Inputs are only the keys the person ticked; arrows are never read. At
 * the click the card reads the board once, turns each input key into its Studio file, and sends both to Studio, which
 * copies them into the generation row. The output is its own `studio-media` card holding the generation id.
 */
import { isLipsyncOnly, isSelectable, MODEL_CATALOG } from "../models.js";
import { STUDIO_GENERATE_CARD, STUDIO_MEDIA_CARD, STUDIO_PLUGIN_KEY } from "../plugin-key.js";

export const MAX_INPUTS = 8;
/** How often an open generation's card asks for its state. */
export const POLL_MS = 5_000;

export interface BoardModel {
  id: string;
  label: string;
  kind: "image" | "video";
  ratios: string[];
  minRefs: number;
  maxRefs: number;
}

/** The models a person can pick: Studio's page list (offered, priced, not lip-sync only). */
export const BOARD_MODELS: readonly BoardModel[] = MODEL_CATALOG.filter((m) => isSelectable(m) && !isLipsyncOnly(m)).map(({ id, label, kind, ratios, minRefs, maxRefs }) => ({ id, label, kind, ratios, minRefs, maxRefs }));

export interface CardSettings {
  prompt: string;
  kind: "image" | "video";
  model: string;
  inputKeys: string[];
  lastGenerationId: string | null;
}

/** The card's settings from its props. Unknown or malformed values fall back; never throws. */
export function settingsFromProps(props: Record<string, string | number | boolean> | undefined): CardSettings {
  const p = props ?? {};
  const kind = p.kind === "video" ? "video" : "image";
  const models = BOARD_MODELS.filter((m) => m.kind === kind);
  const model = typeof p.model === "string" && models.some((m) => m.id === p.model) ? p.model : (models[0]?.id ?? "");
  let inputKeys: string[] = [];
  if (typeof p.inputKeys === "string" && p.inputKeys) {
    try {
      const list = JSON.parse(p.inputKeys) as unknown;
      if (Array.isArray(list)) inputKeys = [...new Set(list.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 100))].slice(0, MAX_INPUTS);
    } catch {
      inputKeys = [];
    }
  }
  return {
    prompt: typeof p.prompt === "string" ? p.prompt : "",
    kind,
    model,
    inputKeys,
    lastGenerationId: typeof p.lastGenerationId === "string" && p.lastGenerationId ? p.lastGenerationId : null,
  };
}

/** The board's limit on an embed node's props, as JSON bytes. */
export const PROPS_MAX_BYTES = 2048;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** The flat props for the node. The prompt is cut so the props stay under the board's 2 KB. */
export function propsFromSettings(s: CardSettings): Record<string, string> {
  const out: Record<string, string> = { prompt: s.prompt.slice(0, 1200), kind: s.kind, model: s.model, inputKeys: JSON.stringify(s.inputKeys.slice(0, MAX_INPUTS)) };
  if (s.lastGenerationId) out.lastGenerationId = s.lastGenerationId;
  // Escapes and multi-byte text can grow a prompt; cut it until the whole set fits.
  while (bytes(out) > PROPS_MAX_BYTES && out.prompt) out.prompt = out.prompt.slice(0, Math.max(0, out.prompt.length - Math.max(1, Math.ceil((bytes(out) - PROPS_MAX_BYTES) / 2))));
  return out;
}

/** The op that saves the card's settings on its own node. */
export function saveSettingsOp(nodeKey: string, s: CardSettings) {
  return { op: "update" as const, key: nodeKey, set: { data: { plugin: STUDIO_PLUGIN_KEY, type: STUDIO_GENERATE_CARD, props: propsFromSettings(s) } } };
}

/** One board node as the board read returns it (only the fields the card uses). */
export interface BoardNode {
  key: string;
  kind: string | null;
  deletedAt?: string | null;
  data?: { x?: number; y?: number; width?: number; title?: string; data?: { plugin?: string; type?: string; assetId?: string | null } };
}

export interface InputCandidate {
  key: string;
  title: string;
  assetId: string;
}

/** Studio media cards on the board with a file: the only nodes a card can take as input. */
export function inputCandidates(items: readonly BoardNode[], selfKey: string): InputCandidate[] {
  const out: InputCandidate[] = [];
  for (const item of items) {
    const embed = item.data?.data;
    if (item.deletedAt || item.key === selfKey || item.kind !== "embed") continue;
    if (embed?.plugin !== STUDIO_PLUGIN_KEY || embed.type !== STUDIO_MEDIA_CARD || !embed.assetId) continue;
    out.push({ key: item.key, title: (item.data?.title || "Studio file").slice(0, 120), assetId: embed.assetId });
  }
  return out;
}

/** The click: each input key turned into its file now. A key that is gone or has no file is named, never skipped. */
export function resolveInputs(items: readonly BoardNode[], selfKey: string, keys: readonly string[]): { assetIds: string[]; missing: string[] } {
  const byKey = new Map(inputCandidates(items, selfKey).map((c) => [c.key, c.assetId]));
  const assetIds: string[] = [];
  const missing: string[] = [];
  for (const key of keys) {
    const id = byKey.get(key);
    if (id) assetIds.push(id);
    else missing.push(key);
  }
  return { assetIds, missing };
}

/** Where the output card goes: to the right of the generate card, stepped down for each earlier output. */
export function outputPlace(items: readonly BoardNode[], selfKey: string, n: number): { x: number; y: number } {
  const self = items.find((i) => i.key === selfKey)?.data;
  const x = (self?.x ?? 80) + (self?.width ?? 360) + 40;
  const y = (self?.y ?? 80) + (n % 6) * 40;
  return { x, y };
}

/** An empty generate card's size on the board. */
export const GENERATE_CARD_SIZE = { width: 360, height: 440 } as const;

/** A new, empty generate card (PAR-14817): default settings, no inputs, no file. Placed from the library panel. */
export function newGenerateCardOp(at: { x: number; y: number }, key = `studio-generate-${Math.random().toString(36).slice(2, 12)}`) {
  return {
    op: "add" as const,
    item: {
      itemType: "node" as const,
      key,
      kind: "embed" as const,
      x: at.x,
      y: at.y,
      width: GENERATE_CARD_SIZE.width,
      height: GENERATE_CARD_SIZE.height,
      zIndex: 1,
      color: "slate" as const,
      title: "Generate with Studio",
      content: "",
      data: { plugin: STUDIO_PLUGIN_KEY, type: STUDIO_GENERATE_CARD, props: propsFromSettings(settingsFromProps({})) },
    },
  };
}

/** The output: its own Studio media card, pointing at the generation until the file exists. */
export function outputNodeOp(input: { generationId: string; title: string; kind: "image" | "video"; at: { x: number; y: number } }) {
  return {
    op: "add" as const,
    item: {
      itemType: "node" as const,
      key: `studio-gen-${input.generationId.slice(0, 40)}`,
      kind: "embed" as const,
      x: input.at.x,
      y: input.at.y,
      width: 320,
      height: input.kind === "video" ? 220 : 280,
      zIndex: 1,
      color: "slate" as const,
      title: input.title.slice(0, 300),
      content: "",
      data: { plugin: STUDIO_PLUGIN_KEY, type: STUDIO_MEDIA_CARD, props: { generationId: input.generationId } },
    },
  };
}

export interface Estimate {
  creditsTotal: number;
  dailyLimit: number;
  usedToday: number;
  payer: string;
  /** The client the estimate priced for (`company:<id>`), null for own work. Sent back as `expectedClient`. */
  client: string | null;
}

export function estimateFromReply(out: unknown): Estimate {
  const r = (out ?? {}) as { creditsTotal?: unknown; dailyLimit?: unknown; usedToday?: unknown; clientName?: unknown; client?: unknown };
  return {
    creditsTotal: Number(r.creditsTotal ?? 0),
    dailyLimit: Number(r.dailyLimit ?? 0),
    usedToday: Number(r.usedToday ?? 0),
    client: typeof r.client === "string" && r.client ? r.client : r.client && typeof r.client === "object" ? `${(r.client as { kind?: unknown }).kind}:${(r.client as { id?: unknown }).id}` : null,
    payer: r.client ? (typeof r.clientName === "string" && r.clientName ? r.clientName : "This board's client") : "Own work",
  };
}

/** The card's state for one click: idle, estimating, waiting to confirm, sending, or a message. */
export type GenerateStep =
  | { step: "idle" }
  | { step: "estimating" }
  | { step: "confirm"; estimate: Estimate; notice?: string }
  | { step: "sending"; estimate: Estimate }
  | { step: "message"; text: string; tone: "info" | "error" };

/** The worker refused because the board's client changed after the estimate (PAR-14835 Approach 4). */
export function isClientChanged(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "board_client_changed";
}

/** Plain words for a refusal; the worker's own message otherwise. */
export function refusalText(error: unknown): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (code === "board_generation_off") return "Generating from boards is switched off in Studio's settings.";
  if (code === "board_cards_off") return "Studio cards are switched off in Studio's settings.";
  return message || "Studio couldn't do that.";
}

export type QueueState = { status: "queued" | "running" | "succeeded" | "failed" | "unknown"; assetId: string | null; error: string | null };

export function queueStateFromReply(out: unknown): QueueState {
  const r = (out ?? {}) as { status?: unknown; assetId?: unknown; error?: unknown };
  const raw = typeof r.status === "string" ? r.status : "";
  const status = raw === "queued" ? "queued" : raw === "succeeded" ? "succeeded" : raw === "failed" ? "failed" : ["submitting", "submitted", "storing"].includes(raw) ? "running" : "unknown";
  return { status, assetId: typeof r.assetId === "string" ? r.assetId : null, error: typeof r.error === "string" ? r.error : null };
}

export function queueLabel(q: QueueState): string {
  if (q.status === "queued") return "Queued";
  if (q.status === "running") return "Generating…";
  if (q.status === "succeeded") return "Done";
  if (q.status === "failed") return q.error ? `Failed: ${q.error}` : "Failed.";
  return "Checking…";
}

export const isOpen = (q: QueueState) => q.status === "queued" || q.status === "running" || q.status === "unknown";
