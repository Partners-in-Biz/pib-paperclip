/** PAR-10175 (D4d2): the preview of animated text reads the same curves as the render (text-animation.ts). */
import { describe, expect, it } from "vitest";
import { normalizeEdit, type TextClip } from "../src/video-edit/timeline.js";
import { animatedOverlay, overlayStyle, textClips } from "../src/ui/editor/text-track.js";

const docOf = (extra: Record<string, unknown>) =>
  normalizeEdit({
    tracks: [
      { id: "video", kind: "video", clips: [{ id: "v1", assetId: "a1", version: 1, start: 0, in: 0, out: 10 }] },
      { id: "titles", kind: "text", clips: [{ id: "t1", start: 1, duration: 4, text: "One two three", ...extra }] },
    ],
  });
const clipOf = (extra: Record<string, unknown>): { clip: TextClip; project: { width: number; height: number } } => {
  const doc = docOf(extra);
  return { clip: textClips(doc)[0]!.clip, project: doc.project };
};

describe("animatedOverlay", () => {
  it("a clip without animation is overlayStyle as before", () => {
    const { clip, project } = clipOf({});
    expect(animatedOverlay(clip, project, 2, 1)).toEqual({ style: overlayStyle(clip, project, 1), units: null });
  });

  it("slideLeft enters from the right with opacity 0 and rests at the centre", () => {
    const { clip, project } = clipOf({ animation: { in: "slideLeft", inDuration: 1 } });
    const start = animatedOverlay(clip, project, 1, 1).style;
    expect(start.opacity).toBe(0);
    expect(parseFloat(String(start.left))).toBeCloseTo(50 + (216 / project.width) * 100, 2);
    const rest = animatedOverlay(clip, project, 2.5, 1).style;
    const plain = overlayStyle(clip, project, 1);
    expect(rest).toMatchObject({ left: plain.left, top: plain.top, opacity: 1 });
  });

  it("pop scales the text around its centre along the shared curve", () => {
    const { clip, project } = clipOf({ animation: { in: "pop", inDuration: 1 } });
    expect(animatedOverlay(clip, project, 1.6, 1).style.transform).toBe("translate(-50%, -50%) rotate(0deg) scale(1.1)");
    expect(animatedOverlay(clip, project, 1, 1).style.transform).toContain("scale(0)");
  });

  it("wordByWord lays every word out and hides the ones not shown yet; the exit hides the last first", () => {
    const { clip, project } = clipOf({ animation: { in: "wordByWord", inDuration: 2, out: "wordByWord", outDuration: 2 } });
    const hidden = (t: number) => animatedOverlay(clip, project, 1 + t, 1).units!.map((u) => u.hidden);
    expect(hidden(0)).toEqual([false, true, true]);
    expect(hidden(1.1)).toEqual([false, false, true]);
    expect(hidden(2.2)).toEqual([false, false, false]); // exit: all shown at its start
    expect(hidden(3.5)).toEqual([false, true, true]); // the last go first
    expect(animatedOverlay(clip, project, 1, 1).units!.map((u) => u.text).join("")).toBe("One two three");
  });

  it("mixed reveal presets split per phase: characters on a typewriter entry, words on a wordByWord exit", () => {
    const { clip, project } = clipOf({ animation: { in: "typewriter", inDuration: 1, out: "wordByWord", outDuration: 2 } });
    const at = (t: number) => animatedOverlay(clip, project, 1 + t, 1).units;
    expect(at(0.5)!.length).toBe(13); // one unit per character
    const exit = at(3.5)!; // 1.5 s into the 2 s exit
    expect(exit.map((u) => u.text.trim())).toEqual(["One", "two", "three"]);
    expect(exit.map((u) => u.hidden)).toEqual([false, true, true]);
    expect(at(1.5)).toBeNull(); // between the phases: no reveal split
    const rev = clipOf({ animation: { in: "wordByWord", inDuration: 1, out: "typewriter", outDuration: 2 } });
    expect(animatedOverlay(rev.clip, rev.project, 1.5, 1).units!.length).toBe(3);
    expect(animatedOverlay(rev.clip, rev.project, 4, 1).units!.length).toBe(13);
  });

  it("multiplies the clip's own opacity (fades, keyframes) with the animation's", () => {
    const { clip, project } = clipOf({ animation: { in: "fadeUp", inDuration: 1 } });
    expect(animatedOverlay(clip, project, 1.5, 0.5).style.opacity).toBe(0.25);
  });
});
