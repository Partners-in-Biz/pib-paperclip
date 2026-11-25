/**
 * Stable Audio price, limits and the USD 25/month hard cap (PAR-10255 T1). Owner: Ada; change by PR.
 * One Stability account serves every company, so the cap sums across all companies (no company filter).
 * Cap column and writers (rule PAR-6670): reads `credit_ledger.credits` for `generations.provider = 'stability'` rows;
 * written only by `reserve`/`refund` in the music action (T2), which also writes provider `stability`.
 * Fails closed: if the usage read throws, nothing starts.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { credits, num, table } from "../db.js";
import { StudioError } from "../errors.js";
import { USD_PER_CREDIT } from "../seedance-price.js";

export const STABLE_AUDIO_USD_PER_GENERATION = 0.08;
export const STABLE_AUDIO_MONTHLY_USD_CAP = 25;
/** Matches LIMITS.maxDuration in video-edit/timeline.ts. */
export const MUSIC_MAX_SECONDS = 180;
export const MUSIC_DEFAULT_SECONDS = 30;
export const MAX_PROMPT_CHARS = 2000;
export const MUSIC_WAIT_MS = 20_000;

/** One track: 1.28 credits. */
export const musicCredits = (): number => credits(STABLE_AUDIO_USD_PER_GENERATION / USD_PER_CREDIT);
/** The monthly cap: 400 credits. */
export const musicCapCredits = (): number => credits(STABLE_AUDIO_MONTHLY_USD_CAP / USD_PER_CREDIT);

/** Credits spent on Stability this period, all companies, refunds netted. */
export async function musicUsage(ctx: PluginContext, period: string): Promise<number> {
  const rows = await ctx.db.query<{ used: unknown }>(
    `SELECT COALESCE(SUM(l.credits), 0) AS used FROM ${table(ctx, "credit_ledger")} l JOIN ${table(ctx, "generations")} g ON g.id = l.generation_id WHERE l.period = $1 AND g.provider = 'stability'`,
    [period],
  );
  return credits(num(rows[0]?.used));
}

/** Refuses when `needed` more credits would pass the cap. Throws before anything is reserved or sent. */
export function assertMusicCapFits(used: number, needed: number = musicCredits()): void {
  if (credits(used + needed) <= musicCapCredits()) return;
  const spent = (Math.round(used * USD_PER_CREDIT * 100) / 100).toFixed(2);
  throw new StudioError(
    `Stable Audio's monthly limit of USD ${STABLE_AUDIO_MONTHLY_USD_CAP} is used up: USD ${spent} spent this month, this needs USD ${STABLE_AUDIO_USD_PER_GENERATION.toFixed(2)}. Nothing was started. It resets on the 1st (UTC). You can still add your own music from the Library.`,
    "provider_cap_reached",
  );
}

/** Reads usage then checks the cap. A throwing read propagates: the caller starts nothing (fail closed). */
export async function checkMusicCap(ctx: PluginContext, period: string): Promise<number> {
  const used = await musicUsage(ctx, period);
  assertMusicCapFits(used);
  return used;
}
