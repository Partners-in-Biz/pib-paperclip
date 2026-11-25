import { describe, expect, it } from "vitest";
import { normalizeEdit, type EditDoc, type MediaClip } from "../src/video-edit/timeline.js";
import { applyOps } from "../src/video-edit/ops.js";
import { ADJUST_ROWS, applyToAllOps, hasLookPanel, LOOK_IDS, resetOps, setAdjustOps, setIntensityOps, setLookOps, type LookEdit } from "../src/ui/editor/look-panel.js";
import { ADJUST_RANGE, PIB_BASIC_IDS } from "../src/video-edit/looks.js";

const clip = (id: string, extra: Record<string, unknown> = {}) => ({ id, assetId: "a1", version: 1, start: id === "a" ? 0 : 5, in: 0, out: 4, ...extra });
const docOf = (a: Record<string, unknown> = {}, b: Record<string, unknown> = {}): EditDoc =>
  normalizeEdit({ tracks: [{ id: "v", kind: "video", clips: [clip("a", a), clip("b", b)] }] });
const find = (doc: EditDoc, id: string) => doc.tracks[0].clips.find((c) => c.id === id) as MediaClip;
/** What the worker does: the ops through the real applier, then the validator. */
const run = (doc: EditDoc, edit: LookEdit | null, which: "ops" | "undo" = "ops"): EditDoc => {
  if (!edit) throw new Error("no edit");
  return applyOps(doc, edit[which]);
};

describe("look panel ops", () => {
  it("lists the worker's looks and every adjust field with its range", () => {
    expect([...LOOK_IDS]).toEqual([...PIB_BASIC_IDS]);
    expect(LOOK_IDS).toHaveLength(12);
    expect(ADJUST_ROWS.map((r) => r.field).sort()).toEqual(Object.keys(ADJUST_RANGE).sort());
    expect(hasLookPanel("video")).toBe(true);
    expect(hasLookPanel("overlay")).toBe(true);
    expect(hasLookPanel("text")).toBe(false);
    expect(hasLookPanel("audio")).toBe(false);
  });
  it("sets, resets and undoes an adjust field", () => {
    let doc = docOf();
    const edit = setAdjustOps(find(doc, "a"), "brightness", 0.3);
    doc = run(doc, edit);
    expect(find(doc, "a").adjust).toEqual({ brightness: 0.3 });
    doc = run(doc, edit, "undo");
    expect(find(doc, "a").adjust).toBeUndefined();
    expect(setAdjustOps(find(doc, "a"), "brightness", 0)).toBeNull();
    expect(setAdjustOps(find(doc, "a"), "brightness", NaN)).toBeNull();
    expect(setAdjustOps(find(doc, "a"), "blur", 99)?.ops[0]).toMatchObject({ props: { adjust: { blur: 50 } } });
  });
  it("picks a look, keeps its strength on a change, a second click removes it", () => {
    let doc = docOf();
    doc = run(doc, setLookOps(find(doc, "a"), "sepia"));
    expect(find(doc, "a").look).toEqual({ pack: "pib-basic", id: "sepia", intensity: 1 });
    doc = run(doc, setIntensityOps(find(doc, "a"), 0.4));
    expect(find(doc, "a").look?.intensity).toBe(0.4);
    const swap = setLookOps(find(doc, "a"), "noir");
    doc = run(doc, swap);
    expect(find(doc, "a").look).toEqual({ pack: "pib-basic", id: "noir", intensity: 0.4 });
    doc = run(doc, swap, "undo");
    expect(find(doc, "a").look?.id).toBe("sepia");
    doc = run(doc, setLookOps(find(doc, "a"), "sepia"));
    expect(find(doc, "a").look).toBeUndefined();
    expect(setLookOps(find(doc, "a"), "../etc")).toBeNull();
    expect(setIntensityOps(find(doc, "a"), 0.5)).toBeNull();
  });
  it("reset removes look and adjust; undo puts both back", () => {
    let doc = docOf({ look: { pack: "pib-basic", id: "warm", intensity: 0.6 }, adjust: { contrast: 1.4, blur: 3 } });
    const edit = resetOps(find(doc, "a"));
    doc = run(doc, edit);
    expect(find(doc, "a").look).toBeUndefined();
    expect(find(doc, "a").adjust).toBeUndefined();
    doc = run(doc, edit, "undo");
    expect(find(doc, "a").look).toEqual({ pack: "pib-basic", id: "warm", intensity: 0.6 });
    expect(find(doc, "a").adjust).toEqual({ contrast: 1.4, blur: 3 });
    expect(resetOps(find(docOf(), "a"))).toBeNull();
  });
  it("apply to all copies the grade exactly (one batch) and undoes per clip", () => {
    let doc = docOf({ look: { pack: "pib-basic", id: "vivid", intensity: 0.7 }, adjust: { saturation: 1.5 } }, { adjust: { contrast: 1.3, vignette: 0.4 }, look: { pack: "pib-basic", id: "mono", intensity: 1 } });
    const before = JSON.stringify(doc);
    const edit = applyToAllOps(doc, find(doc, "a"));
    expect(edit?.ops).toHaveLength(1);
    doc = run(doc, edit);
    expect(find(doc, "b").look).toEqual({ pack: "pib-basic", id: "vivid", intensity: 0.7 });
    expect(find(doc, "b").adjust).toEqual({ saturation: 1.5 });
    doc = run(doc, edit, "undo");
    expect(JSON.stringify(doc)).toBe(before);
    expect(applyToAllOps(docOf(), find(docOf(), "a"))).toBeNull();
  });
  it("apply to all clears the look on clips when the source has none", () => {
    let doc = docOf({ adjust: { brightness: 0.2 } }, { look: { pack: "pib-basic", id: "cool", intensity: 1 } });
    doc = run(doc, applyToAllOps(doc, find(doc, "a")));
    expect(find(doc, "b").look).toBeUndefined();
    expect(find(doc, "b").adjust).toEqual({ brightness: 0.2 });
  });
});
