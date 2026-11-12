import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeMusic, MUSIC_PROVIDER_TIMEOUT_MS, stabilityMusic, STABLE_AUDIO_URL } from "../src/music/stable-audio.js";
import { FAKE_MUSIC_MP3 } from "../src/music/fake-mp3.js";
import { musicCapCredits, musicCredits, assertMusicCapFits } from "../src/music/stable-audio-price.js";
import { sniffMime } from "../src/storage.js";

const MP3 = new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", "music.mp3")));
type Call = { url: string; init: RequestInit };

function gen(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const g = stabilityMusic("sk-test", async (url, init) => {
    calls.push({ url, init });
    return respond();
  });
  return { g, calls };
}
const run = (g: ReturnType<typeof gen>["g"]) => g.generate({ prompt: "calm piano", duration: 30 });
const body = (status: number, text = "x") => new Response(text, { status });

describe("music fixture", () => {
  it("is a real small mp3 and is what the fake returns", () => {
    expect(MP3.length).toBeLessThanOrEqual(20_000);
    expect(sniffMime(MP3)).toBe("audio/mpeg");
    expect(Buffer.from(FAKE_MUSIC_MP3).equals(Buffer.from(MP3))).toBe(true);
  });
  it("fakeMusic never calls out and records the call", async () => {
    const f = fakeMusic();
    const r = await f.generate({ prompt: "p", duration: 5 });
    expect(r.ok && r.mime).toBe("audio/mpeg");
    expect(f.calls).toHaveLength(1);
  });
});

describe("Stable Audio request", () => {
  it("sends the exact URL, headers and form fields", async () => {
    const { g, calls } = gen(() => new Response(MP3, { status: 200 }));
    await run(g);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio");
    expect(STABLE_AUDIO_URL).toBe(calls[0].url);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ authorization: "Bearer sk-test", accept: "audio/*" });
    const form = calls[0].init.body as FormData;
    expect(Object.fromEntries(form.entries())).toEqual({ prompt: "calm piano", duration: "30", model: "stable-audio-2.5", output_format: "mp3" });
    expect(MUSIC_PROVIDER_TIMEOUT_MS).toBe(120_000);
  });
});

describe("Stable Audio outcome table", () => {
  it("200 + mp3 bytes is ok, whatever the content-type says", async () => {
    const { g } = gen(() => new Response(MP3, { status: 200, headers: { "content-type": "application/json" } }));
    const r = await run(g);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.audio.length).toBe(MP3.length);
  });
  it("200 + JSON body labelled audio/mpeg is charged maybe and no bytes are returned", async () => {
    const { g } = gen(() => new Response('{"errors":["x"]}', { status: 200, headers: { "content-type": "audio/mpeg" } }));
    const r = await run(g);
    expect(r).toMatchObject({ ok: false, charged: "maybe", httpStatus: 200, code: "provider_error" });
    expect("audio" in r).toBe(false);
  });
  it.each([
    [400, "bad_request", /could not read/],
    [401, "provider_error", /check the Stability key/],
    [403, "provider_error", /refused this prompt/],
    [422, "provider_error", /refused this prompt/],
    [429, "provider_error", /rate limited/],
  ])("%i is not charged", async (status, code, message) => {
    const { g } = gen(() => body(status));
    const r = await run(g);
    expect(r).toMatchObject({ ok: false, charged: "no", httpStatus: status, code });
    if (!r.ok) expect(r.message).toMatch(message);
  });
  it.each([500, 502, 404, 413])("%i is charged maybe", async (status) => {
    const { g } = gen(() => body(status));
    expect(await run(g)).toMatchObject({ ok: false, charged: "maybe", httpStatus: status, code: "provider_error" });
  });
  it("network error is charged maybe, provider_unknown", async () => {
    const { g } = gen(() => Promise.reject(new TypeError("fetch failed")));
    expect(await run(g)).toMatchObject({ ok: false, charged: "maybe", httpStatus: null, code: "provider_unknown" });
  });
  it("abort is charged maybe, provider_unknown", async () => {
    const ac = new AbortController();
    const g = stabilityMusic("k", (_u, init) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    const p = g.generate({ prompt: "p", duration: 5, signal: ac.signal });
    ac.abort();
    expect(await p).toMatchObject({ ok: false, charged: "maybe", httpStatus: null, code: "provider_unknown" });
  });
  it("timeout is charged maybe, provider_unknown", async () => {
    const g = stabilityMusic("k", async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await run({ generate: g.generate } as never)).toMatchObject({ ok: false, charged: "maybe", code: "provider_unknown" });
  });
});

describe("Stable Audio price", () => {
  it("one track is 1.28 credits and the cap is 400", () => {
    expect(musicCredits()).toBe(1.28);
    expect(musicCapCredits()).toBe(400);
  });
  it("assertMusicCapFits: exactly 400.00 passes, 400.64 is refused with the USD 25 message", () => {
    expect(() => assertMusicCapFits(398.72, 1.28)).not.toThrow();
    try {
      assertMusicCapFits(399.36, 1.28);
      expect.unreachable();
    } catch (e) {
      expect((e as { code: string }).code).toBe("provider_cap_reached");
      expect((e as Error).message).toContain("USD 25");
    }
  });
});
