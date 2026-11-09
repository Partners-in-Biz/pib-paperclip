import { describe, expect, it } from "vitest";
import type { StudioConfig } from "../src/config.js";
import { StudioError } from "../src/errors.js";
import { PROVIDERS, sttFor } from "../src/providers/registry.js";
import { ELEVENLABS_STT_MODEL, ELEVENLABS_STT_URL, elevenLabsSpeechToText } from "../src/video-edit/stt.js";

const input = { audio: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", language: "af" };

describe("ElevenLabs Scribe speech to text (PAR-8714)", () => {
  it("sends a multipart request with the key header and maps words", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const stt = elevenLabsSpeechToText("el-key", async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({
        audio_duration_secs: 2.5,
        words: [
          { text: "world", start: 0.6, end: 1, type: "word" },
          { text: " ", start: 0.5, end: 0.6, type: "spacing" },
          { text: "(laughter)", start: 1.1, end: 1.4, type: "audio_event" },
          { text: "Hello", start: 0.1, end: 0.5, type: "word" },
          { text: "bad", start: 3, end: 2, type: "word" },
        ],
      }), { status: 200 });
    });
    const res = await stt.transcribe(input);
    expect(res).toEqual({ words: [{ text: "Hello", start: 0.1, end: 0.5 }, { text: "world", start: 0.6, end: 1 }], duration: 2.5 });
    expect(seen!.url).toBe(ELEVENLABS_STT_URL);
    expect(seen!.init.method).toBe("POST");
    expect(seen!.init.headers).toEqual({ "xi-api-key": "el-key" });
    const form = seen!.init.body as FormData;
    expect(form.get("model_id")).toBe(ELEVENLABS_STT_MODEL);
    expect(form.get("language_code")).toBe("af");
    expect(form.get("timestamps_granularity")).toBe("word");
    expect((form.get("file") as File).size).toBe(3);
  });

  it("maps HTTP errors and never leaks the key", async () => {
    const denied = await elevenLabsSpeechToText("el-key", async () => new Response("el-key bad", { status: 401 })).transcribe(input).catch((e: Error) => e);
    expect(denied).toMatchObject({ code: "provider_error" });
    expect((denied as Error).message).toContain("(401)");
    expect((denied as Error).message).not.toContain("el-key");
    const limited = await elevenLabsSpeechToText("el-key", async () => new Response("", { status: 429 })).transcribe(input).catch((e: Error) => e);
    expect((limited as Error).message).toContain("rate limiting");
    const down = await elevenLabsSpeechToText("el-key", async () => Promise.reject(new Error("failed el-key"))).transcribe(input).catch((e: Error) => e);
    expect(down).toMatchObject({ code: "provider_unavailable" });
    expect((down as Error).message).not.toContain("el-key");
    await expect(elevenLabsSpeechToText("el-key", async () => { throw new Error("no call"); }).transcribe({ ...input, audio: new Uint8Array() })).rejects.toMatchObject({ code: "no_speech" });
  });

  it("sttFor: listed after xAI, xAI stays default, no key means not_configured", async () => {
    expect(PROVIDERS.stt.map((p) => p.key)).toEqual(["xai", "elevenlabs"]);
    const noKey = { providerDefault: async () => undefined, xaiKey: async () => "k", elevenLabsKey: async () => Promise.reject(new StudioError("no key", "not_configured")) } as unknown as StudioConfig;
    expect((await sttFor(undefined, noKey)).key).toBe("xai");
    await expect(sttFor("elevenlabs", noKey)).rejects.toMatchObject({ code: "not_configured" });
    const keyed = { ...noKey, elevenLabsKey: async () => "k" } as unknown as StudioConfig;
    expect((await sttFor("elevenlabs", keyed)).key).toBe("elevenlabs");
  });
});
