import { describe, expect, it } from "vitest";
import { applyOps } from "../src/video-edit/ops.js";
import { normalizeEdit, type EditDoc } from "../src/video-edit/timeline.js";
import { stickerIds } from "../src/video-edit/sticker-packs.js";
import { addStickerOps, filterStickers, isPack, STICKER_SECONDS, stickerLabel } from "../src/ui/editor/sticker-picker.js";

const empty = (): EditDoc => normalizeEdit({ tracks: [] });
const fire = { pack: "noto-emoji", id: "fire" } as const;

describe("sticker picker", () => {
  it("filters by pack and search over id and label", () => {
    expect(filterStickers("noto-emoji", "").length).toBe(stickerIds("noto-emoji").length);
    expect(filterStickers("noto-emoji", " FIRE ").map((r) => r.id)).toEqual(["fire"]);
    expect(filterStickers("pib-shapes", "arrow").length).toBe(5);
    expect(filterStickers("pib-shapes", "zzz")).toEqual([]);
    expect(stickerLabel({ pack: "pib-shapes", id: "speech-bubble" })).toBe("Speech bubble");
    expect(stickerLabel({ pack: "noto-emoji", id: "heart-eyes" })).toBe("heart eyes");
    expect(isPack("giphy")).toBe(false);
  });

  it("adds a sticker on a new overlay track at the playhead, and the result applies", () => {
    const made = addStickerOps(empty(), fire, 2.5);
    if ("error" in made) throw new Error(made.error);
    expect(made.start).toBe(2.5);
    expect(made.ops.map((o) => o.op)).toEqual(["addTrack", "addClip"]);
    const r = applyOps(empty(), made.ops);
    const clips = r.tracks[0].clips as unknown as { sticker: unknown; out: number; start: number }[];
    expect(r.tracks[0].kind).toBe("overlay");
    expect(clips[0]).toMatchObject({ sticker: fire, start: 2.5, out: STICKER_SECONDS });
  });

  it("reuses the first overlay track, shortens at the 180 s limit, refuses past it and unknown stickers", () => {
    const first = addStickerOps(empty(), fire, 0);
    if ("error" in first) throw new Error(first.error);
    const doc = applyOps(empty(), first.ops);
    const again = addStickerOps(doc, { pack: "pib-shapes", id: "star" }, 179);
    if ("error" in again) throw new Error(again.error);
    expect(again.ops.map((o) => o.op)).toEqual(["addClip"]);
    expect(again.ops[0]).toMatchObject({ clip: { out: 1, start: 179 } });
    expect(applyOps(doc, again.ops).tracks[0].clips).toHaveLength(2);
    expect(addStickerOps(doc, fire, 180)).toHaveProperty("error");
    expect(addStickerOps(doc, { pack: "noto-emoji", id: "nope" }, 0)).toHaveProperty("error");
    expect(addStickerOps(null, fire, 0)).toHaveProperty("error");
  });

  it("never overlaps a clip: a busy playhead gets a new overlay track, a later clip shortens only when no track can be added", () => {
    const add = (doc: EditDoc, at: number) => {
      const made = addStickerOps(doc, fire, at);
      if ("error" in made) throw new Error(made.error);
      return { made, doc: applyOps(doc, made.ops) };
    };
    // Same playhead twice (the reported failure): the second lands on a new track, and both save.
    const one = add(empty(), 1);
    const two = add(one.doc, 1);
    expect(two.made.ops.map((o) => o.op)).toEqual(["addTrack", "addClip"]);
    expect(two.doc.tracks.map((t) => t.clips.length)).toEqual([1, 1]);
    // A later free track is used: track 1 holds 1..4, track 2 holds 10..13, so 2 s goes to track 2 (8 s free there).
    const later = normalizeEdit({ tracks: [{ id: "o1", kind: "overlay", clips: [{ id: "x", sticker: fire, start: 1, in: 0, out: 3 }] }, { id: "o2", kind: "overlay", clips: [{ id: "y", sticker: fire, start: 10, in: 0, out: 3 }] }] });
    expect(add(later, 2).made.ops).toEqual([expect.objectContaining({ op: "addClip", trackId: "o2", clip: expect.objectContaining({ start: 2, out: STICKER_SECONDS }) })]);
    // Right after a sticker ends (4 s) the first track has room again.
    expect(add(two.doc, 4).made.ops[0]).toMatchObject({ trackId: two.doc.tracks[0].id, clip: { start: 4, out: STICKER_SECONDS } });
    // 20 tracks: a clip at 2 s on the only overlay track shortens a sticker at 1 s to 1 s instead of failing.
    const tracks = Array.from({ length: 19 }, (_, i) => ({ id: `a${i}`, kind: "audio", clips: [] }));
    const full = normalizeEdit({ tracks: [...tracks, { id: "o", kind: "overlay", clips: [{ id: "s", sticker: fire, start: 2, in: 0, out: 3 }] }] });
    expect(add(full, 1).made.ops[0]).toMatchObject({ op: "addClip", trackId: "o", clip: { start: 1, out: 1 } });
    expect(addStickerOps(full, fire, 2.5)).toHaveProperty("error");
  });
});
