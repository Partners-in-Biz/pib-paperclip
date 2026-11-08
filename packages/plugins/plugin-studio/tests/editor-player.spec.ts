import { describe, expect, it } from "vitest";
import { clipAt, timelineEnd } from "../src/ui/editor/player-clips.js";
import type { EditDoc } from "../src/video-edit/timeline.js";

const clip = (id: string, start: number, inn: number, out: number, speed = 1) => ({ id, assetId: "a-" + id, version: 1, start, in: inn, out, speed, volume: 1, fadeIn: 0, fadeOut: 0, transitionIn: null });
const doc = { schemaVersion: 1, project: { size: "9:16", width: 1080, height: 1920, fps: 30 }, tracks: [{ id: "v1", kind: "video", clips: [clip("b", 4, 0, 6, 2), clip("a", 0, 2, 6)] }] } as unknown as EditDoc;

describe("player clip lookup", () => {
  it("finds the clip under the playhead, honouring speed", () => {
    expect(clipAt(doc, 1)?.id).toBe("a");
    expect(clipAt(doc, 4)?.id).toBe("b");
    expect(clipAt(doc, 6.9)?.id).toBe("b");
    expect(clipAt(doc, 7)).toBeNull();
  });
  it("computes the end and handles no doc", () => {
    expect(timelineEnd(doc)).toBe(7);
    expect(timelineEnd(null)).toBe(0);
    expect(clipAt(null, 0)).toBeNull();
  });
});
