import { describe, expect, it, vi } from "vitest";
import { StudioError } from "../src/errors.js";
import { estimateGeneration, requestBody } from "../src/generation.js";
import { pageRequest, PAGE_MODELS } from "../src/page.js";
import { buildPhotoPresetPrompt, DEFAULT_PRESET_MODEL, getPhotoPreset, PHOTO_NOTE_MAX, PHOTO_PRESETS } from "../src/presets.js";

vi.mock("../src/scope.js", () => ({ scopeForWork: async () => ({ scope: null, client: null }), scopeInput: () => undefined, assertReachable: () => undefined }));
vi.mock("../src/ledger.js", async (orig) => ({ ...(await orig<object>()), capCheck: async () => ({ cap: { monthlyCredits: 50, source: "default" }, used: 0, remaining: 50 }) }));
vi.mock("../src/config.js", () => ({ StudioConfig: class {} }));

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

  it("rejects unknown ids", async () => {
    expect(getPhotoPreset("nope")).toBeNull();
    expect(getPhotoPreset(42)).toBeNull();
    expect(() => pageRequest({ model: PAGE_MODELS[0]!.id, preset: "nope" })).toThrow(/styles the Studio page offers/);
    await expect(estimateGeneration({} as never, "c", { preset: "nope" }, {})).rejects.toBeInstanceOf(StudioError);
    expect(() => requestBody({ preset: "nope" })).toThrow(/Unknown preset/);
  });

  it("the page request carries the preset and defaults", () => {
    const out = pageRequest({ model: DEFAULT_PRESET_MODEL, preset: "anime", prompt: "" });
    expect(out.preset).toBe("anime");
    expect(out.params).toMatchObject({ aspect_ratio: "1:1" });
  });

  it("builds the provider body from a preset and a note, with the default model and ratio", () => {
    const { model, prompt, body } = requestBody({ preset: "anime", prompt: "  blue hair  " });
    expect(model).toBe(DEFAULT_PRESET_MODEL);
    expect(prompt).toContain(getPhotoPreset("anime")!.prompt);
    expect(prompt).toContain("blue hair");
    expect(body).toMatchObject({ aspect_ratio: "1:1", prompt });
  });

  it("still requires a model and a prompt when there is no preset", () => {
    expect(() => requestBody({ prompt: "a cat" })).toThrow(StudioError);
    expect(() => requestBody({ model: DEFAULT_PRESET_MODEL })).toThrow(/prompt is required/);
    expect(requestBody({ model: DEFAULT_PRESET_MODEL, prompt: "a cat" }).body).toEqual({ prompt: "a cat" });
  });

  it("estimateGeneration hands the preset body to the provider", async () => {
    const estimate = vi.fn(async () => 0.5);
    const runtime = { provider: async () => ({ key: "higgsfield", estimate }), download: async () => new Uint8Array(), now: () => 0 };
    const out = await estimateGeneration({} as never, "c", { preset: "anime", prompt: "blue hair" }, {}, runtime as never);
    expect(out.model).toBe(DEFAULT_PRESET_MODEL);
    expect(estimate).toHaveBeenCalledTimes(1);
    const [model, body] = estimate.mock.calls[0] as unknown as [string, { prompt: string; aspect_ratio: string }];
    expect(model).toBe(DEFAULT_PRESET_MODEL);
    expect(body.aspect_ratio).toBe("1:1");
    expect(body.prompt).toContain(getPhotoPreset("anime")!.prompt);
    expect(body.prompt).toContain("blue hair");
  });
});
