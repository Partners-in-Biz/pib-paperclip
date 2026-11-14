/**
 * The sticker tab of "Add a clip" (PAR-10178, D4g1): which stickers a pack/search shows, and the ops batch that puts one
 * on the first overlay track at the playhead. Pure; ids and packs come from the closed manifest (`sticker-packs.ts`),
 * so a sticker the picker offers is one `normalizeEdit` accepts.
 */
import { PIB_SHAPES, STICKER_PACKS, stickerIds, type StickerPack, type StickerRef } from "../../video-edit/sticker-packs.js";
import type { EditDoc } from "../../video-edit/timeline.js";
import { freeId, MAX_CLIPS_PER_TRACK, MAX_EDIT_SECONDS } from "./timeline-view.js";

/** How long a new sticker shows (it can be trimmed after). */
export const STICKER_SECONDS = 3;
const MIN_SECONDS = 0.1;
const ms = (n: number) => Math.round(n * 1000) / 1000;

export const PACK_LABELS: Record<StickerPack, string> = { "noto-emoji": "Emoji", "pib-shapes": "Shapes" };
export const PACKS: readonly StickerPack[] = STICKER_PACKS;

/** A sticker's name for people: the manifest label for shapes, the id with spaces for emoji. */
export function stickerLabel(ref: StickerRef): string {
  return ref.pack === "pib-shapes" ? PIB_SHAPES[ref.id] ?? ref.id : ref.id.replace(/-/g, " ");
}

/** The stickers of `pack` whose name or id contains `query` (case-insensitive), in manifest order. */
export function filterStickers(pack: StickerPack, query: string): StickerRef[] {
  const q = query.trim().toLowerCase();
  return stickerIds(pack)
    .map((id) => ({ pack, id }))
    .filter((r) => !q || r.id.includes(q) || stickerLabel(r).toLowerCase().includes(q));
}

/** True when `pack` is a bundled pack (a select value is a string, not yet a StickerPack). */
export const isPack = (v: string): v is StickerPack => (STICKER_PACKS as readonly string[]).includes(v);

/**
 * The batch that adds `ref` at `at` (the playhead) on the first overlay track, creating one when the edit has none. It
 * shows STICKER_SECONDS, shortened to fit under the edit's 180 s limit; `{ error }` when there is no room.
 */
export function addStickerOps(doc: EditDoc | null, ref: StickerRef, at: number): { ops: Record<string, unknown>[]; clipId: string; start: number } | { error: string } {
  if (!doc) return { error: "The edit isn't loaded yet." };
  if (!(PACKS as readonly string[]).includes(ref.pack) || !stickerIds(ref.pack).includes(ref.id)) return { error: "That sticker isn't in the pack." };
  const track = doc.tracks.find((t) => t.kind === "overlay");
  if (track && track.clips.length >= MAX_CLIPS_PER_TRACK) return { error: `A track holds at most ${MAX_CLIPS_PER_TRACK} clips.` };
  const start = ms(Math.max(0, Number.isFinite(at) ? at : 0));
  const room = ms(MAX_EDIT_SECONDS - start);
  if (room < MIN_SECONDS) return { error: `Move the playhead earlier: an edit is at most ${MAX_EDIT_SECONDS} s.` };
  const trackId = track ? track.id : freeId(doc, "overlay");
  const clipId = freeId(doc, "sticker");
  const ops: Record<string, unknown>[] = track ? [] : [{ op: "addTrack", track: { id: trackId, kind: "overlay" } }];
  ops.push({ op: "addClip", trackId, clip: { id: clipId, start, sticker: { pack: ref.pack, id: ref.id }, in: 0, out: Math.min(STICKER_SECONDS, room) } });
  return { ops, clipId, start };
}
