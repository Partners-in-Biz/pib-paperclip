import { describe, expect, it } from "vitest";
import { applyOps } from "../src/video-edit/ops.js";
import { normalizeEdit, type Clip, type EditDoc, type MediaClip } from "../src/video-edit/timeline.js";
import { createEditorStore } from "../src/ui/editor/editor-store.js";
import { addClipOps, freeId, IMAGE_SECONDS, reorderResult, splitTarget } from "../src/ui/editor/timeline-view.js";

const media = (id: string, start: number, out: number, assetId = "a1") => ({ id, assetId, version: 1, start, in: 0, out });
const docOf = (clips: ReturnType<typeof media>[], extra: unknown[] = []): EditDoc => normalizeEdit({ tracks: [{ id: "video", kind: "video", clips }, ...extra] });
const order = (doc: EditDoc) => (doc.tracks[0].clips as MediaClip[]).map((c) => `${c.id}@${c.start}`);
const track = (doc: EditDoc) => doc.tracks[0].clips as Clip[];

describe("splitTarget", () => {
  const doc = docOf([media("a", 0, 4), media("b", 4, 6)]);
  it("cuts the selected clip when the playhead is inside it, else the clip under the playhead", () => {
    expect(splitTarget(doc, "b", 5)).toEqual({ clipId: "b", at: 5 });
    expect(splitTarget(doc, "b", 2)).toEqual({ clipId: "a", at: 2 });
    expect(splitTarget(doc, null, 2.0004)).toEqual({ clipId: "a", at: 2 });
  });
  it("refuses an edge, a gap and an empty edit", () => {
    expect(splitTarget(doc, null, 0.05)).toBeNull();
    expect(splitTarget(doc, null, 3.95)).toBeNull();
    expect(splitTarget(doc, null, 20)).toBeNull();
    expect(splitTarget(docOf([]), null, 1)).toBeNull();
    expect(splitTarget(null, null, 1)).toBeNull();
  });
  it("its op is one valid batch the worker accepts", () => {
    const t = splitTarget(doc, null, 1.5)!;
    const next = applyOps(doc, [{ op: "split", ...t }]);
    expect(order(next)).toEqual(["a@0", "a-2@1.5", "b@4"]);
  });
});

describe("reorderResult", () => {
  const doc = docOf([media("a", 0, 2), media("b", 2, 3), media("c", 5, 1)]);
  it("drag later: the passed clips shift left, the dragged one takes the freed slot, in one batch", () => {
    const r = reorderResult("video", track(doc), "a", 5)!;
    expect(r.ops.map((o) => o.op)).toEqual(["delete", "move", "move", "addClip"]);
    expect(order(applyOps(doc, r.ops))).toEqual(["b@0", "c@3", "a@4"]);
  });
  it("drag earlier keeps the total length and the gaps", () => {
    const gappy = docOf([media("a", 0, 2), media("b", 3, 2), media("c", 6, 1)]);
    const r = reorderResult("video", track(gappy), "c", -6)!;
    const next = applyOps(gappy, r.ops);
    expect(order(next)).toEqual(["c@0", "a@1", "b@4"]);
  });
  it("is null when the drop leaves the order alone, or for a bad clip", () => {
    expect(reorderResult("video", track(doc), "b", 0.4)).toBeNull();
    expect(reorderResult("video", track(doc), "zz", 3)).toBeNull();
    expect(reorderResult("video", track(doc), "a", Number.NaN)).toBeNull();
  });
  it("works across 20+ clips (every result is a valid doc)", () => {
    const many = docOf(Array.from({ length: 24 }, (_, i) => media(`c${i}`, i, 1)));
    for (const [id, d] of [["c0", 30], ["c23", -30], ["c10", 4.6], ["c10", -4.6]] as const) {
      const next = applyOps(many, reorderResult("video", track(many), id, d)!.ops);
      expect(next.tracks[0].clips).toHaveLength(24);
    }
  });
});

describe("addClipOps (join)", () => {
  it("appends a video at the end of the video track", () => {
    const doc = docOf([media("clip-1", 0, 4)]);
    const made = addClipOps(doc, { id: "v2", kind: "video", version: 3, seconds: 2.5004 });
    if ("error" in made) throw new Error(made.error);
    const next = applyOps(doc, made.ops);
    expect(order(next)).toEqual(["clip-1@0", "clip-2@4"]);
    expect((next.tracks[0].clips[1] as MediaClip)).toMatchObject({ assetId: "v2", version: 3, in: 0, out: 2.5 });
  });
  it("creates the video track on an empty edit; a picture shows IMAGE_SECONDS", () => {
    const empty = normalizeEdit({ tracks: [{ id: "music", kind: "audio", clips: [] }] });
    const made = addClipOps(empty, { id: "img1", kind: "image", version: 1 });
    if ("error" in made) throw new Error(made.error);
    const next = applyOps(empty, made.ops);
    expect(next.tracks.map((t) => t.kind)).toEqual(["video", "audio"]);
    expect(next.tracks[0].clips[0]).toMatchObject({ assetId: "img1", start: 0, out: IMAGE_SECONDS });
  });
  it("cuts a long video to the 180 s limit and refuses a full track or bad picks", () => {
    const doc = docOf([media("x", 0, 170)]);
    const made = addClipOps(doc, { id: "v", kind: "video", version: 1, seconds: 60 });
    if ("error" in made) throw new Error(made.error);
    expect(applyOps(doc, made.ops).tracks[0].clips[1]).toMatchObject({ start: 170, out: 10 });
    expect(addClipOps(docOf([media("x", 0, 180)]), { id: "v", kind: "video", version: 1, seconds: 5 })).toHaveProperty("error");
    expect(addClipOps(doc, { id: "v", kind: "video", version: 1 })).toHaveProperty("error");
    expect(addClipOps(doc, { id: "p", kind: "pdf", version: 1 })).toHaveProperty("error");
  });
  it("freeId skips used track and clip ids", () => {
    expect(freeId(docOf([media("clip-1", 0, 1), media("clip-1-2", 1, 1)]), "clip-1")).toBe("clip-1-3");
    expect(freeId(null, "video")).toBe("video");
  });
});

describe("a 3-clip edit built through the store survives a reload", () => {
  it("one batch per gesture, and the reloaded doc equals the built one", async () => {
    // A fake worker: applies the batch with the real ops and keeps the saved doc as JSON, like the database row.
    let saved = JSON.stringify({ id: "e1", revision: 1, doc: normalizeEdit({}) });
    const batches: unknown[][] = [];
    const store = createEditorStore({
      get: async () => JSON.parse(saved),
      applyOps: async ({ baseRevision, ops }) => {
        const row = JSON.parse(saved);
        if (row.revision !== baseRevision) throw Object.assign(new Error("edit_conflict"), { code: "edit_conflict" });
        batches.push(ops);
        const next = { ...row, revision: row.revision + 1, doc: applyOps(row.doc, ops) };
        saved = JSON.stringify(next);
        return next;
      },
    });
    await store.load("e1");
    const add = async (pick: Parameters<typeof addClipOps>[1]) => {
      const made = addClipOps(store.getState().doc, pick);
      if ("error" in made) throw new Error(made.error);
      expect(await store.applyOps(made.ops)).toBe(true);
    };
    await add({ id: "v1", kind: "video", version: 1, seconds: 4 });
    await add({ id: "img", kind: "image", version: 1 });
    await add({ id: "v2", kind: "video", version: 2, seconds: 2 });
    const split = splitTarget(store.getState().doc, null, 1)!;
    expect(await store.applyOps([{ op: "split", ...split }])).toBe(true);
    const r = reorderResult("video", track(store.getState().doc!), "clip-3", -8)!;
    expect(await store.applyOps(r.ops)).toBe(true);
    expect(batches).toHaveLength(5);
    const built = store.getState().doc;
    expect(store.getState().revision).toBe(6);
    const reloaded = createEditorStore({ get: async () => JSON.parse(saved), applyOps: async () => null });
    await reloaded.load("e1");
    expect(reloaded.getState().doc).toEqual(built);
    expect(order(reloaded.getState().doc!)).toEqual(["clip-3@0", "clip-1@2", "clip-1-2@3", "clip-2@6"]);
  });
});
