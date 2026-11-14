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
});
