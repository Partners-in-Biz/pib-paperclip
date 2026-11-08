import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deleteTemplate, listSavedTemplates, saveTemplate } from "../src/prompt-template-store.js";
import { buildPairedPrompts, parsePairedPrompts, PASTE_MAX, PROMPT_MAX, fieldLabel, fillPrompt, filterTemplates, missingFields, placeholdersOf, PROMPT_TEMPLATES, TEMPLATE_CATEGORIES } from "../src/prompt-templates.js";

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

describe("paired image + video prompts", () => {
  const t = PROMPT_TEMPLATES.find((x) => x.id === "ugc-pair")!;
  const all = { subject: "a woman", outfit: "a blazer", setting: "a kitchen", product: "a flask", mood: "warm and authentic" };

  it("fills every field into both prompts as valid JSON", () => {
    const { image_prompt, video_prompt } = buildPairedPrompts(t, all);
    const img = JSON.parse(image_prompt);
    const vid = JSON.parse(video_prompt);
    expect(img.outfit).toBe("a blazer");
    expect(vid.sequence[1]).toContain("a flask");
    expect(image_prompt + video_prompt).not.toContain("{{");
    expect(image_prompt).toContain("\n  ");
  });

  it("keeps the placeholder for a missing field", () => {
    const { image_prompt } = buildPairedPrompts(t, { ...all, outfit: " " });
    expect(JSON.parse(image_prompt).outfit).toBe("{{outfit}}");
  });

  it("stays valid JSON when a value has quotes, backslashes and newlines", () => {
    const nasty = 'a "bold" \\ one\nwith a second line';
    const { image_prompt, video_prompt } = buildPairedPrompts(t, { ...all, subject: nasty });
    expect(JSON.parse(image_prompt).subject).toContain(nasty);
    expect(() => JSON.parse(video_prompt)).not.toThrow();
  });

  it("stays under the prompt box limit, even with long values", () => {
    const long = Object.fromEntries(Object.keys(all).map((k) => [k, "x".repeat(300)]));
    const { image_prompt, video_prompt } = buildPairedPrompts(t, long);
    expect(image_prompt.length).toBeLessThan(PROMPT_MAX);
    expect(video_prompt.length).toBeLessThan(PROMPT_MAX);
  });

  it("declares an example for every field its spec uses", () => {
    for (const name of placeholdersOf(JSON.stringify(t.spec))) expect(t.fields?.some((f) => f.name === name && f.example), name).toBe(true);
  });
});

describe("nine-style paired prompt pack", () => {
  const pack = PROMPT_TEMPLATES.filter((x) => x.id.startsWith("style-"));
  it("has the nine styles, 9:16, in a category the gallery shows", () => {
    expect(pack).toHaveLength(9);
    for (const t of pack) {
      expect(t.ratio).toBe("9:16");
      expect(TEMPLATE_CATEGORIES.some((c) => c.id === t.category), t.id).toBe(true);
    }
  });
  it("fills from its examples to valid JSON for both prompts", () => {
    for (const t of pack) {
      const values = Object.fromEntries((t.fields ?? []).map((f) => [f.name, f.example]));
      const { image_prompt, video_prompt } = buildPairedPrompts(t, values);
      expect(() => JSON.parse(image_prompt), t.id).not.toThrow();
      expect(() => JSON.parse(video_prompt), t.id).not.toThrow();
      expect(image_prompt + video_prompt, t.id).not.toContain("{{");
      expect(Array.isArray(JSON.parse(video_prompt).sequence)).toBe(true);
      for (const name of placeholdersOf(JSON.stringify(t.spec))) expect(t.fields?.some((f) => f.name === name), `${t.id} ${name}`).toBe(true);
    }
  });
  it("uses no brand words in titles or prompt text", () => {
    for (const t of pack) expect(JSON.stringify([t.title, t.tagline, t.prompt, t.spec, t.examples, t.fields]), t.id).not.toMatch(/lego|pixar|simpsons|disney/i);
  });
});

describe("parsePairedPrompts (agent paste-back, PAR-8389)", () => {
  const FENCE = "```";
  const block = (body: unknown) => `${FENCE}json\n${typeof body === "string" ? body : JSON.stringify(body, null, 2)}\n${FENCE}`;
  const good = { image_prompt: { shot_type: "Close-up", subject: "a red car" }, video_prompt: { shot_type: "Dolly", sequence: ["a", "b"] } };
  const code = (text: string) => {
    const r = parsePairedPrompts(text);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.message.length).toBeGreaterThan(10);
    return r.code;
  };

  it("reads one valid json block, with talk around it", () => {
    const r = parsePairedPrompts(`Here you go:\n\n${block(good)}\n\nHope that helps.`);
    expect(r).toEqual({ ok: true, image_prompt: JSON.stringify(good.image_prompt, null, 2), video_prompt: JSON.stringify(good.video_prompt, null, 2) });
  });
  it("refuses 0 and 2 json blocks, never picking one", () => {
    expect(code("no block here")).toBe("paste_blocks");
    expect(code(`${FENCE}\n{}\n${FENCE}`)).toBe("paste_blocks");
    expect(code(`Example:\n${block(good)}\nMine:\n${block(good)}`)).toBe("paste_blocks");
  });
  it("refuses invalid JSON", () => expect(code(block("{ nope"))).toBe("paste_json"));
  it("refuses the wrong shape", () => {
    expect(code(block({ image_prompt: {} }))).toBe("paste_shape");
    expect(code(block({ ...good, extra: {} }))).toBe("paste_shape");
    expect(code(block({ image_prompt: {}, prompt: {} }))).toBe("paste_shape");
    expect(code(block([good]))).toBe("paste_shape");
    expect(code(block({ image_prompt: "text", video_prompt: {} }))).toBe("paste_shape");
    expect(code(block({ image_prompt: {}, video_prompt: [1] }))).toBe("paste_shape");
    expect(code(block({ image_prompt: {}, video_prompt: null }))).toBe("paste_shape");
  });
  it("refuses an output over PROMPT_MAX and an input over 20,000", () => {
    expect(code(block({ image_prompt: { subject: "x".repeat(PROMPT_MAX) }, video_prompt: {} }))).toBe("paste_too_long");
    expect(code(block({ image_prompt: {}, video_prompt: { subject: "x".repeat(PROMPT_MAX) } }))).toBe("paste_too_long");
    expect(code(`${"x".repeat(PASTE_MAX + 1)}\n${block(good)}`)).toBe("paste_too_long");
  });
  it("refuses {{placeholder}} left in either prompt", () => {
    expect(code(block({ image_prompt: { subject: "{{subject}}" }, video_prompt: {} }))).toBe("paste_placeholder");
    expect(code(block({ image_prompt: {}, video_prompt: { sequence: ["a {{ product }} b"] } }))).toBe("paste_placeholder");
  });
  it("keeps </script>, quotes and newlines as text", () => {
    const hostile = { image_prompt: { subject: 'a "quoted" </script><b>x</b>\nline two' }, video_prompt: { mood: "it's \\ fine" } };
    const r = parsePairedPrompts(block(hostile));
    if (!r.ok) throw new Error(r.message);
    expect(JSON.parse(r.image_prompt)).toEqual(hostile.image_prompt);
    expect(JSON.parse(r.video_prompt)).toEqual(hostile.video_prompt);
    expect(r.image_prompt).toContain("</script>");
  });
  it("gives exactly the strings the Generate box is filled with (what the template form builds parses back unchanged)", () => {
    const t = PROMPT_TEMPLATES.find((x) => x.spec)!;
    const built = buildPairedPrompts(t, Object.fromEntries((t.fields ?? []).map((f) => [f.name, f.example])));
    const r = parsePairedPrompts(block({ image_prompt: JSON.parse(built.image_prompt), video_prompt: JSON.parse(built.video_prompt) }));
    expect(r).toEqual({ ok: true, image_prompt: built.image_prompt, video_prompt: built.video_prompt });
  });
});
