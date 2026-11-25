/** Text to speech seam and price (PAR-8407 T3). */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioConfig } from "../src/config.js";
import { PROVIDERS, providerOptions, ttsFor } from "../src/providers/registry.js";
import { StudioError } from "../src/errors.js";
import { ELEVENLABS_VOICES, elevenLabsTextToSpeech, FAKE_MP3, xaiTextToSpeech, XAI_TTS_URL } from "../src/video-edit/tts.js";
import { ELEVENLABS_JOB_CEILING_CREDITS, MAX_SCRIPT_CHARS, TTS_JOB_CEILING_CREDITS, ttsCredits, ttsEstimate } from "../src/video-edit/tts-price.js";

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

describe("ElevenLabs text to speech (fake fetch, no live call)", () => {
  const input = { text: "Hello there", voice: ELEVENLABS_VOICES[1], language: "en" };

  it("posts to /text-to-speech/{voice} with xi-api-key, the model and the text, and returns the MP3", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const tts = elevenLabsTextToSpeech("el-key", async (url, init) => {
      calls.push({ url, init });
      return new Response(FAKE_MP3, { status: 200 });
    });
    const out = await tts.synthesize(input);
    expect(out).toEqual({ audio: FAKE_MP3, mime: "audio/mpeg" });
    expect(calls[0]!.url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICES[1]}?output_format=mp3_44100_128`);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe("el-key");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: "Hello there", model_id: "eleven_multilingual_v2" });
  });

  it("rejects non-MP3, maps HTTP and network errors, and never leaks the key", async () => {
    const html = elevenLabsTextToSpeech("el-key", async () => new Response("<html>", { status: 200 }));
    await expect(html.synthesize(input)).rejects.toMatchObject({ code: "provider_error" });
    const denied = await elevenLabsTextToSpeech("el-key", async () => new Response("el-key bad", { status: 401 })).synthesize(input).catch((e: Error) => e);
    expect(denied).toMatchObject({ code: "provider_error" });
    expect((denied as Error).message).not.toContain("el-key");
    const down = await elevenLabsTextToSpeech("el-key", async () => Promise.reject(new Error("failed el-key"))).synthesize(input).catch((e: Error) => e);
    expect(down).toMatchObject({ code: "provider_unavailable" });
    expect((down as Error).message).not.toContain("el-key");
  });

  it("ttsFor: listed after xAI, xAI stays the default, no key means not_configured", async () => {
    expect(PROVIDERS.tts.map((p) => p.key)).toEqual(["xai", "elevenlabs"]);
    const noKey = { providerDefault: async () => undefined, xaiKey: async () => "k", elevenLabsKey: async () => Promise.reject(new StudioError("no key", "not_configured")) } as unknown as StudioConfig;
    expect((await ttsFor(undefined, noKey)).key).toBe("xai");
    await expect(ttsFor("elevenlabs", noKey)).rejects.toMatchObject({ code: "not_configured" });
    const keyed = { ...noKey, elevenLabsKey: async () => "k" } as unknown as StudioConfig;
    expect((await ttsFor("elevenlabs", keyed)).key).toBe("elevenlabs");
    const opts = await providerOptions({ providerDefault: async () => undefined, hasSecret: async (p: string) => p === "xai.apiKey" });
    expect(opts.tts.map((o) => [o.key, o.configured, o.isDefault])).toEqual([["xai", true, true], ["elevenlabs", false, false]]);
  });

  it("prices $0.08 per 1,000 characters and enforces its own ceiling", () => {
    expect(ttsCredits(1000, "elevenlabs")).toBe(1.28);
    expect(ttsCredits(4000, "elevenlabs")).toBe(5.12);
    expect(ELEVENLABS_JOB_CEILING_CREDITS).toBe(5.12);
    expect(ttsEstimate(MAX_SCRIPT_CHARS, undefined, "elevenlabs")).toBe(5.12);
    expect(() => ttsEstimate(4000, 5, "elevenlabs")).toThrow(expect.objectContaining({ code: "over_ceiling" }));
    expect(ttsEstimate(MAX_SCRIPT_CHARS)).toBe(0.96); // xAI unchanged
  });
});
