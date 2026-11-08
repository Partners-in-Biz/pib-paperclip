import { describe, expect, it } from "vitest";
import { applyOps } from "../src/video-edit/ops.js";
import { captionLines } from "../src/video-edit/compile-text.js";
import { CAPTION_STYLES, normalizeEdit, type EditDoc } from "../src/video-edit/timeline.js";
import {
  addCaptionOps, CAPTION_STYLE_IDS, captionClips, captionEditOps, captionStyle, findCaptionClip, formOf, lineOf, respan, retext, spreadWords,
  STYLE_LOOK, visibleCaptions, wordsOf,
} from "../src/ui/editor/caption-timing.js";

const media = { id: "v1", assetId: "a1", version: 1, start: 0, in: 0, out: 10 };
const cap = (id: string, start: number, style = "plain") => ({ id, start, style, words: [{ text: "one", start: 0, end: 1 }, { text: "two", start: 1, end: 2 }] });
const docOf = (caps: unknown[] | null): EditDoc =>
  normalizeEdit({ tracks: [{ id: "video", kind: "video", clips: [media] }, ...(caps ? [{ id: "subs", kind: "caption", clips: caps }] : [])] });
const ok = <T extends object>(r: T | { error: string }): T => {
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("styles", () => {
  it("equal A5a's caption styles", () => {
    expect([...CAPTION_STYLE_IDS]).toEqual([...CAPTION_STYLES]);
    expect(Object.keys(STYLE_LOOK)).toEqual([...CAPTION_STYLES]);
  });
});

describe("spreadWords", () => {
  it("times words evenly over the span, without gaps or overlaps", () => {
    const w = spreadWords(["a", "b", "c"], 3);
    expect(w).toEqual([{ text: "a", start: 0, end: 1 }, { text: "b", start: 1, end: 2 }, { text: "c", start: 2, end: 3 }]);
    const odd = spreadWords(["a", "b", "c"], 1);
    expect(odd[2].end).toBe(1);
    for (let i = 1; i < odd.length; i++) expect(odd[i].start).toBe(odd[i - 1].end);
  });
  it("keeps every word a positive length, even for a tiny span", () => {
    for (const w of spreadWords(["a", "b", "c", "d"], 0)) expect(w.end).toBeGreaterThan(w.start);
  });
  it("is empty for no words; wordsOf splits on any whitespace and cuts long words", () => {
    expect(spreadWords([], 2)).toEqual([]);
    expect(wordsOf("  hi \t there\nyou ")).toEqual(["hi", "there", "you"]);
    expect(wordsOf("x".repeat(150))[0]).toHaveLength(100);
  });
});

describe("addCaptionOps", () => {
  it("creates a caption track when there is none, and the worker accepts the batch", () => {
    const doc = docOf(null);
    const made = ok(addCaptionOps(doc, 1, "hello brave world\nsecond line", "karaoke"));
    expect(made.ops.map((o) => o.op)).toEqual(["addTrack", "addClip", "addClip"]);
    const next = applyOps(doc, made.ops);
    const clips = captionClips(next);
    expect(clips.map((c) => [c.clip.start, c.clip.style])).toEqual([[1, "karaoke"], [2.2, "karaoke"]]);
    expect(findCaptionClip(next, made.clipId)?.clip.words).toHaveLength(3);
    expect(normalizeEdit(JSON.parse(JSON.stringify(next)))).toEqual(next);
  });
  it("skips a caption under the playhead and refuses when it would hit the next one", () => {
    const doc = docOf([cap("a", 0), cap("b", 4)]);
    expect(ok(addCaptionOps(doc, 1, "hi"))).toMatchObject({ start: 2 });
    expect(addCaptionOps(doc, 1, "a b c d e f g h i j k l")).toHaveProperty("error");
  });
  it("refuses empty text, an unloaded edit and a run past 180 s", () => {
    expect(addCaptionOps(docOf(null), 0, "  \n ")).toHaveProperty("error");
    expect(addCaptionOps(null, 0, "hi")).toHaveProperty("error");
    expect(addCaptionOps(docOf(null), 179.5, "one two three four five six")).toHaveProperty("error");
  });
});

describe("captionEditOps", () => {
  const doc = docOf([cap("a", 1)]);
  const clip = captionClips(doc)[0].clip;
  it("returns null when nothing changed", () => expect(captionEditOps(clip, formOf(clip))).toBeNull());
  it("changes only style and start as a minimal setProps that round-trips through normalizeEdit", () => {
    const made = ok(captionEditOps(clip, { ...formOf(clip), style: "bold", start: "2.5" })!);
    expect(made.ops).toEqual([{ op: "setProps", clipId: "a", props: { style: "bold", start: 2.5 } }]);
    const next = applyOps(doc, made.ops);
    expect(captionClips(next)[0].clip).toMatchObject({ style: "bold", start: 2.5 });
    expect(normalizeEdit(JSON.parse(JSON.stringify(next)))).toEqual(next);
  });
  it("edits word timings and re-spreads new wording", () => {
    const form = formOf(clip);
    form.words[1] = { ...form.words[1], start: "1.5", end: "3" };
    const made = ok(captionEditOps(clip, form)!);
    const next = applyOps(doc, made.ops);
    expect(captionClips(next)[0].clip.words[1]).toEqual({ text: "two", start: 1.5, end: 3 });
    const re = retext(formOf(clip), "a b c d");
    expect(re.words.map((w) => w.text)).toEqual(["a", "b", "c", "d"]);
    expect(re.words[3].end).toBe("2");
    const spread = ok(captionEditOps(clip, respan({ ...formOf(clip), words: form.words }, 4))!);
    expect(captionClips(applyOps(doc, spread.ops))[0].clip.words).toEqual([{ text: "one", start: 0, end: 2 }, { text: "two", start: 2, end: 4 }]);
  });
  it("explains bad input in words", () => {
    const f = formOf(clip);
    for (const bad of [
      { ...f, start: "" }, { ...f, start: "-1" }, { ...f, start: "181" }, { ...f, words: [] },
      { ...f, words: [{ text: "a b", start: "0", end: "1" }] }, { ...f, words: [{ text: "a", start: "1", end: "1" }] },
      { ...f, words: [{ text: "a", start: "0", end: "2" }, { text: "b", start: "1", end: "3" }] },
      { ...f, words: [{ text: "", start: "0", end: "1" }] }, { ...f, start: "179", words: [{ text: "a", start: "0", end: "5" }] },
    ]) expect(captionEditOps(clip, bad)).toHaveProperty("error");
  });
});

describe("overlay", () => {
  it("breaks lines like the render and flags spoken / active words", () => {
    const words = [{ text: "aaaa", start: 0, end: 1 }, { text: "bbbb", start: 1, end: 2 }, { text: "cccc", start: 2.2, end: 3 }, { text: "dddd", start: 4, end: 5 }];
    for (const max of [8, 24, 42]) {
      const lines = captionLines(words, max);
      for (const l of lines) expect(lineOf(words, l[0].start, max)).toEqual(l);
    }
    const doc = docOf([{ ...cap("k", 1, "karaoke") }]);
    expect(visibleCaptions(doc, 0.5)).toEqual([]);
    expect(visibleCaptions(doc, 1.5)[0].words).toEqual([{ text: "one", spoken: true, active: true }, { text: "two", spoken: false, active: false }]);
    expect(visibleCaptions(doc, 2.5)[0].words.map((w) => w.spoken)).toEqual([true, true]);
    expect(visibleCaptions(doc, 3)).toEqual([]);
  });
  it("places a style like the render", () => {
    const s = captionStyle("bold", { width: 1080, height: 1920 });
    expect(s.bottom).toBe("28%");
    expect(s.fontWeight).toBe(800);
    expect(captionStyle("plain", { width: 1080, height: 1920 }).fontWeight).toBe(400);
  });
});
