import { describe, expect, it } from "vitest";
import { clipDuration, EditError, editDuration, LIMITS, normalizeEdit, SIZES } from "../src/video-edit/timeline.js";

const media = (id: string, extra: Record<string, unknown> = {}) => ({ id, assetId: "asset-1", version: 1, in: 0, out: 4, start: 0, ...extra });
const edit = (tracks: unknown[], project: Record<string, unknown> = {}) => ({ schemaVersion: 1, project: { size: "9:16", fps: 30, ...project }, tracks });
const videoWith = (extra: Record<string, unknown>) => edit([{ id: "v", kind: "video", clips: [media("c", extra)] }]);

function refused(input: unknown): EditError {
  try {
    normalizeEdit(input);
  } catch (error) {
    expect(error).toBeInstanceOf(EditError);
    return error as EditError;
  }
  throw new Error("expected normalizeEdit to refuse the edit");
}

const full = edit(
  [
    { id: "v", kind: "video", clips: [media("a", { volume: 0.5, fadeIn: 0.5, transform: { x: 10, y: -20, scale: 1.2, rotate: 90, crop: { left: 0.1, top: 0, right: 0.1, bottom: 0.2 } } }), media("b", { start: 3.5, speed: 2, transitionIn: { type: "fade", duration: 0.5 } })] },
    { id: "o", kind: "overlay", clips: [media("logo", { start: 1, out: 2 })] },
    { id: "t", kind: "text", clips: [{ id: "title", text: "Hello", start: 0, duration: 2, font: "inter-bold", color: "#ff0000", fontSize: 72, fadeOut: 0.5 }] },
    { id: "cap", kind: "caption", clips: [{ id: "cc", start: 1, style: "karaoke", words: [{ text: "Buy", start: 0, end: 0.4 }, { text: "now", start: 0.4, end: 0.9 }] }] },
    { id: "m", kind: "audio", clips: [media("music", { out: 6, volume: 0.3, fadeOut: 1 })] },
  ],
  { size: "16:9", fps: 25 },
);

describe("video edit timeline", () => {
  it("round-trips: normalising twice or through JSON gives the same document", () => {
    const once = normalizeEdit(full);
    expect(normalizeEdit(once)).toEqual(once);
    expect(normalizeEdit(JSON.parse(JSON.stringify(once)))).toEqual(once);
    expect(once.project).toEqual({ size: "16:9", width: 1920, height: 1080, fps: 25 });
    expect(once.tracks.map((t) => t.kind)).toEqual(["video", "overlay", "text", "caption", "audio"]);
    expect(once.tracks[2].clips[0]).toMatchObject({ color: "#FF0000", font: "inter-bold", transitionIn: null });
  });

  it("fills defaults for an empty document", () => {
    expect(normalizeEdit({})).toEqual({ schemaVersion: 1, project: { size: "9:16", width: 1080, height: 1920, fps: 30 }, tracks: [] });
    const clip = normalizeEdit(videoWith({})).tracks[0].clips[0];
    expect(clip).toEqual({ id: "c", start: 0, assetId: "asset-1", version: 1, in: 0, out: 4, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, transform: { x: 0, y: 0, scale: 1, rotate: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 } }, transitionIn: null });
  });

  it("drops unknown fields everywhere", () => {
    const doc = normalizeEdit({
      ...edit([{ id: "v", kind: "video", muted: true, clips: [media("c", { effects: ["blur"], keyframes: [], transform: { x: 1, skew: 3, crop: { left: 0.1, feather: 2 } }, transitionIn: { type: "fade", duration: 1, easing: "in" } })] }], { size: "1:1", width: 9, bitrate: 5 }),
      title: "x",
    });
    expect(Object.keys(doc)).toEqual(["schemaVersion", "project", "tracks"]);
    expect(doc.project).toEqual({ size: "1:1", width: 1080, height: 1080, fps: 30 });
    expect(Object.keys(doc.tracks[0])).toEqual(["id", "kind", "clips"]);
    const clip = doc.tracks[0].clips[0] as unknown as Record<string, unknown>;
    expect(clip.effects).toBeUndefined();
    expect(clip.keyframes).toBeUndefined();
    expect(clip.transform).toEqual({ x: 1, y: 0, scale: 1, rotate: 0, crop: { left: 0.1, top: 0, right: 0, bottom: 0 } });
    expect(clip.transitionIn).toEqual({ type: "fade", duration: 1 });
  });

  it("maps every size preset to pixels and accepts only the four frame rates", () => {
    for (const [size, px] of Object.entries(SIZES)) expect(normalizeEdit(edit([], { size })).project).toMatchObject(px);
    expect(SIZES["4:5"]).toEqual({ width: 1080, height: 1350 });
    for (const fps of [24, 25, 30, 60]) expect(normalizeEdit(edit([], { fps })).project.fps).toBe(fps);
    for (const fps of [23.976, 29, 120, "30"]) expect(refused(edit([], { fps })).path).toBe("project.fps");
    expect(refused(edit([], { size: "3:2" })).path).toBe("project.size");
  });

  it.each([
    ["speed", LIMITS.speed[0], LIMITS.speed[1], [0.24, 4.01]],
    ["volume", LIMITS.volume[0], LIMITS.volume[1], [-0.01, 2.01]],
  ])("%s accepts its min and max and refuses out of range", (field, min, max, outside) => {
    expect(normalizeEdit(videoWith({ [field]: min })).tracks[0].clips[0]).toMatchObject({ [field]: min });
    expect(normalizeEdit(videoWith({ [field]: max })).tracks[0].clips[0]).toMatchObject({ [field]: max });
    for (const v of outside) expect(refused(videoWith({ [field]: v }))).toMatchObject({ reason: "out_of_range", path: `tracks[0].clips[0].${field}` });
    expect(refused(videoWith({ [field]: "1" })).reason).toBe("invalid");
    expect(refused(videoWith({ [field]: Number.NaN })).reason).toBe("invalid");
  });

  it.each([
    ["scale", LIMITS.scale, [0, 10.5]],
    ["rotate", LIMITS.rotate, [-361, 361]],
    ["x", LIMITS.offset, [-8001, 8001]],
    ["y", LIMITS.offset, [-8001, 8001]],
  ])("transform.%s accepts its limits and refuses out of range", (field, [min, max], outside) => {
    for (const v of [min, max]) expect(normalizeEdit(videoWith({ transform: { [field]: v } })).tracks[0].clips[0]).toMatchObject({ transform: { [field]: v } });
    for (const v of outside) expect(refused(videoWith({ transform: { [field]: v } }))).toMatchObject({ reason: "out_of_range", path: `tracks[0].clips[0].transform.${field}` });
  });

  it("crop: each side 0..1, and must leave some picture", () => {
    expect(normalizeEdit(videoWith({ transform: { crop: { left: 0.49, right: 0.5 } } })).tracks[0].clips[0]).toMatchObject({ transform: { crop: { left: 0.49, right: 0.5 } } });
    expect(refused(videoWith({ transform: { crop: { top: -0.1 } } })).path).toBe("tracks[0].clips[0].transform.crop.top");
    expect(refused(videoWith({ transform: { crop: { bottom: 1.1 } } })).path).toBe("tracks[0].clips[0].transform.crop.bottom");
    expect(refused(videoWith({ transform: { crop: { left: 0.5, right: 0.5 } } })).path).toBe("tracks[0].clips[0].transform.crop");
  });

  it("in/out, fades and the fade transition stay inside the clip", () => {
    expect(refused(videoWith({ in: 4, out: 4 })).path).toBe("tracks[0].clips[0].out");
    expect(refused(videoWith({ in: -1 })).path).toBe("tracks[0].clips[0].in");
    expect(refused(videoWith({ out: undefined })).reason).toBe("invalid");
    expect(normalizeEdit(videoWith({ fadeIn: 2, fadeOut: 2 })).tracks[0].clips[0]).toMatchObject({ fadeIn: 2, fadeOut: 2 });
    expect(refused(videoWith({ fadeIn: 2.5, fadeOut: 2 })).path).toBe("tracks[0].clips[0].fadeOut");
    expect(refused(videoWith({ fadeIn: 4.1 })).path).toBe("tracks[0].clips[0].fadeIn");
    expect(refused(videoWith({ speed: 4, fadeIn: 1.1 })).reason).toBe("out_of_range"); // 4 s at 4x lasts 1 s
    expect(normalizeEdit(videoWith({ transitionIn: { type: "fade", duration: LIMITS.maxTransition }, out: 10 })).tracks[0].clips[0]).toMatchObject({ transitionIn: { duration: 5 } });
    expect(refused(videoWith({ transitionIn: { type: "fade", duration: 5.1 }, out: 10 })).path).toBe("tracks[0].clips[0].transitionIn.duration");
    expect(refused(videoWith({ transitionIn: { type: "fade", duration: 0 } })).reason).toBe("out_of_range");
    expect(refused(videoWith({ transitionIn: { type: "fade", duration: 4.5 } })).message).toContain("longer than the clip");
    expect(refused(videoWith({ transitionIn: { type: "wipe", duration: 1 } })).path).toBe("tracks[0].clips[0].transitionIn.type");
  });

  it("checks asset ids, versions, clip ids and track kinds", () => {
    expect(refused(videoWith({ assetId: "../x" })).path).toBe("tracks[0].clips[0].assetId");
    for (const version of [0, 1.5, "2"]) expect(refused(videoWith({ version })).path).toBe("tracks[0].clips[0].version");
    expect(refused(edit([{ id: "v", kind: "video", clips: [media("a"), media("a", { start: 5 })] }]))).toMatchObject({ reason: "duplicate", path: "tracks[0].clips[1].id" });
    expect(refused(edit([{ id: "v", kind: "video" }, { id: "v", kind: "audio" }])).reason).toBe("duplicate");
    expect(refused(edit([{ id: "v", kind: "sticker" }])).path).toBe("tracks[0].kind");
    expect(refused(edit([{ id: "bad id", kind: "video" }])).path).toBe("tracks[0].id");
  });

  it("refuses overlapping clips on a track, except by the later clip's transition", () => {
    expect(refused(edit([{ id: "v", kind: "video", clips: [media("a", { start: 3 }), media("b")] }]))).toMatchObject({ reason: "overlap", path: "tracks[0].clips[0].start" });
    expect(normalizeEdit(edit([{ id: "v", kind: "video", clips: [media("a"), media("b", { start: 3, transitionIn: { type: "fade", duration: 1 } })] }])).tracks[0].clips).toHaveLength(2);
    expect(refused(edit([{ id: "v", kind: "video", clips: [media("a"), media("b", { start: 2.9, transitionIn: { type: "fade", duration: 1 } })] }])).reason).toBe("overlap");
    expect(normalizeEdit(edit([{ id: "v", kind: "video", clips: [media("a")] }, { id: "w", kind: "overlay", clips: [media("b")] }])).tracks).toHaveLength(2);
  });

  it("text clips: text, duration, colour and font size limits", () => {
    const textEdit = (c: Record<string, unknown>) => edit([{ id: "t", kind: "text", clips: [{ id: "x", text: "Hi", duration: 2, ...c }] }]);
    expect(normalizeEdit(textEdit({})).tracks[0].clips[0]).toMatchObject({ color: "#FFFFFF", fontSize: 64, font: null });
    expect(normalizeEdit(textEdit({ text: "a".repeat(LIMITS.maxText) })).tracks[0].clips[0]).toMatchObject({ text: "a".repeat(500) });
    expect(refused(textEdit({ text: "a".repeat(501) })).reason).toBe("out_of_range");
    expect(refused(textEdit({ text: "  " })).reason).toBe("invalid");
    expect(refused(textEdit({ color: "red" })).path).toBe("tracks[0].clips[0].color");
    for (const fontSize of [8, 400]) expect(normalizeEdit(textEdit({ fontSize })).tracks[0].clips[0]).toMatchObject({ fontSize });
    for (const fontSize of [7, 401]) expect(refused(textEdit({ fontSize })).path).toBe("tracks[0].clips[0].fontSize");
    expect(refused(textEdit({ duration: 0 })).path).toBe("tracks[0].clips[0].duration");
    expect(refused(textEdit({ duration: 181 })).reason).toBe("out_of_range");
  });

  it("caption words: ordered, positive length, at least one, at most the word limit", () => {
    const cap = (words: unknown[], style?: string) => edit([{ id: "c", kind: "caption", clips: [{ id: "x", start: 0, style, words }] }]);
    const w = (start: number, end: number) => ({ text: "w", start, end });
    expect(normalizeEdit(cap([w(0, 1), w(1, 2)])).tracks[0].clips[0]).toMatchObject({ style: "plain", words: [w(0, 1), w(1, 2)] });
    expect(refused(cap([w(1, 1)]))).toMatchObject({ reason: "out_of_range", path: "tracks[0].clips[0].words[0].end" });
    expect(refused(cap([w(0, 2), w(1, 3)]))).toMatchObject({ reason: "overlap", path: "tracks[0].clips[0].words[1].start" });
    expect(refused(cap([])).path).toBe("tracks[0].clips[0].words");
    expect(refused(cap([w(0, 1)], "neon")).path).toBe("tracks[0].clips[0].style");
    const many = Array.from({ length: LIMITS.maxWords + 1 }, (_, i) => w(i * 0.05, i * 0.05 + 0.05));
    expect(normalizeEdit(cap(many.slice(0, LIMITS.maxWords))).tracks[0].clips[0]).toBeTruthy();
    expect(refused(cap(many)).reason).toBe("too_many");
  });

  it("caps tracks, clips per track and total length at 180 s", () => {
    const tracks = Array.from({ length: LIMITS.maxTracks + 1 }, (_, i) => ({ id: `t${i}`, kind: "audio" }));
    expect(normalizeEdit(edit(tracks.slice(0, LIMITS.maxTracks))).tracks).toHaveLength(20);
    expect(refused(edit(tracks))).toMatchObject({ reason: "too_many", path: "tracks" });
    const clips = Array.from({ length: LIMITS.maxClipsPerTrack + 1 }, (_, i) => media(`c${i}`, { out: 0.5, start: i * 0.5 }));
    expect(normalizeEdit(edit([{ id: "v", kind: "video", clips: clips.slice(0, 200) }])).tracks[0].clips).toHaveLength(200);
    expect(refused(edit([{ id: "v", kind: "video", clips }])).reason).toBe("too_many");
    expect(editDuration(normalizeEdit(videoWith({ start: 176 })))).toBe(180);
    expect(refused(videoWith({ start: 176.5 }))).toMatchObject({ reason: "too_long", path: "tracks" });
    expect(refused(videoWith({ start: 181 })).path).toBe("tracks[0].clips[0].start");
  });

  it("editDuration is the end of the last clip on any track, accounting for speed", () => {
    const doc = normalizeEdit(full);
    expect(clipDuration(doc.tracks[0].clips[1])).toBe(2); // 4 s at 2x
    expect(clipDuration(doc.tracks[3].clips[0])).toBe(0.9);
    expect(editDuration(doc)).toBe(6); // music 0..6
    expect(editDuration(normalizeEdit({}))).toBe(0);
  });

  it("refuses other schema versions with a typed error", () => {
    expect(refused({ schemaVersion: 4 })).toMatchObject({ reason: "unsupported_version", path: "schemaVersion", code: "bad_edit" });
    expect(normalizeEdit({ project: {} }).schemaVersion).toBe(1);
  });
});
