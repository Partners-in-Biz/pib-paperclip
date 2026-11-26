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

/** Spoken-reply text (T3): cap before "The rest is in the chat.", first and later chunk sizes. */
export const SPEECH_MAX_CHARS = 1_500;
export const SPEECH_FIRST_CHUNK_CHARS = 160;
export const SPEECH_CHUNK_CHARS = 300;

/** Direct-mode endpointing (T3): all times in ms, levels are RMS 0..1 from `level()` in `ui/audio.ts`. */
export const ENDPOINT_SPEECH_LEVEL = 0.02;
export const ENDPOINT_START_MS = 150;
export const ENDPOINT_END_QUIET_MS = 1_200;
export const ENDPOINT_MAX_UTTERANCE_MS = 90_000;
/** Barge-in: level above this multiple of the speech level for this long. */
export const BARGE_IN_LEVEL_FACTOR = 2;
export const BARGE_IN_MS = 300;
