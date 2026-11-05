import { describe, expect, it } from "vitest";
import { clientFilter, PAGE_MODELS, pageRequest } from "../src/page.js";
import { canGenerate } from "../src/service.js";

describe("Studio page form", () => {
  const soul = PAGE_MODELS[0]!;

  it("offers only fixed-price models: no Veo, no Seedance", () => {
    expect(PAGE_MODELS.length).toBeGreaterThan(0);
    for (const m of PAGE_MODELS) expect(m.id).not.toMatch(/veo|seedance/i);
  });

  it("turns the form into the engine's request", () => {
    expect(pageRequest({ model: soul.id, prompt: "a red chair", ratio: "16:9", resolution: "1080p", batchSize: "2", client: "company:acme" })).toEqual({
      model: soul.id,
      prompt: "a red chair",
      params: { aspect_ratio: "16:9", resolution: "1080p" },
      batchSize: 2,
      client: "company:acme",
    });
  });

  it("treats own work as no client, and defaults ratio, resolution and batch", () => {
    const out = pageRequest({ model: soul.id, prompt: "x", client: "own" });
    expect(out.client).toBeUndefined();
    expect(out.batchSize).toBe(1);
    expect(out.params).toEqual({ aspect_ratio: soul.ratios[0], resolution: soul.resolutions[0] });
  });

  it("refuses a model, ratio or resolution the page doesn't offer", () => {
    expect(() => pageRequest({ model: "google/veo-3", prompt: "x" })).toThrow(/models the Studio page offers/);
    expect(() => pageRequest({ model: "bytedance/seedance/v1", prompt: "x" })).toThrow(/models the Studio page offers/);
    expect(() => pageRequest({ model: soul.id, prompt: "x", ratio: "7:1" })).toThrow(/ratio/);
    expect(() => pageRequest({ model: soul.id, prompt: "x", resolution: "8k" })).toThrow(/8k/);
  });

  it("reads the library's client filter", () => {
    expect(clientFilter("")).toBeUndefined();
    expect(clientFilter("own")).toBeNull();
    expect(clientFilter("company:acme")).toEqual({ kind: "company", id: "acme" });
    expect(() => clientFilter("nonsense")).toThrow();
  });

  it("lets every active member but a viewer generate", () => {
    expect(canGenerate("owner")).toBe(true);
    expect(canGenerate("member")).toBe(true);
    expect(canGenerate("viewer")).toBe(false);
    expect(canGenerate(null)).toBe(false);
  });
});
