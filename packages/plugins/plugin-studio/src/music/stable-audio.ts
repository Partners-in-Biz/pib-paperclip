/**
 * Stable Audio 2.5 text to music (PAR-10255 T1, plan PAR-10138). One seam, `MusicGenerator`.
 * `POST https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio`, multipart `prompt`, `duration`, `model`,
 * `output_format=mp3`; the answer is raw MP3 bytes (docs.stability.ai sample).
 *
 * `generate` never throws for a provider outcome. The outcome table below is the ONLY place that decides whether a
 * failed call may be refunded: `charged: "no"` is a refusal Stability says it did not bill; `"maybe"` is anything we
 * cannot prove, and is never refunded (USD 25/month hard cap, Peet-approved PAR-10127).
 * `PIB_STUDIO_FAKE_PROVIDER=1` swaps in a fake that never calls out.
 */
import { sniffMime } from "../storage.js";
import { FAKE_MUSIC_MP3 } from "./fake-mp3.js";

export const STABLE_AUDIO_URL = "https://api.stability.ai/v2beta/audio/stable-audio-2/text-to-audio";
export const STABLE_AUDIO_MODEL = "stable-audio-2.5";
export const MUSIC_PROVIDER_TIMEOUT_MS = 120_000;

export type MusicResult =
  | { ok: true; audio: Uint8Array; mime: "audio/mpeg"; ms: number }
  | { ok: false; charged: "no" | "maybe"; httpStatus: number | null; code: string; message: string; ms: number };

export interface MusicInput {
  prompt: string;
  duration: number;
  signal?: AbortSignal;
}

export interface MusicGenerator {
  readonly key: string;
  readonly model: string;
  generate(input: MusicInput): Promise<MusicResult>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Statuses Stability refuses before billing, with the message a person sees. */
const NOT_CHARGED: Record<number, { code: string; message: string }> = {
  400: { code: "bad_request", message: "Stable Audio could not read this request. Check the prompt and length." },
  401: { code: "provider_error", message: "Stable Audio rejected the key: check the Stability key in Studio's plugin settings." },
  403: { code: "provider_error", message: "Stable Audio refused this prompt (moderation). Try different wording." },
  422: { code: "provider_error", message: "Stable Audio refused this prompt. Try different wording." },
  429: { code: "provider_error", message: "Stable Audio is rate limited. Try again in a minute." },
};

export function stabilityMusic(apiKey: string, fetchImpl: FetchLike = fetch): MusicGenerator {
  return {
    key: "stability",
    model: STABLE_AUDIO_MODEL,
    async generate({ prompt, duration, signal }) {
      const started = Date.now();
      const ms = () => Date.now() - started;
      const fail = (charged: "no" | "maybe", httpStatus: number | null, code: string, message: string): MusicResult => ({ ok: false, charged, httpStatus, code, message, ms: ms() });
      const form = new FormData();
      form.set("prompt", prompt);
      form.set("duration", String(duration));
      form.set("model", STABLE_AUDIO_MODEL);
      form.set("output_format", "mp3");
      const timeout = AbortSignal.timeout(MUSIC_PROVIDER_TIMEOUT_MS);
      let res: Response;
      let bytes: Uint8Array | null = null;
      try {
        res = await fetchImpl(STABLE_AUDIO_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, accept: "audio/*" },
          body: form,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (res.status === 200) bytes = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        return fail("maybe", null, "provider_unknown", `Stable Audio did not answer (${e instanceof Error ? e.name : "error"}); it may still have been billed.`);
      }
      if (res.status === 200) {
        // The content-type header is ignored: only the bytes decide (rule PAR-9909).
        if (bytes && sniffMime(bytes) === "audio/mpeg") return { ok: true, audio: bytes, mime: "audio/mpeg", ms: ms() };
        return fail("maybe", 200, "provider_error", "Stable Audio did not send back an MP3 file.");
      }
      const refused = NOT_CHARGED[res.status];
      if (refused) return fail("no", res.status, refused.code, refused.message);
      return fail("maybe", res.status, "provider_error", `Stable Audio failed (${res.status}); it may still have been billed.`);
    },
  };
}

/** Tests and local runs: never calls out. */
export function fakeMusic(audio: Uint8Array = FAKE_MUSIC_MP3): MusicGenerator & { calls: MusicInput[] } {
  const calls: MusicInput[] = [];
  return {
    key: "fake",
    model: STABLE_AUDIO_MODEL,
    calls,
    async generate(input) {
      calls.push(input);
      return { ok: true, audio: new Uint8Array(audio), mime: "audio/mpeg", ms: 0 };
    },
  };
}
