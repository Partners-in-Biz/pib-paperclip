import { describe, expect, it } from "vitest";
import { StudioError } from "../src/errors.js";
import { estimateGeneration } from "../src/generation.js";
import { pageRequest, PAGE_MODELS } from "../src/page.js";
import { buildPhotoPresetPrompt, DEFAULT_PRESET_MODEL, getPhotoPreset, PHOTO_NOTE_MAX, PHOTO_PRESETS } from "../src/presets.js";

describe("photo presets", () => {
  it("has 13 presets with unique ids, each building a non-empty prompt", () => {
    expect(PHOTO_PRESETS).toHaveLength(13);
    expect(new Set(PHOTO_PRESETS.map((p) => p.id)).size).toBe(13);
    for (const preset of PHOTO_PRESETS) expect(buildPhotoPresetPrompt(preset).length).toBeGreaterThan(40);
  });

  it("works a trimmed, capped note into the prompt", () => {
    const style = getPhotoPreset("anime")!;
    const prompt = buildPhotoPresetPrompt(style, `  ${"x".repeat(PHOTO_NOTE_MAX + 50)}  `);
    expect(prompt).toContain("x".repeat(PHOTO_NOTE_MAX));
    expect(prompt).not.toContain("x".repeat(PHOTO_NOTE_MAX + 1));
    expect(buildPhotoPresetPrompt(getPhotoPreset("custom-edit")!)).toContain("Improve the image subtly.");
  });

  it("rejects unknown ids", () => {
    expect(getPhotoPreset("nope")).toBeNull();
    expect(getPhotoPreset(42)).toBeNull();
    expect(() => pageRequest({ model: PAGE_MODELS[0]!.id, preset: "nope" })).toThrow(/styles the Studio page offers/);
    expect(() => estimateGeneration({} as never, "c", { preset: "nope" }, {})).rejects.toBeInstanceOf(StudioError);
  });

  it("the page request carries the preset and defaults", () => {
    const out = pageRequest({ model: DEFAULT_PRESET_MODEL, preset: "anime", prompt: "" });
    expect(out.preset).toBe("anime");
    expect(out.params).toMatchObject({ aspect_ratio: "1:1" });
  });
});
