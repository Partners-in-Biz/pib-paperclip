/**
 * Speech to text for auto-captions (PAR-8360 B9). One seam, `SpeechToText`, so a local engine (whisper.cpp) can
 * replace xAI later without touching the caption action. xAI's batch STT (`grok-voice-transcribe-2.0`, the model the
 * Voice plugin uses) returns `words: [{text, start, end}]` in seconds from the start of the uploaded audio.
 * `PIB_STUDIO_FAKE_PROVIDER=1` swaps in a fake that never calls out (same switch as generation).
 */
import { StudioError } from "../errors.js";

export const XAI_STT_URL = "https://api.x.ai/v1/stt";
export const XAI_STT_MODEL = "grok-voice-transcribe-2.0";
/** The extracted clip audio is 16 kHz mono WAV: 180 s is about 5.8 MB. */
export const MAX_STT_BYTES = 25 * 1024 * 1024;
const STT_TIMEOUT_MS = 180_000;

export interface SttWord {
  text: string;
  /** Seconds from the start of the audio sent. */
  start: number;
  end: number;
}

export interface SttResult {
  words: SttWord[];
  duration: number | null;
}

export interface SttInput {
  audio: Uint8Array;
  mimeType: string;
  /** e.g. "en" or "af"; omit to let the engine detect it. */
  language?: string;
}

export interface SpeechToText {
  readonly key: string;
  transcribe(input: SttInput): Promise<SttResult>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Keeps only well-formed words, in time order. Engines differ on field names; xAI uses `text` (some use `word`). */
export function parseSttWords(raw: unknown): SttWord[] {
  if (!Array.isArray(raw)) return [];
  const out: SttWord[] = [];
  for (const w of raw) {
    const o = (w ?? {}) as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text : typeof o.word === "string" ? o.word : "";
    const start = Number(o.start);
    const end = Number(o.end);
    if (!text.trim() || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) continue;
    out.push({ text: text.trim(), start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function xaiSpeechToText(apiKey: string, fetchImpl: FetchLike = fetch): SpeechToText {
  return {
    key: "xai",
    async transcribe(input) {
      if (input.audio.byteLength === 0) throw new StudioError("The clip's sound is empty.", "no_speech");
      if (input.audio.byteLength > MAX_STT_BYTES) throw new StudioError("The clip's sound is too long to transcribe in one go.", "too_large");
      // Option fields must come before the file in the multipart body.
      const form = new FormData();
      form.append("model", XAI_STT_MODEL);
      if (input.language) {
        form.append("language", input.language);
        form.append("format", "true");
      }
      form.append("file", new Blob([new Uint8Array(input.audio)], { type: input.mimeType }), "clip.wav");
      let res: Response;
      try {
        res = await fetchImpl(XAI_STT_URL, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(STT_TIMEOUT_MS) });
      } catch (e) {
        throw new StudioError(`Speech to text did not answer: ${e instanceof Error ? e.message : String(e)}`, "provider_unavailable");
      }
      if (!res.ok) {
        const hint = res.status === 401 || res.status === 403 ? " Check the xAI key in Studio's plugin settings." : res.status === 429 ? " xAI is rate limiting or out of credit." : "";
        throw new StudioError(`Speech to text failed (${res.status}).${hint}`, "provider_error");
      }
      const body = (await res.json().catch(() => ({}))) as { words?: unknown; duration?: unknown };
      return { words: parseSttWords(body.words), duration: typeof body.duration === "number" ? body.duration : null };
    },
  };
}

/** Tests and local runs: fixed words, or two words spread over the first second. Never calls out. */
export function fakeSpeechToText(words: SttWord[] = [{ text: "Hello", start: 0.1, end: 0.4 }, { text: "world", start: 0.5, end: 0.9 }]): SpeechToText & { calls: SttInput[] } {
  const calls: SttInput[] = [];
  return {
    key: "fake",
    calls,
    async transcribe(input) {
      calls.push(input);
      return { words: words.map((w) => ({ ...w })), duration: null };
    },
  };
}
