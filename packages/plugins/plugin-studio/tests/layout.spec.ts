import { describe, expect, it } from "vitest";
import { canConnect } from "../src/canvas-rules.js";
import { normalizeDoc } from "../src/canvas.js";
import { takeTextDraft, textDrafts, writeCardText } from "../src/canvas-layout.js";
import { coverCrop, fileStem, LAYOUT_SIZES, layoutInputs, layoutOptions, pageOrder, partText, planPage, sizeById, splitParts, wrapLines, writingTaskDescription } from "../src/layout.js";
import { crc32, makePdf, makeZip } from "../src/ui/export-files.js";

const measure = (t: string, size = 10) => t.length * size * 0.5;
const opts = (over = {}) => layoutOptions(over);

describe("sizes", () => {
  it("match what the stores ask for", () => {
    expect(sizeById("app-store-iphone")).toMatchObject({ width: 1320, height: 2868 });
    expect(sizeById("app-store-ipad")).toMatchObject({ width: 2064, height: 2752 });
    expect(sizeById("play-phone")).toMatchObject({ width: 1080, height: 1920 });
    expect(sizeById("play-feature")).toMatchObject({ width: 1024, height: 500 });
    expect(new Set(LAYOUT_SIZES.map((s) => s.id)).size).toBe(LAYOUT_SIZES.length);
  });
  it("falls back for an unknown size, and for unknown settings", () => {
    expect(sizeById("nope").id).toBe("social-portrait");
    expect(layoutOptions({ position: "sideways", font: "comic" })).toMatchObject({ position: "top", font: "sans" });
  });
});

describe("parts", () => {
  it("split on a line holding only ---, and pick one", () => {
    const text = "One\n---\nTwo words\n  ---  \n\nThree\n---\n";
    expect(splitParts(text)).toEqual(["One", "Two words", "Three"]);
    expect(partText(text, "2")).toBe("Two words");
    expect(partText(text, "9")).toBe("");
    expect(partText("All of it", undefined)).toBe("All of it");
    expect(splitParts("a --- b")).toEqual(["a --- b"]);
    expect(splitParts(undefined)).toEqual([]);
  });
});

describe("wrapping", () => {
  it("wraps at the width, keeps typed line breaks, and never loses a long word", () => {
    expect(wrapLines("aaa bbb ccc", 35, (t) => t.length * 5)).toEqual(["aaa bbb", "ccc"]);
    expect(wrapLines("one\ntwo", 500, (t) => t.length)).toEqual(["one", "two"]);
    expect(wrapLines("supercalifragilistic ok", 20, (t) => t.length * 5)).toEqual(["supercalifragilistic", "ok"]);
    expect(wrapLines("first\n\nsecond\n\n", 500, (t) => t.length)).toEqual(["first", "", "second"]);
  });
});

describe("the page plan", () => {
  it("keeps every line inside the margins at every size", () => {
    for (const size of LAYOUT_SIZES) {
      for (const style of ["headline", "body"] as const) {
        for (const position of ["top", "middle", "bottom", "below"] as const) {
          const plan = planPage(size.width, size.height, "A caption long enough that it has to wrap onto a few lines on most pages", opts({ style, position }), measure);
          const widest = Math.max(...plan.lines.map((l) => measure(l, plan.fontSize)));
          expect(widest, `${size.id} ${style} ${position}`).toBeLessThanOrEqual(size.width);
          expect(plan.y, `${size.id} ${position} top`).toBeGreaterThanOrEqual(0);
          expect(plan.y + plan.lines.length * plan.lineHeight, `${size.id} ${style} ${position} bottom`).toBeLessThanOrEqual(size.height);
        }
      }
    }
  });
  it("shrinks long words to fit, and says so when even the smallest size can't hold them", () => {
    const short = planPage(1080, 1350, "Short", opts(), measure);
    const long = planPage(1080, 1350, "word ".repeat(60), opts(), measure);
    expect(long.fontSize).toBeLessThan(short.fontSize);
    expect(short.clipped).toBe(false);
    expect(planPage(1080, 1350, "word ".repeat(2000), opts(), measure).clipped).toBe(true);
  });
  it("puts words under the picture on a paper panel for book pages", () => {
    const plan = planPage(3300, 2550, "Thandi looked up at the sky.", opts({ position: "below", style: "body" }), measure);
    expect(plan.panel).toBeTruthy();
    expect(plan.image.height + plan.panel!.height).toBe(2550);
    expect(plan.y).toBeGreaterThanOrEqual(plan.panel!.y);
    expect(plan.fade).toBeNull();
  });
  it("fades behind words on the picture", () => {
    expect(planPage(1320, 2868, "Hi", opts({ position: "top" }), measure).fade).toMatchObject({ from: 0 });
    expect(planPage(1320, 2868, "Hi", opts({ position: "bottom" }), measure).fade).toMatchObject({ from: 2868 });
  });
  it("aligns from the margin or the centre", () => {
    expect(planPage(1000, 1000, "Hi", opts({ align: "center" }), measure).x).toBe(500);
    expect(planPage(1000, 1000, "Hi", opts({ align: "left" }), measure).x).toBeLessThan(100);
  });
});

describe("the crop", () => {
  it("fills the box without stretching", () => {
    const wide = coverCrop(1000, 500, { width: 500, height: 500 });
    expect(wide).toMatchObject({ width: 500, height: 500, x: 250, y: 0 });
    const tall = coverCrop(500, 1000, { width: 500, height: 500 });
    expect(tall).toMatchObject({ width: 500, height: 500, x: 0 });
    expect(tall.y).toBeCloseTo(175);
  });
});

describe("what feeds a Layout card", () => {
  const nodes = [
    { id: "l", type: "layout", data: { part: "2" } },
    { id: "i", type: "image", data: { label: "Hero", assetId: "a1" } },
    { id: "t", type: "text", data: { text: "One\n---\nTwo" } },
    { id: "e", type: "image", data: { label: "Empty" } },
  ];
  it("takes the picture and its part of the words", () => {
    expect(layoutInputs(nodes, [{ source: "i", target: "l" }, { source: "t", target: "l" }], "l")).toEqual({ imageAssetId: "a1", text: "Two", missing: [] });
  });
  it("says what's missing", () => {
    expect(layoutInputs(nodes, [], "l").missing).toEqual(["Connect a picture", "Connect a Text card"]);
    expect(layoutInputs(nodes, [{ source: "e", target: "l" }, { source: "t", target: "l" }], "l").missing).toEqual(['"Empty" has no result yet']);
    const noPart = [{ ...nodes[0]!, data: { part: "5" } }, nodes[1]!, nodes[2]!];
    expect(layoutInputs(noPart, [{ source: "i", target: "l" }, { source: "t", target: "l" }], "l").missing).toEqual(["No words for part 5 yet"]);
  });
  it("orders pages down then across, and makes safe file names", () => {
    const cards = [{ id: "b", position: { x: 0, y: 200 } }, { id: "c", position: { x: 100, y: 0 } }, { id: "a", position: { x: 0, y: 0 } }];
    expect(pageOrder(cards).map((c) => c.id)).toEqual(["a", "c", "b"]);
    expect(fileStem("Page 1: The Ending!", 0)).toBe("01-page-1-the-ending");
    expect(fileStem("", 11)).toBe("12");
  });
});

describe("the rules for the new cards", () => {
  it("words only go to a Layout card; pictures can; a Layout card feeds nothing", () => {
    expect(canConnect("text", "layout")).toBe(true);
    expect(canConnect("text", "image")).toBe(false);
    expect(canConnect("text", "video")).toBe(false);
    expect(canConnect("prompt", "layout")).toBe(false);
    for (const from of ["image", "output", "source"] as const) expect(canConnect(from, "layout"), from).toBe(true);
    expect(canConnect("video", "layout")).toBe(false);
    for (const to of ["image", "video", "output", "layout", "text"] as const) expect(canConnect("layout", to), to).toBe(false);
  });
  it("the worker keeps the new cards' settings and refuses a bad connection", () => {
    const doc = normalizeDoc({ nodes: [{ id: "t", type: "text", position: { x: 0, y: 0 }, data: { label: "W", text: "Hi", brief: "Say hi", requested: "PAR-1", junk: "x" } }, { id: "l", type: "layout", position: { x: 1, y: 0 }, data: { size: "youtube", part: "1", position: "top", font: "serif" } }], edges: [{ id: "e", source: "t", target: "l" }] });
    expect(doc.nodes[0]!.data).toEqual({ label: "W", text: "Hi", brief: "Say hi", requested: "PAR-1" });
    expect(doc.nodes[1]!.data).toMatchObject({ size: "youtube", part: "1", font: "serif" });
    expect(() => normalizeDoc({ nodes: [{ id: "t", type: "text", position: { x: 0, y: 0 }, data: {} }, { id: "i", type: "image", position: { x: 1, y: 0 }, data: {} }], edges: [{ id: "e", source: "t", target: "i" }] })).toThrow();
  });
});

describe("the agent's writing task", () => {
  it("names the tool, the card and the page count, and keeps the current words fenced", () => {
    const out = writingTaskDescription({ canvasId: "c1", cardId: "k1", board: "Book", card: "Story", brief: "A story", current: "old ``` words", client: "Acme", pages: 5 });
    expect(out).toContain("partnersinbiz.studio:canvas-write-text");
    expect(out).toContain("canvasId `c1`");
    expect(out).toContain("cardId `k1`");
    expect(out).toContain("exactly 5 parts");
    expect(out).toContain("for Acme");
    expect(out).toContain("old ''' words");
    expect(writingTaskDescription({ canvasId: "c", cardId: "k", board: "B", card: "C", brief: "", current: "", client: null, pages: 1 })).not.toContain("parts");
  });
});

describe("an agent delivering words", () => {
  const board = { client: null, doc: { nodes: [{ id: "t", type: "text", data: { label: "Story" } }, { id: "i", type: "image", data: {} }] } };
  function fake() {
    const state = new Map<string, unknown>();
    const key = (k: { scopeId: string; stateKey: string }) => `${k.scopeId}:${k.stateKey}`;
    return {
      state: { get: async (k: never) => state.get(key(k)) ?? null, set: async (k: never, v: unknown) => void state.set(key(k), v) },
      db: { namespace: "plugin_studio_x", query: async (sql: string) => (sql.includes("canvases") ? [{ id: "c1", title: "B", doc: JSON.stringify({ nodes: [{ id: "t", type: "text", position: { x: 0, y: 0 }, data: { label: "Story" } }, { id: "i", type: "image", position: { x: 1, y: 0 }, data: {} }], edges: [] }), revision: 1, client_ref: null, client_kind: null, client_name: null, project_id: null, created_at: null, updated_at: null }] : []), execute: async () => ({ rowCount: 1 }) },
      projects: { get: async () => null },
    } as never;
  }
  void board;
  it("waits in state until the board takes it, and is removed after", async () => {
    const ctx = fake();
    const out = await writeCardText(ctx, "co", { canvasId: "c1", cardId: "t", text: " The words " }, { agentId: "a1", projectId: null });
    expect(out.delivered).toBe(true);
    expect((await textDrafts(ctx, "co", "c1")).t).toMatchObject({ text: "The words", agentId: "a1" });
    await takeTextDraft(ctx, "co", "c1", "t");
    expect(await textDrafts(ctx, "co", "c1")).toEqual({});
  });
  it("refuses empty words, an unknown card and a card that isn't a Text card", async () => {
    const ctx = fake();
    await expect(writeCardText(ctx, "co", { canvasId: "c1", cardId: "t", text: " " }, { agentId: "a", projectId: null })).rejects.toThrow("required");
    await expect(writeCardText(ctx, "co", { canvasId: "c1", cardId: "zz", text: "x" }, { agentId: "a", projectId: null })).rejects.toThrow("No card");
    await expect(writeCardText(ctx, "co", { canvasId: "c1", cardId: "i", text: "x" }, { agentId: "a", projectId: null })).rejects.toThrow("not a Text card");
    await expect(writeCardText(ctx, "co", { canvasId: "c1", cardId: "t", text: "x".repeat(5000) }, { agentId: "a", projectId: null })).rejects.toThrow("Shorten");
  });
});

describe("the files", () => {
  const dec = new TextDecoder("latin1");
  it("computes the standard CRC", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("writes a ZIP with its files, names and sizes", () => {
    const zip = makeZip([{ name: "01-a.jpg", bytes: new Uint8Array([1, 2, 3]) }, { name: "02-b.jpg", bytes: new Uint8Array([4]) }]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(zip.length - 12, true)).toBe(2);
    const dirOffset = view.getUint32(zip.length - 6, true);
    expect(view.getUint32(dirOffset, true)).toBe(0x02014b50);
    expect(dec.decode(zip)).toContain("01-a.jpg");
    expect(dec.decode(zip)).toContain("02-b.jpg");
  });
  it("writes a PDF with one page per picture, at print size, with a correct index", () => {
    const pdf = dec.decode(makePdf([{ jpeg: new Uint8Array([0xff, 0xd8, 0xff]), width: 3300, height: 2550 }, { jpeg: new Uint8Array([0xff, 0xd8]), width: 2480, height: 3508 }]));
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf).toContain("/Count 2");
    expect(pdf).toContain("/MediaBox [0 0 792.00 612.00]");
    expect(pdf.match(/\/DCTDecode/g)?.length).toBe(2);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    const start = Number(pdf.match(/startxref\n(\d+)/)![1]);
    expect(pdf.slice(start, start + 4)).toBe("xref");
    const offsets = [...pdf.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((offset, i) => expect(pdf.slice(offset).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`).toBe(true));
  });
});

describe("video input (PAR-8364)", () => {
  it("takes an Edit card's render as the picture", () => {
    const nodes = [
      { id: "e", type: "edit", position: { x: 0, y: 0 }, data: { assetId: "vid1" } },
      { id: "t", type: "text", position: { x: 0, y: 10 }, data: { text: "Hi" } },
      { id: "l", type: "layout", position: { x: 5, y: 5 }, data: {} },
    ];
    const edges = [{ source: "e", target: "l" }, { source: "t", target: "l" }];
    expect(layoutInputs(nodes as never, edges, "l")).toMatchObject({ imageAssetId: "vid1", text: "Hi", missing: [] });
  });
});
