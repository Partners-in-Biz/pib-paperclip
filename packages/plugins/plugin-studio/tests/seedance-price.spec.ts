import { afterEach, describe, expect, it, vi } from "vitest";
import { isTablePriced, localCredits, SEEDANCE_PIXELS, SEEDANCE_RATES, USD_PER_CREDIT } from "../src/seedance-price.js";
import { creditsIn, higgsfieldProvider } from "../src/provider.js";

const V20 = "bytedance/seedance-2.0/text-to-video";
const V25 = "bytedance/seedance-2.5/text-to-video";
const body = (extra: Record<string, unknown> = {}) => ({ prompt: "waves at sunset", duration: 5, resolution: "720p", aspect_ratio: "16:9", ...extra });

function noPrice(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe("no_price");
    return;
  }
  throw new Error("expected no_price");
}

describe("Seedance local price", () => {
  it.each([
    [V20, 5, "720p", 24.192],
    [V20, 5, "480p", 10.761],
    [V25, 5, "480p", 16.449],
    [V25, 4, "720p", 29.584],
  ])("%s %i s %s 16:9 costs %f credits", (model, duration, resolution, credits) => {
    expect(Math.abs((localCredits(model, body({ duration, resolution })) as number) - credits)).toBeLessThan(0.001);
  });

  it("matches Higgsfield's published 16:9 dollars per second", () => {
    const perSecond = (model: string, resolution: string) =>
      ((localCredits(model, body({ duration: 1, resolution })) as number) * USD_PER_CREDIT);
    expect(perSecond(V20, "480p")).toBeCloseTo(0.1345, 3);
    expect(perSecond(V20, "720p")).toBeCloseTo(0.3024, 3);
    expect(perSecond(V20, "1080p")).toBeCloseTo(0.6804, 3);
    expect(perSecond(V25, "480p")).toBeCloseTo(0.2056, 3);
    expect(perSecond(V25, "720p")).toBeCloseTo(0.4622, 3);
  });

  it("prices only what was cited", () => {
    expect(USD_PER_CREDIT).toBe(0.0625);
    expect(Object.keys(SEEDANCE_RATES[V25])).toEqual(["480p", "720p"]);
    for (const ratios of Object.values(SEEDANCE_PIXELS)) expect(Object.keys(ratios)).toEqual(["16:9"]);
  });

  it("gives null for a model that is not table-priced", () => {
    expect(localCredits("kling-video/v3.0/turbo/text-to-video", body())).toBeNull();
    expect(localCredits("toString", body())).toBeNull();
  });

  it("refuses a missing duration", () => noPrice(() => localCredits(V20, body({ duration: undefined }))));
  it("refuses an unknown duration", () => noPrice(() => localCredits(V20, body({ duration: "5" }))));
  it("refuses a missing resolution", () => noPrice(() => localCredits(V20, body({ resolution: undefined }))));
  it("refuses an unknown resolution", () => noPrice(() => localCredits(V20, body({ resolution: "540p" }))));
  it("refuses a missing aspect ratio", () => noPrice(() => localCredits(V20, body({ aspect_ratio: undefined }))));
  it("refuses an unknown aspect ratio", () => noPrice(() => localCredits(V20, body({ aspect_ratio: "9:16" }))));
  it("refuses 4K on 2.0", () => noPrice(() => localCredits(V20, body({ resolution: "4k" }))));
  it("refuses 1080p on 2.5", () => noPrice(() => localCredits(V25, body({ resolution: "1080p" }))));
  it("refuses a reference field", () => noPrice(() => localCredits(V25, body({ image_url: "https://example.com/a.png" }))));
});

describe("provider price guard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([[0], [-1], [Number.NaN], ["0"], ["-1"], ["NaN"]])("creditsIn treats %s as no price", (credits) => {
    expect(creditsIn({ credits })).toBeNull();
  });

  it.each([[0], [-1], ["NaN"]])("estimate with credits %s throws no_price", async (credits) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ type: "estimate", credits }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(higgsfieldProvider("id:secret").estimate("kling-video/v3.0/turbo/text-to-video", body())).rejects.toMatchObject({ code: "no_price" });
  });

  it("estimate still passes a real price through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ type: "estimate", credits: "8.960", usd: "0.560" }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(higgsfieldProvider("id:secret").estimate("kling-video/v3.0/turbo/text-to-video", body())).resolves.toBe(8.96);
  });
});

describe("per-second lip-sync prices (PAR-8435)", () => {
  const WAN3 = "alibaba/wan-3.0-prime/reference-to-video";
  const SD_I2V = "bytedance/seedance-2.5/image-to-video";
  const media = { image_urls: ["https://x/a.png"], audio_urls: ["https://x/a.mp3"] };
  it("prices duration x the per-second rate, the portrait and audio included", () => {
    expect(localCredits(WAN3, { prompt: "hi", duration: 5, resolution: "480p", ...media })).toBe(5.44);
    expect(localCredits(SD_I2V, { prompt: "hi", duration: 5, resolution: "480p", generate_audio: true, image_url: "https://x/a.png" })).toBe(16.448);
    expect(isTablePriced(WAN3)).toBe(true);
  });
  it("refuses an unpriced resolution, a missing duration and a video reference", () => {
    for (const body of [{ duration: 5, resolution: "720p" }, { duration: 5, resolution: "1080p" }, { resolution: "480p" }, { duration: 5, resolution: "480p", video_urls: ["https://x/v.mp4"] }]) {
      expect(() => localCredits(WAN3, body)).toThrow(expect.objectContaining({ code: "no_price" }));
    }
  });
});
