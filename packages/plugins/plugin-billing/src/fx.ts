/**
 * Daily FX rates for reporting and foreign-currency settlement.
 *
 * Source: frankfurter.app (ECB), falling back to exchangerate.host. Stored
 * per day and base in `fx_rates` (rates[X] = units of X per 1 base), so a
 * day is fetched once and history never changes. The reporting (book)
 * currency is the base, ZAR by default.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { table } from "./db.js";

export interface FxDay {
  day: string;
  base: string;
  rates: Record<string, number>;
  source: string;
}

type FetchLike = typeof fetch;

function cleanRates(input: unknown, base: string): Record<string, number> {
  const out: Record<string, number> = { [base]: 1 };
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const code = key.length === 6 && key.startsWith(base) ? key.slice(3) : key;
    const rate = Number(value);
    if (/^[A-Z]{3}$/.test(code) && Number.isFinite(rate) && rate > 0) out[code] = rate;
  }
  return out;
}

/** Fetch one day (or "latest") from frankfurter, then exchangerate.host. Null when both fail. */
export async function fetchRates(base: string, day: string | "latest", fetchImpl: FetchLike = fetch): Promise<FxDay | null> {
  const attempts: Array<{ source: string; url: string }> = [
    { source: "frankfurter", url: `https://api.frankfurter.app/${day}?from=${encodeURIComponent(base)}` },
    { source: "exchangerate.host", url: `https://api.exchangerate.host/${day}?base=${encodeURIComponent(base)}` },
  ];
  for (const attempt of attempts) {
    try {
      const res = await fetchImpl(attempt.url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const data = (await res.json()) as { date?: string; rates?: Record<string, unknown>; quotes?: Record<string, unknown>; success?: boolean };
      const rates = cleanRates(data.rates ?? data.quotes, base);
      if (Object.keys(rates).length < 2) continue;
      const when = typeof data.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.date) ? data.date : day === "latest" ? new Date().toISOString().slice(0, 10) : day;
      return { day: when, base, rates, source: attempt.source };
    } catch {
      continue;
    }
  }
  return null;
}

export async function storeRates(ctx: PluginContext, fx: FxDay): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "fx_rates")} (day, base, rates, source) VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (day, base) DO UPDATE SET rates = EXCLUDED.rates, source = EXCLUDED.source, fetched_at = now()`,
    [fx.day, fx.base, JSON.stringify(fx.rates), fx.source],
  );
}

/** The most recent stored day on or before `day` (weekends have no quote). */
export async function storedRates(ctx: PluginContext, base: string, day: string): Promise<FxDay | null> {
  const rows = await ctx.db.query<{ day: unknown; base: string; rates: unknown; source: string }>(
    `SELECT day::text AS day, base, rates, source FROM ${table(ctx, "fx_rates")} WHERE base = $1 AND day <= $2::date ORDER BY day DESC LIMIT 1`,
    [base, day],
  );
  const row = rows[0];
  if (!row) return null;
  const rates = typeof row.rates === "string" ? (JSON.parse(row.rates) as Record<string, number>) : (row.rates as Record<string, number>);
  const stamp = row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10);
  return { day: stamp, base: row.base, rates, source: row.source };
}

/** 1 unit of `currency` in `base` from a day's rates (rates[X] = X per base). */
export function rateFrom(fx: Pick<FxDay, "rates" | "base">, currency: string): number | null {
  if (currency === fx.base) return 1;
  const perBase = fx.rates[currency];
  return perBase && perBase > 0 ? 1 / perBase : null;
}

/** Convert minor units of `currency` into `base` minor units. */
export function convertMinor(amountMinor: number, rate: number | null): number | null {
  if (rate == null || !Number.isFinite(rate)) return null;
  return Math.round(amountMinor * rate);
}

/**
 * Rate to the book currency for a day: stored (≤ 5 days old), else fetched
 * for that day and stored. Null when no rate can be found.
 */
export async function rateToBook(ctx: PluginContext, currency: string, base: string, day: string, fetchImpl?: FetchLike): Promise<number | null> {
  if (currency === base) return 1;
  const stored = await storedRates(ctx, base, day).catch(() => null);
  if (stored && Date.parse(day) - Date.parse(stored.day) <= 5 * 86_400_000) {
    const rate = rateFrom(stored, currency);
    if (rate) return rate;
  }
  const fetched = await fetchRates(base, day > new Date().toISOString().slice(0, 10) ? "latest" : day, fetchImpl);
  if (!fetched) return stored ? rateFrom(stored, currency) : null;
  await storeRates(ctx, fetched).catch(() => undefined);
  return rateFrom(fetched, currency);
}

/** Daily job: store today's rates for each reporting currency in use. */
export async function refreshDailyRates(ctx: PluginContext, bases: string[], fetchImpl?: FetchLike): Promise<number> {
  let stored = 0;
  for (const base of [...new Set(bases.length ? bases : ["ZAR"])]) {
    const fx = await fetchRates(base, "latest", fetchImpl);
    if (!fx) {
      ctx.logger.info("FX rates unavailable today", { base });
      continue;
    }
    await storeRates(ctx, fx);
    stored += 1;
  }
  return stored;
}
