import { describe, expect, it } from "vitest";
import { buildPreviewPlan } from "../src/ui/editor/preview-plan.js";
import { stickerUrl } from "../src/ui/editor/sticker-url.js";
import { normalizeEdit } from "../src/video-edit/timeline.js";

const doc = normalizeEdit({
  project: { size: "9:16", fps: 30 },
  tracks: [
    { id: "v", kind: "video", clips: [{ id: "b", assetId: "base", version: 1, start: 0, in: 0, out: 2 }] },
    { id: "o", kind: "overlay", clips: [{ id: "s", sticker: { pack: "noto-emoji", id: "fire" }, start: 0, in: 0, out: 1 }] },
    { id: "o2", kind: "overlay", clips: [{ id: "m", assetId: "top", version: 1, start: 0, in: 0, out: 1 }] },
  ],
});

describe("preview plan with a sticker overlay", () => {
  it("carries the sticker ref and no asset id, so only library assets reach usePreviewUrls", () => {
    const plan = buildPreviewPlan(doc);
    const [sticker, media] = plan.overlays;
    expect(sticker).toMatchObject({ clipId: "s", assetId: "", sticker: { pack: "noto-emoji", id: "fire" } });
    expect(media).toMatchObject({ clipId: "m", assetId: "top", sticker: null });
    // The id list Player.tsx builds: stickers filtered out.
    expect(plan.overlays.filter((s) => !s.sticker).map((s) => s.assetId)).toEqual(["top"]);
  });
});

describe("stickerUrl", () => {
  it("builds <base>stickers/<pack>/<id>.png from the manifest only", () => {
    expect(stickerUrl("https://h/ui/", { pack: "pib-shapes", id: "star" })).toBe("https://h/ui/stickers/pib-shapes/star.png");
    expect(stickerUrl(null, { pack: "pib-shapes", id: "star" })).toBeUndefined();
    expect(stickerUrl("https://h/ui/", { pack: "noto-emoji", id: "../../x" } as never)).toBeUndefined();
    expect(stickerUrl("https://h/ui/", undefined)).toBeUndefined();
  });
});
