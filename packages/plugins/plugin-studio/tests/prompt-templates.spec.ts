import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deleteTemplate, listSavedTemplates, saveTemplate } from "../src/prompt-template-store.js";
import { fieldLabel, fillPrompt, filterTemplates, missingFields, placeholdersOf, PROMPT_TEMPLATES, TEMPLATE_CATEGORIES } from "../src/prompt-templates.js";

function fakeCtx() {
  const data = new Map<string, unknown>();
  const key = (k: { scopeId: string; stateKey: string }) => `${k.scopeId}:${k.stateKey}`;
  return { state: { get: async (k: never) => data.get(key(k)) ?? null, set: async (k: never, v: unknown) => void data.set(key(k), v) } } as never;
}

describe("the built-in templates", () => {
  it("have unique ids, a known category, a ratio, and an example for every field", () => {
    expect(new Set(PROMPT_TEMPLATES.map((t) => t.id)).size).toBe(PROMPT_TEMPLATES.length);
    const known = new Set(TEMPLATE_CATEGORIES.map((c) => c.id));
    for (const t of PROMPT_TEMPLATES) {
      expect(known.has(t.category), t.id).toBe(true);
      expect(t.ratio, t.id).toMatch(/^\d+:\d+$/);
      for (const field of placeholdersOf(t.prompt)) expect(t.examples?.[field], `${t.id} ${field}`).toBeTruthy();
      expect(t.prompt.length, t.id).toBeLessThan(1000);
    }
  });

  it("every image template has its example picture, and uses a ratio the default model can make", () => {
    const soul = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"];
    for (const t of PROMPT_TEMPLATES.filter((x) => x.kind === "image")) {
      expect(existsSync(new URL(`../assets/template-samples/${t.id}.jpg`, import.meta.url)), t.id).toBe(true);
      expect(soul, t.id).toContain(t.ratio);
    }
  });

  it("never builds a picture address from import.meta.url: the host runs pages from a blob: address, where new URL throws", () => {
    const source = readFileSync(new URL("../src/ui/TemplateGallery.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/new URL\([^)]*import\.meta\.url/);
    expect(() => new URL("./x.jpg", "blob:https://example.com/abc")).toThrow();
  });

  it("cover images and video, and every category has something", () => {
    expect(PROMPT_TEMPLATES.some((t) => t.kind === "video")).toBe(true);
    expect(PROMPT_TEMPLATES.some((t) => t.kind === "image")).toBe(true);
    for (const c of TEMPLATE_CATEGORIES) expect(PROMPT_TEMPLATES.some((t) => t.category === c.id), c.id).toBe(true);
  });

  it("ask for no made-up text on images and name a camera move or a still camera on video", () => {
    for (const t of PROMPT_TEMPLATES) {
      if (t.kind === "image") expect(t.prompt, t.id).toContain("No text");
      else expect(t.prompt, t.id).toMatch(/camera|gimbal|handheld/i);
    }
  });
});

describe("fields", () => {
  const prompt = "A photo of {{product}} on {{ Surface }} near another {{product}}";
  it("lists each field once, in order", () => {
    expect(placeholdersOf(prompt)).toEqual(["product", "surface"]);
    expect(placeholdersOf("no fields")).toEqual([]);
  });
  it("fills what is given and leaves the rest visible", () => {
    expect(fillPrompt(prompt, { product: "a mug" })).toBe("A photo of a mug on {{ Surface }} near another a mug");
    expect(fillPrompt(prompt, { product: "a mug", surface: "oak" })).toBe("A photo of a mug on oak near another a mug");
    expect(fillPrompt(prompt, { product: "   " })).toContain("{{product}}");
  });
  it("names what is still blank", () => {
    expect(missingFields(prompt, { product: "a mug" })).toEqual(["surface"]);
    expect(missingFields(prompt, { product: "a mug", surface: "oak" })).toEqual([]);
    expect(fieldLabel("brand_colour")).toBe("Brand colour");
  });
});

describe("the gallery filter", () => {
  it("narrows by words, category and kind", () => {
    expect(filterTemplates(PROMPT_TEMPLATES, {}).length).toBe(PROMPT_TEMPLATES.length);
    expect(filterTemplates(PROMPT_TEMPLATES, { q: "PACKSHOT" }).map((t) => t.id)).toContain("packshot");
    expect(filterTemplates(PROMPT_TEMPLATES, { kind: "video" }).every((t) => t.kind === "video")).toBe(true);
    expect(filterTemplates(PROMPT_TEMPLATES, { category: "food" }).every((t) => t.category === "food")).toBe(true);
    expect(filterTemplates(PROMPT_TEMPLATES, { q: "zzzznothing" })).toEqual([]);
  });
});

describe("saved templates", () => {
  it("saves newest first, per company, and deletes", async () => {
    const ctx = fakeCtx();
    const a = await saveTemplate(ctx, "co1", { title: " First ", prompt: "a {{thing}}", kind: "image", ratio: "1:1" });
    const b = await saveTemplate(ctx, "co1", { title: "Second", prompt: "clip", kind: "video", assetId: "asset-1" });
    expect(a).toMatchObject({ title: "First", category: "saved", kind: "image" });
    expect(b).toMatchObject({ kind: "video", assetId: "asset-1", ratio: "" });
    expect((await listSavedTemplates(ctx, "co1")).map((t) => t.title)).toEqual(["Second", "First"]);
    expect(await listSavedTemplates(ctx, "co2")).toEqual([]);
    expect(await deleteTemplate(ctx, "co1", a.id)).toEqual({ removed: true });
    expect(await deleteTemplate(ctx, "co1", a.id)).toEqual({ removed: false });
    expect((await listSavedTemplates(ctx, "co1")).map((t) => t.title)).toEqual(["Second"]);
  });

  it("refuses a blank name, a blank prompt and an oversized one, and treats an unknown kind as an image", async () => {
    const ctx = fakeCtx();
    await expect(saveTemplate(ctx, "c", { title: "  ", prompt: "x" })).rejects.toThrow("name");
    await expect(saveTemplate(ctx, "c", { title: "x", prompt: " " })).rejects.toThrow("prompt");
    await expect(saveTemplate(ctx, "c", { title: "x", prompt: "y".repeat(4001) })).rejects.toThrow("under");
    await expect(saveTemplate(ctx, "c", { title: "t".repeat(81), prompt: "y" })).rejects.toThrow("under");
    expect((await saveTemplate(ctx, "c", { title: "x", prompt: "y", kind: "audio" })).kind).toBe("image");
  });

  it("stops at the limit", async () => {
    const ctx = fakeCtx();
    for (let i = 0; i < 200; i++) await saveTemplate(ctx, "c", { title: `t${i}`, prompt: "p" });
    await expect(saveTemplate(ctx, "c", { title: "one more", prompt: "p" })).rejects.toThrow("Delete one first");
  });
});
