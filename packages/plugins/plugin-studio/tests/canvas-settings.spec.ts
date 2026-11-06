import { describe, expect, it } from "vitest";
import { MAX_BATCH } from "../src/generation.js";
import { PAGE_MODELS } from "../src/page.js";
import { aspectChips, BATCH_MAX, clampBatch, disabledNote, effectiveValue, headerCredits, qualityChips, resolutionChips } from "../src/canvas-settings.js";

const model = (id: string) => PAGE_MODELS.find((m) => m.id === id)!;
const off = (chips: Array<{ value: string; disabled: string | null }>) => chips.filter((c) => c.disabled).map((c) => c.value);
const on = (chips: Array<{ value: string; disabled: string | null }>) => chips.filter((c) => !c.disabled).map((c) => c.value);

describe("canvas settings chips", () => {
  it("keeps the batch stepper's limit equal to the engine's", () => {
    expect(BATCH_MAX).toBe(MAX_BATCH);
  });

  it("enables only the aspect ratios the model lists, and keeps the rest visible with a reason", () => {
    const chips = aspectChips(model("kling-video/v3.0/std/text-to-video"));
    expect(on(chips).sort()).toEqual(["1:1", "16:9", "9:16"].sort());
    expect(off(chips)).toEqual(["4:5", "3:2"]);
    expect(chips.find((c) => c.value === "4:5")?.disabled).toBe("Kling 3.0 (video) doesn't offer 4:5");
  });

  it("lists a model's extra ratios after the five, so none is unreachable", () => {
    const chips = aspectChips(model("z-image/turbo"));
    expect(chips.map((c) => c.value).slice(0, 5)).toEqual(["1:1", "9:16", "16:9", "4:5", "3:2"]);
    expect(chips.find((c) => c.value === "21:9")?.disabled).toBeNull();
    expect(off(chips)).toEqual(["4:5"]);
  });

  it("disables 4k for every model (none offers it) and 1k/2k where the model lacks them", () => {
    for (const m of PAGE_MODELS) expect(resolutionChips(m).find((c) => c.value === "4k")?.disabled).toBeTruthy();
    expect(on(resolutionChips(model("z-image/turbo")))).toEqual(["1k", "2k"]);
    expect(on(resolutionChips(model("higgsfield-ai/soul/v2/standard")))).toEqual(["720p", "1080p"]);
    expect(off(resolutionChips(model("higgsfield-ai/soul/v2/standard")))).toEqual(["1k", "2k", "4k"]);
  });

  it("says a model takes no setting when it lists none", () => {
    const kling = model("kling-video/v3.0/std/text-to-video");
    const chips = resolutionChips(kling);
    expect(off(chips)).toEqual(["1k", "2k", "4k"]);
    expect(disabledNote(chips, kling)).toBe("Kling 3.0 (video) takes no resolution setting");
    const hailuo = model("minimax/hailuo-2.3/standard/text-to-video");
    expect(off(aspectChips(hailuo)).length).toBe(5);
  });

  it("disables quality for every catalog model, never faking a value", () => {
    for (const m of PAGE_MODELS) {
      const chips = qualityChips(m);
      expect(chips.map((c) => c.value)).toEqual(["Draft", "Standard", "High"]);
      expect(on(chips)).toEqual([]);
    }
    expect(on(qualityChips({ id: "x", label: "X", ratios: [], resolutions: [], qualities: ["High"] }))).toEqual(["High"]);
  });

  it("disables everything until a model is picked", () => {
    expect(on(aspectChips(undefined))).toEqual([]);
    expect(aspectChips(undefined)[0].disabled).toBe("Pick a model first");
  });

  it("describes a partly disabled group by the values missing", () => {
    const z = model("z-image/turbo");
    expect(disabledNote(aspectChips(z), z)).toBe("Z-Image Turbo (image) doesn't offer 4:5");
  });

  it("sends the picked value only when the model offers it, else the model's first", () => {
    expect(effectiveValue("16:9", ["1:1", "16:9"])).toBe("16:9");
    expect(effectiveValue("4:5", ["1:1", "16:9"])).toBe("1:1");
    expect(effectiveValue("4:5", [])).toBeUndefined();
  });

  it("keeps the batch inside 1..8", () => {
    expect([clampBatch(undefined), clampBatch("0"), clampBatch("3"), clampBatch(99), clampBatch("x")]).toEqual([1, 1, 3, 8, 1]);
  });
});

describe("header credits", () => {
  const overview = {
    companyUsed: 12,
    caps: [{ scopeKey: "company", monthlyCredits: 50 }, { scopeKey: "company:c1", monthlyCredits: 20 }],
    clientUsage: [{ scopeKey: "company:c1", used: 7 }],
  };
  it("uses the client's own cap and use on a client board", () => {
    expect(headerCredits(overview, "company:c1")).toEqual({ used: 7, cap: 20, scope: "client" });
  });
  it("uses the company cap for own work or a client without a cap", () => {
    expect(headerCredits(overview, undefined)).toEqual({ used: 12, cap: 50, scope: "company" });
    expect(headerCredits(overview, "company:other")).toEqual({ used: 12, cap: 50, scope: "company" });
  });
  it("falls back to the default cap, then to none", () => {
    expect(headerCredits({ ...overview, caps: [{ scopeKey: "default", monthlyCredits: 5 }] }, undefined).cap).toBe(5);
    expect(headerCredits({ ...overview, caps: [] }, undefined).cap).toBeNull();
  });
});
