/**
 * Every size and timeout of the spoken-reply path in one place, so a dogfood run can retune them
 * without touching logic (plan PAR-14808, T1).
 */

/** The Gemini text-to-speech model. One constant, no per-company setting. */
export const GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";

/** Both providers answer headerless PCM16 little-endian mono at this rate. */
export const TTS_SAMPLE_RATE = 24000;

/** One `speak` call carries at least 1 and at most this many characters. */
export const SPEAK_MIN_CHARS = 1;
export const SPEAK_MAX_CHARS = 600;

/** Characters one person may have spoken per UTC day. */
export const SPEAK_DAILY_CHAR_CAP = 50_000;

/** The provider fetch is aborted after this long. */
export const PROVIDER_TIMEOUT_MS = 12_000;

/** The whole action answers `timeout` itself after this long; the host RPC gives up at 30 s. */
export const SPEAK_DEADLINE_MS = 20_000;

/** A provider answer above this many audio bytes (about 60 s of 24 kHz PCM16) is treated as a bad body. */
export const MAX_TTS_AUDIO_BYTES = 3 * 1024 * 1024;

/** Longest Gemini style line sent in `speech_metadata.style`. */
export const GEMINI_STYLE_MAX_CHARS = 120;
