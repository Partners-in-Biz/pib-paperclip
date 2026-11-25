import { describe, expect, it, vi } from "vitest";
import { LIPSYNC, lipsyncInputOf, lipsyncPrice } from "../src/providers/registry.js";
import { defaultKey, keyFor, lipsyncParams, optionsFor, optionText, problem, submitLipsync, warningFor, type LipsyncOption } from "../src/ui/lipsync-form.js";

// The options exactly as the overview serves them (service.ts providerOptions), built from the real registry.
const options: LipsyncOption[] = LIPSYNC.map((e) => {
  const input = lipsyncInputOf(e);
  return { key: e.key, label: e.label, model: e.model, input, ...lipsyncPrice(e.model), qualityNote: e.qualityNote, isDefault: e.isDefaultFor === input };
});

describe("lip-sync mode form (PAR-8437)", () => {
  it("lists all 5 options, each with price and quality note", () => {
    const all = [...optionsFor(options, "audio"), ...optionsFor(options, "line")];
    expect(all.map((o) => o.key).sort()).toEqual(["grok-video-1.5", "seedance-2.5-dialogue", "seedance-2.5-reference", "wan-2.7", "wan-3.0-prime"]);
    for (const o of all) {
      expect(o.price.length).toBeGreaterThan(0);
      expect(o.qualityNote.length).toBeGreaterThan(0);
      expect(optionText(o)).toContain(o.price);
    }
  });

  it("preselects the default per input type, default first in the list", () => {
    expect(defaultKey(options, "audio")).toBe("wan-3.0-prime");
    expect(defaultKey(options, "line")).toBe("seedance-2.5-dialogue");
    expect(optionsFor(options, "audio")[0].key).toBe("wan-3.0-prime");
    expect(optionsFor(options, "audio")).toHaveLength(4);
    expect(optionsFor(options, "line")).toHaveLength(1);
  });

  it("honours a company default and falls back to the type default when switching input", () => {
    const company = options.map((o) => ({ ...o, isDefault: o.key === "wan-2.7" || o.key === "seedance-2.5-dialogue" }));
    expect(defaultKey(company, "audio")).toBe("wan-2.7");
    expect(keyFor(options, "line", "wan-2.7")).toBe("seedance-2.5-dialogue");
    expect(keyFor(options, "audio", "grok-video-1.5")).toBe("grok-video-1.5");
  });

  it("warns before submit on Seedance 2.5 reference only", () => {
    expect(warningFor(options, "seedance-2.5-reference")).toMatch(/re-times or replaces your audio/);
    for (const k of ["wan-3.0-prime", "wan-2.7", "seedance-2.5-dialogue", "grok-video-1.5"]) expect(warningFor(options, k)).toBeNull();
  });

  it("validates the form", () => {
    const base = { input: "audio" as const, portraitAssetId: "", audioAssetId: "", line: "", provider: "" };
    expect(problem(base)).toBe("Pick a portrait.");
    expect(problem({ ...base, portraitAssetId: "p" })).toBe("Pick an audio file.");
    expect(problem({ ...base, portraitAssetId: "p", audioAssetId: "a" })).toBeNull();
    expect(problem({ ...base, input: "line", portraitAssetId: "p" })).toBe("Type the line to say.");
    expect(problem({ ...base, input: "line", portraitAssetId: "p", line: "x".repeat(501) })).toMatch(/at most 500/);
  });

  it("calls studio-lipsync with the portrait, audio and chosen model; a line sends the line instead", async () => {
    const run = vi.fn(async () => ({ groupId: "g1" }));
    await submitLipsync(run, { input: "audio", portraitAssetId: "p1", audioAssetId: "a1", line: "ignored", provider: "wan-3.0-prime" });
    expect(run).toHaveBeenLastCalledWith({ portraitAssetId: "p1", audioAssetId: "a1", provider: "wan-3.0-prime" });
    await submitLipsync(run, { input: "line", portraitAssetId: "p1", audioAssetId: "a1", line: "  Hello  ", provider: "seedance-2.5-dialogue" });
    expect(run).toHaveBeenLastCalledWith({ portraitAssetId: "p1", line: "Hello", provider: "seedance-2.5-dialogue" });
    expect(lipsyncParams({ input: "line", portraitAssetId: "p", audioAssetId: "", line: "Hi", provider: "" })).toEqual({ portraitAssetId: "p", line: "Hi" });
  });

  it("makes no call when the form is incomplete", async () => {
    const run = vi.fn();
    await expect(submitLipsync(run, { input: "audio", portraitAssetId: "", audioAssetId: "", line: "", provider: "" })).rejects.toThrow("Pick a portrait.");
    expect(run).not.toHaveBeenCalled();
  });
});
