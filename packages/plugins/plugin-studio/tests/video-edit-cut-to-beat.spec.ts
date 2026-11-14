/** Cut-to-beat (PAR-8279 D4e): trim ops that end every clip of a track on a beat, saved through apply-ops. */
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { BEATS_ALGO } from "../src/video-edit/beats.js";
import { cutToBeatAction, cutToBeatOps } from "../src/video-edit/cut-to-beat.js";
import { applyOps } from "../src/video-edit/ops.js";
import { clipDuration, normalizeEdit, type EditDoc } from "../src/video-edit/timeline.js";

const v = (id: string, start: number, len: number, extra: object = {}) => ({ id, assetId: `a-${id}`, version: 1, in: 1, out: 1 + len, start, ...extra });
const doc = normalizeEdit({
  tracks: [
    { id: "main", kind: "video", clips: [v("c1", 0, 2.3), v("c2", 2.3, 2.6), v("c3", 4.9, 2.3)] },
    { id: "music", kind: "audio", clips: [{ id: "m1", assetId: "song", version: 1, in: 0, out: 30, start: 0 }] },
  ],
});
// 120 BPM from 0 s.
const beats = Array.from({ length: 60 }, (_, i) => i * 0.5);

vi.mock("../src/video-edit/store.js", () => ({ getVideoEdit: async () => ({ id: "e1", revision: 3, client: null, doc }) }));
vi.mock("../src/video-edit/render-pipeline.js", () => ({ resolveInputs: async () => [{ assetId: "song", version: 1, key: "k", mime: "audio/wav", kind: "audio", bytes: 1 }] }));
const applied = vi.hoisted(() => [] as unknown[]);
vi.mock("../src/video-edit/actions.js", () => ({ applyOpsAction: async (_c: unknown, _co: string, params: unknown) => (applied.push(params), { revision: 4 }) }));

const ends = (d: EditDoc, trackId: string) => d.tracks.find((t) => t.id === trackId)!.clips.map((c) => Math.round((c.start + clipDuration(c)) * 1000) / 1000);
const ctx = {
  state: { get: async () => ({ algo: BEATS_ALGO, tempo: 120, beats }), set: async () => undefined },
  logger: { info: () => undefined },
} as unknown as PluginContext;

describe("cutToBeatOps", () => {
  it("ends every clip on the latest beat before its end, later clips moving up", () => {
    const ops = cutToBeatOps(doc, "main", beats, 0.501);
    expect(ops).toEqual([
      { op: "trim", clipId: "c1", out: 3, ripple: true },
      { op: "trim", clipId: "c2", out: 3.5, ripple: true },
      { op: "trim", clipId: "c3", out: 3, ripple: true },
    ]);
    const out = applyOps(doc, ops);
    expect(ends(out, "main")).toEqual([2, 4.5, 6.5]);
    expect(out.tracks[0]!.clips.map((c) => c.start)).toEqual([0, 2, 4.5]);
  });

  it("uses the clip's speed and leaves clips already on a beat, past the beats, or too short", () => {
    const d = normalizeEdit({ tracks: [{ id: "main", kind: "video", clips: [v("fast", 0, 4.2, { speed: 2 }), v("on", 2.1, 0.4), v("tiny", 2.5, 0.05), v("tail", 2.55, 30)] }] });
    // fast: 0..2.1 -> beat 2.0 (out 1 + 2 * 2); on: 2.0..2.4 has no beat over 0.1 s after its start; tiny too short; tail past the beats.
    expect(cutToBeatOps(d, "main", beats.slice(0, 10), 0.501)).toEqual([{ op: "trim", clipId: "fast", out: 5, ripple: true }]);
    expect(cutToBeatOps(d, "main", [0.5, 1, 1.5, 2.1], 0.501)).toEqual([]);
  });

  it("cuts only video and overlay tracks", () => {
    expect(() => cutToBeatOps(doc, "music", beats, 1)).toThrow(/audio track/);
    expect(() => cutToBeatOps(doc, "nope", beats, 1)).toThrow(/not in this video edit/);
  });
});

describe("cutToBeatAction", () => {
  it("dryRun returns the ops unsaved; every 2 cuts on every other beat", async () => {
    const out = await cutToBeatAction(ctx, "co", { editId: "e1", baseRevision: 3, musicClipId: "m1", every: 2, dryRun: true }, { agentId: "ag" });
    expect(out.ops.map((o) => (o as { out: number }).out)).toEqual([3, 3, 3]);
    expect(ends(applyOps(doc, out.ops), "main")).toEqual([2, 4, 6]);
    expect(out.cutToBeat).toEqual({ trackId: "main", cuts: 3, tempo: 120, every: 2 });
    expect(applied).toEqual([]);
  });

  it("saves through apply-ops at baseRevision", async () => {
    const out = await cutToBeatAction(ctx, "co", { editId: "e1", baseRevision: 3, musicClipId: "m1" }, { agentId: "ag" });
    expect(applied).toEqual([{ editId: "e1", baseRevision: 3, ops: out.ops }]);
    expect(out).toMatchObject({ revision: 4, cutToBeat: { cuts: 3 } });
  });

  it("refuses a stale revision, a bad every and cutting the music's own track", async () => {
    await expect(cutToBeatAction(ctx, "co", { editId: "e1", baseRevision: 2, musicClipId: "m1" }, {})).rejects.toThrow(/revision 3/);
    await expect(cutToBeatAction(ctx, "co", { editId: "e1", baseRevision: 3, musicClipId: "m1", every: 3 }, {})).rejects.toThrow(/every must be/);
    await expect(cutToBeatAction(ctx, "co", { editId: "e1", baseRevision: 3, musicClipId: "c1", trackId: "main" }, {})).rejects.toThrow(/track being cut/);
  });
});
