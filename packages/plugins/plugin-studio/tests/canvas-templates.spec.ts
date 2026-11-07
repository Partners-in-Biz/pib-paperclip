import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canConnect, hasCycle } from "../src/canvas-rules.js";
import { deleteCanvasTemplate, listCanvasTemplates, saveCanvasTemplate } from "../src/canvas-template-store.js";
import { boardFieldLabel, boardFields, boardSummary, boardToTemplateDoc, CANVAS_TEMPLATE_CATEGORIES, CANVAS_TEMPLATES, fillBoard, filterCanvasTemplates } from "../src/canvas-templates.js";
import { cardInputs } from "../src/canvas-inputs.js";
import { normalizeDoc } from "../src/canvas.js";
import { LAYOUT_SIZES, partText } from "../src/layout.js";

function fakeCtx() {
  const data = new Map<string, unknown>();
  const key = (k: { scopeId: string; stateKey: string }) => `${k.scopeId}:${k.stateKey}`;
  return { state: { get: async (k: never) => data.get(key(k)) ?? null, set: async (k: never, v: unknown) => void data.set(key(k), v) } } as never;
}

describe("the starter boards", () => {
  it.each(CANVAS_TEMPLATES.map((t) => [t.id, t] as const))("%s is a board the worker accepts, with allowed wiring and no loops", (_id, t) => {
    expect(() => normalizeDoc(t.doc)).not.toThrow();
    expect(hasCycle(t.doc.nodes, t.doc.edges)).toBe(false);
    const type = new Map(t.doc.nodes.map((n) => [n.id, n.type]));
    for (const e of t.doc.edges) expect(canConnect(type.get(e.source)!, type.get(e.target)!), `${e.source} to ${e.target}`).toBe(true);
    expect(new Set(t.doc.nodes.map((n) => JSON.stringify(n.position))).size, "cards on top of each other").toBe(t.doc.nodes.length);
  });

  it("gives every field an example, and every category has a template", () => {
    expect(new Set(CANVAS_TEMPLATES.map((t) => t.id)).size).toBe(CANVAS_TEMPLATES.length);
    for (const t of CANVAS_TEMPLATES) for (const field of boardFields(t.doc)) expect(t.examples[field], `${t.id}: ${field}`).toBeTruthy();
    for (const t of CANVAS_TEMPLATES) for (const name of Object.keys(t.examples)) expect(boardFields(t.doc), `${t.id}: unused example ${name}`).toContain(name);
    for (const c of CANVAS_TEMPLATE_CATEGORIES) expect(CANVAS_TEMPLATES.some((t) => t.category === c.id), c.id).toBe(true);
  });

  it("every generating card has something to make once its fields are filled", () => {
    for (const t of CANVAS_TEMPLATES) {
      const filled = fillBoard(t.doc, t.examples);
      expect(JSON.stringify(filled.nodes), t.id).not.toContain("{{");
      for (const n of filled.nodes.filter((x) => x.type === "image" || x.type === "video")) {
        expect(cardInputs(filled.nodes, filled.edges, n.id).prompt.trim(), `${t.id}: ${n.id}`).not.toBe("");
      }
    }
  });

  it("the book feeds its character sheet into every page, so the character stays the same", () => {
    const book = CANVAS_TEMPLATES.find((t) => t.id === "picture-book")!;
    const pages = book.doc.nodes.filter((n) => n.id.startsWith("page"));
    expect(pages.length).toBe(5);
    for (const page of pages) expect(book.doc.edges.some((e) => e.source === "sheet" && e.target === page.id), page.id).toBe(true);
  });

  it("pictures ask for no lettering, or inherit that from a prompt card", () => {
    for (const t of CANVAS_TEMPLATES) {
      for (const n of t.doc.nodes.filter((x) => x.type === "image")) expect(cardInputs(t.doc.nodes, t.doc.edges, n.id).prompt, `${t.id}: ${n.id}`).toMatch(/No text|same look|same style|Same look|same product|the same character/i);
    }
  });

  it("the page never builds an address from import.meta.url, which throws on the host's blob: address", () => {
    expect(readFileSync(new URL("../src/ui/CanvasTemplates.tsx", import.meta.url), "utf8")).not.toContain("import.meta.url");
  });
});

describe("board helpers", () => {
  const t = CANVAS_TEMPLATES.find((x) => x.id === "blog-heroes")!;
  it("finds fields, fills what is given and leaves the rest visible", () => {
    expect(boardFields(t.doc)).toContain("article1");
    const out = fillBoard(t.doc, { business: "a law firm" });
    expect(JSON.stringify(out.nodes)).toContain("a law firm");
    expect(JSON.stringify(out.nodes)).toContain("{{article1}}");
    expect(JSON.stringify(t.doc.nodes)).toContain("{{business}}");
  });
  it("words the labels and the summary", () => {
    expect(boardFieldLabel("article1")).toBe("Article 1");
    expect(boardFieldLabel("brand_colour")).toBe("Brand colour");
    expect(boardSummary(CANVAS_TEMPLATES.find((x) => x.id === "product-launch")!.doc)).toBe("3 pictures, 1 video");
    expect(boardSummary(CANVAS_TEMPLATES.find((x) => x.id === "ad-test")!.doc)).toBe("4 pictures, 4 finished pages");
  });
  it("filters by category and words", () => {
    expect(filterCanvasTemplates(CANVAS_TEMPLATES, { category: "books" }).map((x) => x.id)).toEqual(["picture-book", "ebook"]);
    expect(filterCanvasTemplates(CANVAS_TEMPLATES, { q: "APP STORE" }).map((x) => x.id)).toContain("app-store-set");
  });
  it("a saved template keeps wiring and words, never files or results", () => {
    const doc = { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
      { id: "s", type: "source" as const, position: { x: 0, y: 0 }, data: { label: "Client file", assetId: "a1" } },
      { id: "i", type: "image" as const, position: { x: 400, y: 0 }, data: { label: "Hero", prompt: "words", assetId: "a2", groupId: "g1" } },
      { id: "o", type: "output" as const, position: { x: 800, y: 0 }, data: { assetId: "a3", generated: "1" } },
      { id: "w", type: "output" as const, position: { x: 800, y: 200 }, data: { label: "Wired", assetId: "a4" } },
    ], edges: [{ id: "e1", source: "s", target: "i" }, { id: "e2", source: "i", target: "o" }, { id: "e3", source: "i", target: "w" }] };
    const out = boardToTemplateDoc(doc as never);
    expect(JSON.stringify(out)).not.toMatch(/a1|a2|a3|a4|g1/);
    expect(out.nodes.map((n) => n.id)).toEqual(["s", "i", "w"]);
    expect(out.edges.map((e) => e.id)).toEqual(["e1", "e3"]);
    expect(out.nodes[1]!.data).toEqual({ label: "Hero", prompt: "words" });
  });
});

describe("saved canvas templates", () => {
  const doc = { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: "p", type: "prompt", position: { x: 0, y: 0 }, data: { label: "P", text: "a {{thing}}" } }, { id: "s", type: "source", position: { x: 0, y: 200 }, data: { assetId: "secret-file" } }], edges: [] };
  it("saves per company without files, lists newest first and deletes", async () => {
    const ctx = fakeCtx();
    const a = await saveCanvasTemplate(ctx, "c1", { title: " One ", doc });
    await saveCanvasTemplate(ctx, "c1", { title: "Two", doc });
    expect(a.title).toBe("One");
    expect(JSON.stringify(a.doc)).not.toContain("secret-file");
    expect((await listCanvasTemplates(ctx, "c1")).map((t) => t.title)).toEqual(["Two", "One"]);
    expect(await listCanvasTemplates(ctx, "c2")).toEqual([]);
    expect(await deleteCanvasTemplate(ctx, "c1", a.id)).toEqual({ removed: true });
    expect(await deleteCanvasTemplate(ctx, "c1", a.id)).toEqual({ removed: false });
  });
  it("refuses a blank name and an empty board, and stops at the limit", async () => {
    const ctx = fakeCtx();
    await expect(saveCanvasTemplate(ctx, "c", { title: " ", doc })).rejects.toThrow("name");
    await expect(saveCanvasTemplate(ctx, "c", { title: "x", doc: { nodes: [], edges: [] } })).rejects.toThrow("no cards");
    for (let i = 0; i < 50; i++) await saveCanvasTemplate(ctx, "c", { title: `t${i}`, doc });
    await expect(saveCanvasTemplate(ctx, "c", { title: "more", doc })).rejects.toThrow("Delete one first");
  });
});

describe("boards with finished pages", () => {
  it("every Layout card gets a picture and has words for its part", () => {
    const withPages = CANVAS_TEMPLATES.filter((t) => t.doc.nodes.some((n) => n.type === "layout"));
    expect(withPages.map((t) => t.id)).toEqual(expect.arrayContaining(["app-store-set", "picture-book", "ebook", "carousel", "ad-test", "youtube-thumbnails"]));
    for (const t of withPages) {
      const filled = fillBoard(t.doc, t.examples);
      for (const n of filled.nodes.filter((x) => x.type === "layout")) {
        const froms = filled.edges.filter((e) => e.target === n.id).map((e) => filled.nodes.find((x) => x.id === e.source)!);
        expect(froms.some((x) => x.type === "image" || x.type === "source"), `${t.id}: ${n.id} picture`).toBe(true);
        const text = froms.find((x) => x.type === "text");
        expect(text, `${t.id}: ${n.id} words`).toBeTruthy();
        expect(partText(text!.data.text, n.data.part), `${t.id}: ${n.id} part ${n.data.part}`).not.toBe("");
        expect(LAYOUT_SIZES.map((s) => s.id), `${t.id}: ${n.id} size`).toContain(n.data.size);
      }
    }
  });
  it("the app store set comes out at Apple's size, and the book at print size with serif words under the picture", () => {
    const shots = CANVAS_TEMPLATES.find((t) => t.id === "app-store-set")!.doc.nodes.filter((n) => n.type === "layout");
    expect(shots.length).toBe(5);
    expect(shots.every((n) => n.data.size === "app-store-iphone")).toBe(true);
    const book = CANVAS_TEMPLATES.find((t) => t.id === "picture-book")!.doc.nodes.filter((n) => n.type === "layout");
    expect(book.map((n) => n.data.part)).toEqual(["1", "2", "3", "4", "5"]);
    expect(book.every((n) => n.data.position === "below" && n.data.font === "serif")).toBe(true);
  });
  it("words on a Text card never reach an image model", () => {
    for (const t of CANVAS_TEMPLATES) {
      for (const n of t.doc.nodes.filter((x) => x.type === "text")) {
        const targets = t.doc.edges.filter((e) => e.source === n.id).map((e) => t.doc.nodes.find((x) => x.id === e.target)!.type);
        expect(targets.every((type) => type === "layout"), `${t.id}: ${n.id}`).toBe(true);
      }
    }
  });
});
