/** Text to speech seam and price (PAR-8407 T3). */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioConfig } from "../src/config.js";
import { ttsFor } from "../src/providers/registry.js";
import { FAKE_MP3, xaiTextToSpeech, XAI_TTS_URL } from "../src/video-edit/tts.js";
import { MAX_SCRIPT_CHARS, TTS_JOB_CEILING_CREDITS, ttsCredits, ttsEstimate } from "../src/video-edit/tts-price.js";

afterEach(() => vi.unstubAllEnvs());

describe("xAI text to speech", () => {
  it("posts {text, voice_id, language} to /v1/tts with the key as Bearer, and returns the MP3", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const tts = xaiTextToSpeech("test-key", async (url, init) => {
      calls.push({ url, init });
      return new Response(FAKE_MP3, { status: 200, headers: { "content-type": "audio/mpeg" } });
    });
    const out = await tts.synthesize({ text: "Hello there", voice: "rex", language: "en" });
    expect(out.mime).toBe("audio/mpeg");
    expect(out.audio).toEqual(FAKE_MP3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.x.ai/v1/tts");
    expect(XAI_TTS_URL).toBe("https://api.x.ai/v1/tts");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: "Hello there", voice_id: "rex", language: "en" });
  });

  it("refuses a body that is not MP3, and HTTP errors, as provider errors without the key", async () => {
    const wav = xaiTextToSpeech("test-key", async () => new Response(new TextEncoder().encode('{"error":"nope"}'), { status: 200 }));
    await expect(wav.synthesize({ text: "x", voice: "eve", language: "en" })).rejects.toMatchObject({ code: "provider_error" });
    const denied = xaiTextToSpeech("test-key", async () => new Response("no", { status: 401 }));
    const err = await denied.synthesize({ text: "x", voice: "eve", language: "en" }).catch((e: Error) => e);
    expect(err).toMatchObject({ code: "provider_error" });
    expect(String((err as Error).message)).not.toContain("test-key");
    const down = xaiTextToSpeech("test-key", async () => Promise.reject(new Error("socket hang up")));
    await expect(down.synthesize({ text: "x", voice: "eve", language: "en" })).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("ttsFor picks xAI by default and the fake when PIB_STUDIO_FAKE_PROVIDER=1", async () => {
    const config = { providerDefault: async () => undefined, xaiKey: async () => "k" } as unknown as StudioConfig;
    expect((await ttsFor(undefined, config)).key).toBe("xai");
    await expect(ttsFor("nope", config)).rejects.toMatchObject({ code: "bad_request" });
    vi.stubEnv("PIB_STUDIO_FAKE_PROVIDER", "1");
    const fake = await ttsFor("xai", config);
    expect(fake.key).toBe("fake");
    expect((await fake.synthesize({ text: "hi", voice: "eve", language: "en" })).mime).toBe("audio/mpeg");
  });
});

describe("text to speech price", () => {
  it("charges $15 per 1M characters: 0.00024 credits a character, 0.96 for 4000", () => {
    expect(ttsCredits(1)).toBe(0.0002); // rounded to 4 places like every ledger amount
    expect(ttsCredits(1000)).toBe(0.24);
    expect(ttsCredits(4000)).toBe(0.96);
  });

  it("pins the script limit at 4000 (xAI allows 60,000) and the ceiling at 1 credit", () => {
    expect(MAX_SCRIPT_CHARS).toBe(4000);
    expect(TTS_JOB_CEILING_CREDITS).toBe(1);
    expect(ttsEstimate(MAX_SCRIPT_CHARS)).toBe(0.96);
    expect(() => ttsEstimate(4000, 0.5)).toThrow(expect.objectContaining({ code: "over_ceiling" }));
  });
});
