/** Pure helpers for the phone board review screen (PAR-8094): which board results to review, in what order. */
import { humanTitle, statusLabel } from "./library.js";

export interface ReviewCard { id: string; type?: string; position: { x: number; y: number }; data: Record<string, string> }
export interface ReviewAsset { id: string; name: string; kind: string; status?: string; prompt?: string | null; model?: string | null; credits?: number | null }
export interface ReviewItem {
  assetId: string;
  cardId: string;
  kind: "image" | "video" | "audio";
  status: string;
  title: string;
  prompt: string;
  model: string | null;
  credits: number | null;
}

/** Cards whose file is a generation result. Source cards hold library inputs and prompt cards hold text, so they're left out. */
const RESULT_CARDS = new Set(["image", "video", "output", "layout", "edit"]);

/**
 * The board's results to review: one item per file (an image card and the output card it fills share one), drafts
 * first, then in reading order on the board (top to bottom, then left to right).
 */
export function reviewQueue(cards: ReadonlyArray<ReviewCard>, assets: ReadonlyArray<ReviewAsset>, promptFor: (cardId: string) => string = () => ""): ReviewItem[] {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const placed = cards
    .filter((c) => RESULT_CARDS.has(c.type ?? "") && c.data.assetId)
    .slice()
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const items: ReviewItem[] = [];
  for (const c of placed) {
    const assetId = c.data.assetId as string;
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    const a = byId.get(assetId);
    const prompt = (a?.prompt ?? "").trim() || promptFor(c.id).trim() || (c.data.prompt ?? "").trim();
    const kind = a?.kind === "audio" ? "audio" : a?.kind === "video" || (!a && c.type === "video") ? "video" : "image";
    items.push({ assetId, cardId: c.id, kind, status: a?.status ?? "", title: humanTitle(prompt, a?.name || c.data.label || "Result"), prompt, model: a?.model ?? null, credits: typeof a?.credits === "number" ? a.credits : null });
  }
  // Stable sort keeps reading order inside each group.
  return items.sort((x, y) => Number(y.status === "draft") - Number(x.status === "draft"));
}

/** "1 of 4 outputs awaiting review". */
export function awaitingLine(items: ReadonlyArray<{ status: string }>): string {
  if (items.length === 0) return "No results on this board yet.";
  const drafts = items.filter((i) => i.status === "draft").length;
  return `${drafts} of ${items.length} output${items.length === 1 ? "" : "s"} awaiting review`;
}

/** The pill on the selected result: a draft says it needs review. */
export function reviewPill(status: string): string {
  if (status === "draft") return "Draft · needs review";
  return statusLabel(status) || "Not in the library";
}

/** After a decision, move to the next draft (in queue order), or stay put when none is left. */
export function nextAfterReview(items: ReadonlyArray<{ assetId: string; status: string }>, reviewedId: string): string {
  const at = items.findIndex((i) => i.assetId === reviewedId);
  const after = [...items.slice(at + 1), ...items.slice(0, Math.max(0, at))];
  return after.find((i) => i.status === "draft")?.assetId ?? reviewedId;
}

/** The prompt cut at a word near `max` characters for the collapsed view; `clipped` says whether "More" is needed. */
export function clipPrompt(text: string, max = 80): { text: string; clipped: boolean } {
  const t = text.trim();
  if (t.length <= max) return { text: t, clipped: false };
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return { text: `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.!?-]+$/, "")}…`, clipped: true };
}
