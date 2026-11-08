import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyOps } from "../src/video-edit/ops.js";
import { FONT_IDS, FONTS } from "../src/video-edit/fonts.js";
import { normalizeEdit, type EditDoc } from "../src/video-edit/timeline.js";
import { createEditorStore, type EditorApi } from "../src/ui/editor/editor-store.js";
import { addTextOps, findTextClip, FONT_NAMES, formOf, overlayStyle, TEXT_FONTS, textClips, textEditOps, visibleText } from "../src/ui/editor/text-track.js";
const media = { id: "v1", assetId: "a1", version: 1, start: 0, in: 0, out: 10 };
const text = (id: string, start: number, duration: number, extra: Record<string, unknown> = {}) => ({ id, start, duration, text: `T ${id}`, ...extra });
const docOf = (texts: unknown[] | null): EditDoc =>
  normalizeEdit({ tracks: [{ id: "video", kind: "video", clips: [media] }, ...(texts ? [{ id: "titles", kind: "text", clips: texts }] : [])] });

describe("font list", () => {
  it("matches A5a's fonts.ts ids and families", () => {
    expect([...TEXT_FONTS]).toEqual([...FONT_IDS]);
    for (const id of FONT_IDS) expect(FONT_NAMES[id]).toBe(FONTS[id].family);
  });
});

describe("addTextOps", () => {
  it("creates a text track when there is none, and the worker accepts the batch", () => {
    const doc = docOf(null);
    const made = addTextOps(doc, 2);
    if ("error" in made) throw new Error(made.error);
    expect(made.ops.map((o) => o.op)).toEqual(["addTrack", "addClip"]);
    const next = applyOps(doc, made.ops);
    const added = findTextClip(next, made.clipId)!;
    expect(added.clip).toMatchObject({ start: 2, duration: 3, font: "sans", color: "#FFFFFF", fontSize: 64 });
  });
  it("uses the existing text track, skips a clip under the playhead and fits before the next one", () => {
    const doc = docOf([text("a", 0, 2), text("b", 3, 2)]);
    const made = addTextOps(doc, 1);
    if ("error" in made) throw new Error(made.error);
    expect(made.ops).toHaveLength(1);
    const added = findTextClip(applyOps(doc, made.ops), made.clipId)!;
    expect(added).toMatchObject({ trackId: "titles", clip: { start: 2, duration: 1 } });
  });
  it("refuses when there is no room", () => {
    const back2back = addTextOps(docOf([text("a", 0, 2), text("b", 2, 2)]), 1);
    expect(back2back).toMatchObject({ start: 4 }); // skips both touching clips
    expect(addTextOps(docOf([text("a", 0, 179.95)]), 1)).toHaveProperty("error"); // 3 min cap
    expect(addTextOps(null, 0)).toHaveProperty("error");
  });
});

describe("textEditOps", () => {
  const doc = docOf([text("a", 0, 4, { fadeIn: 1, fadeOut: 1 }), text("b", 5, 2)]);
  const a = findTextClip(doc, "a")!.clip;
  it("round-trips every field in one setProps op", () => {
    const form = { ...formOf(a), text: "Hello <b>there</b>", font: "serif", fontSize: "96", color: "#ff0000", x: "-120", y: "300", start: "0.5", duration: "4.4" };
    const made = textEditOps(a, form);
    if (!made || "error" in made) throw new Error("expected ops");
    expect(made.ops).toHaveLength(1);
    const back = findTextClip(applyOps(doc, made.ops), "a")!.clip;
    expect(back).toMatchObject({ text: "Hello <b>there</b>", font: "serif", fontSize: 96, color: "#FF0000", start: 0.5, duration: 4.4, transform: { x: -120, y: 300, scale: 1 } });
    expect(formOf(back)).toEqual({ ...form, color: "#FF0000" });
  });
  it("sends nothing when nothing changed, drops fades that no longer fit", () => {
    expect(textEditOps(a, formOf(a))).toBeNull();
    const made = textEditOps(a, { ...formOf(a), duration: "1" });
    if (!made || "error" in made) throw new Error("expected ops");
    expect(made.ops[0].props).toEqual({ duration: 1, fadeIn: 0, fadeOut: 0 });
    expect(() => applyOps(doc, made.ops)).not.toThrow();
  });
  it("refuses bad input before it reaches the worker", () => {
    for (const bad of [{ text: "  " }, { color: "red" }, { fontSize: "2" }, { start: "-1" }, { duration: "" }, { x: "abc" }]) {
      expect(textEditOps(a, { ...formOf(a), ...bad })).toHaveProperty("error");
    }
  });
  it("an overlapping move is refused by the worker, so the store keeps the old doc", async () => {
    let current = { id: "e1", revision: 1, doc };
    const api: EditorApi = {
      get: async () => current,
      applyOps: async ({ ops }) => {
        current = { ...current, revision: current.revision + 1, doc: applyOps(current.doc, ops) };
        return current;
      },
    };
    const store = createEditorStore(api);
    await store.load("e1");
    const bad = textEditOps(a, { ...formOf(a), start: "4" }) as { ops: unknown[] };
    expect(await store.applyOps(bad.ops)).toBe(false);
    expect(store.getState().revision).toBe(1);
    const good = textEditOps(a, { ...formOf(a), text: "Saved" }) as { ops: unknown[] };
    expect(await store.applyOps(good.ops)).toBe(true);
    expect(findTextClip(store.getState().doc, "a")!.clip.text).toBe("Saved");
  });
});

describe("Overlay", () => {
  const evil = '<img src=x onerror="alert(1)">';
  const doc = docOf([text("a", 0, 4, { text: evil, fadeIn: 2, transform: { x: 54, y: -96 } }), text("b", 5, 2)]);
  it("shows the clips at the playhead with their fade", () => {
    expect(visibleText(doc, 1).map((v) => [v.clip.id, v.opacity])).toEqual([["a", 0.5]]);
    expect(visibleText(doc, 4.5)).toEqual([]);
    expect(textClips(doc).map((c) => c.clip.id)).toEqual(["a", "b"]);
  });
  it("places the text where the render's drawtext puts it", () => {
    const a = findTextClip(doc, "a")!.clip;
    expect(a.text).toBe(evil); // stored as plain text
    expect(overlayStyle(a, doc.project, 0.5)).toMatchObject({ left: "55%", top: "45%", opacity: 0.5, color: "#FFFFFF", fontSize: "3.333cqh" }); // 1080x1920
  });
  it("renders text only as React text children, never as HTML, with the preview note", () => {
    const src = readFileSync(new URL("../src/ui/editor/Overlay.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|FontFace|@font-face/);
    expect(src).toContain("{clip.text}");
    expect(src).toContain("{PREVIEW_NOTE}");
  });
});
