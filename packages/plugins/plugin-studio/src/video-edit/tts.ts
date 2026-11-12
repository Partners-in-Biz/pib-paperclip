/**
 * Text to speech for voiceovers (PAR-8407 T3). One seam, `TextToSpeech`, like stt.ts. xAI: `POST /v1/tts` with JSON
 * `{text, voice_id, language}`; the answer is raw MP3 bytes (docs.x.ai text-to-speech Quick Start, read 2026-11-08).
 * The bytes are sniffed: anything that is not MP3 is a provider error, so it is never stored.
 * `PIB_STUDIO_FAKE_PROVIDER=1` swaps in a fake that never calls out.
 */
import { StudioError } from "../errors.js";
import { sniffMime } from "../storage.js";

export const XAI_TTS_URL = "https://api.x.ai/v1/tts";
export const XAI_TTS_MODEL = "grok-tts";
/** The Voice plugin's list (plugin-voice config.ts), default first. */
export const XAI_VOICES = ["eve", "ara", "rex", "sal", "leo"] as const;
export const DEFAULT_VOICE = "eve";
const TTS_TIMEOUT_MS = 120_000;

export interface TtsInput {
  text: string;
  voice: string;
  language: string;
}

export interface TtsResult {
  audio: Uint8Array<ArrayBuffer>;
  mime: "audio/mpeg";
}

export interface TextToSpeech {
  readonly key: string;
  readonly model: string;
  readonly voices: readonly string[];
  synthesize(input: TtsInput): Promise<TtsResult>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function xaiTextToSpeech(apiKey: string, fetchImpl: FetchLike = fetch): TextToSpeech {
  return {
    key: "xai",
    model: XAI_TTS_MODEL,
    voices: XAI_VOICES,
    async synthesize(input) {
      let res: Response;
      try {
        res = await fetchImpl(XAI_TTS_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ text: input.text, voice_id: input.voice, language: input.language }),
          signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
        });
      } catch (e) {
        throw new StudioError(`Text to speech did not answer: ${e instanceof Error ? e.message : String(e)}`, "provider_unavailable");
      }
      if (!res.ok) {
        const hint = res.status === 401 || res.status === 403 ? " Check the xAI key in Studio's plugin settings." : res.status === 429 ? " xAI is rate limiting or out of credit." : "";
        throw new StudioError(`Text to speech failed (${res.status}).${hint}`, "provider_error");
      }
      const audio = new Uint8Array(await res.arrayBuffer());
      if (sniffMime(audio) !== "audio/mpeg") throw new StudioError("Text to speech did not send back an MP3 file.", "provider_error");
      return { audio, mime: "audio/mpeg" };
    },
  };
}

export const ELEVENLABS_TTS_BASE = "https://api.elevenlabs.io/v1/text-to-speech";
export const ELEVENLABS_TTS_MODEL = "eleven_multilingual_v2";
/** ElevenLabs premade voices (elevenlabs.io/docs voice library, read 2026-11-09): Rachel first, then Adam, Bella, Josh, Sam. */
export const ELEVENLABS_VOICES = ["21m00Tcm4TlvDq8ikWAM", "pNInz6obpgDQGcFmaJgB", "EXAVITQu4vr4xnSDxMaL", "TxGEqnHWrfWFTfGW9XjX", "yoZ06aMxZJJ28mfd3POQ"] as const;

/**
 * ElevenLabs: `POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128` with the key in `xi-api-key` and JSON
 * `{text, model_id}`; the answer is raw MP3 bytes. No `language_code`: the multilingual model detects the language
 * (only the v2.5 Flash/Turbo models accept one). The key never reaches an error message.
 */
export function elevenLabsTextToSpeech(apiKey: string, fetchImpl: FetchLike = fetch): TextToSpeech {
  return {
    key: "elevenlabs",
    model: ELEVENLABS_TTS_MODEL,
    voices: ELEVENLABS_VOICES,
    async synthesize(input) {
      let res: Response;
      try {
        res = await fetchImpl(`${ELEVENLABS_TTS_BASE}/${encodeURIComponent(input.voice)}?output_format=mp3_44100_128`, {
          method: "POST",
          headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({ text: input.text, model_id: ELEVENLABS_TTS_MODEL }),
          signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
        });
      } catch (e) {
        throw new StudioError(`Text to speech did not answer: ${e instanceof Error ? e.message : String(e)}`.replaceAll(apiKey, "[key]"), "provider_unavailable");
      }
      if (!res.ok) {
        const hint = res.status === 401 || res.status === 403 ? " Check the ElevenLabs key in Studio's plugin settings." : res.status === 429 ? " ElevenLabs is rate limiting or out of credit." : "";
        throw new StudioError(`Text to speech failed (${res.status}).${hint}`, "provider_error");
      }
      const audio = new Uint8Array(await res.arrayBuffer());
      if (sniffMime(audio) !== "audio/mpeg") throw new StudioError("Text to speech did not send back an MP3 file.", "provider_error");
      return { audio, mime: "audio/mpeg" };
    },
  };
}

/** An ID3v2 header and one MPEG-1 layer III frame header: sniffs as MP3. Tests inject their own probe. */
export const FAKE_MP3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);

/** Tests and local runs: never calls out. */
export function fakeTextToSpeech(audio: Uint8Array = FAKE_MP3): TextToSpeech & { calls: TtsInput[] } {
  const calls: TtsInput[] = [];
  return {
    key: "fake",
    model: XAI_TTS_MODEL,
    voices: XAI_VOICES,
    calls,
    async synthesize(input) {
      calls.push(input);
      return { audio: new Uint8Array(audio), mime: "audio/mpeg" };
    },
  };
}
