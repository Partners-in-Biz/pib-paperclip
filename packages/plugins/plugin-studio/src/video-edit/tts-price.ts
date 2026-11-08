/**
 * Text to speech price and limits (PAR-8407 T3). Owner: Planner; change by PR.
 * xAI bills $15.00 per 1M input characters (docs.x.ai/developers/models/text-to-speech, read 2026-11-08). The
 * response is binary MP3 with no usage field, so the estimate is the charge: one reserve row, no adjust.
 */
import { credits } from "../db.js";
import { StudioError } from "../errors.js";
import { USD_PER_CREDIT } from "../seedance-price.js";

export const TTS_USD_PER_CHAR = 15 / 1_000_000;
/** xAI's unary limit is 60,000 characters per request (docs.x.ai text-to-speech, Limits); Studio keeps scripts short. */
export const MAX_SCRIPT_CHARS = 4000;
/** One voiceover may cost at most this (4,000 chars = 0.96 credits = $0.06, about R1.10). Guards a price change. */
export const TTS_JOB_CEILING_CREDITS = 1;

/** Credits for `chars` characters: 0.00024 per character. */
export function ttsCredits(chars: number): number {
  return credits((chars * TTS_USD_PER_CHAR) / USD_PER_CREDIT);
}

/** The estimate, refused when it is over the ceiling (before anything is reserved or sent). */
export function ttsEstimate(chars: number, ceiling = TTS_JOB_CEILING_CREDITS): number {
  const estimate = ttsCredits(chars);
  if (estimate > ceiling) throw new StudioError(`This voiceover would cost ${estimate} credits; one voiceover may cost at most ${ceiling}. Nothing was started. Use a shorter script.`, "over_ceiling");
  return estimate;
}
