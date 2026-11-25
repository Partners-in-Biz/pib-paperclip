import { describe, expect, it } from "vitest";
import { lipsyncRequest } from "../src/lipsync.js";
import { LIPSYNC, lipsyncInputOf, lipsyncPrice, providerOptions, resolveLipsync } from "../src/providers/registry.js";
import { isTablePriced, localCredits } from "../src/seedance-price.js";
import { ttsCredits } from "../src/video-edit/tts-price.js";

const config = (values: Record<string, string>) => ({ providerDefault: async (cap: string) => values[cap] });

describe("lip-sync registry (PAR-8436)", () => {
  it("derives each entry's input from its model and has one code default per input", () => {
    expect(Object.fromEntries(LIPSYNC.map((e) => [e.key, lipsyncInputOf(e)]))).toEqual({
      "wan-3.0-prime": "audio",
      "seedance-2.5-dialogue": "line",
      "wan-2.7": "audio",
      "seedance-2.5-reference": "audio",
      "grok-video-1.5": "audio",
    });
    for (const input of ["audio", "line"] as const) expect(LIPSYNC.filter((e) => e.isDefaultFor === input)).toHaveLength(1);
  });

  it.each([
    ["audio", "wan-3.0-prime", "wan-2.7", "grok-video-1.5"],
    ["line", "seedance-2.5-dialogue", "seedance-2.5-dialogue", "seedance-2.5-dialogue"],
  ] as const)("%s: override > company default > code default", (input, codeDefault, companyDefault, override) => {
    expect(resolveLipsync(input).key).toBe(codeDefault);
    expect(resolveLipsync(input, undefined, { [input]: companyDefault }).key).toBe(companyDefault);
    expect(resolveLipsync(input, override, { [input]: companyDefault }).key).toBe(override);
    expect(resolveLipsync(input, "  ", { [input]: "" }).key).toBe(codeDefault);
  });

  it("the audio default ignores the line setting and the other way round", () => {
    expect(resolveLipsync("audio", undefined, { line: "seedance-2.5-dialogue" }).key).toBe("wan-3.0-prime");
    expect(resolveLipsync("line", undefined, { audio: "wan-2.7" }).key).toBe("seedance-2.5-dialogue");
  });

  it("refuses a mode mismatch and an unknown key with bad_request", () => {
    expect(() => resolveLipsync("audio", "seedance-2.5-dialogue")).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(() => resolveLipsync("line", "wan-3.0-prime")).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(() => resolveLipsync("audio", "lipsync-9000")).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(() => resolveLipsync("line", undefined, { line: "wan-2.7" })).toThrow(expect.objectContaining({ code: "bad_request" }));
  });

  it("price strings come from the model's own estimate, never a typed number", () => {
    for (const e of LIPSYNC) {
      const { credits, price } = lipsyncPrice(e.model);
      if (isTablePriced(e.model)) {
        const resolution = price.match(/at (\S+)$/)![1]!;
        expect(credits).toBe(localCredits(e.model, { duration: 5, resolution }));
        expect(price).toBe(`About ${credits} credits per 5 s at ${resolution}`);
      } else {
        expect(credits).toBeNull();
      }
    }
  });

  it("overview options: price, quality note and default flag for stt, tts and lipsync", async () => {
    const out = await providerOptions(config({ lipsync: "wan-2.7" }));
    for (const cap of ["stt", "tts", "lipsync"] as const) {
      expect(out[cap].length).toBeGreaterThan(0);
      for (const o of out[cap]) {
        expect(typeof o.price).toBe("string");
        expect(o.qualityNote.length).toBeGreaterThan(0);
        expect(typeof o.isDefault).toBe("boolean");
      }
    }
    expect(out.tts[0]).toMatchObject({ key: "xai", isDefault: true, price: `${ttsCredits(1000)} credits per 1,000 characters` });
    expect(out.stt[0]).toMatchObject({ key: "xai", isDefault: true });
    expect(out.lipsync.filter((o) => o.isDefault).map((o) => o.key).sort()).toEqual(["seedance-2.5-dialogue", "wan-2.7"]);
    // A broken setting falls back to the code default instead of failing the overview.
    const broken = await providerOptions(config({ lipsync: "nope", lipsyncLine: "wan-2.7" }));
    expect(broken.lipsync.filter((o) => o.isDefault).map((o) => o.key).sort()).toEqual(["seedance-2.5-dialogue", "wan-3.0-prime"]);
  });
});

describe("lipsyncRequest", () => {
  it("audio: the portrait as reference and our audio as an audio asset, resolved model", () => {
    const { entry, input, request } = lipsyncRequest({ portraitAssetId: "img-1", audioAssetId: "aud-1", issueId: "PAR-1" });
    expect(input).toBe("audio");
    expect(entry.key).toBe("wan-3.0-prime");
    expect(request).toMatchObject({ model: "alibaba/wan-3.0-prime/reference-to-video", referenceAssetIds: ["img-1"], audioAssetIds: ["aud-1"], issueId: "PAR-1" });
  });

  it("line: the model says the line, no audio asset", () => {
    const { entry, request } = lipsyncRequest({ portraitAssetId: "img-1", line: "Hello there" });
    expect(entry.key).toBe("seedance-2.5-dialogue");
    expect(request.model).toBe("bytedance/seedance-2.5/image-to-video");
    expect(request.prompt).toContain('"Hello there"');
    expect(request).not.toHaveProperty("audioAssetIds");
  });

  it.each([
    [{ audioAssetId: "a" }],
    [{ portraitAssetId: "i" }],
    [{ portraitAssetId: "i", audioAssetId: "a", line: "hi" }],
    [{ portraitAssetId: "i", line: "x".repeat(501) }],
    [{ portraitAssetId: "i", audioAssetId: "a", provider: "seedance-2.5-dialogue" }],
  ])("refuses %j with bad_request", (params) => {
    expect(() => lipsyncRequest(params)).toThrow(expect.objectContaining({ code: "bad_request" }));
  });
});
