/**
 * Text to speech price and limits (PAR-8407 T3). Owner: Planner; change by PR.
 * xAI bills $15.00 per 1M input characters (docs.x.ai/developers/models/text-to-speech, read 2026-11-08). The
 * response is binary MP3 with no usage field, so the estimate is the charge: one reserve row, no adjust.
 * ElevenLabs bills $0.08 per 1,000 characters on the Multilingual v2 model Studio uses ($0.04 on Flash/Turbo)
 * (elevenlabs.io/pricing/api, read 2026-11-09). At that price one 4,000-character job is $0.32 = 5.12 credits, so its
 * ceiling is 5.12, not 1. The monthly caps are untouched.
 */
import { credits } from "../db.js";
import { StudioError } from "../errors.js";
import { USD_PER_CREDIT } from "../seedance-price.js";

export const TTS_USD_PER_CHAR = 15 / 1_000_000;
export const ELEVENLABS_USD_PER_CHAR = 0.08 / 1000;
/** xAI's unary limit is 60,000 characters per request (docs.x.ai text-to-speech, Limits); Studio keeps scripts short. */
export const MAX_SCRIPT_CHARS = 4000;
/** One voiceover may cost at most this (4,000 chars = 0.96 credits = $0.06, about R1.10). Guards a price change. */
export const TTS_JOB_CEILING_CREDITS = 1;
/** ElevenLabs: the real cost of a full-length job (4,000 chars x $0.00008 / $0.0625 = 5.12 credits). */
export const ELEVENLABS_JOB_CEILING_CREDITS = 5.12;

const PRICES: Record<string, { usdPerChar: number; ceiling: number }> = {
  xai: { usdPerChar: TTS_USD_PER_CHAR, ceiling: TTS_JOB_CEILING_CREDITS },
  elevenlabs: { usdPerChar: ELEVENLABS_USD_PER_CHAR, ceiling: ELEVENLABS_JOB_CEILING_CREDITS },
};
const priceOf = (provider: string) => PRICES[provider] ?? PRICES.xai!;

/** Credits for `chars` characters: xAI 0.00024 per character, ElevenLabs 0.00128. */
export function ttsCredits(chars: number, provider = "xai"): number {
  return credits((chars * priceOf(provider).usdPerChar) / USD_PER_CREDIT);
}

/** The estimate, refused when it is over the ceiling (before anything is reserved or sent). */
export function ttsEstimate(chars: number, ceiling?: number, provider = "xai"): number {
  const max = ceiling ?? priceOf(provider).ceiling;
  const estimate = ttsCredits(chars, provider);
  if (estimate > max) throw new StudioError(`This voiceover would cost ${estimate} credits; one voiceover may cost at most ${max}. Nothing was started. Use a shorter script.`, "over_ceiling");
  return estimate;
}
