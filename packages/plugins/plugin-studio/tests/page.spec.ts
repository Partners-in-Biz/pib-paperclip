import { describe, expect, it } from "vitest";
import { findModel, MODEL_CATALOG } from "../src/models.js";
import { clientFilter, PAGE_MODELS, pageRequest, UNAVAILABLE_MODELS } from "../src/page.js";
import { fakeProvider, scrubLinks } from "../src/provider.js";
import { canGenerate } from "../src/service.js";

describe("Studio page form", () => {
  const soul = PAGE_MODELS[0]!;

  it("offers only priced models: no Veo; Seedance only with its per-job ceiling", () => {
    expect(PAGE_MODELS.length).toBeGreaterThan(0);
    for (const m of PAGE_MODELS) expect(m.id).not.toMatch(/veo/i);
    const seedance = PAGE_MODELS.filter((m) => /seedance/i.test(m.id));
    expect(seedance.map((m) => [m.id, m.resolutions, m.ratios, findModel(m.id)?.maxCreditsPerJob])).toEqual([
      ["bytedance/seedance-2.0/text-to-video", ["480p", "720p", "1080p"], ["16:9"], 60],
      ["bytedance/seedance-2.5/text-to-video", ["480p", "720p"], ["16:9"], 60],
    ]);
    expect(seedance.map((m) => [m.durations[0], m.durations.at(-1)])).toEqual([[4, 15], [4, 30]]);
    for (const m of PAGE_MODELS.filter((p) => !/seedance/i.test(p.id))) expect(findModel(m.id)?.maxCreditsPerJob).toBeNull();
  });

  it("offers more than Soul v2 and lists Veo and Seedance as not offered / not priced instead of hiding them", () => {
    expect(PAGE_MODELS.length).toBeGreaterThan(5);
    expect(soul.id).toBe("higgsfield-ai/soul/v2/standard");
    const notes = Object.fromEntries(UNAVAILABLE_MODELS.map((m) => [m.label, m.note]));
    expect(notes["Veo 3.1 (video)"]).toMatch(/Not on the Higgsfield REST API/);
    expect(notes["Seedance 2.0 (video)"]).toBeUndefined();
    expect(MODEL_CATALOG.find((m) => m.registryId === "seedance_2_0")).toMatchObject({ offered: true, priced: true });
    expect(MODEL_CATALOG.find((m) => m.registryId === "seedance_2_5")).toMatchObject({ offered: true, priced: true });
    // Every registry model is accounted for, once as offered or listed.
    const ids = new Set(MODEL_CATALOG.map((m) => m.registryId));
    expect(ids.size).toBe(24);
  });

  it("writes the chosen duration to the model's own field and refuses one it lacks", () => {
    const hailuo = "minimax/hailuo-2.3/standard/text-to-video";
    expect(pageRequest({ model: hailuo, prompt: "x", duration: 10 })).toMatchObject({ params: { duration: 10 } });
    expect((pageRequest({ model: hailuo, prompt: "x" }).params as Record<string, unknown>).duration).toBeUndefined();
    expect(() => pageRequest({ model: hailuo, prompt: "x", duration: 5 })).toThrow(/doesn't offer 5 seconds/);
    expect(() => pageRequest({ model: soul.id, prompt: "x", duration: 5 })).toThrow(/takes no duration/);
  });

  it("passes reference asset ids through and checks the count against the model", () => {
    const grok = PAGE_MODELS.find((m) => m.id === "xai/grok-imagine-image-2.0")!;
    expect(pageRequest({ model: grok.id, prompt: "x", referenceAssetIds: ["a1", "a2", "a1"] })).toMatchObject({ referenceAssetIds: ["a1", "a2"] });
    expect(() => pageRequest({ model: soul.id, prompt: "x", referenceAssetIds: ["a1"] })).toThrow(/takes no reference images/);
    expect(() => pageRequest({ model: "kling-video/v3.0-turbo/image-to-video", prompt: "x" })).toThrow(/needs exactly 1 reference image/);
    expect(() => pageRequest({ model: grok.id, prompt: "x", referenceAssetIds: "a1" })).toThrow(/list of Studio asset ids/);
  });

  it("sends no ratio or resolution field to a model that takes none", () => {
    expect(pageRequest({ model: "minimax/hailuo-2.3/standard/text-to-video", prompt: "x" }).params).toEqual({});
  });

  it("the fake provider spends nothing and finishes at once", async () => {
    const fake = fakeProvider(2);
    expect(await fake.estimate(soul.id, {})).toBe(2);
    expect(await fake.submit(soul.id, {})).toMatch(/^fake-/);
    expect(await fake.status("fake-1")).toMatchObject({ state: "done" });
    expect(fake.submitted()).toBe(1);
  });

  it("keeps signed storage links out of outputs and provider errors", () => {
    expect(scrubLinks("bad image_urls: https://acc.r2.cloudflarestorage.com/k?X-Amz-Signature=abc")).toBe("bad image_urls: <link>");
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
