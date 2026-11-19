import { describe, expect, it } from "vitest";
import { blendCss, buildPreviewPlan, containBox, frameAt, layerFrame, overlaysAt } from "../src/ui/editor/preview-plan.js";
import { BLEND_CSS } from "../src/video-edit/layer.js";
import { normalizeEdit } from "../src/video-edit/timeline.js";

// PAR-10166 (D3d1): overlay clips show over the base with CSS blend and frame from the same layer.ts as the D3b render.
// Pixel parity against the D3b render runs in a real browser (harness attached to the issue); these pin the pure part.
const clip = (id: string, extra: Record<string, unknown> = {}) => ({ id, assetId: `a-${id}`, version: 1, start: 0, in: 0, out: 4, ...extra });
const plan = (overlay: Record<string, unknown>[]) =>
  buildPreviewPlan(normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks: [{ id: "v", kind: "video", clips: [clip("m")] }, { id: "o1", kind: "overlay", clips: overlay }] }));

describe("preview plan overlays", () => {
  it("keeps overlay clips apart from the base: the base plan and its end are unchanged", () => {
    const p = plan([clip("o", { start: 1, out: 2 })]);
    expect(p.segments.map((s) => s.clipId)).toEqual(["m"]);
    expect(p.overlays.map((s) => s.clipId)).toEqual(["o"]);
    expect(p.end).toBe(4);
    expect(frameAt(p, 1.5).layers.map((l) => l.segment.clipId)).toEqual(["m"]);
  });

  it("shows an overlay only inside its interval, in track order", () => {
    const edit = normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks: [{ id: "v", kind: "video", clips: [clip("m")] }, { id: "o1", kind: "overlay", clips: [clip("a", { start: 1, out: 1 })] }, { id: "o2", kind: "overlay", clips: [clip("b", { start: 1.5, out: 0.5 })] }] });
    const p = buildPreviewPlan(edit);
    expect(overlaysAt(p, 0.5)).toEqual([]);
    expect(overlaysAt(p, 1.2).map((l) => l.segment.clipId)).toEqual(["a"]);
    expect(overlaysAt(p, 1.7).map((l) => l.segment.clipId)).toEqual(["a", "b"]);
    expect(overlaysAt(p, 2.6)).toEqual([]);
    expect(overlaysAt(p, 1.2)[0]!.sourceTime).toBeCloseTo(0.2);
  });

  it("maps every blend mode to a CSS mix-blend-mode; addition is plus-lighter, normal is none", () => {
    const modes = Object.keys(BLEND_CSS);
    expect(modes).toHaveLength(8);
    for (const m of modes) expect(blendCss(plan([clip("o", { blendMode: m })]).overlays[0]!)).toBe(BLEND_CSS[m as keyof typeof BLEND_CSS]);
    expect(blendCss(plan([clip("o", { blendMode: "addition" })]).overlays[0]!)).toBe("plus-lighter");
    expect(blendCss(plan([clip("o", { blendMode: "normal" })]).overlays[0]!)).toBeNull();
    expect(plan([clip("o")]).segments[0]!.blendMode).toBeNull();
  });
});

describe("layerFrame", () => {
  const box = { width: 360, height: 640 };
  const project = { width: 1080, height: 1920 };
  const region = containBox(box, { width: 1080, height: 1920 });
  const seg = (frame: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => plan([clip("o", { frame, ...extra })]).overlays[0]!;

  it("is null without a visible frame", () => {
    expect(layerFrame(seg(undefined), 1, region, box, project)).toBeNull();
    expect(layerFrame(seg({ borderWidth: 0, cornerRadius: 0 }), 1, region, box, project)).toBeNull();
  });

  it("takes the radius from the short side of the picture and the border in render px (1080 wide -> 360 CSS px)", () => {
    const f = layerFrame(seg({ borderWidth: 6, borderColor: "#FF0000", cornerRadius: 20 }), 1, region, box, project)!;
    expect(f.radius).toBeCloseTo(0.2 * 360);
    expect(f.borderWidth).toBeCloseTo(2);
    expect(f.borderColor).toBe("#FF0000");
  });

  it("keeps a static-scale border at its render width (the layer transform scales it back) and scales a keyed one", () => {
    const f = { borderWidth: 6, borderColor: "#FFFFFF", cornerRadius: 0 };
    expect(layerFrame(seg(f, { transform: { scale: 0.5 } }), 0.5, region, box, project)!.borderWidth).toBeCloseTo(4);
    const keyed = seg(f, { keyframes: { scale: [{ t: 0, value: 1, ease: "linear" }, { t: 2, value: 0.5, ease: "linear" }] } });
    expect(layerFrame(keyed, 0.75, region, box, project)!.borderWidth).toBeCloseTo(2);
  });
});
